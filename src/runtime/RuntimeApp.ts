import { randomUUID } from 'node:crypto';
import type { AgentEvent } from '../agent-runner/index.js';
import { ApprovalManager } from '../channel/ApprovalManager.js';
import type { Channel, ChannelRunRequest } from '../channel/types.js';
import { loadContextFiles } from '../workspace/index.js';
import type { ContextFile } from '../workspace/types.js';
import { bootstrapRuntime } from './bootstrap.js';
import { classifyRuntimeError, createRuntimeError } from './errors.js';
import { buildSystemPromptParams, resolveContextLoadMode } from './prompt-factory.js';
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

export class RuntimeApp {
  private readonly onEvent?: RuntimeAppOptions['onEvent'];
  private readonly inFlightRuns = new Set<Promise<unknown>>();
  /** Per-session 串行 gate：同一 sessionKey 同时只允许一个 turn。跨 session 可并发 */
  private readonly inFlightSessions = new Set<string>();

  // ── Channel 层 ──────────────────────────────────────────────────
  /** 与 bootstrap fanout 闭包共享引用：registerChannel 后注册的新 channel 实时可见 */
  private readonly channels: Channel[];
  private readonly approvalManager: ApprovalManager;
  /** turnId → 起源 channel，approval 路由用 */
  private readonly originChannelByTurn = new Map<string, Channel>();
  /** turnId → 起源 client（WebSocketChannel 用此字段定向） */
  private readonly originClientByTurn = new Map<string, string>();
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
    this.approvalManager = new ApprovalManager();
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
          // channel.send 抛错不应中断事件分发；记录到 stderr 即可
          // eslint-disable-next-line no-console
          console.error(`[RuntimeApp] channel ${channel.id} send failed:`, err);
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
   * 注册 channel，绑定 onMessage 与（如有）onApprovalDecision。
   * 须在 startChannels() 前调用；多次调用支持注册多个 channel。
   */
  registerChannel(channel: Channel): void {
    this.assertNotClosed();
    this.channels.push(channel);
    channel.onMessage(this.makeMessageHandler(channel));
    channel.approval?.onApprovalDecision((id, decision) => {
      this.approvalManager.resolve(id, decision);
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
    await Promise.all(this.channels.map((c) => c.start()));
  }

  /** 依次调用所有已注册 channel 的 stop()；幂等 */
  async stopChannels(): Promise<void> {
    await Promise.allSettled(this.channels.map((c) => c.stop()));
  }

  // ── Approval 路由（详见 channel-design.md §4.3）────────────────────

  /**
   * 启动时调用一次。仅在至少一个 channel 提供 approval 能力时才注册 hook，
   * 否则库模式所有 tool 调用直通。
   */
  private wireApprovalRouting(): void {
    if (this.approvalRoutingWired) return;
    if (!this.channels.some((c) => c.approval)) return;
    this.approvalRoutingWired = true;

    // ① hook → ApprovalManager
    this.resources.agentRunner.on(
      'before_tool_call',
      async ({ toolName, input, turnId, sessionKey }) => {
        const result = await this.approvalManager.request({
          toolName,
          input,
          sessionKey,
          turnId,
          originClientId: this.originClientByTurn.get(turnId),
        });
        return result.decision === 'allow'
          ? { action: 'allow' as const }
          : {
              action: 'deny' as const,
              reason: result.reason === 'timeout' ? 'Denied by timeout' : 'Denied by user',
            };
      },
    );

    // ② ApprovalManager → 起源 channel
    this.approvalManager.onRequest((request) => {
      const originChannel = this.originChannelByTurn.get(request.turnId);
      if (!originChannel?.approval) return;  // 起源不可达：让 ApprovalManager 走超时
      originChannel.approval.sendApprovalRequest(request);
    });

    this.approvalManager.onExpire((request) => {
      const originChannel = this.originChannelByTurn.get(request.turnId);
      originChannel?.approval?.sendApprovalExpired(request);
    });
  }

  /** 每个 channel 一份消息处理器，闭包绑定 channel 自身用于路由表登记 */
  private makeMessageHandler(channel: Channel) {
    return async (req: ChannelRunRequest) => {
      const turnId = randomUUID();
      this.originChannelByTurn.set(turnId, channel);
      if (req.clientId) this.originClientByTurn.set(turnId, req.clientId);
      try {
        await this.runTurn({
          sessionKey: req.sessionKey,
          message: req.message,
          model: req.model,
          maxTokens: req.maxTokens,
          maxToolRounds: req.maxToolRounds,
          turnId,
        });
      } finally {
        this.originChannelByTurn.delete(turnId);
        this.originClientByTurn.delete(turnId);
      }
    };
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
    const runPromise = this.runTurnInternal({ ...params, turnId });
    this.inFlightRuns.add(runPromise);

    try {
      const result = await runPromise;
      this.emit({
        type: 'turn_end',
        sessionKey: params.sessionKey,
        result,
      });
      return result;
    } catch (error) {
      const info = classifyRuntimeError('run', error);
      this.recordError('run', info);
      throw createRuntimeError(info);
    } finally {
      this.inFlightRuns.delete(runPromise);
      this.inFlightSessions.delete(params.sessionKey);
      this.state.activeRunCount = Math.max(0, this.state.activeRunCount - 1);
      this.state.lastRunEndedAt = Date.now();
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

    this.emit({ type: 'shutdown_start', reason });
    this.setPhase('closing');

    this.closePromise = (async () => {
      const startedAt = Date.now();
      const completed: string[] = [];
      const failed: Array<{ resource: string; message: string }> = [];

      try {
        await Promise.allSettled([...this.inFlightRuns]);

        // 先停 channel（阻塞循环退出），再关 approvalManager 和其他 disposable
        await this.stopChannels();
        completed.push('channels');

        this.approvalManager.close();
        completed.push('approvalManager');

        for (const [name, disposable] of this.collectDisposables()) {
          try {
            await Promise.resolve(disposable.close());
            completed.push(name);
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            failed.push({ resource: name, message });
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
        this.emit({ type: 'shutdown_end', report });
        return report;
      } catch (error) {
        const info = classifyRuntimeError('shutdown', error);
        this.recordError('shutdown', info);
        this.setPhase('failed');
        throw createRuntimeError(info);
      }
    })();

    return this.closePromise;
  }

  // ── 内部辅助 ──────────────────────────────────────────────────────

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
      maxToolRounds: params.maxToolRounds ?? this.resources.resolvedConfig.runner.maxToolRounds,
      maxFollowUpRounds:
        params.maxFollowUpRounds ?? this.resources.resolvedConfig.runner.maxFollowUpRounds,
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
