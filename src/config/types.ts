// ── Utility Types ────────────────────────────────────────

/** 深度 Partial：递归地将所有属性变为可选 */
export type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K];
};

// ── Scalar Types ─────────────────────────────────────────

/** 嵌入提供者类型 */
export type EmbeddingProviderType = 'local' | 'openai';

/** 提示模式 */
export type PromptMode = 'full' | 'minimal' | 'none';

/** 安全等级 */
export type SafetyLevel = 'strict' | 'normal' | 'relaxed';

// ── Module Configs ───────────────────────────────────────

/** LLM 配置 */
export interface LLMConfig {
  /** Anthropic API Key（env ANTHROPIC_API_KEY 优先） */
  apiKey?: string;
  /** API base URL（支持 LiteLLM Proxy、MAI-LLMProxy） */
  baseURL?: string;
  /** 默认模型（预留，目前 AnthropicClient 不支持选模型） */
  model?: string;
  /** 默认 max tokens */
  maxTokens: number;
}

/** Agent Runner 配置 */
export interface RunnerConfig {
  /** 内层 tool-use 最大轮数 */
  maxToolRounds: number;
  /** 外层 followUp 最大轮数 */
  maxFollowUpRounds: number;
}

/** 嵌入配置 */
export interface EmbeddingConfig {
  /** 提供者类型 */
  provider: EmbeddingProviderType;
  /** 模型标识 */
  model: string;
  /** 向量维度 */
  dimensions: number;
}

/** 分块配置 */
export interface ChunkingConfig {
  /** 目标块大小（字符） */
  chunkChars: number;
  /** 块间重叠（字符） */
  overlapChars: number;
}

/** 搜索配置 */
export interface SearchConfig {
  /** 最大结果数 */
  maxResults: number;
  /** 最低分数阈值 */
  minScore: number;
  /** 向量搜索权重（混合搜索） */
  vectorWeight: number;
  /** 关键词搜索权重（混合搜索） */
  textWeight: number;
}

/** Memory 模块配置 */
export interface MemoryModuleConfig {
  /** 是否启用 */
  enabled: boolean;
  /** SQLite 路径（相对 workspaceDir） */
  dbPath: string;
  /** 嵌入配置 */
  embedding: EmbeddingConfig;
  /** 分块配置 */
  chunking: ChunkingConfig;
  /** 搜索配置 */
  search: SearchConfig;
}

/** Prompt 配置 */
export interface PromptConfig {
  /** 提示模式 */
  mode: PromptMode;
  /** 安全等级 */
  safetyLevel: SafetyLevel;
}

/** Session 配置 */
export interface SessionConfig {
  /** session 存储目录名（相对 .agent/） */
  dir: string;
}

/** Tools 配置 */
export interface ToolsConfig {
  /** exec 默认超时（秒） */
  execTimeout: number;
  /** read_file 默认最大行数 */
  readMaxLines: number;
  /** web_fetch 超时（毫秒） */
  webFetchTimeout: number;
  /** web_fetch 最大响应字符数 */
  webFetchMaxChars: number;
}

/** Workspace 配置 */
export interface WorkspaceConfig {
  /** agent 目录名 */
  agentDir: string;
  /** 上下文文件单文件最大字符数 */
  maxFileChars: number;
  /** 上下文文件总字符数上限 */
  maxTotalChars: number;
}

// ── Agent-level Config ───────────────────────────────────

/** 单个 agent 的完整配置集 */
export interface AgentDefaults {
  llm: LLMConfig;
  runner: RunnerConfig;
  memory: MemoryModuleConfig;
  prompt: PromptConfig;
  session: SessionConfig;
  tools: ToolsConfig;
  workspace: WorkspaceConfig;
}

/** agents.list 中的单项：id + 覆盖字段 */
export interface AgentEntry extends DeepPartial<AgentDefaults> {
  /** agent 标识，如 "main"、"coding" */
  id: string;
  /** 是否为默认 agent */
  default?: boolean;
}

// ── Top-level Config ─────────────────────────────────────

/** agents 配置分区 */
export interface AgentsConfig {
  /** 全局默认配置 */
  defaults: AgentDefaults;
  /** per-agent 覆盖列表（预留） */
  list: AgentEntry[];
}

/**
 * 应用顶层配置。
 *
 * 运行时最终态——由 loadConfig() 合并硬编码默认值和配置文件后生成。
 * 环境变量和 CLI 覆盖在 resolveAgentConfig() 中叠加。
 */
export interface AppConfig {
  /** 工作区根目录（运行时确定，不来自文件） */
  workspaceDir: string;
  /** agent 配置（defaults + list） */
  agents: AgentsConfig;
}

// ── Config File Schema ───────────────────────────────────

/**
 * config.json 文件的 schema。
 *
 * 与 AppConfig 的区别：所有字段都是可选的（部分配置），
 * 且不包含 workspaceDir（运行时确定）。
 */
export interface ConfigFile {
  agents?: {
    defaults?: DeepPartial<AgentDefaults>;
    list?: AgentEntry[];
  };
}
