import { randomUUID } from 'node:crypto';
import type { AgentEvent } from '../core/runner/index.js';
import type { ChatContentBlock, ChatMessage } from '../core/model-invocation/index.js';
import type { ModelReference } from '../core/model-resolution/index.js';
import { ModelResolutionError } from '../core/model-resolution/index.js';
import { TurnInteractionManager } from '../adapters/channel/TurnInteractionManager.js';
import type {
  ApprovalInteractionRequest,
  ChannelRunRequest,
  ChannelCompletion,
  ChannelCompletionObserver,
  ChannelRuntimeBinding,
  ChannelRuntimeHost,
  ChannelShutdownHandoff,
  TurnInteractionResponse,
} from '../core/channel/index.js';
import { Logger } from '../platform/logger/index.js';
import { loadContextFiles } from '../core/workspace/index.js';
import type { ContextFile } from '../core/workspace/types.js';
import {
  processInboundMessage,
  type DroppedAttachment,
} from '../core/media/attachment-pipeline.js';
import { ATTACHMENT_DROP_NOTICE_DEFAULT } from '../core/media/constants.js';
import { bootstrapRuntime } from './bootstrap.js';
import { classifyRuntimeError, createRuntimeError } from './errors.js';
import { buildSystemPromptParams } from './prompt-factory.js';
import { summarizeAssembled } from './summarize-assembled.js';
import type { CurrentCallApprovalCapability } from '../core/approval/index.js';
import type { ActiveParentTurn } from './subagent-orchestration.js';
import {
  collectAvailableSubagents,
} from '../core/subagent/index.js';
import type {
  SubagentProfile,
} from '../core/subagent/types.js';
import type { AvailableSubagentEntry } from '../core/subagent/index.js';
import type {
  MessageRouteContext,
  PendingSteeringInput,
  QueuedChannelTurn,
  TurnLaunchContext,
} from './queue-types.js';
import type {
  RunTurnParams,
  RunTurnResult,
  RuntimeAppOptions,
  RuntimeDisposable,
  RuntimeErrorInfo,
  RuntimeErrorScope,
  RuntimeEvent,
  RuntimeLifecyclePhase,
  RuntimeLifecycleState,
  RuntimeResourceSet,
  RuntimeShutdownReport,
} from './types.js';

const log = Logger.get('RuntimeApp');

export class RuntimeApp {
  private readonly onEvent?: RuntimeAppOptions['onEvent'];
  private readonly inFlightRuns = new Set<Promise<unknown>>();
  /** Per-session 串行 gate：同一 sessionKey 同时只允许一个 turn。跨 session 可并发 */
  private readonly inFlightSessions = new Set<string>();
  /** 每个 session 的普通消息队列；消息在真正启动 turn 前先进入这里。 */
  private readonly messageQueueBySession = new Map<string, QueuedChannelTurn[]>();
  /** 当前活动 run-turn 的 steering inbox；由 runner 在执行过程中的注入点拉取并清空。 */
  private readonly steeringInboxBySession = new Map<string, PendingSteeringInput[]>();
  /**
   * 仅跟踪当前正在运行的 run-turn；steering 路由依赖这个最小运行态。
   * 它和 inFlightSessions 的区别是：前者表达“是否 busy”，这里表达“是否存在可接 steering 的活动 run-turn”。
   */
  private readonly activeTurnIdBySession = new Map<string, string>();

  /**
   * Per-session active turn 的 AbortController，供 `abortTurn(sk)` / shutdown 触发中止。
   *  - 写：runTurnInternal 入口（清 stale + 设新）
   *  - 写：runTurnInternal finally（清掉自己注册的那个）
   *  - 读：abortTurn / close / bindAbortHooks.querySessionsNeedingAbort
   * 详见 core-abort-spec.md §8.1。
   */
  private readonly activeAborts = new Map<string, AbortController>();
  /** Active resolved Parent Turns eligible to delegate a tracked Child. */
  private readonly activeParentTurns: Map<string, ActiveParentTurn>;

  // ── Channel 层 ──────────────────────────────────────────────────
  private readonly turnInteractionManager: TurnInteractionManager;
  /** turnId → 交互路由上下文；当前最小实现仍用 channel 引用加 originClientId 做定向。 */
  private readonly routeContextByTurn: Map<string, MessageRouteContext>;
  private approvalRoutingWired = false;

  private closePromise?: Promise<RuntimeShutdownReport>;
  private shutdownReport?: RuntimeShutdownReport;

  /**
   * Fanout entry for AgentEvent broadcasts. Set inside `create()` after the
   * bootstrap closure builds it; instance methods (notably
   * `handleInboundChannelMessage`) call this to emit `user_message` events
   * without needing to import the fanout closure.
   * 见 channel-multi-client-user-message-spec §5.3。
   */
  private fanoutAgentEvent!: (event: AgentEvent) => void;

  /**
   * Profile registry including the built-in `general-purpose` entry. Filled
   * by `create()` after `bootstrapRuntime()` returns; not part of
   * RuntimeResourceSet because it is consumed only by RuntimeApp itself
  * (the public surface is the available-profile projection).
   */
  private subagentProfiles!: ReadonlyMap<string, SubagentProfile>;

  private constructor(
    private readonly resources: RuntimeResourceSet,
    private state: RuntimeLifecycleState,
    private readonly channelCompletionObserver: ChannelCompletionObserver,
    private readonly channelShutdownHandoff: ChannelShutdownHandoff,
    subagentProfiles: ReadonlyMap<string, SubagentProfile>,
    activeParentTurns: Map<string, ActiveParentTurn>,
    routeContextByTurn: Map<string, MessageRouteContext>,
    onEvent?: RuntimeAppOptions['onEvent'],
  ) {
    this.subagentProfiles = subagentProfiles;
    this.activeParentTurns = activeParentTurns;
    this.routeContextByTurn = routeContextByTurn;
    this.onEvent = onEvent;
    this.turnInteractionManager = new TurnInteractionManager();
  }

  static async create(options: RuntimeAppOptions): Promise<RuntimeApp> {
    let app: RuntimeApp | undefined;
    let channelBindings: readonly ChannelRuntimeBinding[] = [];
    const userObserver = options.onAgentEvent;

    const fanout = (event: AgentEvent) => {
      for (const channel of channelBindings) {
        try {
          channel.send(event);
        } catch (err) {
          // channel.send 抛错不应中断事件分发
          log.warn('channel.send failed', {
            channelId: channel.id,
            eventType: event.type,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      try {
        userObserver?.(event);
      } catch (error) {
        log.warn('onAgentEvent observer failed', {
          eventType: event.type,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    };

    const channelHost: ChannelRuntimeHost = Object.freeze({
      onMessage(binding: ChannelRuntimeBinding, request: ChannelRunRequest) {
        if (!app) {
          return Promise.reject(new Error('Runtime Channel ingress is not ready.'));
        }
        return app.handleInboundChannelMessage(binding, request);
      },
      onInteractionResponse(response: TurnInteractionResponse) {
        app?.handleInteractionResponse(response);
      },
      onInteractionUnavailable(id: string, reason: 'origin_disconnected') {
        app?.turnInteractionManager.settle(id, { outcome: 'unavailable', reason });
      },
      abortHooks: Object.freeze({
        querySessionsNeedingAbort(): string[] {
          if (!app) return [];
          const sessions = new Set<string>(app.activeAborts.keys());
          for (const [sessionKey, queue] of app.messageQueueBySession) {
            if (queue.length > 0) sessions.add(sessionKey);
          }
          return [...sessions];
        },
        abortTurn(sessionKey: string) {
          return app?.abortTurn(sessionKey) ?? { aborted: false, dropped: 0 };
        },
      }),
    });

    const {
      resources,
      state,
      subagentProfiles,
      activeParentTurns,
      routeContextByTurn,
      channelCompletionObserver,
      channelShutdownHandoff,
    } = await bootstrapRuntime({
      ...options,
      onAgentEvent: fanout,
    }, channelHost);

    try {
      channelBindings = resources.registrySnapshot.channels.bindings;

      app = new RuntimeApp(
        resources,
        state,
        channelCompletionObserver,
        channelShutdownHandoff,
        subagentProfiles,
        activeParentTurns,
        routeContextByTurn,
        options.onEvent,
      );
      app.fanoutAgentEvent = fanout;
      app.wireApprovalRouting();

      options.onEvent?.({
        type: 'app_ready',
        workspaceDir: options.workspaceDir,
        contextVersion: state.contextVersion,
        toolNames: resources.registrySnapshot.tools.definitions.map((tool) => tool.name),
        channelIds: channelBindings.map((channel) => channel.id),
        memoryEnabled: resources.memoryManager !== null,
      });

      return app;
    } catch (error) {
      const report = await channelShutdownHandoff.runtimeConverged();
      for (const failure of report.failed) {
        log.warn('channel cleanup after RuntimeApp creation failure failed', {
          channelId: failure.channelId,
          error: failure.message,
        });
      }
      throw error;
    }
  }

  // ── 状态查询 ──────────────────────────────────────────────────────

  getState(): RuntimeLifecycleState {
    return {
      ...this.state,
      lastError: this.state.lastError ? { ...this.state.lastError } : undefined,
    };
  }

  getContextFiles(): ContextFile[] {
    return [...this.resources.contextFiles];
  }

  getToolNames(): string[] {
    return this.resources.registrySnapshot.tools.definitions.map((tool) => tool.name);
  }

  waitForChannelCompletion(id: string): Promise<ChannelCompletion> {
    return this.channelCompletionObserver.waitForChannelCompletion(id);
  }

  /**
   * Abort the active turn on `sessionKey` AND drop any queued (followup)
   * messages for that session. See core-abort-spec.md §0.3 D3 — single-step
   * "stop everything for this session" semantics.
   *
   * 返回 `{ aborted, dropped }`（两个字段正交）：
   *  - `aborted`：是否有 active turn 被 abort（`activeAborts` 命中）
   *  - `dropped`：从 `messageQueueBySession` 里被清空的消息数（可为 0）
   *
   * `aborted === false && dropped === 0` 时表示无事发生，此时也不 emit event。
   *
   * Never throws —— 包括 EventEmitter subscriber 抛错也会被 `safeEmit` swallow 为 log warn。
   *
   * Cascade：通过 AbortSignal 透传，正在跑的子 subagent 也会自动 abort。
   *
   * `messages_dropped` runtime event 仍照常 emit（供 library 用户 / telemetry 消费）；
   * 事件字段 `dropped` 与本返回值 `dropped` 同义。Channel 侧走返回值路径以避免
   * event 订阅顺序敏感问题。
   *
   * **pending steering 处理**：runAttempt 内 abort 命中时未注入的 steering 消息会
   * 被丢弃、仅写 `log.info`，**不计入本返回值 `dropped`，也不进 `messages_dropped`
   * event**。理由见 core-abort-spec.md §7.2.3。
   */
  abortTurn(sessionKey: string): { aborted: boolean; dropped: number } {
    const controller = this.activeAborts.get(sessionKey);
    const queue = this.messageQueueBySession.get(sessionKey);
    const dropped = queue?.length ?? 0;
    const aborted = !!controller;

    if (!aborted && dropped === 0) return { aborted: false, dropped: 0 };

    if (controller) controller.abort();
    if (dropped > 0) {
      this.messageQueueBySession.delete(sessionKey);
      this.safeEmit({
        type: 'messages_dropped',
        sessionKey,
        reason: 'abort',
        dropped, // pending steering 不计入（§7.2.3）
      });
    }
    log.info('turn aborted by user', { sessionKey, aborted, dropped });
    return { aborted, dropped };
  }

  /**
   * emit 抛错时降级为 warn 而非传出，保证调用方 "never throws" 契约。
   * Node EventEmitter 语义下 subscriber 抛错默认会传出——`safeEmit` 兜底。
   */
  private safeEmit(event: RuntimeEvent): void {
    try {
      this.emit(event);
    } catch (err) {
      log.warn('RuntimeEvent subscriber threw; swallowed', {
        eventType: event.type,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // ── Approval 路由（详见 channel-design.md §4.3）────────────────────

  /** Configure interaction transport once; Tool authorization stays in Runner policy flow. */
  private wireApprovalRouting(): void {
    if (this.approvalRoutingWired) return;
    this.approvalRoutingWired = true;

    // TurnInteractionManager → origin channel
    this.turnInteractionManager.onRequest((request) => {
      const originChannel = this.routeContextByTurn.get(request.turnId)?.originChannel;
      if (!originChannel) {
        log.warn('interaction request has no origin channel', {
          interactionId: request.id,
          toolName: request.toolName,
          turnId: request.turnId,
          sessionKey: request.sessionKey,
          originClientId: request.originClientId,
        });
        return { status: 'unavailable', reason: 'origin_missing' };
      }

      log.info('routing interaction request to origin channel', {
        interactionId: request.id,
        toolName: request.toolName,
        turnId: request.turnId,
        sessionKey: request.sessionKey,
        originClientId: request.originClientId,
        channelId: originChannel.id,
        route: 'interaction',
      });
      if (!originChannel.interaction) {
        return { status: 'unavailable', reason: 'origin_missing' };
      }
      const interactionRequest: ApprovalInteractionRequest = {
        ...request,
        kind: 'approval',
      };
      return originChannel.interaction.sendInteractionRequest(interactionRequest);
    });

    this.turnInteractionManager.onClose((request, result) => {
      const originChannel = this.routeContextByTurn.get(request.turnId)?.originChannel;
      if (!originChannel) {
        log.warn('interaction closure has no origin channel', {
          interactionId: request.id,
          toolName: request.toolName,
          turnId: request.turnId,
          sessionKey: request.sessionKey,
          originClientId: request.originClientId,
        });
        return;
      }

      log.info('routing interaction closure to origin channel', {
        interactionId: request.id,
        toolName: request.toolName,
        turnId: request.turnId,
        sessionKey: request.sessionKey,
        originClientId: request.originClientId,
        channelId: originChannel.id,
        route: 'interaction',
      });

      if (originChannel.interaction) {
        const interactionRequest: ApprovalInteractionRequest = {
          ...request,
          kind: 'approval',
        };
        originChannel.interaction.sendInteractionClosed(interactionRequest, result);
      }
    });
  }

  private getApprovalCapability(turnId: string): CurrentCallApprovalCapability | undefined {
    const route = this.routeContextByTurn.get(turnId);
    const originChannel = route?.originChannel;
    if (!originChannel?.interaction) return undefined;

    const capability: CurrentCallApprovalCapability = {
      request: async (request, signal) => this.turnInteractionManager.request({
        request: {
          toolName: request.toolName,
          input: { ...request.input },
          sessionKey: request.sessionKey,
          turnId: request.turnId,
          originClientId: this.routeContextByTurn.get(request.turnId)?.originClientId,
        },
        signal,
      }),
    };
    return Object.freeze(capability);
  }

  private handleInteractionResponse(response: TurnInteractionResponse): void {
    log.info('interaction response received from channel', {
      interactionId: response.id,
      kind: response.kind,
      outcome: response.outcome,
      decision: 'decision' in response ? response.decision : undefined,
    });

    if (response.kind !== 'approval') {
      log.warn('unsupported interaction response', {
        interactionId: response.id,
        kind: response.kind,
        outcome: response.outcome,
      });
      return;
    }

    if (response.outcome === 'submitted') {
      this.turnInteractionManager.resolve(response.id, response.decision);
      return;
    }

    if (response.outcome === 'cancelled') {
      this.turnInteractionManager.settle(response.id, {
        outcome: 'denied',
        reason: 'user_cancelled',
      });
      return;
    }

    this.turnInteractionManager.settle(response.id, {
      outcome: 'aborted',
      reason: 'turn',
    });
  }

  /**
   * Channel 入站统一先过 runtime intake。
   * 顺序：media 处理 → 占位装配 → user_message 广播 → steering 剥离 → 普通队列。
   * 决策 8：失败即丢弃 + 可选文本占位；不发任何事件 / 拒收。
   * user_message emit 时机对齐 channel-multi-client-user-message-spec §5.3
   * （assemble 后、route 分歧前，覆盖 queued+steering 两条路径）。
   */
  private async handleInboundChannelMessage(
    channel: ChannelRuntimeBinding,
    req: ChannelRunRequest,
  ): Promise<void> {
    log.info('channel message received', {
      channelId: channel.id,
      clientId: req.clientId,
      sessionKey: req.sessionKey,
      hasModelOverride: req.model !== undefined,
      hasMaxTokens: req.maxTokens !== undefined,
      hasMaxLlmCalls: req.maxLlmCalls !== undefined,
      messageChars: typeof req.message === 'string' ? req.message.length : undefined,
      attachmentCount: Array.isArray(req.message) ? req.message.length : 0,
    });
    // ① Media 处理：永不整体失败，失败 / 超限的附件已进 dropped[]
    const { normalized, dropped } = await processInboundMessage(req.message);

    // ② 占位装配：失败提示 + 空消息回落 + 退化输入 skip
    const assembled = this.assembleInboundMessage(normalized, dropped);
    if (assembled === undefined) return;

    const assembledMessageChars =
      typeof assembled === 'string' ? assembled.length : undefined;
    const assembledAttachmentCount = Array.isArray(assembled) ? assembled.length : 0;

    // ③ 路由分歧前先广播 user_message（spec §5.3）
    const routeToSteering = this.shouldRouteMessageToSteering(req.sessionKey);
    const deliveryMode: 'queued' | 'steering' = routeToSteering ? 'steering' : 'queued';
    const { text: broadcastText, attachmentSummaries } = summarizeAssembled(assembled);
    const messageId = randomUUID();

    this.fanoutAgentEvent({
      type: 'user_message',
      sessionKey: req.sessionKey,
      messageId,
      content: broadcastText,
      attachmentSummaries: attachmentSummaries.length ? attachmentSummaries : undefined,
      originClientId: req.clientId ?? null,
      deliveryMode,
      timestamp: Date.now(),
    });

    // ④ Steering 剥离：steering 路径只接文本（R1）；纯附件消息不入队（R1'）
    if (routeToSteering) {
      if (broadcastText.trim() === '') {
        log.info('steering message has no text after summarize; skipping enqueue', {
          channelId: channel.id,
          clientId: req.clientId,
          sessionKey: req.sessionKey,
          attachmentCount: attachmentSummaries.length,
        });
        return;
      }
      this.enqueueSteeringInput(
        req.sessionKey,
        broadcastText,
        this.buildMessageRouteContext(channel, req),
      );
      log.info('channel message routed to steering', {
        channelId: channel.id,
        clientId: req.clientId,
        sessionKey: req.sessionKey,
        messageChars: broadcastText.length,
        droppedAttachments: dropped.length,
      });
      return;
    }

    // ⑤ 普通队列
    const queuedTurn: QueuedChannelTurn = {
      sessionKey: req.sessionKey,
      message: assembled,
      launchContext: this.buildTurnLaunchContext(req),
      routeContext: this.buildMessageRouteContext(channel, req),
      originMessageId: messageId,
    };

    this.enqueueQueuedTurn(queuedTurn);
    log.info('channel message enqueued', {
      channelId: channel.id,
      clientId: req.clientId,
      sessionKey: req.sessionKey,
      queueLength: this.messageQueueBySession.get(req.sessionKey)?.length ?? 0,
      messageChars: assembledMessageChars,
      attachmentCount: assembledAttachmentCount,
      droppedAttachments: dropped.length,
    });

    const started = this.scheduleNextQueuedTurn(req.sessionKey);
    if (started) {
      await started;
    }
  }

  /**
   * 占位装配（决策 8）：把 media 输出 + dropped 列表组装成可入队的消息。
   *
   * 返回值语义：
   *   string | ChatContentBlock[] → 正常入队
   *   undefined                   → 退化输入（无文本、无成功附件、占位也空），调用方 skip
   */
  private assembleInboundMessage(
    normalized: string | ChatContentBlock[],
    dropped: DroppedAttachment[],
  ): string | ChatContentBlock[] | undefined {
    const notice = dropped.length > 0 && ATTACHMENT_DROP_NOTICE_DEFAULT
      ? `[系统提示：${dropped.length} 个附件因无法处理已忽略]`
      : '';

    if (typeof normalized === 'string') {
      const body = notice ? (normalized ? `${normalized}\n\n${notice}` : notice) : normalized;
      return body.trim() === '' ? undefined : body;
    }

    // 数组：是否含「有意义内容」= 任一非 text block，或任一 trim 后非空的 text。
    const hasContent = normalized.some(
      (b) => b.type !== 'text' || (b as { type: 'text'; text: string }).text.trim() !== '',
    );
    if (!hasContent) {
      return notice ? notice : undefined;
    }
    if (!notice) return normalized;

    // 追加提示行：并入首个 text block，无则在末尾插一个 text block
    const hostIndex = normalized.findIndex((b) => b.type === 'text');
    if (hostIndex >= 0) {
      return normalized.map((b, i) =>
        i === hostIndex
          ? { type: 'text', text: `${(b as { type: 'text'; text: string }).text}\n\n${notice}` }
          : b,
      );
    }
    return [...normalized, { type: 'text', text: notice }];
  }

  /**
   * steering 只在配置开启 steer 模式且当前 session 确实有活动 run-turn 时接收。
   * 这样可以保证“没有活动 turn 的消息默认回到普通排队路径”。
   */
  private shouldRouteMessageToSteering(sessionKey: string): boolean {
    return this.resources.resolvedConfig.runner.inTurnMessageMode === 'steer'
      && this.activeTurnIdBySession.has(sessionKey);
  }

  private buildTurnLaunchContext(req: ChannelRunRequest): TurnLaunchContext | undefined {
    if (
      req.model === undefined
      && req.maxTokens === undefined
      && req.maxLlmCalls === undefined
    ) {
      return undefined;
    }

    return {
      model: req.model,
      maxTokens: req.maxTokens,
      maxLlmCalls: req.maxLlmCalls,
    };
  }

  private buildMessageRouteContext(
    channel: ChannelRuntimeBinding,
    req: ChannelRunRequest,
  ): MessageRouteContext {
    return {
      originChannel: channel,
      originClientId: req.clientId,
    };
  }

  /** 普通消息入队只修改局部 queue state；真正何时启动 turn 交给 scheduleNextQueuedTurn 决定。 */
  private enqueueQueuedTurn(item: QueuedChannelTurn): void {
    const queue = this.messageQueueBySession.get(item.sessionKey) ?? [];
    queue.push(item);
    this.messageQueueBySession.set(item.sessionKey, queue);
  }

  /**
   * 活动 turn 的 steering inbox 采用追加写入；
   * 当前 runner 只消费文本，但这里仍保留 routeContext 以对齐统一消息模型，便于后续审计或扩展站内交互路由。
   */
  private enqueueSteeringInput(
    sessionKey: string,
    message: string,
    routeContext?: MessageRouteContext,
  ): void {
    const inbox = this.steeringInboxBySession.get(sessionKey) ?? [];
    inbox.push({ message, routeContext });
    this.steeringInboxBySession.set(sessionKey, inbox);
  }

  /**
   * 最小调度器：同 session 只拉起一条队头消息。
   * 如果该 session 当前仍 busy，就保持队列静止，等当前 turn 释放后再续跑下一条。
   */
  private scheduleNextQueuedTurn(sessionKey: string): Promise<RunTurnResult> | undefined {
    if (this.inFlightSessions.has(sessionKey)) {
      return undefined;
    }

    const queue = this.messageQueueBySession.get(sessionKey);
    if (!queue || queue.length === 0) {
      return undefined;
    }

    const next = queue.shift();
    if (!next) {
      return undefined;
    }

    if (queue.length === 0) {
      this.messageQueueBySession.delete(sessionKey);
    }

    return this.startQueuedTurn(next);
  }

  /**
   * 队列项真正启动时才生成 turnId 并登记 origin 路由。
   * 这样排队阶段不占用 turn 级资源，同时仍能把审批/交互回到原始 channel/client。
   */
  private async startQueuedTurn(item: QueuedChannelTurn): Promise<RunTurnResult> {
    const turnId = randomUUID();
    if (item.routeContext) {
      this.routeContextByTurn.set(turnId, item.routeContext);
    }

    try {
      return await this.runTurn({
        sessionKey: item.sessionKey,
        message: item.message,
        promptMode: 'full',
        model: item.launchContext?.model,
        maxTokens: item.launchContext?.maxTokens,
        maxLlmCalls: item.launchContext?.maxLlmCalls,
        turnId,
        originMessageId: item.originMessageId,
      });
    } finally {
      this.routeContextByTurn.delete(turnId);
      log.debug('queued turn routing cleared', {
        sessionKey: item.sessionKey,
        turnId,
      });
    }
  }

  // ── runTurn ───────────────────────────────────────────────────────

  async runTurn(params: RunTurnParams): Promise<RunTurnResult> {
    this.assertCanRunForSession(params.sessionKey);

    this.inFlightSessions.add(params.sessionKey);
    this.state.activeRunCount += 1;
    this.state.lastRunStartedAt = Date.now();
    this.emit({
      type: 'turn_start',
      sessionKey: params.sessionKey,
      contextVersion: this.state.contextVersion,
    });

    const turnId = params.turnId ?? randomUUID();
    const turnStartedAt = Date.now();
    this.activeTurnIdBySession.set(params.sessionKey, turnId);
    log.debug('turn start', {
      sessionKey: params.sessionKey,
      turnId,
      messageChars: typeof params.message === 'string' ? params.message.length : undefined,
      attachmentCount: Array.isArray(params.message) ? params.message.length : 0,
      activeRuns: this.state.activeRunCount,
    });

    const runPromise = this.runTurnInternal({ ...params, turnId });
    this.inFlightRuns.add(runPromise);

    try {
      const result = await runPromise;
      this.emit({
        type: 'turn_end',
        sessionKey: params.sessionKey,
        result,
      });
      log.info('turn end', {
        sessionKey: params.sessionKey,
        turnId,
        durationMs: Date.now() - turnStartedAt,
        toolRounds: result.toolRounds,
        stopReason: result.stopReason,
        inputTokens: result.usage.inputTokens,
        outputTokens: result.usage.outputTokens,
      });
      return result;
    } catch (error) {
      const info = classifyRuntimeError('run', error);
      if (params.originMessageId && error instanceof ModelResolutionError) {
        this.fanoutAgentEvent({
          type: 'error',
          sessionKey: params.sessionKey,
          turnId,
          error,
          category: error.category,
          originMessageId: params.originMessageId,
        });
      }
      log.error('turn failed', {
        sessionKey: params.sessionKey,
        turnId,
        durationMs: Date.now() - turnStartedAt,
        code: info.code,
        message: info.message,
      });
      this.recordError('run', info);
      throw createRuntimeError(info);
    } finally {
      this.inFlightRuns.delete(runPromise);
      this.inFlightSessions.delete(params.sessionKey);
      if (this.activeTurnIdBySession.get(params.sessionKey) === turnId) {
        this.activeTurnIdBySession.delete(params.sessionKey);
      }
      // steering 只服务当前这一轮活动 turn；turn 结束后整包丢弃，避免泄漏到下一轮。
      this.steeringInboxBySession.delete(params.sessionKey);
      this.state.activeRunCount = Math.max(0, this.state.activeRunCount - 1);
      this.state.lastRunEndedAt = Date.now();

      // 当前 turn 释放后，再尝试推进同 session 队头下一条消息，保持 session 内串行执行。
      const next = this.scheduleNextQueuedTurn(params.sessionKey);
      if (next) {
        void next.catch((error) => {
          log.warn('queued turn failed after scheduling', {
            sessionKey: params.sessionKey,
            error: error instanceof Error ? error.message : String(error),
          });
        });
      }
    }
  }

  /**
   * Snapshot the projection of `subagentProfiles` used for the
   * `<available-subagents>` system prompt section. Caller (typically
   * the prompt-factory layer) decides whether to inject it based on
   * `subagents.enabled` and the prompt mode.
   */
  getAvailableSubagents(): AvailableSubagentEntry[] {
    return collectAvailableSubagents(this.subagentProfiles);
  }

  async reloadContextFiles(): Promise<ContextFile[]> {
    this.assertCanReload();

    try {
      const nextFiles = await loadContextFiles(this.resources.workspaceDir, {
        mode: 'full',
        maxFileChars: this.resources.resolvedConfig.workspace.maxFileChars,
        maxTotalChars: this.resources.resolvedConfig.workspace.maxTotalChars,
      });

      this.resources.contextFiles = nextFiles;
      this.state.contextVersion += 1;
      this.emit({
        type: 'context_reload',
        contextVersion: this.state.contextVersion,
        fileCount: nextFiles.length,
      });
      return nextFiles;
    } catch (error) {
      const info = classifyRuntimeError('reload', error);
      this.recordError('reload', info, 'warning');
      return this.resources.contextFiles;
    }
  }

  async close(reason?: string): Promise<RuntimeShutdownReport> {
    if (this.shutdownReport) {
      return this.shutdownReport;
    }

    if (this.closePromise) {
      return this.closePromise;
    }

    log.info('shutdown start', {
      reason,
      inFlightTurns: this.inFlightRuns.size,
      channels: this.resources.registrySnapshot.channels.bindings.length,
    });
    this.emit({ type: 'shutdown_start', reason });
    this.setPhase('closing');

    this.closePromise = (async () => {
      const startedAt = Date.now();
      const completed: string[] = [];
      const failed: Array<{ resource: string; message: string }> = [];

      try {
        // Abort-then-wait（D4）：先 abort 所有 active turn，避免 shutdown 被响应
        // signal 的慢 turn 卡住；再 allSettled 等 in-flight Promise 收完。
        //
        // 遍历安全：controller.abort() 只是同步 flip signal + queue microtask，
        // 不会同步触发 runTurnInternal 的 finally（后者要等 await 链解开）；所以
        // for-of 期间 map 不会被并发 mutate。impl 未来如把 abort 改成同步等 cleanup
        // 完成，必须先 snapshot entries 再遍历。详见 core-abort-spec.md §8.5。
        for (const [sessionKey, controller] of this.activeAborts) {
          log.info('aborting in-flight turn on shutdown', { sessionKey });
          controller.abort('shutdown');
        }
        // activeAborts 不主动清；各 runTurnInternal finally 自己清。

        // 老实等所有 in-flight Promise 收完——多久都等（不响应 signal 的 tool 会
        // 使 close 挂到 tool 自然完成为止；runtime 不设内建 timeout，见 §8.5 shutdown 时长界限）。
        await Promise.allSettled([...this.inFlightRuns]);

        this.turnInteractionManager.close();
        completed.push('turnInteractionManager');

        const channelReport = await this.channelShutdownHandoff.runtimeConverged();
        completed.push(...channelReport.completed.map((id) => `channel:${id}`));
        for (const channelFailure of channelReport.failed) {
          failed.push({
            resource: `channel:${channelFailure.channelId}`,
            message: channelFailure.message,
          });
          log.warn('channel stop failed', {
            channelId: channelFailure.channelId,
            error: channelFailure.message,
          });
        }

        for (const [name, disposable] of this.collectDisposables()) {
          try {
            await Promise.resolve(disposable.close());
            completed.push(name);
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            failed.push({ resource: name, message });
            log.warn('disposable close failed', { resource: name, error: message });
            this.recordError('shutdown', {
              scope: 'shutdown',
              severity: 'warning',
              code: 'SHUTDOWN_FAILED',
              message,
              cause: error instanceof Error ? error : new Error(String(error)),
            }, 'warning');
          }
        }

        this.resources.contextFiles = [];
        this.state.closedAt = Date.now();
        this.setPhase('closed');

        const report = {
          reason,
          startedAt,
          finishedAt: Date.now(),
          completed,
          failed,
        } satisfies RuntimeShutdownReport;

        this.shutdownReport = report;
        log.info('shutdown complete', {
          durationMs: report.finishedAt - report.startedAt,
          completed: completed.length,
          failed: failed.length,
        });
        this.emit({ type: 'shutdown_end', report });
        return report;
      } catch (error) {
        const info = classifyRuntimeError('shutdown', error);
        log.error('shutdown failed', { code: info.code, message: info.message });
        this.recordError('shutdown', info);
        this.setPhase('failed');
        throw createRuntimeError(info);
      }
    })();

    return this.closePromise;
  }

  // ── 内部辅助 ──────────────────────────────────────────────────────

  /**
   * turn 一旦真正开始执行后，就进入既有的 turn body bridge：
   * resolve session、按需 reload context、构建 prompts，然后把一次完整 turn 委托给 agentRunner。
   */
  private async runTurnInternal(params: RunTurnParams & { turnId: string }): Promise<RunTurnResult> {
    // 防御性 stale 清理（core-abort-spec.md §8.2）：正常流由下面 finally 保证 cleanup，
    // 不会遗留 stale entry。仅为防未来意外路径（finally 本身 throw / 某次重构意外
    // 提前 return）留一层兜底。命中即 log warn。
    const stale = this.activeAborts.get(params.sessionKey);
    if (stale) {
      log.warn('stale abort controller cleared (defensive)', { sessionKey: params.sessionKey });
      this.activeAborts.delete(params.sessionKey);
    }

    // 注册本 turn 的 controller —— abortTurn / shutdown 拿它来 abort。
    const controller = new AbortController();
    this.activeAborts.set(params.sessionKey, controller);
    let parentRecord: ActiveParentTurn | undefined;

    try {
      await this.resources.sessionManager.resolveSession(params.sessionKey);

      if (params.reloadContextFiles) {
        await this.reloadContextFiles();
      }

      const visibleToolDefinitions = this.resources.registrySnapshot.tools.visibleDefinitions(
        this.resources.toolPolicy,
      );

      const resolvedModel = this.resources.resolveParentModel({
        model: params.model,
        maxTokens: params.maxTokens,
        tools: visibleToolDefinitions.length > 0,
        mediaKinds: Array.isArray(params.message) && params.message.some((block) => block.type === 'image')
          ? ['image']
          : [],
      });

      const systemPrompt = this.resources.systemPromptBuilder.build(
        buildSystemPromptParams({
          config: this.resources.resolvedConfig,
          contextFiles: this.resources.contextFiles,
          toolNames: visibleToolDefinitions.map(({ name }) => name),
          overrides: params,
          workspaceDir: this.resources.workspaceDir,
          // Only inject the <available-subagents> section when the feature is
          // on. SystemPromptBuilder additionally suppresses it in minimal mode
          // (which is what subagents themselves get).
          availableSubagents:
            this.resources.resolvedConfig.subagents?.enabled !== false
              ? this.getAvailableSubagents()
              : undefined,
        }),
      );

      // context-hook prepend 只作用于文本部分：数组消息保持图文混排顺序与原始内容
      let runnerMessage: string | ChatContentBlock[];
      if (typeof params.message === 'string') {
        runnerMessage = (await this.resources.userPromptBuilder.build({
          text: params.message,
        })).text;
      } else {
        // 用首个 text block 作为 prepend 宿主；其余 block 保持原序原值
        const hostIndex = params.message.findIndex((b) => b.type === 'text');
        const hostText = hostIndex >= 0
          ? (params.message[hostIndex] as { type: 'text'; text: string }).text
          : '';
        const prepended = (await this.resources.userPromptBuilder.build({
          text: hostText,
        })).text;

        runnerMessage = hostIndex >= 0
          ? params.message.map((b, i) =>
              i === hostIndex ? { type: 'text', text: prepended } : b,
            )
          : [{ type: 'text', text: prepended }, ...params.message];
      }

      const effectiveReference: ModelReference = Object.freeze({
        providerId: resolvedModel.identity.providerId,
        modelId: resolvedModel.identity.modelId,
      });
      parentRecord = Object.freeze({
        sessionKey: params.sessionKey,
        turnId: params.turnId,
        signal: controller.signal,
        effectiveReference,
        contextFiles: Object.freeze([...this.resources.contextFiles]),
      });
      this.activeParentTurns.set(params.turnId, parentRecord);

      const result = await this.resources.agentRunner.run({
        sessionKey: params.sessionKey,
        message: runnerMessage,
        resolvedModel,
        systemPrompt,
        turnId: params.turnId,
        toolProjection: this.resources.registrySnapshot.tools,
        hookProjection: this.resources.registrySnapshot.hooks,
        toolPolicy: this.resources.toolPolicy,
        approvalCapability: this.getApprovalCapability(params.turnId),
        maxLlmCalls: params.maxLlmCalls ?? this.resources.resolvedConfig.runner.maxLlmCalls,
        // runtime 只提供"读取并清空当前 steering inbox"的能力，具体消费时机仍由 runner 控制。
        getSteeringMessages: async () => this.drainSteeringMessages(params.sessionKey),
        compaction: this.resources.resolvedConfig.compaction,
        originMessageId: params.originMessageId,
        signal: controller.signal, // core-abort-spec.md §8.2
      });

      return {
        sessionKey: params.sessionKey,
        text: result.text,
        content: result.content,
        stopReason: result.stopReason,
        usage: result.usage,
        toolRounds: result.toolRounds,
      };
    } finally {
      if (parentRecord && this.activeParentTurns.get(params.turnId) === parentRecord) {
        this.activeParentTurns.delete(params.turnId);
      }
      // 只清自己注册的那一个（防止"另一个 turn 已重置 map"误清）
      if (this.activeAborts.get(params.sessionKey) === controller) {
        this.activeAborts.delete(params.sessionKey);
      }
    }
  }

  /**
   * steering 输入在被 runner 读取后立即从 inbox 删除，避免同一条输入在多个注入点重复消费。
   */
  private async drainSteeringMessages(sessionKey: string): Promise<ChatMessage[]> {
    const inbox = this.steeringInboxBySession.get(sessionKey);
    if (!inbox || inbox.length === 0) {
      return [];
    }

    this.steeringInboxBySession.delete(sessionKey);

    const messages = await Promise.all(inbox.map(async (item) => {
      // 当前 runner 只消费文本；routeContext 仍保留在 inbox 项里，用于后续扩展统一消息路由模型。
      const builtUserPrompt = await this.resources.userPromptBuilder.build({ text: item.message });
      return {
        role: 'user' as const,
        content: builtUserPrompt.text,
      } satisfies ChatMessage;
    }));

    return messages;
  }

  private collectDisposables(): Array<[string, RuntimeDisposable]> {
    const candidates: Array<[string, unknown]> = [
      ['memoryManager', this.resources.memoryManager],
    ];

    return candidates.filter((candidate): candidate is [string, RuntimeDisposable] => {
      const resource = candidate[1] as Partial<RuntimeDisposable> | null;
      return typeof resource?.close === 'function';
    });
  }

  /**
   * Per-session 并发控制：同 session 串行（消息历史一致性），跨 session 可并发。
   * runtime 关闭后任何 turn 都拒绝。
   */
  private assertCanRunForSession(sessionKey: string): void {
    if (
      this.state.phase === 'closing' ||
      this.state.phase === 'closed' ||
      this.state.phase === 'failed'
    ) {
      throw createRuntimeError({
        scope: 'run',
        severity: 'recoverable',
        code: 'RUN_REJECTED',
        message: `Cannot run when runtime phase is ${this.state.phase}.`,
      });
    }
    if (this.inFlightSessions.has(sessionKey)) {
      throw createRuntimeError({
        scope: 'run',
        severity: 'recoverable',
        code: 'RUN_REJECTED',
        message: `Session ${sessionKey} already has a turn in flight.`,
      });
    }
  }

  private assertCanReload(): void {
    if (this.state.phase === 'closing' || this.state.phase === 'closed' || this.state.phase === 'failed') {
      throw createRuntimeError({
        scope: 'reload',
        severity: 'recoverable',
        code: 'CONTEXT_LOAD_FAILED',
        message: `Cannot reload context files when runtime phase is ${this.state.phase}.`,
      });
    }
  }

  private assertNotClosed(): void {
    if (this.state.phase === 'closing' || this.state.phase === 'closed' || this.state.phase === 'failed') {
      throw createRuntimeError({
        scope: 'startup',
        severity: 'recoverable',
        code: 'RUN_REJECTED',
        message: `Cannot register channel when runtime phase is ${this.state.phase}.`,
      });
    }
  }

  private setPhase(next: RuntimeLifecyclePhase): void {
    this.state.phase = next;
    if (next === 'ready' && !this.state.readyAt) {
      this.state.readyAt = Date.now();
    }
  }

  private recordError(
    scope: RuntimeErrorScope,
    info: RuntimeErrorInfo,
    eventType?: 'warning' | 'error',
  ): void {
    this.state.lastError = {
      message: info.message,
      at: Date.now(),
      scope,
    };

    const type = eventType ?? (info.severity === 'warning' ? 'warning' : 'error');
    this.emit({ type, info });
  }

  private emit(event: RuntimeEvent): void {
    this.onEvent?.(event);
  }
}
