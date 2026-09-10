import type { AgentDefaults, LoggerModuleConfig } from './types.js';

/**
 * 所有模块的默认配置值。
 *
 * 每个值都来自对应模块中当前的硬编码常量。将来各模块可逐步
 * 迁移到从 config 读取，而非自己维护 DEFAULT_* 常量。
 *
 * 值来源映射：
 *   llm.maxTokens          → Runtime Model Policy default → ModelResolver
 *   runner.*               ← AgentRunner.ts DEFAULT_MAX_TOOL_ROUNDS / DEFAULT_MAX_FOLLOWUP_ROUNDS
 *   memory.embedding.*      ← LocalEmbeddingProvider.ts DEFAULT_MODEL（dimensions 由 model 反查）
 *   memory.chunking.*       ← MemoryIndexer.ts DEFAULT_CHUNK_CHARS / DEFAULT_OVERLAP_CHARS
 *   memory.search.*         ← MemorySearcher.ts DEFAULT_MAX_RESULTS / DEFAULT_MIN_SCORE / DEFAULT_*_WEIGHT
 *   prompt.*                ← SystemPromptBuilder.ts default params
 *   tools.fs.workspaceOnly  ← path-policy.ts DEFAULT_WORKSPACE_ONLY
 *   workspace.maxFileChars  ← loader.ts DEFAULT_MAX_FILE_CHARS
 *   workspace.maxTotalChars ← loader.ts DEFAULT_MAX_TOTAL_CHARS
 *   subagents.*             ← core-subagent-spec.md §12
 *
 * 已删除字段（spec §8.2/§8.3）：
 *   memory.dbPath           → 固定 `<workspaceDir>/.agent/memory.sqlite`
 *   memory.embedding.dimensions → 由 model 反查（KNOWN_DIMENSIONS 表 + 动态探测）
 *   session.dir             → SessionManager hardcode `'sessions'`
 *   workspace.agentDir      → 固定 `.agent/`
 *   tools.execTimeout / readMaxLines / webFetchTimeout / webFetchMaxChars → 工具自身 DEFAULT_* 常量
 *   tools.approval          → 平移到 tools.allow / deny（语义升级，见 spec §10.3）
 *   logger.file.dir         → bootstrap 固定传 `<workspaceDir>/logs/`
 *   logger.file.prefix      → FileAdapter 默认 'app'
 *   logger.file.maxQueueSize → FileAdapter 默认 10_000
 */
export const DEFAULT_AGENT_CONFIG: AgentDefaults = {
  llm: {
    apiKey: undefined, // 可选，不设则由 env 或配置文件提供
    baseURL: undefined, // 可选，不设则用 Anthropic 官方端点
    model: undefined, // 预留，当前 AnthropicClient 不支持选模型
    maxTokens: 4096,
    contextWindowTokens: 200_000,
  },

  runner: {
    maxLlmCalls: 12,
    inTurnMessageMode: 'followup',
  },

  memory: {
    enabled: true,
    embedding: {
      provider: 'local',
      model: 'Xenova/all-MiniLM-L6-v2',
      // dimensions 由 LocalEmbeddingProvider 启动时反查
    },
    chunking: {
      chunkChars: 1600,
      overlapChars: 320,
    },
    search: {
      maxResults: 6,
      minScore: 0.25,
      vectorWeight: 0.7,
      textWeight: 0.3,
    },
  },

  prompt: {
    safetyLevel: 'normal',
  },

  tools: {
    fs: {
      workspaceOnly: true,
    },
    allow: [],
    deny: [],
  },

  workspace: {
    maxFileChars: 20_000,
    maxTotalChars: 150_000,
  },

  compaction: {
    enabled: true,
    reserveTokens: 20_000,
    keepRecentTurns: 3,
    toolResultContextShare: 0.5,
    toolResultHeadChars: 10_000,
    toolResultTailChars: 5_000,
    timeoutSeconds: 300,
  },

  subagents: {
    enabled: true,
    maxDepth: 1,
    list: [],
  },
};

/**
 * Logger 模块的默认配置。
 *
 * console.enabled 默认 true（保持现有 stdout/stderr 行为）。
 * file.enabled 默认 false（不写文件，向后兼容；需要时在 config.json 中显式打开）。
 * file 子字段（dir / prefix / maxQueueSize）由 FileAdapter 内部默认决定，
 * bootstrap 启动时固定传 `<workspaceDir>/logs/` 给 dir。
 */
export const DEFAULT_LOGGER_CONFIG: LoggerModuleConfig = {
  minLevel: 'info',
  console: {
    enabled: true,
  },
  file: {
    enabled: false,
  },
};
