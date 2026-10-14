import type { ModelReference } from '../../core/model-resolution/index.js';
import type { LLMConfig } from '../../builtins/providers/builtin/index.js';
import type { MemoryConfig } from '../../core/memory/index.js';
import type { ToolPolicyConfig } from '../../core/tools/index.js';
import type { AgentContextConfig } from '../../core/agent-context/index.js';
import type { CompactionConfig } from '../../core/runner/index.js';
import type { LoggerConfig } from '../logger/index.js';

export type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K];
};

export type {
  MemoryConfig,
  MemoryConfig as MemoryModuleConfig,
  ToolPolicyConfig,
  ToolPolicyConfig as ToolsConfig,
  AgentContextConfig,
  CompactionConfig,
  LoggerConfig,
  LoggerConfig as LoggerModuleConfig,
};
export type {
  EmbeddingConfig,
  ChunkingConfig,
  MemorySearchConfig as SearchConfig,
  EmbeddingProviderType,
} from '../../core/memory/index.js';
export type { LogLevel as LoggerLevel } from '../logger/index.js';

export interface AgentDefaults {
  readonly memory: MemoryConfig;
  readonly tools: ToolPolicyConfig;
  readonly context: AgentContextConfig;
  readonly compaction: CompactionConfig;
}

export interface AgentEntry extends DeepPartial<AgentDefaults> {
  readonly id: string;
  readonly description: string;
  readonly default?: boolean;
  readonly model?: ModelReference;
}

export interface AgentsConfig {
  readonly steeringEnabled: boolean;
  readonly maxLlmCallsPerTurn?: number;
  readonly maxSubagentDepth: number;
  readonly defaults: AgentDefaults;
  readonly list: readonly AgentEntry[];
}

export interface AppConfig {
  readonly agentHome: string;
  readonly llm: LLMConfig;
  readonly agents: AgentsConfig;
  readonly logger: LoggerConfig;
}

export interface ApplicationConfigProjection {
  readonly llm: LLMConfig;
  readonly agents: AgentsConfig;
  readonly logger: LoggerConfig;
}

interface AgentApplicationDocument {
  readonly llm?: {
    readonly defaultModel?: ModelReference;
    readonly builtin?: unknown;
  };
  readonly agents?: {
    readonly steeringEnabled?: boolean;
    readonly maxLlmCallsPerTurn?: number;
    readonly maxSubagentDepth?: number;
    readonly defaults?: DeepPartial<AgentDefaults>;
    readonly list?: readonly AgentEntry[];
  };
  readonly logger?: LoggerConfig;
}

export interface AgentConfigDocument extends AgentApplicationDocument {
  readonly extensions?: {
    readonly enabled?: boolean;
    readonly entries?: Record<string, unknown>;
  };
}
