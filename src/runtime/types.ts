import type { AppConfig, AgentDefaults, DeepPartial } from '../platform/config/types.js';
import type {
  ChatContentBlock,
  TokenUsage,
} from '../core/model-invocation/index.js';
import type {
  ModelResolver,
  ProviderProjectionEntry,
  ResolvedModel,
} from '../core/model-resolution/index.js';
import type { MemoryManager } from '../core/memory/MemoryManager.js';
import type { SystemPromptBuilder } from '../core/prompt/SystemPromptBuilder.js';
import type { SessionManager, SessionManagerOptions } from '../core/session/SessionManager.js';
import type { RuntimeContributionUnit, RegistrySnapshot } from '../core/registry/index.js';
import type { ApplicationToolPolicy } from '../core/tools/types.js';
import type { ContextFile } from '../core/workspace/types.js';
import type { AgentEvent, AgentRunner, AgentRunnerConfig } from '../core/runner/index.js';
import type { SubagentProfile } from '../core/subagent/types.js';
import type { ActiveParentTurn } from './subagent-orchestration.js';
import type { MessageRouteContext } from './queue-types.js';
import type {
  ChannelCompletionObserver,
  ChannelShutdownHandoff,
} from '../core/channel/index.js';

import type { UserPromptBuilder } from '../core/prompt/UserPromptBuilder.js';

export interface RuntimeResourceSet {
  readonly appConfig: AppConfig;
  readonly resolvedConfig: AgentDefaults;
  readonly workspaceDir: string;
  readonly sessionManager: SessionManager;
  readonly registrySnapshot: RegistrySnapshot;
  readonly toolPolicy: ApplicationToolPolicy;
  readonly modelResolver: ModelResolver;
  readonly defaultProviderId: string;
  readonly resolveParentModel: (input: {
    model?: string;
    maxTokens?: number;
    tools: boolean;
    mediaKinds: readonly string[];
  }) => ResolvedModel;
  readonly memoryManager: MemoryManager | null;
  readonly systemPromptBuilder: SystemPromptBuilder;
  readonly userPromptBuilder: UserPromptBuilder;
  contextFiles: ContextFile[];
  readonly agentRunner: AgentRunner;
}

export interface RuntimeProviderOptions {
  apiKey?: string;
  baseURL?: string;
  defaultModel?: string;
  legacyContextWindowTokens: number;
  deploymentFacts?: AgentDefaults['llm']['deploymentFacts'];
}

export interface RuntimeMemoryOptions {
  workspaceDir: string;
  enabled: boolean;
  embedding?: AgentDefaults['memory']['embedding'];
  search?: AgentDefaults['memory']['search'];
}

export interface RuntimeBuiltinToolOptions {
  workspaceDir: string;
  fsWorkspaceOnly?: boolean;
  webFetchEnabled?: boolean;
  execEnabled?: boolean;
  processEnabled?: boolean;
}

export interface RuntimeDependencies {
  createProviderProjection(options: RuntimeProviderOptions): readonly ProviderProjectionEntry[];
  createSessionManager(workspaceDir: string, options?: SessionManagerOptions): SessionManager;
  createMemoryManager(options: RuntimeMemoryOptions): Promise<MemoryManager | null>;
  createSystemPromptBuilder(): SystemPromptBuilder;
  createAgentRunner(config: AgentRunnerConfig): AgentRunner;
  getBuiltinContributionUnits(
    options: RuntimeBuiltinToolOptions,
    memoryManager: MemoryManager | null,
  ): readonly RuntimeContributionUnit[];
}

export interface RuntimeAppOptions {
  workspaceDir: string;
  readonly contributionUnits?: readonly RuntimeContributionUnit[];
  agentId?: string;
  envOverrides?: DeepPartial<AgentDefaults>;
  cliOverrides?: DeepPartial<AgentDefaults>;
  dependencies?: Partial<RuntimeDependencies>;
  onEvent?: (event: RuntimeEvent) => void;
  /**
   * 可选的 AgentEvent 观察者（telemetry/调试日志用）。
   * RuntimeApp 在 fanout 闭包末尾调用此回调，与 channel.send 并行触发。
   */
  onAgentEvent?: (event: AgentEvent) => void;
}

export interface RunTurnParams {
  sessionKey: string;
  message: string | ChatContentBlock[];
  model?: string;
  maxTokens?: number;
  maxLlmCalls?: number;
  /** v1.0 必填；调用方明确传入，不再回退 config。交互式场景传 'full'，sub-agent / 定时任务传 'minimal' 或 'none' */
  promptMode: 'full' | 'minimal' | 'none';
  safetyLevel?: AgentDefaults['prompt']['safetyLevel'];
  reloadContextFiles?: boolean;
  /** 可选 turn 标识；不提供则由 RuntimeApp 自动生成 UUID */
  turnId?: string;
  /**
   * 触发本 turn 的 `user_message.messageId`。仅由 handleInboundChannelMessage → startQueuedTurn
   * 内部透传；直接调用 runTurn 一般不需要。
   * 见 channel-multi-client-user-message-spec §5.1 D6。
   */
  originMessageId?: string;
}

export interface RunTurnResult {
  sessionKey: string;
  text: string;
  content: ChatContentBlock[];
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
  | 'WORKSPACE_INIT_FAILED'
  | 'CONTEXT_LOAD_FAILED'
  | 'MEMORY_INIT_FAILED'
  | 'TOOL_ASSEMBLY_FAILED'
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

export interface RuntimeShutdownReport {
  reason?: string;
  startedAt: number;
  finishedAt: number;
  completed: string[];
  failed: Array<{ resource: string; message: string }>;
}

export type RuntimeEvent =
  | {
      type: 'app_start';
      workspaceDir: string;
    }
  | {
      type: 'app_ready';
      workspaceDir: string;
      contextVersion: number;
      toolNames: string[];
      channelIds: string[];
      memoryEnabled: boolean;
    }
  | {
      type: 'turn_start';
      sessionKey: string;
      contextVersion: number;
    }
  | {
      type: 'turn_end';
      sessionKey: string;
      result: RunTurnResult;
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
  /**
   * abort 时从 `messageQueueBySession` 里被丢弃的 queued/followup 消息计数。
   * 与 `RuntimeApp.abortTurn()` 返回值的 `dropped` 字段同义，供 caller / telemetry
   * 消费者跨返回值与 event 两条路径对齐。详见 core-abort-spec.md §8.3。
   *
   * **不包含**：
   *  - `runAttempt` 内 `pendingSteeringMessages` 未注入部分（仅写 log；见 §7.2 pending
   *    steering 处理）——那些位于 AgentRunner 局部变量，RuntimeApp 拿不到
   *
   * `dropped === 0` 且 abort 命中 active turn 时 event 不 emit（无 audit 价值）。
   */
  | {
      type: 'messages_dropped';
      sessionKey: string;
      /** v1 只有 'abort'，预留 'shutdown' 等 */
      reason: 'abort';
      /** 从 messageQueueBySession 中被丢弃的 queued/followup 消息数（≥1） */
      dropped: number;
    };

export interface RuntimeDisposable {
  close(): void | Promise<void>;
}

export interface RuntimeBootstrapResult {
  readonly resources: RuntimeResourceSet;
  readonly state: RuntimeLifecycleState;
  readonly subagentProfiles: ReadonlyMap<string, SubagentProfile>;
  readonly activeParentTurns: Map<string, ActiveParentTurn>;
  readonly routeContextByTurn: Map<string, MessageRouteContext>;
  readonly channelCompletionObserver: ChannelCompletionObserver;
  readonly channelShutdownHandoff: ChannelShutdownHandoff;
}