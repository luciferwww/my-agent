import { join } from 'node:path';
import {
  createDefaultAgentConfig,
  getEnvOverrides,
  resolveAgentConfig,
} from '../platform/config/index.js';
import { DEFAULT_RUNNER_CONFIG } from '../core/runner/config.js';
import { DEFAULT_RUNTIME_CONFIG } from './config.js';
import type { AppConfig } from '../platform/config/types.js';
import {
  ConsoleAdapter,
  DEFAULT_LOGGER_CONFIG,
  FileAdapter,
  Logger,
} from '../platform/logger/index.js';
import type { LogAdapter } from '../platform/logger/index.js';
import type { MemoryManager } from '../core/memory/index.js';
import { UserPromptBuilder } from '../core/prompt/index.js';
import { ensureAgentContext, loadContextFiles } from '../core/agent-context/index.js';
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
    agentHome: options.agentHome,
    agentId: options.agentId,
  });
  emit(options.onEvent, {
    type: 'app_start',
    agentHome: options.agentHome,
  });

  try {
    const applicationConfig = deepFreeze(structuredClone(
      options.startupContext?.configuration.application
      ?? options.applicationConfig
      ?? {
        llm: {},
        runtime: DEFAULT_RUNTIME_CONFIG,
        runner: DEFAULT_RUNNER_CONFIG,
        agents: {
          defaults: createDefaultAgentConfig(),
          list: [],
        },
        logger: DEFAULT_LOGGER_CONFIG,
      },
    ));
    const appConfig: AppConfig = {
      agentHome: options.agentHome,
      llm: applicationConfig.llm,
      runtime: applicationConfig.runtime,
      runner: applicationConfig.runner,
      agents: applicationConfig.agents,
      logger: applicationConfig.logger,
    };

    const adapters: LogAdapter[] = [];
    if (appConfig.logger.console?.enabled !== false) {
      const consoleMin = appConfig.logger.console?.minLevel;
      adapters.push(new ConsoleAdapter(consoleMin ? { minLevel: consoleMin } : {}));
    }
    if (appConfig.logger.file?.enabled) {
      const fileCfg = appConfig.logger.file;
      adapters.push(new FileAdapter({
        // Agent Home owns the log directory; FileAdapter owns the remaining defaults.
        dir: join(options.agentHome, 'logs'),
        ...(fileCfg.minLevel !== undefined ? { minLevel: fileCfg.minLevel } : {}),
      }));
    }
    await Logger.configure({
      adapters,
      minLevel: appConfig.logger.minLevel ?? DEFAULT_LOGGER_CONFIG.minLevel,
    });
    loggerConfigured = true;
    log.debug('logger configured', {
      minLevel: appConfig.logger.minLevel ?? DEFAULT_LOGGER_CONFIG.minLevel,
      adapters: adapters.map((a) => a.constructor.name),
    });

    const resolvedConfig = resolveAgentConfig(appConfig, {
      agentId: options.agentId,
      envOverrides: options.envOverrides
        ?? (options.startupContext === undefined
          ? undefined
          : getEnvOverrides(options.startupContext.environment)),
      cliOverrides: options.cliOverrides,
    });

    const acquiredUnits = options.startupContext === undefined
      ? Object.freeze([])
      : (await deps.acquireExtensions({
          extensionsDir: join(options.startupContext.installDir, 'extensions'),
          extensionsConfig: options.startupContext.configuration.extensions,
          environment: options.startupContext.environment,
        })).loadedUnits;

    await ensureAgentContext(options.agentHome);

    const contextFiles = await loadContextFiles(options.agentHome, {
      mode: 'full',
      maxFileChars: resolvedConfig.context.maxFileChars,
      maxTotalChars: resolvedConfig.context.maxTotalChars,
    });
    log.debug('context files loaded', {
      fileCount: contextFiles.length,
    });

    const sessionManager = deps.createSessionManager(options.agentHome, {
      toolResultHeadChars: resolvedConfig.compaction.toolResultHeadChars,
      toolResultTailChars: resolvedConfig.compaction.toolResultTailChars,
    });
    await sessionManager.initialize();
    const systemPromptBuilder = deps.createSystemPromptBuilder();
    const userPromptBuilder = new UserPromptBuilder();

    try {
      memoryManager = await deps.createMemoryManager({
        agentHome: options.agentHome,
        enabled: resolvedConfig.memory.enabled,
        embedding: resolvedConfig.memory.embedding,
        chunking: resolvedConfig.memory.chunking,
        search: resolvedConfig.memory.search,
      });
      if (memoryManager) {
        log.info('memory manager ready', { agentHome: options.agentHome });
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

    const toolPolicy = createApplicationToolPolicy(resolvedConfig.tools, options.agentHome);

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
        runtimeConfig: appConfig.runtime,
        runnerConfig: appConfig.runner,
        resolvedConfig,
        agentHome: options.agentHome,
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
      acquiredUnits,
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

function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}