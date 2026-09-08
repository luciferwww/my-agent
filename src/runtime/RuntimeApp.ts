import { randomUUID } from 'node:crypto';
import type { AgentEvent } from '../core/runner/index.js';
import type { ChatContentBlock, ChatMessage } from '../core/model-invocation/index.js';
import type { ModelReference } from '../core/model-resolution/index.js';
import { ModelResolutionError, ModelResolver } from '../core/model-resolution/index.js';
import { TurnInteractionManager } from '../adapters/channel/TurnInteractionManager.js';
import type {
  ApprovalInteractionRequest,
  ChannelRunRequest,
  ChannelCompletion,
  ChannelCompletionObserver,
  ChannelRuntimeBinding,
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
import { classifyRuntimeError, createRuntimeError } from './errors.js';
import {
  buildRuntimeHandle,
  type RuntimeApplicationKernel,
  type RuntimeApplicationKernelInput,
} from './runtime-builder.js';
import type { RuntimeHandle } from './runtime-composition.js';
import type {
  RuntimeGenerationPin,
  RuntimeSnapshotAccess,
} from './composition-coordinator.js';
import { buildSystemPromptParams } from './prompt-factory.js';
import { summarizeAssembled } from './summarize-assembled.js';
import {
  RequestCompletionGate,
  type RequestTerminal,
} from './request-completion-gate.js';
import {
  RuntimeDeadlineBudget,
  createSystemRuntimeDeadlineDriver,
  resolveRuntimeDeadlinePolicy,
} from './runtime-deadline.js';
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
  RuntimeErrorInfo,
  RuntimeErrorScope,
  RuntimeEvent,
  RuntimeLifecyclePhase,
  RuntimeLifecycleState,
  RuntimeResourceSet,
  RuntimeShutdownReport,
} from './types.js';

const log = Logger.get('RuntimeApp');

interface ActiveRootTree {
  readonly requestId: string;
  readonly generation: number;
  readonly sessionKey: string;
  readonly channels: readonly ChannelRuntimeBinding[];
  readonly pin: RuntimeGenerationPin;
  members: number;
  released: boolean;
}

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
  private readonly activeRootGenerations = new Map<string, ActiveRootTree>();
  private readonly requestGates = new Map<string, RequestCompletionGate<RunTurnResult>>();
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
    * Fanout entry for AgentEvent broadcasts. Injected by the Runtime Builder
    * when it constructs the application kernel; instance methods (notably
   * `handleInboundChannelMessage`) call this to emit `user_message` events
   * without needing to import the fanout closure.
   * 见 channel-multi-client-user-message-spec §5.3。
   */
  private fanoutAgentEvent!: (event: AgentEvent) => void | Promise<void>;

  /**
    * Profile registry including the built-in `general-purpose` entry. Built
    * by the Runtime Builder before kernel construction; not part of
   * RuntimeResourceSet because it is consumed only by RuntimeApp itself
  * (the public surface is the available-profile projection).
   */
  private subagentProfiles!: ReadonlyMap<string, SubagentProfile>;

  private constructor(
    private readonly resources: RuntimeResourceSet,
    private state: RuntimeLifecycleState,
    private readonly channelCompletionObserver: ChannelCompletionObserver,
    private readonly snapshotAccess: RuntimeSnapshotAccess,
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

  static async create(options: RuntimeAppOptions): Promise<RuntimeHandle> {
    return buildRuntimeHandle(options, RuntimeApp.createKernel);
  }

  private static createKernel(input: RuntimeApplicationKernelInput): RuntimeApplicationKernel {
    const app = new RuntimeApp(
      input.resources,
      input.state,
      input.channelCompletionObserver,
      input.snapshotAccess,
      input.subagentProfiles,
      input.activeParentTurns,
      input.routeContextByTurn,
      input.onEvent,
    );
    app.fanoutAgentEvent = input.fanoutAgentEvent;
    app.wireApprovalRouting();

    return {
      application: app,
      onChannelMessage: (binding, request) =>
        app.handleInboundChannelMessage(binding, request),
      onInteractionResponse: (response) => app.handleInteractionResponse(response),
      onInteractionUnavailable: (id, reason) => {
        app.turnInteractionManager.settle(id, { outcome: 'unavailable', reason });
      },
      querySessionsNeedingAbort: () => {
        const sessions = new Set<string>(app.activeAborts.keys());
        for (const [sessionKey, queue] of app.messageQueueBySession) {
          if (queue.length > 0) sessions.add(sessionKey);
        }
        return [...sessions];
      },
      abortTurn: (sessionKey) => app.abortTurn(sessionKey),
      blockingTurnIds: (generation) => app.blockingTurnIds(generation),
      abortGeneration: (generation) => app.abortGeneration(generation),
      channelBindingsForTurn: (turnId) => app.channelBindingsForTurn(turnId),
      shouldDeliverAgentEvent: (event) => app.shouldDeliverAgentEvent(event),
      close: (reason, budget) => app.close(reason, budget),
    };
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
    return this.snapshotAccess.currentSnapshot().tools.definitions.map((tool) => tool.name);
  }

  waitForChannelCompletion(id: string): Promise<ChannelCompletion> {
    return this.channelCompletionObserver.waitForChannelCompletion(id);
  }

  private blockingTurnIds(generation: number): readonly string[] {
    return Object.freeze([...this.activeRootGenerations]
      .filter(([, root]) => root.generation === generation)
      .map(([turnId]) => turnId)
      .sort());
  }

  private abortGeneration(generation: number): readonly string[] {
    const aborted: string[] = [];
    for (const [turnId, root] of this.activeRootGenerations) {
      if (root.generation !== generation) continue;
      this.activeAborts.get(root.sessionKey)?.abort('generation-retirement');
      aborted.push(turnId);
    }
    return Object.freeze(aborted.sort());
  }

  private channelBindingsForTurn(
    turnId: string,
  ): readonly ChannelRuntimeBinding[] | undefined {
    return this.activeRootGenerations.get(turnId)?.channels;
  }

  private shouldDeliverAgentEvent(event: AgentEvent): boolean {
    if (event.type !== 'run_end' && event.type !== 'error') return true;
    const outcome = this.requestGates.get(event.requestId)?.terminalOutcome;
    return outcome !== 'shutdown_nonconverged';
  }

  private registerChild(turnId: string, tree: ActiveRootTree): () => void {
    if (tree.released || this.activeRootGenerations.get(turnId) !== tree) {
      throw new Error(`Root tree "${turnId}" no longer accepts Child members.`);
    }
    tree.members += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.releaseTreeMember(turnId, tree);
    };
  }

  private releaseTreeMember(turnId: string, tree: ActiveRootTree): void {
    if (tree.released) return;
    tree.members -= 1;
    if (tree.members > 0) return;
    if (tree.members < 0) {
      throw new Error(`Root tree "${turnId}" member accounting underflow.`);
    }
    tree.released = true;
    tree.pin.release();
    if (this.activeRootGenerations.get(turnId) === tree) {
      this.activeRootGenerations.delete(turnId);
    }
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
      for (const item of queue ?? []) {
        void this.settleQueuedRequest(item, 'abort_queue_drop');
      }
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
      hasModelOverride: req.modelReference !== undefined,
      hasMaxOutputTokens: req.requestOverride?.maxOutputTokens !== undefined,
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
      requestId: randomUUID(),
      sessionKey: req.sessionKey,
      message: assembled,
      launchContext: this.buildTurnLaunchContext(req),
      routeContext: this.buildMessageRouteContext(channel, req),
      originMessageId: messageId,
    };
    this.requestGates.set(
      queuedTurn.requestId,
      new RequestCompletionGate(queuedTurn.requestId, queuedTurn.originMessageId),
    );

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
      req.modelReference === undefined
      && req.requestOverride === undefined
      && req.maxLlmCalls === undefined
    ) {
      return undefined;
    }

    return {
      modelReference: req.modelReference,
      requestOverride: req.requestOverride,
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

  private settleQueuedRequest(
    item: QueuedChannelTurn,
    reason: 'abort_queue_drop' | 'shutdown',
  ): Promise<void> | undefined {
    const gate = this.requestGates.get(item.requestId);
    if (!gate?.seal({ outcome: 'cancelled', reason })) return undefined;
    const event = Object.freeze({
      type: 'request_end' as const,
      requestId: item.requestId,
      ...(item.originMessageId ? { originMessageId: item.originMessageId } : {}),
      outcome: 'cancelled' as const,
      reason,
    });
    this.safeEmit(event);
    const fanout = Promise.resolve(this.fanoutAgentEvent(event)).catch((error) => {
      log.warn('request_end Fanout failed', {
        requestId: item.requestId,
        error: error instanceof Error ? error.message : String(error),
      });
    });
    this.requestGates.delete(item.requestId);
    return fanout;
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
        requestId: item.requestId,
        sessionKey: item.sessionKey,
        message: item.message,
        promptMode: 'full',
        modelReference: item.launchContext?.modelReference,
        requestOverride: item.launchContext?.requestOverride,
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

  runTurn(params: RunTurnParams): Promise<RunTurnResult> {
    try {
      this.assertCanRunForSession(params.sessionKey);
    } catch (error) {
      return Promise.reject(error);
    }

    const requestId = params.requestId ?? randomUUID();
    const existingGate = this.requestGates.get(requestId);
    const gate = existingGate ?? new RequestCompletionGate<RunTurnResult>(
      requestId,
      params.originMessageId,
    );
    if (!existingGate) this.requestGates.set(requestId, gate);

    const turnId = params.turnId ?? randomUUID();
    if (!gate.start(turnId)) {
      return Promise.reject(new Error(`Runtime request "${requestId}" is already started or terminal.`));
    }

    const worker = this.executeRootRequest(
      { ...params, requestId, turnId },
      gate,
    );
    this.inFlightRuns.add(worker);
    void worker.then(
      () => this.inFlightRuns.delete(worker),
      (error: unknown) => {
        this.inFlightRuns.delete(worker);
        const runtimeError = error instanceof Error ? error : new Error(String(error));
        gate.seal({ outcome: 'failed', error: runtimeError });
        this.requestGates.delete(requestId);
      },
    );

    return gate.terminal.then((terminal) => this.callerResult(terminal));
  }

  private async executeRootRequest(
    params: RunTurnParams & { requestId: string; turnId: string },
    gate: RequestCompletionGate<RunTurnResult>,
  ): Promise<void> {
    const generationPin = this.snapshotAccess.captureRootGeneration();
    const tree: ActiveRootTree = {
      requestId: params.requestId,
      generation: generationPin.generation,
      sessionKey: params.sessionKey,
      channels: generationPin.snapshot.channels.bindings,
      pin: generationPin,
      members: 1,
      released: false,
    };
    this.activeRootGenerations.set(params.turnId, tree);
    this.inFlightSessions.add(params.sessionKey);
    this.state.activeRunCount += 1;
    this.state.lastRunStartedAt = Date.now();
    this.safeEmit({
      type: 'turn_start',
      requestId: params.requestId,
      ...(params.originMessageId ? { originMessageId: params.originMessageId } : {}),
      turnId: params.turnId,
      sessionKey: params.sessionKey,
      contextVersion: this.state.contextVersion,
    });

    const turnStartedAt = Date.now();
    this.activeTurnIdBySession.set(params.sessionKey, params.turnId);
    log.debug('turn start', {
      requestId: params.requestId,
      sessionKey: params.sessionKey,
      turnId: params.turnId,
      generation: generationPin.generation,
      messageChars: typeof params.message === 'string' ? params.message.length : undefined,
      attachmentCount: Array.isArray(params.message) ? params.message.length : 0,
      activeRuns: this.state.activeRunCount,
    });

    try {
      const result = await this.runTurnInternal(params, generationPin, tree);
      const outcome = result.stopReason === 'aborted' ? 'aborted' : 'completed';
      if (gate.seal({ outcome, value: result })) {
        this.safeEmit({
          type: 'turn_end',
          requestId: params.requestId,
          ...(params.originMessageId ? { originMessageId: params.originMessageId } : {}),
          turnId: params.turnId,
          sessionKey: params.sessionKey,
          outcome,
          result,
        });
      } else {
        log.info('late Root completion ignored by public gate', {
          requestId: params.requestId,
          turnId: params.turnId,
          outcome,
        });
      }
      log.info('turn end', {
        requestId: params.requestId,
        sessionKey: params.sessionKey,
        turnId: params.turnId,
        durationMs: Date.now() - turnStartedAt,
        toolRounds: result.toolRounds,
        stopReason: result.stopReason,
        inputTokens: result.usage.inputTokens,
        outputTokens: result.usage.outputTokens,
      });
    } catch (error) {
      const info = classifyRuntimeError('run', error);
      const runtimeError = createRuntimeError(info);
      if (gate.seal({ outcome: 'failed', error: runtimeError })) {
        this.safeEmit({
          type: 'turn_end',
          requestId: params.requestId,
          ...(params.originMessageId ? { originMessageId: params.originMessageId } : {}),
          turnId: params.turnId,
          sessionKey: params.sessionKey,
          outcome: 'failed',
          failure: Object.freeze({ code: info.code, message: info.message }),
        });
      } else {
        log.info('late Root failure ignored by public gate', {
          requestId: params.requestId,
          turnId: params.turnId,
          code: info.code,
        });
      }
      if (params.originMessageId && error instanceof ModelResolutionError) {
        void Promise.resolve(this.fanoutAgentEvent({
          type: 'error',
          requestId: params.requestId,
          sessionKey: params.sessionKey,
          turnId: params.turnId,
          error,
          category: error.category,
          originMessageId: params.originMessageId,
        })).catch(() => undefined);
      }
      log.error('turn failed', {
        requestId: params.requestId,
        sessionKey: params.sessionKey,
        turnId: params.turnId,
        durationMs: Date.now() - turnStartedAt,
        code: info.code,
        message: info.message,
      });
      this.recordError('run', info);
    } finally {
      this.inFlightSessions.delete(params.sessionKey);
      if (this.activeTurnIdBySession.get(params.sessionKey) === params.turnId) {
        this.activeTurnIdBySession.delete(params.sessionKey);
      }
      this.steeringInboxBySession.delete(params.sessionKey);
      this.state.activeRunCount = Math.max(0, this.state.activeRunCount - 1);
      this.state.lastRunEndedAt = Date.now();
      this.releaseTreeMember(params.turnId, tree);
      this.requestGates.delete(params.requestId);

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

  private callerResult(terminal: RequestTerminal<RunTurnResult>): RunTurnResult {
    if (terminal.outcome === 'completed' || terminal.outcome === 'aborted') return terminal.value;
    if (terminal.outcome === 'cancelled') {
      throw new Error(`Runtime request cancelled: ${terminal.reason}`);
    }
    throw terminal.error;
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

  async close(
    reason?: string,
    sharedBudget?: RuntimeDeadlineBudget,
  ): Promise<RuntimeShutdownReport> {
    if (this.shutdownReport) {
      return this.shutdownReport;
    }

    if (this.closePromise) {
      return this.closePromise;
    }

    log.info('shutdown start', {
      reason,
      inFlightTurns: this.inFlightRuns.size,
      channels: this.snapshotAccess.currentSnapshot().channels.bindings.length,
    });
    this.emit({ type: 'shutdown_start', reason });
    this.setPhase('closing');

    this.closePromise = (async () => {
      const startedAt = Date.now();
      const budget = sharedBudget ?? new RuntimeDeadlineBudget(
        createSystemRuntimeDeadlineDriver(),
        resolveRuntimeDeadlinePolicy(undefined),
      );
      const completed: string[] = [];
      const failed: Array<{ resource: string; message: string }> = [];
      const residuals: import('./types.js').RuntimeShutdownResidual[] = [];
      const queuedCancelledRequestIds: string[] = [];
      const terminalFanout: Promise<void>[] = [];
      const activeAtAdmission = [...this.activeRootGenerations.entries()]
        .sort(([left], [right]) => left.localeCompare(right));
      const terminals = new Map(activeAtAdmission.map(([, tree]) => [
        tree.requestId,
        this.requestGates.get(tree.requestId)?.terminal,
      ]));

      try {
        for (const [sessionKey, queue] of [...this.messageQueueBySession]
          .sort(([left], [right]) => left.localeCompare(right))) {
          this.messageQueueBySession.delete(sessionKey);
          for (const item of queue) {
            queuedCancelledRequestIds.push(item.requestId);
            const delivery = this.settleQueuedRequest(item, 'shutdown');
            if (delivery) terminalFanout.push(delivery);
          }
        }
        this.turnInteractionManager.close();
        completed.push('turnInteractionManager');

        const convergence = () => Promise.allSettled([...this.inFlightRuns]);
        const graceful = await budget.race(
          convergence(),
          budget.policy.shutdownGracefulDrainMs,
        );
        if (graceful.outcome === 'failed') {
          failed.push({ resource: 'turns', message: graceful.message });
        }

        if (graceful.outcome === 'deadline-exhausted') {
          for (const [turnId, tree] of activeAtAdmission) {
            if (this.activeRootGenerations.get(turnId) !== tree) continue;
            this.activeAborts.get(tree.sessionKey)?.abort('shutdown');
          }
        }

        const abortConvergence = graceful.outcome === 'deadline-exhausted'
          ? await budget.race(convergence(), budget.policy.shutdownAbortConvergenceMs)
          : graceful;
        if (abortConvergence.outcome === 'failed') {
          failed.push({ resource: 'turns', message: abortConvergence.message });
        }

        const nonconvergedRequestIds: string[] = [];
        if (abortConvergence.outcome === 'deadline-exhausted') {
          for (const [turnId, tree] of [...this.activeRootGenerations.entries()]
            .sort(([left], [right]) => left.localeCompare(right))) {
            const gate = this.requestGates.get(tree.requestId);
            const error = new Error(`Runtime request "${tree.requestId}" did not converge during shutdown.`);
            if (gate?.seal({ outcome: 'shutdown_nonconverged', error })) {
              nonconvergedRequestIds.push(tree.requestId);
              this.safeEmit({
                type: 'turn_end',
                requestId: tree.requestId,
                ...(gate.originMessageId ? { originMessageId: gate.originMessageId } : {}),
                turnId,
                sessionKey: tree.sessionKey,
                outcome: 'shutdown_nonconverged',
                failure: Object.freeze({
                  code: 'SHUTDOWN_NONCONVERGED',
                  message: error.message,
                }),
              });
            }
            residuals.push({
              owner: 'runtime',
              phase: 'shutdown-abort-convergence',
              generation: tree.generation,
              requestId: tree.requestId,
              turnId,
              blockingTurnIds: Object.freeze([turnId]),
              message: error.message,
            });
          }
        }

        if (terminalFanout.length > 0) {
          const fanout = await budget.raceRemaining(Promise.allSettled(terminalFanout));
          if (fanout.outcome === 'deadline-exhausted') {
            residuals.push({
              owner: 'fanout',
              phase: 'terminal-fanout',
              message: 'Terminal Fanout did not converge before the shutdown deadline.',
            });
          } else if (fanout.outcome === 'failed') {
            failed.push({ resource: 'terminalFanout', message: fanout.message });
          }
        }

        const terminalOutcomes = await Promise.all([...terminals.entries()].map(async ([requestId, terminal]) => [
          requestId,
          terminal ? await terminal : undefined,
        ] as const));
        const completedRequestIds = terminalOutcomes
          .filter(([, terminal]) => terminal?.outcome === 'completed')
          .map(([requestId]) => requestId)
          .sort();
        const actualAbortedRequestIds = terminalOutcomes
          .filter(([, terminal]) => terminal?.outcome === 'aborted')
          .map(([requestId]) => requestId);
        actualAbortedRequestIds.sort();
        nonconvergedRequestIds.sort();
        queuedCancelledRequestIds.sort();
        const protectedGenerations = [...new Set(
          [...this.activeRootGenerations.values()].map((tree) => tree.generation),
        )].sort((left, right) => left - right);

        this.resources.contextFiles = [];
        this.state.closedAt = Date.now();
        this.setPhase('closed');

        const report = freezeShutdownReport({
          outcome: residuals.length > 0 || budget.remaining() <= 0
            ? 'deadline-exhausted'
            : 'completed',
          reason,
          startedAt,
          finishedAt: Date.now(),
          completed,
          failed,
          turns: {
            completedRequestIds,
            abortedRequestIds: actualAbortedRequestIds,
            nonconvergedRequestIds,
            queuedCancelledRequestIds,
            protectedGenerations,
          },
          instanceStops: {
            completedInstanceIds: [],
            failedInstanceIds: [],
            pendingInstanceIds: [],
            skippedProtectedInstanceIds: [],
          },
          residuals,
        });

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
  private async runTurnInternal(
    params: RunTurnParams & { requestId: string; turnId: string },
    generationPin: RuntimeGenerationPin,
    tree: ActiveRootTree,
  ): Promise<RunTurnResult> {
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

      const snapshot = generationPin.snapshot;
      const visibleToolDefinitions = snapshot.tools.visibleDefinitions(
        this.resources.toolPolicy,
      );

      const resolvedModel = new ModelResolver(snapshot.providers).resolve({
        reference: params.modelReference ?? this.resources.resolvedConfig.llm.model,
        referenceSource: params.modelReference === undefined ? 'config-default' : 'turn-explicit',
        defaultProviderId: this.resources.defaultProviderId,
        request: {
          tools: visibleToolDefinitions.length > 0,
          mediaKinds: Array.isArray(params.message)
            && params.message.some((block) => block.type === 'image')
            ? ['image']
            : [],
        },
        requestOverride: params.requestOverride,
        policy: { defaultMaxTokens: this.resources.resolvedConfig.llm.maxTokens },
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
        requestId: params.requestId,
        sessionKey: params.sessionKey,
        turnId: params.turnId,
        signal: controller.signal,
        effectiveReference,
        contextFiles: Object.freeze([...this.resources.contextFiles]),
        registrySnapshot: snapshot,
        registerChild: () => this.registerChild(params.turnId, tree),
      });
      this.activeParentTurns.set(params.turnId, parentRecord);

      const result = await this.resources.agentRunner.run({
        requestId: params.requestId,
        sessionKey: params.sessionKey,
        message: runnerMessage,
        resolvedModel,
        systemPrompt,
        turnId: params.turnId,
        toolProjection: snapshot.tools,
        hookProjection: snapshot.hooks,
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

function freezeShutdownReport(report: RuntimeShutdownReport): RuntimeShutdownReport {
  const turns = Object.freeze({
    completedRequestIds: Object.freeze([...report.turns.completedRequestIds]),
    abortedRequestIds: Object.freeze([...report.turns.abortedRequestIds]),
    nonconvergedRequestIds: Object.freeze([...report.turns.nonconvergedRequestIds]),
    queuedCancelledRequestIds: Object.freeze([...report.turns.queuedCancelledRequestIds]),
    protectedGenerations: Object.freeze([...report.turns.protectedGenerations]),
  });
  const instanceStops = Object.freeze({
    completedInstanceIds: Object.freeze([...report.instanceStops.completedInstanceIds]),
    failedInstanceIds: Object.freeze([...report.instanceStops.failedInstanceIds]),
    pendingInstanceIds: Object.freeze([...report.instanceStops.pendingInstanceIds]),
    skippedProtectedInstanceIds: Object.freeze([
      ...report.instanceStops.skippedProtectedInstanceIds,
    ]),
  });
  return Object.freeze({
    ...report,
    completed: Object.freeze([...report.completed]),
    failed: Object.freeze(report.failed.map((entry) => Object.freeze({ ...entry }))),
    turns,
    instanceStops,
    residuals: Object.freeze(report.residuals.map((entry) => Object.freeze({
      ...entry,
      ...(entry.blockingTurnIds
        ? { blockingTurnIds: Object.freeze([...entry.blockingTurnIds]) }
        : {}),
    }))),
  });
}
