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

  private closePromise?: Promise<RuntimeShutdownReport>;
  private shutdownReport?: RuntimeShutdownReport;

  private constructor(
    private readonly resources: RuntimeResourceSet,
    private state: RuntimeLifecycleState,
    onEvent?: RuntimeAppOptions['onEvent'],
  ) {
    this.onEvent = onEvent;
  }

  static async create(options: RuntimeAppOptions): Promise<RuntimeApp> {
    const { resources, state } = await bootstrapRuntime(options);
    return new RuntimeApp(resources, state, options.onEvent);
  }

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

  async runTurn(params: RunTurnParams): Promise<RunTurnResult> {
    this.assertCanRun();

    this.state.activeRunCount += 1;
    this.state.lastRunStartedAt = Date.now();
    this.setPhase('running');
    this.emit({
      type: 'turn_start',
      sessionKey: params.sessionKey,
      contextVersion: this.state.contextVersion,
    });

    // Track the active promise so close() can wait for in-flight work to settle.
    const runPromise = this.runTurnInternal(params);
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
      this.state.activeRunCount = Math.max(0, this.state.activeRunCount - 1);
      this.state.lastRunEndedAt = Date.now();

      if (this.state.phase === 'running') {
        this.setPhase('ready');
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

    this.emit({ type: 'shutdown_start', reason });
    this.setPhase('closing');

    this.closePromise = (async () => {
      const startedAt = Date.now();
      const completed: string[] = [];
      const failed: Array<{ resource: string; message: string }> = [];

      try {
        await Promise.allSettled([...this.inFlightRuns]);

        // Dispose each resource independently so one failure does not block the rest.
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

  private async runTurnInternal(params: RunTurnParams): Promise<RunTurnResult> {
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

    // 使用 userPromptBuilder 处理用户输入
    const builtUserPrompt = await this.resources.userPromptBuilder.build({
      text: params.message,
      // 可扩展：attachments/metadata 支持
    });

    const result = await this.resources.agentRunner.run({
      sessionKey: params.sessionKey,
      message: builtUserPrompt.text,
      model: this.requireModel(params.model),
      systemPrompt,
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

  private assertCanRun(): void {
    if (this.state.phase !== 'ready') {
      throw createRuntimeError({
        scope: 'run',
        severity: 'recoverable',
        code: 'RUN_REJECTED',
        message: `Cannot run when runtime phase is ${this.state.phase}.`,
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