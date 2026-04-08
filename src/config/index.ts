// ── Types ─────────────────────────────────────────────────
export type {
  AppConfig,
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
  SessionConfig,
  ToolsConfig,
  WorkspaceConfig,
  ConfigFile,
  DeepPartial,
  EmbeddingProviderType,
  PromptMode,
  SafetyLevel,
} from './types.js';

// ── Defaults ──────────────────────────────────────────────
export { DEFAULT_AGENT_CONFIG } from './defaults.js';

// ── Loader ────────────────────────────────────────────────
export { loadConfig, resolveAgentConfig, getEnvOverrides, deepMerge } from './loader.js';
export type { LoadConfigOptions, ResolveOptions } from './loader.js';
