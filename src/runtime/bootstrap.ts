import { join } from 'node:path';
import { AgentRunner } from '../core/runner/index.js';
import { ModelResolver } from '../core/model-resolution/index.js';
import { loadConfig, resolveAgentConfig } from '../platform/config/index.js';
import { AnthropicProvider } from '../adapters/llm/index.js';
import { createLegacyStaticModelResolver } from '../compat/model-resolution/legacy-static-config.js';
import { ConsoleAdapter, FileAdapter, Logger } from '../platform/logger/index.js';
import type { LogAdapter } from '../platform/logger/index.js';
import { MemoryManager } from '../core/memory/index.js';
import { SystemPromptBuilder, UserPromptBuilder } from '../core/prompt/index.js';
import { SessionManager } from '../core/session/index.js';
import { ensureWorkspace, loadContextFiles, loadContextFilesFromDir } from '../core/workspace/index.js';
import { classifyRuntimeError } from './errors.js';
import { stageRegistryCandidate } from './registry-builder.js';
import {
  activateRegistryChannels,
  type ChannelLifecycleSet,
} from './channel-lifecycle.js';
import { createApplicationToolPolicy } from './tool-approval-policy.js';
import {
  createMemoryToolModule,
  createTaskToolModule,
  createWorkspaceToolModule,
} from '../runtime-modules/index.js';
import { SubagentExecutor } from '../core/subagent/SubagentExecutor.js';
import {
  buildGeneralPurposeProfile,
  loadSubagentProfiles,
  resolveSubagentCapabilities,
  resolveSubagentTools,
} from '../core/subagent/index.js';
import type { SubagentProfile } from '../core/subagent/types.js';
import { createSubagentDelegationPort } from './subagent-orchestration.js';
import type { ActiveParentTurn } from './subagent-orchestration.js';
import type { MessageRouteContext } from './queue-types.js';
import type { ChannelRuntimeHost } from '../core/channel/index.js';
import type { RegistrySnapshot } from '../core/registry/index.js';
import type { RuntimeAppOptions, RuntimeBootstrapResult, RuntimeDependencies, RuntimeEvent } from './types.js';

const log = Logger.get('RuntimeBootstrap');

export function createDefaultRuntimeDependencies(
  overrides?: Partial<RuntimeDependencies>,
): RuntimeDependencies {
  const defaults: RuntimeDependencies = {
    createProviderProjection(options) {
      const provider = new AnthropicProvider({
        apiKey: options.apiKey,
        baseURL: options.baseURL,
        defaultModel: options.defaultModel,
        legacyContextWindowTokens: options.legacyContextWindowTokens,
        deploymentFacts: options.deploymentFacts,
      });
      return Object.freeze([provider.entry]);
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

    getBuiltinContributionUnits(options, memoryManager) {
      return Object.freeze([
        createWorkspaceToolModule({
          workspaceDir: options.workspaceDir,
          fsWorkspaceOnly: options.fsWorkspaceOnly ?? true,
          webFetchEnabled: options.webFetchEnabled ?? true,
          execEnabled: options.execEnabled ?? true,
          processEnabled: options.processEnabled ?? true,
        }),
        ...(memoryManager ? [createMemoryToolModule(memoryManager)] : []),
      ]);
    },
  };

  return {
    ...defaults,
    ...overrides,
  };
}

export async function bootstrapRuntime(
  options: RuntimeAppOptions,
  channelHost: ChannelRuntimeHost,
): Promise<RuntimeBootstrapResult> {
  const startedAt = Date.now();
  let channelLifecycle: ChannelLifecycleSet | undefined;
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

    const deps = createDefaultRuntimeDependencies(options.dependencies);
    const sessionManager = deps.createSessionManager(options.workspaceDir, {
      toolResultHeadChars: resolvedConfig.compaction.toolResultHeadChars,
      toolResultTailChars: resolvedConfig.compaction.toolResultTailChars,
    });
    const providerProjection = Object.freeze([...deps.createProviderProjection({
      apiKey: resolvedConfig.llm.apiKey,
      baseURL: resolvedConfig.llm.baseURL,
      defaultModel: resolvedConfig.llm.model,
      legacyContextWindowTokens: resolvedConfig.llm.contextWindowTokens,
      deploymentFacts: resolvedConfig.llm.deploymentFacts,
    })]);
    const defaultProviderId = providerProjection[0]?.id;
    if (!defaultProviderId) {
      throw new Error('Provider projection must contain at least one accepted Provider entry.');
    }
    const modelResolver = new ModelResolver(providerProjection);
    const resolveParentModel = createLegacyStaticModelResolver({
      resolver: modelResolver,
      defaultProviderId,
      defaultModel: resolvedConfig.llm.model,
      defaultMaxTokens: resolvedConfig.llm.maxTokens,
    });
    const systemPromptBuilder = deps.createSystemPromptBuilder();
    const userPromptBuilder = new UserPromptBuilder();

    let memoryManager = null;
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

    const toolOptions = {
      workspaceDir: options.workspaceDir,
      fsWorkspaceOnly: resolvedConfig.tools.fs?.workspaceOnly ?? true,
      webFetchEnabled: true,
      execEnabled: true,
      processEnabled: true,
    };
    const runtimeContributionUnits = [
      ...deps.getBuiltinContributionUnits(toolOptions, memoryManager),
      ...(options.contributionUnits ?? []),
    ];
    const toolPolicy = createApplicationToolPolicy(resolvedConfig.tools);

    const agentRunner = deps.createAgentRunner({
      sessionManager,
      onEvent: options.onAgentEvent,
    });

    const activeParentTurns = new Map<string, ActiveParentTurn>();
    const routeContextByTurn = new Map<string, MessageRouteContext>();
    const generalPurpose = buildGeneralPurposeProfile(options.workspaceDir);
    const subagentProfiles = new Map<string, SubagentProfile>([
      [generalPurpose.id, generalPurpose],
    ]);
    let registrySnapshot: RegistrySnapshot;

    const subagentExecutor = new SubagentExecutor({
      agentRunner,
      systemPromptBuilder,
      loadContextFilesFromDir: (absDir) =>
        loadContextFilesFromDir(absDir, {
          maxFileChars: resolvedConfig.workspace.maxFileChars,
          maxTotalChars: resolvedConfig.workspace.maxTotalChars,
        }),
      workspaceDir: options.workspaceDir,
      promptSafetyLevel: resolvedConfig.prompt?.safetyLevel ?? 'normal',
      getToolProjection: () => registrySnapshot.tools,
      getHookProjection: () => registrySnapshot.hooks,
      resolveToolPolicy: (profile) => createApplicationToolPolicy(resolveSubagentTools(
        profile,
        resolvedConfig.tools.allow ?? [],
        resolvedConfig.tools.deny ?? [],
      )),
    });
    const delegationPort = createSubagentDelegationPort({
      activeParents: activeParentTurns,
      routeContextByTurn,
      sessionManager,
      modelResolver,
      defaultProviderId,
      defaultMaxTokens: resolvedConfig.llm.maxTokens,
      maxDepth: resolvedConfig.subagents?.maxDepth ?? 1,
      executor: subagentExecutor,
      onEvent: options.onAgentEvent ?? (() => {}),
    });

    if (resolvedConfig.subagents?.enabled !== false) {
      runtimeContributionUnits.push(createTaskToolModule({
        delegationPort,
        profileRegistry: subagentProfiles,
        getCapabilities: (sessionKey) =>
          resolveSubagentCapabilities(
            sessionKey,
            resolvedConfig.subagents?.maxDepth ?? 1,
          ),
        maxDepth: resolvedConfig.subagents?.maxDepth ?? 1,
      }));
    }

    const candidate = stageRegistryCandidate({
      providers: providerProjection,
      units: runtimeContributionUnits,
    });
    const activated = await activateRegistryChannels({ candidate, host: channelHost });
    channelLifecycle = activated.lifecycle;
    registrySnapshot = activated.snapshot;
    const registeredToolNames = new Set(
      registrySnapshot.tools.definitions.map((tool) => tool.name),
    );
    for (const profile of loadSubagentProfiles(
      resolvedConfig.subagents?.list ?? [],
      options.workspaceDir,
      registeredToolNames,
    )) {
      subagentProfiles.set(profile.id, profile);
    }

    const state = {
      phase: 'ready' as const,
      startedAt,
      readyAt: Date.now(),
      activeRunCount: 0,
      contextVersion: 1,
    };

    log.info('bootstrap complete', {
      durationMs: Date.now() - startedAt,
      tools: registrySnapshot.tools.definitions.length,
      channels: registrySnapshot.channels.bindings.map((channel) => channel.id),
      memoryEnabled: memoryManager !== null,
      contextFiles: contextFiles.length,
    });

    for (const diagnostic of registrySnapshot.diagnostics) {
      if (!diagnostic.code.startsWith('CHANNEL_')) continue;
      const code = diagnostic.code === 'CHANNEL_CREATE_FAILED'
        ? 'CHANNEL_CREATE_FAILED'
        : diagnostic.code === 'CHANNEL_ROLLBACK_FAILED'
          ? 'CHANNEL_ROLLBACK_FAILED'
          : 'CHANNEL_START_FAILED';
      emit(options.onEvent, {
        type: 'warning',
        info: {
          scope: 'startup',
          severity: 'warning',
          code,
          message: diagnostic.message,
          unitId: diagnostic.unitId,
          contributionId: diagnostic.contributionId,
          phase: diagnostic.phase,
        },
      });
    }

    return {
      resources: {
        appConfig,
        resolvedConfig,
        workspaceDir: options.workspaceDir,
        sessionManager,
        registrySnapshot,
        toolPolicy,
        modelResolver,
        defaultProviderId,
        resolveParentModel,
        memoryManager,
        systemPromptBuilder,
        userPromptBuilder,
        contextFiles,
        agentRunner,
      },
      state,
      subagentProfiles,
      activeParentTurns,
      routeContextByTurn,
      channelCompletionObserver: activated.lifecycle,
      channelShutdownHandoff: activated.lifecycle,
    };
  } catch (error) {
    if (channelLifecycle) {
      const report = await channelLifecycle.runtimeConverged();
      for (const failure of report.failed) {
        log.warn('channel cleanup after bootstrap failure failed', {
          channelId: failure.channelId,
          error: failure.message,
        });
      }
    }
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