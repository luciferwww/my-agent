import { AgentRunner } from '../agent-runner/index.js';
import { loadConfig, resolveAgentConfig } from '../config/index.js';
import { AnthropicClient } from '../llm-client/index.js';
import { MemoryManager } from '../memory/index.js';
import { SystemPromptBuilder, UserPromptBuilder } from '../prompt-builder/index.js';
import { SessionManager } from '../session/index.js';
import { ensureWorkspace, loadContextFiles } from '../workspace/index.js';
import { classifyRuntimeError } from './errors.js';
import { resolveContextLoadMode } from './prompt-factory.js';
import { assembleRuntimeTools, getDefaultBuiltinTools } from './tool-registry.js';
import type { RuntimeAppOptions, RuntimeBootstrapResult, RuntimeDependencies, RuntimeEvent } from './types.js';

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

    createSessionManager(workspaceDir) {
      return new SessionManager(workspaceDir);
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
  emit(options.onEvent, {
    type: 'app_start',
    workspaceDir: options.workspaceDir,
  });

  try {
    const appConfig = loadConfig({ workspaceDir: options.workspaceDir });
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

    const deps = createDefaultRuntimeDependencies(options.dependencies);
    const sessionManager = deps.createSessionManager(options.workspaceDir);
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
    } catch (error) {
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
    });

    const state = {
      phase: 'ready' as const,
      startedAt,
      readyAt: Date.now(),
      activeRunCount: 0,
      contextVersion: 1,
    };

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
    emit(options.onEvent, { type: 'error', info });
    throw error;
  }
}

function emit(onEvent: RuntimeAppOptions['onEvent'], event: RuntimeEvent): void {
  onEvent?.(event);
}