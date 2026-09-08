import type {
  ChannelCompletionObserver,
  ChannelRunRequest,
  ChannelRuntimeBinding,
  ChannelRuntimeHost,
  TurnInteractionResponse,
} from '../core/channel/index.js';
import type { AgentEvent } from '../core/runner/index.js';
import { AgentRunner } from '../core/runner/index.js';
import { Logger } from '../platform/logger/index.js';
import { AnthropicProvider } from '../adapters/llm/index.js';
import { MemoryManager } from '../core/memory/index.js';
import { SystemPromptBuilder } from '../core/prompt/index.js';
import { SessionManager } from '../core/session/index.js';
import { bootstrapRuntime } from './bootstrap.js';
import {
  CompositionCoordinator,
  type RuntimeSnapshotAccess,
} from './composition-coordinator.js';
import type {
  RuntimeApplication,
  RuntimeHandle,
} from './runtime-composition.js';
import type {
  RuntimeAppOptions,
  RuntimeDependencies,
  RuntimeLifecycleState,
  RuntimeResourceSet,
  RuntimeShutdownReport,
} from './types.js';
import { RuntimeLifecycleLedger } from './runtime-lifecycle.js';
import { RuntimeCompositionManager } from './runtime-composition-manager.js';
import {
  RuntimeUnitCatalog,
  createLoadedRuntimeUnit,
  type LoadedRuntimeUnit,
} from './runtime-unit.js';
import {
  buildGeneralPurposeProfile,
  loadSubagentProfiles,
  resolveSubagentCapabilities,
  resolveSubagentTools,
} from '../core/subagent/index.js';
import type { SubagentProfile } from '../core/subagent/types.js';
import { SubagentExecutor } from '../core/subagent/SubagentExecutor.js';
import { loadContextFilesFromDir } from '../core/workspace/index.js';
import { createApplicationToolPolicy } from './tool-approval-policy.js';
import {
  createMemoryToolModule,
  createTaskToolModule,
  createWorkspaceToolModule,
} from '../runtime-modules/index.js';
import { createSubagentDelegationPort } from './subagent-orchestration.js';
import type { ActiveParentTurn } from './subagent-orchestration.js';
import type { MessageRouteContext } from './queue-types.js';
import type { ExtensionRegistrationApi, RuntimeContributionUnit } from '../core/registry/index.js';
import { classifyRuntimeError } from './errors.js';
import {
  RuntimeDeadlineBudget,
  createSystemRuntimeDeadlineDriver,
  resolveRuntimeDeadlinePolicy,
} from './runtime-deadline.js';

const log = Logger.get('RuntimeBuilder');

export interface RuntimeApplicationKernel {
  readonly application: RuntimeApplication;
  onChannelMessage(binding: ChannelRuntimeBinding, request: ChannelRunRequest): Promise<void>;
  onInteractionResponse(response: TurnInteractionResponse): void;
  onInteractionUnavailable(id: string, reason: 'origin_disconnected'): void;
  querySessionsNeedingAbort(): string[];
  abortTurn(sessionKey: string): { aborted: boolean; dropped: number };
  blockingTurnIds(generation: number): readonly string[];
  abortGeneration(generation: number): readonly string[];
  channelBindingsForTurn(turnId: string): readonly ChannelRuntimeBinding[] | undefined;
  shouldDeliverAgentEvent(event: AgentEvent): boolean;
  close(reason?: string, budget?: RuntimeDeadlineBudget): Promise<RuntimeShutdownReport>;
}

export interface RuntimeApplicationKernelInput {
  readonly resources: RuntimeResourceSet;
  readonly state: RuntimeLifecycleState;
  readonly subagentProfiles: ReadonlyMap<string, SubagentProfile>;
  readonly activeParentTurns: Map<string, ActiveParentTurn>;
  readonly routeContextByTurn: Map<string, MessageRouteContext>;
  readonly onEvent?: RuntimeAppOptions['onEvent'];
  readonly channelCompletionObserver: ChannelCompletionObserver;
  readonly fanoutAgentEvent: (event: AgentEvent) => Promise<void>;
  readonly snapshotAccess: RuntimeSnapshotAccess;
}

export type RuntimeApplicationKernelFactory = (
  input: RuntimeApplicationKernelInput,
) => RuntimeApplicationKernel;

export async function buildRuntimeHandle(
  options: RuntimeAppOptions,
  createApplication: RuntimeApplicationKernelFactory,
): Promise<RuntimeHandle> {
  const lifecycleLedger = new RuntimeLifecycleLedger();
  const coordinator = new CompositionCoordinator(lifecycleLedger);
  let kernel: RuntimeApplicationKernel | undefined;
  let compositionManager: RuntimeCompositionManager | undefined;
  const userObserver = options.onAgentEvent;
  const deadlinePolicy = resolveRuntimeDeadlinePolicy(options.deadlinePolicy);
  const deadlineDriver = options.deadlineDriver ?? createSystemRuntimeDeadlineDriver();
  const pendingTerminalFanouts = new Map<
    string,
    { readonly owner: string; readonly eventType: string; readonly promise: Promise<void> }
  >();
  const fanoutFailures: Array<{ owner: string; eventType: string; message: string }> = [];
  let fanoutSequence = 0;
  const dependencies = createRuntimeDependencies(options.dependencies);

  const fanoutAgentEvent = (event: AgentEvent): Promise<void> => {
    if (kernel && !kernel.shouldDeliverAgentEvent(event)) {
      log.info('late Agent terminal event suppressed', {
        eventType: event.type,
        requestId: 'requestId' in event ? event.requestId : undefined,
      });
      return Promise.resolve();
    }
    const turnId = 'turnId' in event && typeof event.turnId === 'string'
      ? event.turnId
      : undefined;
    const channels = turnId
      ? kernel?.channelBindingsForTurn(turnId) ?? compositionManager?.currentChannelBindings() ?? []
      : compositionManager?.currentChannelBindings() ?? [];
    const deliveries: Promise<void>[] = [];
    const terminal = event.type === 'run_end' || event.type === 'request_end';
    const track = (
      owner: string,
      invoke: () => unknown,
    ): void => {
      const token = `${++fanoutSequence}:${owner}:${event.type}`;
      let operation: Promise<void>;
      try {
        operation = Promise.resolve(invoke()).then(() => undefined);
      } catch (error) {
        operation = Promise.reject(error);
      }
      const settled = operation.then(
        () => undefined,
        (error: unknown) => {
          const failure = { owner, eventType: event.type, message: messageOf(error) };
          fanoutFailures.push(failure);
          log.warn('Agent event Fanout target failed', {
            owner,
            eventType: event.type,
            error: failure.message,
          });
        },
      ).finally(() => pendingTerminalFanouts.delete(token));
      if (terminal) {
        pendingTerminalFanouts.set(token, { owner, eventType: event.type, promise: settled });
      }
      deliveries.push(settled);
    };
    for (const channel of channels) {
      track(`channel:${channel.id}`, () => channel.send(event));
    }
    if (userObserver) {
      track('observer:onAgentEvent', () => userObserver(event));
    }
    return Promise.all(deliveries).then(() => undefined);
  };

  const channelHost: ChannelRuntimeHost = Object.freeze({
    onMessage(binding: ChannelRuntimeBinding, request: ChannelRunRequest) {
      if (!kernel) {
        return Promise.reject(new Error('Runtime Channel ingress is not ready.'));
      }
      return kernel.onChannelMessage(binding, request);
    },
    onInteractionResponse(response: TurnInteractionResponse) {
      kernel?.onInteractionResponse(response);
    },
    onInteractionUnavailable(id: string, reason: 'origin_disconnected') {
      kernel?.onInteractionUnavailable(id, reason);
    },
    abortHooks: Object.freeze({
      querySessionsNeedingAbort(): string[] {
        return kernel?.querySessionsNeedingAbort() ?? [];
      },
      abortTurn(sessionKey: string) {
        return kernel?.abortTurn(sessionKey) ?? { aborted: false, dropped: 0 };
      },
    }),
  });

  const bootstrap = await bootstrapRuntime({
    ...options,
    onAgentEvent: fanoutAgentEvent,
  }, dependencies, {
    driver: deadlineDriver,
    timeoutMs: deadlinePolicy.candidateCleanupMs,
  });

  try {
    const activeParentTurns = new Map<string, ActiveParentTurn>();
    const routeContextByTurn = new Map<string, MessageRouteContext>();
    const generalPurpose = buildGeneralPurposeProfile(options.workspaceDir);
    const subagentProfiles = new Map<string, SubagentProfile>([
      [generalPurpose.id, generalPurpose],
    ]);
    const assembly = assembleLoadedRuntimeUnits({
      options,
      resources: bootstrap.resources,
      dependencies: bootstrap.dependencies,
      activeParentTurns,
      routeContextByTurn,
      subagentProfiles,
      onAgentEvent: fanoutAgentEvent,
    });
    compositionManager = new RuntimeCompositionManager(
      new RuntimeUnitCatalog(assembly.loadedUnits),
      coordinator,
      lifecycleLedger,
      channelHost,
      {
        candidateCleanupTimeoutMs: deadlinePolicy.candidateCleanupMs,
        retirementDrainTimeoutMs: deadlinePolicy.retirementGracefulDrainMs,
        retirementAbortTimeoutMs: deadlinePolicy.retirementAbortConvergenceMs,
      },
    );
    const registrySnapshot = await compositionManager.start();
    const registeredToolNames = new Set(
      registrySnapshot.tools.definitions.map((tool) => tool.name),
    );
    for (const profile of loadSubagentProfiles(
      bootstrap.resources.resolvedConfig.subagents?.list ?? [],
      options.workspaceDir,
      registeredToolNames,
    )) {
      subagentProfiles.set(profile.id, profile);
    }
    kernel = createApplication({
      resources: { ...bootstrap.resources, defaultProviderId: assembly.defaultProviderId },
      state: bootstrap.state,
      subagentProfiles,
      activeParentTurns,
      routeContextByTurn,
      onEvent: options.onEvent,
      channelCompletionObserver: compositionManager,
      fanoutAgentEvent,
      snapshotAccess: coordinator.createSnapshotAccess(),
    });
    compositionManager.setGenerationConvergence(Object.freeze({
      blockingTurnIds: (generation: number) => kernel!.blockingTurnIds(generation),
      abortGeneration: (generation: number) => kernel!.abortGeneration(generation),
    }));
    options.onEvent?.({
      type: 'app_ready',
      workspaceDir: options.workspaceDir,
      contextVersion: bootstrap.state.contextVersion,
      toolNames: registrySnapshot.tools.definitions.map((tool) => tool.name),
      channelIds: registrySnapshot.channels.bindings.map((channel) => channel.id),
      memoryEnabled: bootstrap.resources.memoryManager !== null,
    });
    emitStartupDiagnostics(options, registrySnapshot);
  } catch (error) {
    options.onEvent?.({ type: 'error', info: classifyRuntimeError('startup', error) });
    const report = await compositionManager?.shutdown();
    for (const failure of report?.failed ?? []) {
      log.warn('Unit cleanup after Runtime application creation failure failed', {
        instanceId: failure.instanceId,
        error: failure.message,
      });
    }
    const memoryManager = bootstrap.resources.memoryManager as {
      close?: () => void | Promise<void>;
    } | null;
    if (typeof memoryManager?.close === 'function') {
      const cleanup = await deadlineDriver.race(
        Promise.resolve().then(() => memoryManager.close!()),
        deadlineDriver.now() + deadlinePolicy.candidateCleanupMs,
      );
      if (cleanup.outcome === 'failed') {
        log.warn('Memory cleanup after Runtime application creation failure failed', {
          error: cleanup.message,
        });
      } else if (cleanup.outcome === 'deadline-exhausted') {
        log.warn('Memory cleanup after Runtime application creation failure timed out');
      }
    }
    await deadlineDriver.race(
      Logger.close(),
      deadlineDriver.now() + deadlinePolicy.candidateCleanupMs,
    );
    throw error;
  }

  let closePromise: Promise<RuntimeShutdownReport> | undefined;
  const close = (reason?: string): Promise<RuntimeShutdownReport> => {
    if (closePromise) return closePromise;
    const budget = new RuntimeDeadlineBudget(deadlineDriver, deadlinePolicy);
    compositionManager!.beginShutdown(budget);
    closePromise = (async () => {
      const applicationReport = await kernel!.close(reason, budget);
      const completed = [...applicationReport.completed];
      const failed = [...applicationReport.failed];
      const residuals = [...applicationReport.residuals];

      const pendingFanouts = [...pendingTerminalFanouts.values()];
      if (pendingFanouts.length > 0) {
        const fanout = await budget.raceRemaining(Promise.allSettled(
          pendingFanouts.map((entry) => entry.promise),
        ));
        if (fanout.outcome !== 'completed') {
          for (const entry of pendingFanouts) {
            residuals.push({
              owner: 'fanout',
              phase: 'terminal-fanout',
              message: `Terminal ${entry.eventType} delivery to ${entry.owner} did not converge.`,
            });
          }
        }
      }
      for (const failure of fanoutFailures) {
        failed.push({
          resource: failure.owner,
          message: `${failure.eventType}: ${failure.message}`,
        });
      }

      const unitReport = await compositionManager!.shutdown(budget);
      completed.push(...unitReport.completed);
      failed.push(...unitReport.failed.map((failure) => ({
        resource: failure.instanceId,
        message: failure.message,
      })));
      residuals.push(...unitReport.residuals);

      const memoryManager = bootstrap.resources.memoryManager as {
        close?: () => void | Promise<void>;
      } | null;
      if (typeof memoryManager?.close === 'function') {
        if (budget.remaining() <= 0) {
          residuals.push({
            owner: 'resource',
            phase: 'memory-close',
            message: 'Memory close was not started because the shutdown deadline was exhausted.',
          });
        } else {
          const memoryClose = await budget.raceRemaining(
            Promise.resolve().then(() => memoryManager.close!()),
          );
          if (memoryClose.outcome === 'completed') {
            completed.push('memoryManager');
          } else if (memoryClose.outcome === 'failed') {
            failed.push({ resource: 'memoryManager', message: memoryClose.message });
          } else {
            residuals.push({
              owner: 'resource',
              phase: 'memory-close',
              message: 'Memory close did not converge before the shutdown deadline.',
            });
          }
        }
      }

      if (budget.remaining() > 0) {
        const loggerClose = await budget.raceRemaining(Logger.close());
        if (loggerClose.outcome === 'completed') completed.push('logger');
        else if (loggerClose.outcome === 'failed') {
          failed.push({ resource: 'logger', message: loggerClose.message });
        } else {
          residuals.push({
            owner: 'resource',
            phase: 'logger-close',
            message: 'Logger close did not converge before the shutdown deadline.',
          });
        }
      } else {
        residuals.push({
          owner: 'resource',
          phase: 'logger-close',
          message: 'Logger close was not started because the shutdown deadline was exhausted.',
        });
      }

      return sealShutdownReport({
        outcome: residuals.length > 0 || budget.remaining() <= 0
          ? 'deadline-exhausted'
          : applicationReport.outcome,
        reason: applicationReport.reason,
        startedAt: applicationReport.startedAt,
        finishedAt: Date.now(),
        completed,
        failed,
        turns: applicationReport.turns,
        instanceStops: {
          completedInstanceIds: unitReport.completed,
          failedInstanceIds: unitReport.failed.map((entry) => entry.instanceId),
          pendingInstanceIds: unitReport.pending,
          skippedProtectedInstanceIds: unitReport.skippedProtected,
        },
        residuals,
      });
    })();
    return closePromise;
  };

  return Object.freeze({
    application: kernel.application,
    composition: compositionManager.compositionControl(),
    close,
  });
}

function assembleLoadedRuntimeUnits(params: {
  readonly options: RuntimeAppOptions;
  readonly resources: Omit<RuntimeResourceSet, 'defaultProviderId'>;
  readonly dependencies: RuntimeDependencies;
  readonly activeParentTurns: Map<string, ActiveParentTurn>;
  readonly routeContextByTurn: Map<string, MessageRouteContext>;
  readonly subagentProfiles: Map<string, SubagentProfile>;
  readonly onAgentEvent: (event: AgentEvent) => Promise<void>;
}): {
  readonly defaultProviderId: string;
  readonly loadedUnits: readonly LoadedRuntimeUnit[];
} {
  const { options, resources, dependencies } = params;
  const providerProjection = Object.freeze([...dependencies.createProviderProjection({
    apiKey: resources.resolvedConfig.llm.apiKey,
    baseURL: resources.resolvedConfig.llm.baseURL,
    defaultModel: resources.resolvedConfig.llm.model,
    legacyContextWindowTokens: resources.resolvedConfig.llm.contextWindowTokens,
    deploymentFacts: resources.resolvedConfig.llm.deploymentFacts,
  })]);
  const defaultProviderId = providerProjection[0]?.id;
  if (!defaultProviderId) {
    throw new Error('Provider projection must contain at least one accepted Provider entry.');
  }
  const providerUnit: RuntimeContributionUnit = Object.freeze({
    id: 'builtin-provider-bindings',
    source: 'builtin',
    register(api: ExtensionRegistrationApi) {
      for (const provider of providerProjection) api.registerProvider(provider);
    },
  });
  const toolOptions = {
    workspaceDir: options.workspaceDir,
    fsWorkspaceOnly: resources.resolvedConfig.tools.fs?.workspaceOnly ?? true,
    webFetchEnabled: true,
    execEnabled: true,
    processEnabled: true,
  };
  const loadedUnits: LoadedRuntimeUnit[] = [
    createLoadedRuntimeUnit({ registration: providerUnit, required: true }),
    ...dependencies.getBuiltinContributionUnits(toolOptions, resources.memoryManager)
      .map((registration) => createLoadedRuntimeUnit({ registration, required: true })),
    ...(options.loadedUnits ?? []),
  ];

  if (resources.resolvedConfig.subagents?.enabled !== false) {
    const maxDepth = resources.resolvedConfig.subagents?.maxDepth ?? 1;
    const executor = new SubagentExecutor({
      agentRunner: resources.agentRunner,
      systemPromptBuilder: resources.systemPromptBuilder,
      loadContextFilesFromDir: (absDir) => loadContextFilesFromDir(absDir, {
        maxFileChars: resources.resolvedConfig.workspace.maxFileChars,
        maxTotalChars: resources.resolvedConfig.workspace.maxTotalChars,
      }),
      workspaceDir: options.workspaceDir,
      promptSafetyLevel: resources.resolvedConfig.prompt?.safetyLevel ?? 'normal',
      resolveToolPolicy: (profile) => createApplicationToolPolicy(resolveSubagentTools(
        profile,
        resources.resolvedConfig.tools.allow ?? [],
        resources.resolvedConfig.tools.deny ?? [],
      )),
    });
    const delegationPort = createSubagentDelegationPort({
      activeParents: params.activeParentTurns,
      routeContextByTurn: params.routeContextByTurn,
      sessionManager: resources.sessionManager,
      defaultProviderId,
      defaultMaxTokens: resources.resolvedConfig.llm.maxTokens,
      maxDepth,
      executor,
      onEvent: params.onAgentEvent,
    });
    loadedUnits.push(createLoadedRuntimeUnit({
      registration: createTaskToolModule({
        delegationPort,
        profileRegistry: params.subagentProfiles,
        getCapabilities: (sessionKey) => resolveSubagentCapabilities(sessionKey, maxDepth),
        maxDepth,
      }),
      required: true,
    }));
  }

  return Object.freeze({
    defaultProviderId,
    loadedUnits: Object.freeze(loadedUnits),
  });
}

function createRuntimeDependencies(
  overrides: Partial<RuntimeDependencies> | undefined,
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
      if (!options.enabled) return null;
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
  return { ...defaults, ...overrides };
}

function emitStartupDiagnostics(
  options: RuntimeAppOptions,
  snapshot: import('../core/registry/index.js').RegistrySnapshot,
): void {
  for (const diagnostic of snapshot.diagnostics) {
    if (!diagnostic.code.startsWith('CHANNEL_')) continue;
    const code = diagnostic.code === 'CHANNEL_CREATE_FAILED'
      ? 'CHANNEL_CREATE_FAILED'
      : diagnostic.code === 'CHANNEL_ROLLBACK_FAILED'
        ? 'CHANNEL_ROLLBACK_FAILED'
        : 'CHANNEL_START_FAILED';
    options.onEvent?.({
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
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sealShutdownReport(report: RuntimeShutdownReport): RuntimeShutdownReport {
  const completed = Object.freeze([...report.completed].sort());
  const failed = Object.freeze([...report.failed]
    .sort((left, right) => left.resource.localeCompare(right.resource))
    .map((entry) => Object.freeze({ ...entry })));
  const turns = Object.freeze({
    completedRequestIds: Object.freeze([...report.turns.completedRequestIds].sort()),
    abortedRequestIds: Object.freeze([...report.turns.abortedRequestIds].sort()),
    nonconvergedRequestIds: Object.freeze([...report.turns.nonconvergedRequestIds].sort()),
    queuedCancelledRequestIds: Object.freeze([...report.turns.queuedCancelledRequestIds].sort()),
    protectedGenerations: Object.freeze([...report.turns.protectedGenerations]
      .sort((left, right) => left - right)),
  });
  const instanceStops = Object.freeze({
    completedInstanceIds: Object.freeze([...report.instanceStops.completedInstanceIds].sort()),
    failedInstanceIds: Object.freeze([...report.instanceStops.failedInstanceIds].sort()),
    pendingInstanceIds: Object.freeze([...report.instanceStops.pendingInstanceIds].sort()),
    skippedProtectedInstanceIds: Object.freeze([
      ...report.instanceStops.skippedProtectedInstanceIds,
    ].sort()),
  });
  const residuals = Object.freeze([...report.residuals]
    .sort((left, right) => {
      const leftKey = `${left.owner}:${left.phase}:${left.generation ?? ''}:${left.requestId ?? ''}:${left.instanceId ?? ''}`;
      const rightKey = `${right.owner}:${right.phase}:${right.generation ?? ''}:${right.requestId ?? ''}:${right.instanceId ?? ''}`;
      return leftKey.localeCompare(rightKey);
    })
    .map((entry) => Object.freeze({
      ...entry,
      ...(entry.blockingTurnIds
        ? { blockingTurnIds: Object.freeze([...entry.blockingTurnIds].sort()) }
        : {}),
    })));
  return Object.freeze({ ...report, completed, failed, turns, instanceStops, residuals });
}
