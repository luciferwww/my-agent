import { randomUUID } from 'node:crypto';
import type { AgentEvent } from '../core/runner/index.js';
import type { ChatMessage } from '../adapters/llm/types.js';
import { TurnInteractionManager } from '../adapters/channel/TurnInteractionManager.js';
import type {
  ApprovalInteractionRequest,
  Channel,
  ChannelRunRequest,
  TurnInteractionResponse,
} from '../adapters/channel/types.js';
import { Logger } from '../platform/logger/index.js';
import { loadContextFiles } from '../core/workspace/index.js';
import type { ContextFile } from '../core/workspace/types.js';
import { bootstrapRuntime } from './bootstrap.js';
import { classifyRuntimeError, createRuntimeError } from './errors.js';
import { buildSystemPromptParams, resolveContextLoadMode } from './prompt-factory.js';
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

  // ── Channel 层 ──────────────────────────────────────────────────
  /** 与 bootstrap fanout 闭包共享引用：registerChannel 后注册的新 channel 实时可见 */
  private readonly channels: Channel[];
  private readonly turnInteractionManager: TurnInteractionManager;
  /** turnId → 交互路由上下文；当前最小实现仍用 channel 引用加 originClientId 做定向。 */
  private readonly routeContextByTurn = new Map<string, MessageRouteContext>();
  private approvalRoutingWired = false;
  private channelsStarted = false;

  private closePromise?: Promise<RuntimeShutdownReport>;
  private shutdownReport?: RuntimeShutdownReport;

  private constructor(
    private readonly resources: RuntimeResourceSet,
    private state: RuntimeLifecycleState,
    channels: Channel[],
    onEvent?: RuntimeAppOptions['onEvent'],
  ) {
    this.channels = channels;
    this.onEvent = onEvent;
    this.turnInteractionManager = new TurnInteractionManager();
  }

  static async create(options: RuntimeAppOptions): Promise<RuntimeApp> {
    // 与未来 RuntimeApp 实例共享的可变数组：registerChannel 后填充，fanout 实时读取
    const channels: Channel[] = [];
    const userObserver = options.onAgentEvent;

    const fanout = (event: AgentEvent) => {
      for (const channel of channels) {
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
      userObserver?.(event);
    };

    const { resources, state } = await bootstrapRuntime({
      ...options,
      onAgentEvent: fanout,
    });

    return new RuntimeApp(resources, state, channels, options.onEvent);
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
    return this.resources.toolBundle.tools.map((tool) => tool.name);
  }

  // ── Channel 注册与生命周期 ────────────────────────────────────────

  /**
   * 注册 channel，绑定 onMessage 与（如有）interaction / approval 响应处理器。
   * 须在 startChannels() 前调用；多次调用支持注册多个 channel。
   */
  registerChannel(channel: Channel): void {
    this.assertNotClosed();
    this.channels.push(channel);
    channel.onMessage(this.makeMessageHandler(channel));
    channel.interaction?.onInteractionResponse((response) => {
      this.handleInteractionResponse(response);
    });
    channel.approval?.onApprovalDecision((id, decision) => {
      this.turnInteractionManager.resolve(id, decision);
    });
    log.info('channel registered', {
      channelId: channel.id,
      hasInteraction: !!channel.interaction,
      hasApproval: !!channel.approval,
      total: this.channels.length,
    });
  }

  /**
   * 依次启动所有已注册 channel。先调 wireApprovalRouting() 把 hook 装上，
   * 再依次调 channel.start()。
   *
   * 注意：CliChannel.start() 是阻塞的（readline 循环），多 channel 启动应并行；
   * 这里使用 Promise.all 让阻塞 channel 不阻塞其他 channel 的启动。
   */
  async startChannels(): Promise<void> {
    if (this.channelsStarted) return;
    this.channelsStarted = true;
    this.wireApprovalRouting();
    log.info('starting channels', {
      count: this.channels.length,
      approvalWired: this.approvalRoutingWired,
      channelIds: this.channels.map((channel) => channel.id),
    });
    await Promise.all(this.channels.map((c) => c.start()));
  }

  /** 依次调用所有已注册 channel 的 stop()；幂等 */
  async stopChannels(): Promise<void> {
    log.info('stopping channels', {
      count: this.channels.length,
      channelIds: this.channels.map((channel) => channel.id),
    });

    const results = await Promise.allSettled(this.channels.map((c) => c.stop()));
    const failed = results.filter((result) => result.status === 'rejected').length;

    log.info('channels stopped', {
      count: this.channels.length,
      failed,
    });
  }

  // ── Approval 路由（详见 channel-design.md §4.3）────────────────────

  /**
   * 启动时调用一次。仅在至少一个 channel 提供 interaction/approval 能力时才注册 hook，
   * 否则库模式所有 tool 调用直通。
   */
  private wireApprovalRouting(): void {
    if (this.approvalRoutingWired) return;
    if (!this.channels.some((c) => c.interaction || c.approval)) return;
    this.approvalRoutingWired = true;

    // ① hook → TurnInteractionManager
    this.resources.agentRunner.on(
      'before_tool_call',
      async ({ toolName, input, turnId, sessionKey }) => {
        const result = await this.turnInteractionManager.request({
          toolName,
          input,
          sessionKey,
          turnId,
          originClientId: this.routeContextByTurn.get(turnId)?.originClientId,
        });
        return result.decision === 'allow'
          ? { action: 'allow' as const }
          : {
              action: 'deny' as const,
              reason: result.reason === 'timeout' ? 'Denied by timeout' : 'Denied by user',
            };
      },
    );

    // ② TurnInteractionManager → 起源 channel
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
        return;  // 起源不可达：让 TurnInteractionManager 走超时
      }

      log.info('routing interaction request to origin channel', {
        interactionId: request.id,
        toolName: request.toolName,
        turnId: request.turnId,
        sessionKey: request.sessionKey,
        originClientId: request.originClientId,
        channelId: originChannel.id,
        route: originChannel.interaction ? 'interaction' : 'approval',
      });

      if (originChannel.interaction) {
        const interactionRequest: ApprovalInteractionRequest = {
          ...request,
          kind: 'approval',
        };
        originChannel.interaction.sendInteractionRequest(interactionRequest);
        return;
      }

      originChannel.approval?.sendApprovalRequest(request);
    });

    this.turnInteractionManager.onExpire((request) => {
      const originChannel = this.routeContextByTurn.get(request.turnId)?.originChannel;
      if (!originChannel) {
        log.warn('interaction expiry has no origin channel', {
          interactionId: request.id,
          toolName: request.toolName,
          turnId: request.turnId,
          sessionKey: request.sessionKey,
          originClientId: request.originClientId,
        });
        return;
      }

      log.info('routing interaction expiry to origin channel', {
        interactionId: request.id,
        toolName: request.toolName,
        turnId: request.turnId,
        sessionKey: request.sessionKey,
        originClientId: request.originClientId,
        channelId: originChannel.id,
        route: originChannel.interaction ? 'interaction' : 'approval',
      });

      if (originChannel?.interaction) {
        const interactionRequest: ApprovalInteractionRequest = {
          ...request,
          kind: 'approval',
        };
        originChannel.interaction.sendInteractionExpired(interactionRequest);
        return;
      }

      originChannel?.approval?.sendApprovalExpired(request);
    });
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

    this.turnInteractionManager.resolve(response.id, 'deny');
  }

  /** 每个 channel 一份消息处理器，闭包绑定 channel 自身用于路由表登记 */
  private makeMessageHandler(channel: Channel) {
    return async (req: ChannelRunRequest) => {
      log.info('channel message received', {
        channelId: channel.id,
        clientId: req.clientId,
        sessionKey: req.sessionKey,
        hasModelOverride: req.model !== undefined,
        hasMaxTokens: req.maxTokens !== undefined,
        hasMaxLlmCalls: req.maxLlmCalls !== undefined,
        messageChars: req.message.length,
      });

      await this.handleInboundChannelMessage(channel, req);
    };
  }

  /**
   * Channel 入站统一先过 runtime intake。
   * 这里先做最小分流：命中 steering 条件则附着到当前 turn，否则进入普通消息队列。
   */
  private async handleInboundChannelMessage(
    channel: Channel,
    req: ChannelRunRequest,
  ): Promise<void> {
    if (this.shouldRouteMessageToSteering(req.sessionKey)) {
      this.enqueueSteeringInput(req.sessionKey, req.message, this.buildMessageRouteContext(channel, req));
      log.info('channel message routed to steering', {
        channelId: channel.id,
        clientId: req.clientId,
        sessionKey: req.sessionKey,
        messageChars: req.message.length,
      });
      return;
    }

    const queuedTurn: QueuedChannelTurn = {
      sessionKey: req.sessionKey,
      message: req.message,
      launchContext: this.buildTurnLaunchContext(req),
      routeContext: this.buildMessageRouteContext(channel, req),
    };

    this.enqueueQueuedTurn(queuedTurn);
    log.info('channel message enqueued', {
      channelId: channel.id,
      clientId: req.clientId,
      sessionKey: req.sessionKey,
      queueLength: this.messageQueueBySession.get(req.sessionKey)?.length ?? 0,
      messageChars: req.message.length,
    });

    const started = this.scheduleNextQueuedTurn(req.sessionKey);
    if (started) {
      await started;
    }
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

  private buildMessageRouteContext(channel: Channel, req: ChannelRunRequest): MessageRouteContext {
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
        model: item.launchContext?.model,
        maxTokens: item.launchContext?.maxTokens,
        maxLlmCalls: item.launchContext?.maxLlmCalls,
        turnId,
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
      messageChars: params.message.length,
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

  async reloadContextFiles(): Promise<ContextFile[]> {
    this.assertCanReload();

    try {
      const nextFiles = await loadContextFiles(this.resources.workspaceDir, {
        mode: resolveContextLoadMode(this.resources.resolvedConfig.prompt.mode),
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
      channels: this.channels.length,
    });
    this.emit({ type: 'shutdown_start', reason });
    this.setPhase('closing');

    this.closePromise = (async () => {
      const startedAt = Date.now();
      const completed: string[] = [];
      const failed: Array<{ resource: string; message: string }> = [];

      try {
        await Promise.allSettled([...this.inFlightRuns]);

        // 先停 channel（阻塞循环退出），再关 turnInteractionManager 和其他 disposable
        await this.stopChannels();
        completed.push('channels');

        this.turnInteractionManager.close();
        completed.push('turnInteractionManager');

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
    await this.resources.sessionManager.resolveSession(params.sessionKey);

    if (params.reloadContextFiles) {
      await this.reloadContextFiles();
    }

    const systemPrompt = this.resources.systemPromptBuilder.build(
      buildSystemPromptParams({
        config: this.resources.resolvedConfig,
        contextFiles: this.resources.contextFiles,
        promptDefinitions: this.resources.toolBundle.promptDefinitions,
        overrides: params,
      }),
    );

    const builtUserPrompt = await this.resources.userPromptBuilder.build({
      text: params.message,
    });

    const result = await this.resources.agentRunner.run({
      sessionKey: params.sessionKey,
      message: builtUserPrompt.text,
      model: this.requireModel(params.model),
      systemPrompt,
      turnId: params.turnId,
      tools: this.resources.toolBundle.llmDefinitions,
      maxTokens: params.maxTokens ?? this.resources.resolvedConfig.llm.maxTokens,
      maxLlmCalls: params.maxLlmCalls ?? this.resources.resolvedConfig.runner.maxLlmCalls,
      inTurnMessageMode:
        params.inTurnMessageMode ?? this.resources.resolvedConfig.runner.inTurnMessageMode,
      // runtime 只提供“读取并清空当前 steering inbox”的能力，具体消费时机仍由 runner 控制。
      getSteeringMessages: async () => this.drainSteeringMessages(params.sessionKey),
      compaction: this.resources.resolvedConfig.compaction,
      contextWindowTokens: this.resources.resolvedConfig.llm.contextWindowTokens,
    });

    return {
      sessionKey: params.sessionKey,
      text: result.text,
      content: result.content,
      stopReason: result.stopReason,
      usage: result.usage,
      toolRounds: result.toolRounds,
    };
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

  private requireModel(explicitModel?: string): string {
    const model = explicitModel ?? this.resources.resolvedConfig.llm.model;
    if (!model) {
      throw createRuntimeError({
        scope: 'run',
        severity: 'recoverable',
        code: 'MODEL_MISSING',
        message: 'No model was provided for this turn and no default model is configured.',
      });
    }
    return model;
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
