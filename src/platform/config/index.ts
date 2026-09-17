// ── Types ─────────────────────────────────────────────────
export type {
  AppConfig,
  ApplicationConfigProjection,
  AgentsConfig,
  AgentDefaults,
  AgentEntry,
  LLMConfig,
  RunnerConfig,
  MemoryModuleConfig,
  EmbeddingConfig,
  ChunkingConfig,
  SearchConfig,
  PromptConfig,
  ToolsConfig,
  AgentContextConfig,
  SubagentsConfig,
  SubagentConfigEntry,
  SubagentToolsConfig,
  DeepPartial,
  EmbeddingProviderType,
  SafetyLevel,
} from './types.js';

// ── Defaults ──────────────────────────────────────────────
export { DEFAULT_AGENT_CONFIG } from './defaults.js';

// ── Resolution ────────────────────────────────────────────
export { resolveAgentConfig, getEnvOverrides, deepMerge } from './loader.js';
export type { ResolveOptions } from './loader.js';

// ── Agent configuration loader ───────────────────────────
export { ensureAgentConfigDocument } from './agent-config-bootstrap.js';
export { loadAgentConfig } from './agent-config-loader.js';
export type { AgentConfigSnapshot } from './agent-config-loader.js';
export { AgentConfigError } from './agent-config-errors.js';
export type { AgentConfigErrorCode } from './agent-config-errors.js';
