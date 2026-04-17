import type { AppConfig, AgentDefaults, DeepPartial } from '../config/types.js';
import type { ChatContentBlock, ChatToolDefinition, LLMClient, TokenUsage } from '../llm-client/types.js';
import type { MemoryManager } from '../memory/MemoryManager.js';
import type { SystemPromptBuilder } from '../prompt-builder/system/SystemPromptBuilder.js';
import type { ToolDefinition as PromptToolDefinition } from '../prompt-builder/types/builder.js';
import type { SessionManager, SessionManagerOptions } from '../session/SessionManager.js';
import type { Tool, ToolExecutor } from '../tools/types.js';
import type { ContextFile } from '../workspace/types.js';
import type { AgentRunner, AgentRunnerConfig } from '../agent-runner/index.js';

export interface RuntimeToolBundle {
  tools: Tool[];
  executor: ToolExecutor;
  llmDefinitions: ChatToolDefinition[];
  promptDefinitions: PromptToolDefinition[];
}

import type { UserPromptBuilder } from '../prompt-builder/user/UserPromptBuilder.js';

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
}

export interface RunTurnParams {
  sessionKey: string;
  message: string;
  model?: string;
  maxTokens?: number;
  maxToolRounds?: number;
  maxFollowUpRounds?: number;
  promptMode?: AgentDefaults['prompt']['mode'];
  safetyLevel?: AgentDefaults['prompt']['safetyLevel'];
  reloadContextFiles?: boolean;
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