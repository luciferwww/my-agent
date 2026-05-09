import { join } from 'node:path';
import { AgentRunner } from '../core/runner/index.js';
import { loadConfig, resolveAgentConfig } from '../platform/config/index.js';
import { AnthropicClient } from '../adapters/llm/index.js';
import { ConsoleAdapter, FileAdapter, Logger } from '../platform/logger/index.js';
import type { LogAdapter } from '../platform/logger/index.js';
import { MemoryManager } from '../core/memory/index.js';
import { SystemPromptBuilder, UserPromptBuilder } from '../core/prompt/index.js';
import { SessionManager } from '../core/session/index.js';
import { ensureWorkspace, loadContextFiles } from '../core/workspace/index.js';
import { classifyRuntimeError } from './errors.js';
import { resolveContextLoadMode } from './prompt-factory.js';
import { assembleRuntimeTools, getDefaultBuiltinTools } from './tool-registry.js';
import type { RuntimeAppOptions, RuntimeBootstrapResult, RuntimeDependencies, RuntimeEvent } from './types.js';

const log = Logger.get('RuntimeBootstrap');

export function createDefaultRuntimeDependencies(
  overrides?: Partial<RuntimeDependencies>,
): RuntimeDependencies {
  const defaults: RuntimeDependencies = {
    createLLMClient(options) {
      if (!options.apiKey) {
        throw new Error('LLM API key is required to create the runtime client.');
      }

      return new AnthropicClient({
        apiKey: options.apiKey,
        baseURL: options.baseURL,
      });
    },

    createSessionManager(workspaceDir, options) {
      return new SessionManager(workspaceDir, options);
    },

    async createMemoryManager(options) {
      if (!options.enabled) {
        return null;
      }

      return MemoryManager.create({
        workspaceDir: options.workspaceDir,
        dbPath: options.dbPath,
        embedding: options.embedding,
        search: options.search,
        enabled: options.enabled,
      });
    },

    createSystemPromptBuilder() {
      return new SystemPromptBuilder();
    },

    createAgentRunner(config) {
      return new AgentRunner(config);
    },

    getBuiltinTools(options) {
      return getDefaultBuiltinTools(options);
    },
  };

  return {
    ...defaults,
    ...overrides,
  };
}

export async function bootstrapRuntime(options: RuntimeAppOptions): Promise<RuntimeBootstrapResult> {
  const startedAt = Date.now();
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
        dir: join(options.workspaceDir, fileCfg.dir ?? 'logs'),
        ...(fileCfg.prefix !== undefined ? { prefix: fileCfg.prefix } : {}),
        ...(fileCfg.minLevel !== undefined ? { minLevel: fileCfg.minLevel } : {}),
        ...(fileCfg.maxQueueSize !== undefined ? { maxQueueSize: fileCfg.maxQueueSize } : {}),
      }));
    }
    await Logger.configure({
      adapters,
      minLevel: appConfig.logger.minLevel ?? 'info',
    });
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
      mode: resolveContextLoadMode(resolvedConfig.prompt.mode),
      maxFileChars: resolvedConfig.workspace.maxFileChars,
      maxTotalChars: resolvedConfig.workspace.maxTotalChars,
    });
    log.debug('context files loaded', {
      fileCount: contextFiles.length,
      mode: resolvedConfig.prompt.mode,
    });

    const deps = createDefaultRuntimeDependencies(options.dependencies);
    const sessionManager = deps.createSessionManager(options.workspaceDir, {
      toolResultHeadChars: resolvedConfig.compaction.toolResultHeadChars,
      toolResultTailChars: resolvedConfig.compaction.toolResultTailChars,
    });
    const llmClient = deps.createLLMClient({
      apiKey: resolvedConfig.llm.apiKey,
      baseURL: resolvedConfig.llm.baseURL,
      defaultModel: resolvedConfig.llm.model,
      maxTokens: resolvedConfig.llm.maxTokens,
    });
    const systemPromptBuilder = deps.createSystemPromptBuilder();
    const userPromptBuilder = new UserPromptBuilder();

    let memoryManager = null;
    try {
      memoryManager = await deps.createMemoryManager({
        workspaceDir: options.workspaceDir,
        enabled: resolvedConfig.memory.enabled,
        dbPath: resolvedConfig.memory.dbPath,
        embedding: resolvedConfig.memory.embedding,
        search: resolvedConfig.memory.search,
      });
      if (memoryManager) {
        log.info('memory manager ready', { dbPath: resolvedConfig.memory.dbPath });
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

    const toolBundle = assembleRuntimeTools({
      builtinTools: deps.getBuiltinTools({
        workspaceDir: options.workspaceDir,
        webFetchEnabled: true,
        execEnabled: true,
        processEnabled: true,
      }),
      memoryManager,
    });

    const agentRunner = deps.createAgentRunner({
      llmClient,
      sessionManager,
      toolExecutor: toolBundle.executor,
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
      tools: toolBundle.tools.length,
      memoryEnabled: memoryManager !== null,
      contextFiles: contextFiles.length,
    });
    emit(options.onEvent, {
      type: 'app_ready',
      workspaceDir: options.workspaceDir,
      contextVersion: state.contextVersion,
      toolNames: toolBundle.tools.map((tool) => tool.name),
      memoryEnabled: memoryManager !== null,
    });

    return {
      resources: {
        appConfig,
        resolvedConfig,
        workspaceDir: options.workspaceDir,
        sessionManager,
        llmClient,
        memoryManager,
        systemPromptBuilder,
        userPromptBuilder,
        toolBundle,
        contextFiles,
        agentRunner,
      },
      state,
    };
  } catch (error) {
    const info = classifyRuntimeError('startup', error);
    log.error('bootstrap failed', {
      code: info.code,
      message: info.message,
    });
    emit(options.onEvent, { type: 'error', info });
    throw error;
  }
}

function emit(onEvent: RuntimeAppOptions['onEvent'], event: RuntimeEvent): void {
  onEvent?.(event);
}