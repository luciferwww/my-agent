import type { ModelReference } from '../../core/model-resolution/index.js';
import type { LLMConfig } from '../../builtins/providers/builtin/index.js';
import type { RunnerConfig } from '../../core/runner/config.js';
import type { RuntimeConfig } from '../../runtime/config.js';

// ── Utility Types ────────────────────────────────────────

/** 深度 Partial：递归地将所有属性变为可选 */
export type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K];
};

// ── Scalar Types ─────────────────────────────────────────

/** 嵌入提供者类型 */
export type EmbeddingProviderType = 'local' | 'openai';

/** 安全等级 */
export type SafetyLevel = 'strict' | 'normal' | 'relaxed';

// ── Module Configs ───────────────────────────────────────

/** 对话压缩配置 */
export interface CompactionConfig {
  /** 是否启用压缩 */
  enabled: boolean;
  /** 预留 token 数（仅为模型输出留出空间；currentPrompt 已显式计入估算） */
  reserveTokens: number;
  /** 压缩后保留最近 N 个用户轮次的完整消息 */
  keepRecentTurns: number;
  /**
   * 单条 tool result 最大占 context window 的比例。
   * 运行时计算：maxChars = contextWindowTokens × TOOL_RESULT_CHARS_PER_TOKEN × toolResultContextShare
   * 例：200k 窗口 × 2 × 0.5 = 200,000 字符。
   */
  toolResultContextShare: number;
  /** Tool result 裁剪：保留头部字符数 */
  toolResultHeadChars: number;
  /** Tool result 裁剪：保留尾部字符数 */
  toolResultTailChars: number;
  /** 压缩超时（秒） */
  timeoutSeconds: number;
  /** 摘要生成的自定义指令（追加到默认指令后） */
  customInstructions?: string;
}

/** 嵌入配置。维度由 model 反查（见 LocalEmbeddingProvider.KNOWN_DIMENSIONS），不再接受配置。 */
export interface EmbeddingConfig {
  /** 提供者类型 */
  provider: EmbeddingProviderType;
  /** 模型标识 */
  model: string;
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

/** Memory 模块配置。DB 路径固定为 `<agentHome>/memory.sqlite`，不可配。 */
export interface MemoryModuleConfig {
  /** 是否启用 */
  enabled: boolean;
  /** 嵌入配置 */
  embedding: EmbeddingConfig;
  /** 分块配置 */
  chunking: ChunkingConfig;
  /** 搜索配置 */
  search: SearchConfig;
}

/** Prompt 配置 */
export interface PromptConfig {
  /** 安全等级 */
  safetyLevel: SafetyLevel;
}

/**
 * Tools 配置。
 *
 * 单一一对 `allow / deny`，用户视角下三档语义（见 spec §5.1）：
 *   - 在 `deny`         → 禁用（LLM 看不到 schema，注册时过滤）
 *   - 在 `allow`        → 直接执行（运行时免审批）
 *   - 都不在         → 需审批（有 channel 弹 prompt；无 channel fail-closed deny）
 *
 * 同一工具同时出现在 allow 与 deny 时 deny 优先。
 *
 * 条目语法：
 *   精确名称  "exec"     工具名完全相等（大小写敏感）
 *   Glob       "memory_*" * 匹配任意字符序列，? 匹配单字符
 *
 * v1 起不再支持 `group:*` 简写；显式列名或用 glob 替代。
 */
export interface ToolsConfig {
  /**
   * 直接执行的工具列表（精确名或 glob）。
   * 命中即跳过审批；运行时由 before_tool_call hook 短路。
   * 默认 [] = 无工具免审批，全部走 prompt（有 channel）/ deny（无 channel）。
   */
  allow?: string[];
  /**
   * 禁用的工具列表（精确名或 glob）。
   * 命中即在工具注册组件中过滤掉——LLM 完全看不到该工具的 schema。
   * deny 优先于 allow。默认 [] = 不禁用任何工具。
   */
  deny?: string[];
}

/** Agent Context 文件加载预算；文件路径固定在 Agent Home，不可配。 */
export interface AgentContextConfig {
  /** 上下文文件单文件最大字符数 */
  maxFileChars: number;
  /** 上下文文件总字符数上限 */
  maxTotalChars: number;
}

// ── Subagents ────────────────────────────────────────────

/**
 * subagent 工具策略，与主 agent tools.allow/deny 语义一致。
 *
 * 不对称设计（spec §5.3）：
 *   - allow 写了 → 完全替换主 agent allow（让 subagent 能「更紧」限制免审批集）
 *   - deny  写了 → 在主 agent deny 基础上叠加（保证 subagent 不会「更宽松」）
 *   - 不写    → 降级用主 agent 同名列表
 *
 * 请勿为了「对称」重构：双边叠加 / 双边替换都会破坏隔离语义。
 */
export interface SubagentToolsConfig {
  /** 不写时降级用主 agent 的 tools.allow */
  allow?: string[];
  /** 不写时降级用主 agent 的 tools.deny；写了则在主 agent deny 基础上叠加 */
  deny?: string[];
}

/** 单个 subagent 的配置条目 */
export type SubagentModelSelection =
  | 'inherit'
  | ModelReference;

export interface SubagentConfigEntry {
  /** 唯一标识符 */
  id: string;
  /** 给父 LLM 看的「何时使用」 */
  description: string;
  /** 显式继承 Parent effective reference，或提供 native Model Reference。 */
  model: SubagentModelSelection;
  /** 子 Agent 的 LLM 调用上限；不写沿用父 maxLlmCalls。对齐 RunParams.maxLlmCalls。 */
  maxLlmCalls?: number;
  /** 工具策略 */
  tools?: SubagentToolsConfig;
  // agentDir / cwd 按约定推导或预留未实现，不接受 config（见 spec §8.2）
}

/** subagents 节 */
export interface SubagentsConfig {
  /** 默认 true；false 则不注册 task 工具 */
  enabled: boolean;
  /** 子 agent 嵌套深度上限；默认 1 */
  maxDepth: number;
  /** subagent 定义列表 */
  list?: SubagentConfigEntry[];
}

// ── Agent-level Config ───────────────────────────────────

/** 单个 agent 的完整配置集 */
export interface AgentDefaults {
  memory: MemoryModuleConfig;
  prompt: PromptConfig;
  tools: ToolsConfig;
  context: AgentContextConfig;
  compaction: CompactionConfig;
  /** subagents 节；未提供时走 DEFAULT_AGENT_CONFIG.subagents */
  subagents?: SubagentsConfig;
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

/** 日志级别（与 platform/logger 的 LogLevel 同义；此处复制定义避免跨模块依赖） */
export type LoggerLevel = 'debug' | 'info' | 'warn' | 'error';

/** Console adapter 的配置段 */
export interface LoggerConsoleConfig {
  /** 是否启用 Console adapter；默认 true */
  enabled?: boolean;
  /** 此 adapter 的最低输出级别；不设跟随全局 minLevel */
  minLevel?: LoggerLevel;
}

/** File adapter 的配置段。路径/前缀/队列上限等由 FileAdapter 内部默认决定。 */
export interface LoggerFileConfig {
  /** 是否启用 File adapter；默认 false（不写文件） */
  enabled?: boolean;
  /** 此 adapter 的最低输出级别；不设跟随全局 minLevel */
  minLevel?: LoggerLevel;
}

/** Logger 配置 */
export interface LoggerModuleConfig {
  /** 全局最低输出级别；默认 'info' */
  minLevel?: LoggerLevel;
  /** Console adapter 子配置 */
  console?: LoggerConsoleConfig;
  /** File adapter 子配置 */
  file?: LoggerFileConfig;
}

/**
 * 应用顶层配置。
 *
 * 运行时最终态——由 Agent 配置投影和显式 agentHome 组合生成。
 * 环境变量和 CLI 覆盖在 resolveAgentConfig() 中叠加。
 */
export interface AppConfig {
  /** Agent 状态根目录（运行时确定，不来自文件） */
  agentHome: string;
  /** Application-level LLM selection and optional Built-in Provider. */
  llm: LLMConfig;
  /** Application-wide Runtime policy. */
  runtime: RuntimeConfig;
  /** Application-wide Runner policy. */
  runner: RunnerConfig;
  /** agent 配置（defaults + list） */
  agents: AgentsConfig;
  /** logger 配置 */
  logger: LoggerModuleConfig;
}

// ── Config File Schema ───────────────────────────────────

/** Immutable application-owned projection from the Agent configuration document. */
export interface ApplicationConfigProjection {
  readonly llm: LLMConfig;
  readonly runtime: RuntimeConfig;
  readonly runner: RunnerConfig;
  readonly agents: AgentsConfig;
  readonly logger: LoggerModuleConfig;
}

interface AgentApplicationDocument {
  llm?: {
    defaultModel?: ModelReference;
    builtin?: unknown;
  };
  runtime?: Partial<RuntimeConfig>;
  runner?: Partial<RunnerConfig>;
  agents?: {
    defaults?: DeepPartial<AgentDefaults>;
    list?: AgentEntry[];
  };
  logger?: LoggerModuleConfig;
}

/** Raw Agent configuration document shape; structural validation occurs before projection. */
export interface AgentConfigDocument extends AgentApplicationDocument {
  readonly extensions?: {
    readonly enabled?: boolean;
    readonly entries?: Record<string, unknown>;
  };
}