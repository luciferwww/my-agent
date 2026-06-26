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
  ToolsConfig,
  FsToolsConfig,
  WorkspaceConfig,
  SubagentsConfig,
  SubagentConfigEntry,
  SubagentToolsConfig,
  ConfigFile,
  DeepPartial,
  EmbeddingProviderType,
  SafetyLevel,
} from './types.js';

// ── Defaults ──────────────────────────────────────────────
export { DEFAULT_AGENT_CONFIG } from './defaults.js';

// ── Loader ────────────────────────────────────────────────
export { loadConfig, resolveAgentConfig, getEnvOverrides, deepMerge } from './loader.js';
export type { LoadConfigOptions, ResolveOptions } from './loader.js';
