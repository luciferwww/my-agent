// ── Types ─────────────────────────────────────────────────
export type {
  AppConfig,
  ApplicationConfigProjection,
  AgentsConfig,
  AgentDefaults,
  AgentEntry,
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
export type { RunnerConfig } from '../../core/runner/config.js';
export type { RuntimeConfig } from '../../runtime/config.js';
export type {
  BuiltinLlmProviderConfig,
  BuiltinModelRegistration,
  BuiltinProtocol,
  LLMConfig,
} from '../../builtins/providers/builtin/index.js';

// ── Defaults ──────────────────────────────────────────────
export { createDefaultAgentConfig } from './default-composition.js';
export { DEFAULT_LOGGER_CONFIG } from '../logger/index.js';

// ── Resolution ────────────────────────────────────────────
export { resolveAgentConfig, getEnvOverrides, deepMerge } from './loader.js';
export type { ResolveOptions } from './loader.js';

// ── Agent configuration loader ───────────────────────────
export { ensureAgentConfigDocument } from './agent-config-bootstrap.js';
export { loadAgentConfig } from './agent-config-loader.js';
export type { AgentConfigSnapshot } from './agent-config-loader.js';
export { AgentConfigError } from './agent-config-errors.js';
export type { AgentConfigErrorCode } from './agent-config-errors.js';
