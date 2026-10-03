import type { AppConfig, AgentDefaults, DeepPartial } from '../platform/config/types.js';
import type { ApplicationConfigProjection } from '../platform/config/types.js';
import type { AgentConfigSnapshot } from '../platform/config/agent-config-loader.js';
import type {
  ChatContentBlock,
  PresentationContentBlock,
  ReasoningPreference,
  ResolvedReasoningPolicy,
  TokenUsage,
} from '../core/model-invocation/index.js';
import type { ModelReference } from '../core/model-resolution/index.js';
import type { BuiltinLlmProviderConfig } from '../builtins/providers/builtin/index.js';
import type { MemoryManager } from '../core/memory/MemoryManager.js';
import type { SystemPromptBuilder } from '../core/prompt/SystemPromptBuilder.js';
import type { SessionManager, SessionManagerOptions } from '../core/session/SessionManager.js';
import type { RuntimeContributionUnit } from '../core/registry/index.js';
import type { ApplicationToolPolicy } from '../core/tools/types.js';
import type { ContextFile } from '../core/agent-context/types.js';
import type { AgentEvent, AgentRunner, AgentRunnerConfig } from '../core/runner/index.js';
import type { RunnerConfig } from '../core/runner/config.js';
import type { UserPromptBuilder } from '../core/prompt/UserPromptBuilder.js';
import type {
  ExtensionAcquisitionOptions,
  ExtensionAcquisitionResult,
} from '../extension/acquisition/index.js';
import type { LoadedRuntimeUnit } from './runtime-unit.js';
import type { RuntimeDeadlineDriver, RuntimeDeadlinePolicy } from './runtime-deadline.js';

export interface RuntimeResourceSet {
  readonly appConfig: AppConfig;
  readonly runnerConfig: RunnerConfig;
  readonly resolvedConfig: AgentDefaults;
  readonly agentHome: string;
  readonly sessionManager: SessionManager;
  readonly toolPolicy: ApplicationToolPolicy;
  readonly memoryManager: MemoryManager | null;
  readonly systemPromptBuilder: SystemPromptBuilder;
  readonly userPromptBuilder: UserPromptBuilder;
  contextFiles: ContextFile[];
  readonly agentRunner: AgentRunner;
  readonly managedProcessLifecycle: ManagedProcessLifecycle;
}

export interface ManagedProcessLifecycle {
  cleanupSession(sessionId: string): Promise<void>;
  shutdown(): Promise<void>;
}

export interface RuntimeMemoryOptions {
  agentHome: string;
  enabled: boolean;
  embedding?: AgentDefaults['memory']['embedding'];
  chunking?: AgentDefaults['memory']['chunking'];
  search?: AgentDefaults['memory']['search'];
}

export interface RuntimeBuiltinToolOptions {
  agentHome: string;
  webFetchEnabled?: boolean;
  execEnabled?: boolean;
  processEnabled?: boolean;
}

export interface RuntimeDependencies {
  acquireExtensions(options: ExtensionAcquisitionOptions): Promise<ExtensionAcquisitionResult>;
  createBuiltinProviderUnit(config: BuiltinLlmProviderConfig): LoadedRuntimeUnit;
  createSessionManager(agentHome: string, options?: SessionManagerOptions): SessionManager;
  createMemoryManager(options: RuntimeMemoryOptions): Promise<MemoryManager | null>;
  createSystemPromptBuilder(): SystemPromptBuilder;
  createAgentRunner(config: AgentRunnerConfig): AgentRunner;
  readonly managedProcessLifecycle: ManagedProcessLifecycle;
  getBuiltinContributionUnits(
    options: RuntimeBuiltinToolOptions,
    memoryManager: MemoryManager | null,
  ): readonly RuntimeContributionUnit[];
}

export interface RuntimeAppOptions {
  readonly agentHome: string;
  /** Generic Host startup facts consumed only during Runtime Bootstrap. */
  readonly startupContext?: Readonly<{
    installDir: string;
    configuration: AgentConfigSnapshot;
    environment: Readonly<Record<string, string | undefined>>;
  }>;
  /** Validated application projection. Omission uses hardcoded defaults without filesystem loading. */
  readonly applicationConfig?: ApplicationConfigProjection;
  readonly loadedUnits?: readonly LoadedRuntimeUnit[];
  readonly deadlinePolicy?: Partial<RuntimeDeadlinePolicy>;
  readonly deadlineDriver?: RuntimeDeadlineDriver;
  agentId?: string;
  envOverrides?: DeepPartial<AgentDefaults>;
  cliOverrides?: DeepPartial<AgentDefaults>;
  dependencies?: Partial<RuntimeDependencies>;
  onEvent?: (event: RuntimeEvent) => void;
  /**
   * Optional AgentEvent observer for telemetry and diagnostics.
   * RuntimeApp invokes it from the fanout closure alongside channel.send.
   */
  onAgentEvent?: (event: AgentEvent) => unknown;
}

export interface RunTurnParams {
  /** Root request identity allocated by Channel intake. */
  requestId: string;
  sessionId: string;
  message: string | ChatContentBlock[];
  modelReference?: ModelReference;
  reasoningPreference?: ReasoningPreference;
  reasoningPolicy?: ResolvedReasoningPolicy;
  maxLlmCalls?: number;
  /** Root Channel Turns use full prompts. */
  promptMode: 'full' | 'minimal' | 'none';
  reloadContextFiles?: boolean;
  /** Turn identity allocated when the queued message starts. */
  turnId: string;
  /**
   * `user_message.messageId` that triggered this Turn, passed internally from
   * handleInboundChannelMessage through startQueuedTurn.
   */
  originMessageId: string;
}

export interface RunTurnResult {
  sessionId: string;
  text: string;
  content: PresentationContentBlock[];
  stopReason: string;
  usage: TokenUsage;
  toolRounds: number;
}

export type RuntimeLifecyclePhase =
  | 'starting'
  | 'ready'
  | 'running'
  | 'closing'
  | 'closed'
  | 'failed';

export interface RuntimeLifecycleState {
  phase: RuntimeLifecyclePhase;
  startedAt: number;
  readyAt?: number;
  closedAt?: number;
  lastRunStartedAt?: number;
  lastRunEndedAt?: number;
  activeRunCount: number;
  contextVersion: number;
  lastError?: {
    message: string;
    at: number;
    scope: RuntimeErrorScope;
  };
}

export type RuntimeErrorScope = 'startup' | 'run' | 'reload' | 'shutdown';
export type RuntimeErrorSeverity = 'warning' | 'recoverable' | 'fatal';

export type RuntimeErrorCode =
  | 'CONFIG_INVALID'
  | 'MODEL_MISSING'
  | 'AGENT_CONTEXT_INIT_FAILED'
  | 'CONTEXT_LOAD_FAILED'
  | 'MEMORY_INIT_FAILED'
  | 'TOOL_ASSEMBLY_FAILED'
  | 'UNIT_INVALID'
  | 'UNIT_CONFLICT'
  | 'CHANNEL_CREATE_FAILED'
  | 'CHANNEL_START_FAILED'
  | 'CHANNEL_ROLLBACK_FAILED'
  | 'RUN_REJECTED'
  | 'RUN_FAILED'
  | 'SHUTDOWN_FAILED';

export interface RuntimeErrorInfo {
  scope: RuntimeErrorScope;
  severity: RuntimeErrorSeverity;
  code: RuntimeErrorCode;
  message: string;
  unitId?: string;
  contributionId?: string;
  phase?: 'create' | 'start' | 'rollback';
  resolutionCategory?: import('../core/model-resolution/index.js').ResolutionFailureCategory;
  cause?: Error;
}

export interface RuntimeShutdownResidual {
  readonly owner: 'runtime' | 'reload' | 'retirement' | 'instance' | 'resource' | 'fanout';
  readonly phase: string;
  readonly message: string;
  readonly generation?: number;
  readonly requestId?: string;
  readonly turnId?: string;
  readonly unitId?: string;
  readonly instanceId?: string;
  readonly blockingTurnIds?: readonly string[];
}

export interface RuntimeTurnConvergenceReport {
  readonly completedRequestIds: readonly string[];
  readonly abortedRequestIds: readonly string[];
  readonly nonconvergedRequestIds: readonly string[];
  readonly queuedCancelledRequestIds: readonly string[];
  readonly protectedGenerations: readonly number[];
}

export interface RuntimeInstanceStopReport {
  readonly completedInstanceIds: readonly string[];
  readonly failedInstanceIds: readonly string[];
  readonly pendingInstanceIds: readonly string[];
  readonly skippedProtectedInstanceIds: readonly string[];
}

export interface RuntimeShutdownReport {
  readonly outcome: 'completed' | 'deadline-exhausted';
  readonly reason?: string;
  readonly startedAt: number;
  readonly finishedAt: number;
  readonly completed: readonly string[];
  readonly failed: readonly { readonly resource: string; readonly message: string }[];
  readonly turns: RuntimeTurnConvergenceReport;
  readonly instanceStops: RuntimeInstanceStopReport;
  readonly residuals: readonly RuntimeShutdownResidual[];
}

export type RuntimeEvent =
  | {
      type: 'app_start';
      agentHome: string;
    }
  | {
      type: 'app_ready';
      agentHome: string;
      contextVersion: number;
      toolNames: string[];
      channelIds: string[];
      memoryEnabled: boolean;
    }
  | {
      type: 'turn_start';
      requestId: string;
      originMessageId?: string;
      turnId: string;
      sessionId: string;
      contextVersion: number;
    }
  | {
      type: 'turn_end';
      requestId: string;
      originMessageId?: string;
      turnId: string;
      sessionId: string;
      outcome: 'completed' | 'failed' | 'aborted' | 'shutdown_nonconverged';
      result?: RunTurnResult;
      failure?: { readonly code: string; readonly message: string };
    }
  | {
      type: 'request_end';
      requestId: string;
      originMessageId?: string;
      outcome: 'cancelled';
      reason: 'abort_queue_drop' | 'shutdown';
    }
  | {
      type: 'context_reload';
      contextVersion: number;
      fileCount: number;
    }
  | {
      type: 'warning';
      info: RuntimeErrorInfo;
    }
  | {
      type: 'error';
      info: RuntimeErrorInfo;
    }
  | {
      type: 'shutdown_start';
      reason?: string;
    }
  | {
      type: 'shutdown_end';
      report: RuntimeShutdownReport;
    }
  /** Reports unclaimed FIFO messages removed by Abort. */
  | {
      type: 'messages_dropped';
      sessionId: string;
      reason: 'abort';
      dropped: number;
    };

export interface RuntimeDisposable {
  close(): void | Promise<void>;
}

export interface RuntimeBootstrapResult {
  readonly resources: RuntimeResourceSet;
  readonly state: RuntimeLifecycleState;
  readonly dependencies: RuntimeDependencies;
  readonly acquiredUnits: readonly LoadedRuntimeUnit[];
}