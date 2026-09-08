import { join } from 'node:path';
import { loadConfig, resolveAgentConfig } from '../platform/config/index.js';
import { ConsoleAdapter, FileAdapter, Logger } from '../platform/logger/index.js';
import type { LogAdapter } from '../platform/logger/index.js';
import type { MemoryManager } from '../core/memory/index.js';
import { UserPromptBuilder } from '../core/prompt/index.js';
import { ensureWorkspace, loadContextFiles } from '../core/workspace/index.js';
import { classifyRuntimeError } from './errors.js';
import { createApplicationToolPolicy } from './tool-approval-policy.js';
import type { RuntimeAppOptions, RuntimeBootstrapResult, RuntimeDependencies, RuntimeEvent } from './types.js';
import type { RuntimeDeadlineDriver } from './runtime-deadline.js';

const log = Logger.get('RuntimeBootstrap');

export async function bootstrapRuntime(
  options: RuntimeAppOptions,
  deps: RuntimeDependencies,
  cleanupDeadline: { readonly driver: RuntimeDeadlineDriver; readonly timeoutMs: number },
): Promise<RuntimeBootstrapResult> {
  const startedAt = Date.now();
  let loggerConfigured = false;
  let memoryManager: MemoryManager | null = null;
  log.info('bootstrap start', {
    workspaceDir: options.workspaceDir,
    agentId: options.agentId,
  });
  emit(options.onEvent, {
    type: 'app_start',
    workspaceDir: options.workspaceDir,
  });

  try {
    const appConfig = loadConfig({ workspaceDir: options.workspaceDir });

    const adapters: LogAdapter[] = [];
    if (appConfig.logger.console?.enabled !== false) {
      const consoleMin = appConfig.logger.console?.minLevel;
      adapters.push(new ConsoleAdapter(consoleMin ? { minLevel: consoleMin } : {}));
    }
    if (appConfig.logger.file?.enabled) {
      const fileCfg = appConfig.logger.file;
      adapters.push(new FileAdapter({
        // 路径固定为 <workspaceDir>/logs/；prefix / maxQueueSize 走 FileAdapter 内部默认
        dir: join(options.workspaceDir, 'logs'),
        ...(fileCfg.minLevel !== undefined ? { minLevel: fileCfg.minLevel } : {}),
      }));
    }
    await Logger.configure({
      adapters,
      minLevel: appConfig.logger.minLevel ?? 'info',
    });
    loggerConfigured = true;
    log.debug('logger configured', {
      minLevel: appConfig.logger.minLevel ?? 'info',
      adapters: adapters.map((a) => a.constructor.name),
    });

    const resolvedConfig = resolveAgentConfig(appConfig, {
      agentId: options.agentId,
      envOverrides: options.envOverrides,
      cliOverrides: options.cliOverrides,
    });

    await ensureWorkspace(options.workspaceDir);

    const contextFiles = await loadContextFiles(options.workspaceDir, {
      mode: 'full',
      maxFileChars: resolvedConfig.workspace.maxFileChars,
      maxTotalChars: resolvedConfig.workspace.maxTotalChars,
    });
    log.debug('context files loaded', {
      fileCount: contextFiles.length,
    });

    const sessionManager = deps.createSessionManager(options.workspaceDir, {
      toolResultHeadChars: resolvedConfig.compaction.toolResultHeadChars,
      toolResultTailChars: resolvedConfig.compaction.toolResultTailChars,
    });
    const systemPromptBuilder = deps.createSystemPromptBuilder();
    const userPromptBuilder = new UserPromptBuilder();

    try {
      memoryManager = await deps.createMemoryManager({
        workspaceDir: options.workspaceDir,
        enabled: resolvedConfig.memory.enabled,
        embedding: resolvedConfig.memory.embedding,
        search: resolvedConfig.memory.search,
      });
      if (memoryManager) {
        log.info('memory manager ready', { workspaceDir: options.workspaceDir });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.warn('memory init failed, continuing without memory', { error: message });
      emit(options.onEvent, {
        type: 'warning',
        info: {
          ...classifyRuntimeError('startup', error),
          code: 'MEMORY_INIT_FAILED',
          severity: 'recoverable',
        },
      });
    }

    const toolPolicy = createApplicationToolPolicy(resolvedConfig.tools);

    const agentRunner = deps.createAgentRunner({
      sessionManager,
      onEvent: options.onAgentEvent,
    });

    const state = {
      phase: 'ready' as const,
      startedAt,
      readyAt: Date.now(),
      activeRunCount: 0,
      contextVersion: 1,
    };

    log.info('bootstrap complete', {
      durationMs: Date.now() - startedAt,
      memoryEnabled: memoryManager !== null,
      contextFiles: contextFiles.length,
    });

    return {
      resources: {
        appConfig,
        resolvedConfig,
        workspaceDir: options.workspaceDir,
        sessionManager,
        toolPolicy,
        memoryManager,
        systemPromptBuilder,
        userPromptBuilder,
        contextFiles,
        agentRunner,
      },
      state,
      dependencies: deps,
    };
  } catch (error) {
    const info = classifyRuntimeError('startup', error);
    log.error('bootstrap failed', {
      code: info.code,
      message: info.message,
    });
    emit(options.onEvent, { type: 'error', info });
    if (memoryManager) {
      const cleanup = await cleanupDeadline.driver.race(
        Promise.resolve().then(() => memoryManager!.close()),
        cleanupDeadline.driver.now() + cleanupDeadline.timeoutMs,
      );
      if (cleanup.outcome === 'failed') {
        log.warn('Memory cleanup after bootstrap failure failed', {
          error: cleanup.message,
        });
      } else if (cleanup.outcome === 'deadline-exhausted') {
        log.warn('Memory cleanup after bootstrap failure timed out');
      }
    }
    if (loggerConfigured) {
      await cleanupDeadline.driver.race(
        Logger.close(),
        cleanupDeadline.driver.now() + cleanupDeadline.timeoutMs,
      );
    }
    throw error;
  }
}

function emit(onEvent: RuntimeAppOptions['onEvent'], event: RuntimeEvent): void {
  onEvent?.(event);
}