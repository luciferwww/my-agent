import type { AppConfig, AgentDefaults, DeepPartial } from '../platform/config/types.js';
import type { ChatContentBlock, ChatToolDefinition, LLMClient, TokenUsage } from '../adapters/llm/types.js';
import type { MemoryManager } from '../core/memory/MemoryManager.js';
import type { SystemPromptBuilder } from '../core/prompt/SystemPromptBuilder.js';
import type { ToolDefinition as PromptToolDefinition } from '../core/prompt/types.js';
import type { SessionManager, SessionManagerOptions } from '../core/session/SessionManager.js';
import type { Tool, ToolExecutor } from '../core/tools/types.js';
import type { ContextFile } from '../core/workspace/types.js';
import type { AgentEvent, AgentRunner, AgentRunnerConfig } from '../core/runner/index.js';

export interface RuntimeToolBundle {
  tools: Tool[];
  executor: ToolExecutor;
  llmDefinitions: ChatToolDefinition[];
  promptDefinitions: PromptToolDefinition[];
}

import type { UserPromptBuilder } from '../core/prompt/UserPromptBuilder.js';

export interface RuntimeResourceSet {
  appConfig: AppConfig;
  resolvedConfig: AgentDefaults;
  workspaceDir: string;
  sessionManager: SessionManager;
  llmClient: LLMClient;
  memoryManager: MemoryManager | null;
  systemPromptBuilder: SystemPromptBuilder;
  userPromptBuilder: UserPromptBuilder;
  toolBundle: RuntimeToolBundle;
  contextFiles: ContextFile[];
  agentRunner: AgentRunner;
}

export interface RuntimeLLMClientOptions {
  apiKey?: string;
  baseURL?: string;
  defaultModel?: string;
  maxTokens?: number;
}

export interface RuntimeMemoryOptions {
  workspaceDir: string;
  enabled: boolean;
  dbPath?: string;
  embedding?: AgentDefaults['memory']['embedding'];
  search?: AgentDefaults['memory']['search'];
}

export interface RuntimeBuiltinToolOptions {
  workspaceDir: string;
  webFetchEnabled?: boolean;
  execEnabled?: boolean;
  processEnabled?: boolean;
}

export interface RuntimeDependencies {
  createLLMClient(options: RuntimeLLMClientOptions): LLMClient;
  createSessionManager(workspaceDir: string, options?: SessionManagerOptions): SessionManager;
  createMemoryManager(options: RuntimeMemoryOptions): Promise<MemoryManager | null>;
  createSystemPromptBuilder(): SystemPromptBuilder;
  createAgentRunner(config: AgentRunnerConfig): AgentRunner;
  getBuiltinTools(options: RuntimeBuiltinToolOptions): Tool[];
}

export interface RuntimeAppOptions {
  workspaceDir: string;
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
  message: string;
  model?: string;
  maxTokens?: number;
  maxToolRounds?: number;
  maxFollowUpRounds?: number;
  inTurnMessageMode?: 'steer' | 'followup';
  promptMode?: AgentDefaults['prompt']['mode'];
  safetyLevel?: AgentDefaults['prompt']['safetyLevel'];
  reloadContextFiles?: boolean;
  /** 可选 turn 标识；不提供则由 RuntimeApp 自动生成 UUID */
  turnId?: string;
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
  | 'RUN_REJECTED'
  | 'RUN_FAILED'
  | 'SHUTDOWN_FAILED';

export interface RuntimeErrorInfo {
  scope: RuntimeErrorScope;
  severity: RuntimeErrorSeverity;
  code: RuntimeErrorCode;
  message: string;
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
    };

export interface RuntimeDisposable {
  close(): void | Promise<void>;
}

export interface RuntimeBootstrapResult {
  resources: RuntimeResourceSet;
  state: RuntimeLifecycleState;
}