import type { AgentDefaults } from './types.js';

/**
 * 所有模块的默认配置值。
 *
 * 每个值都来自对应模块中当前的硬编码常量。将来各模块可逐步
 * 迁移到从 config 读取，而非自己维护 DEFAULT_* 常量。
 *
 * 值来源映射：
 *   llm.maxTokens          ← AnthropicClient.ts DEFAULT_MAX_TOKENS
 *   runner.*               ← AgentRunner.ts DEFAULT_MAX_TOOL_ROUNDS / DEFAULT_MAX_FOLLOWUP_ROUNDS
 *   memory.dbPath           ← MemoryManager.ts DEFAULT_DB_PATH
 *   memory.embedding.*      ← LocalEmbeddingProvider.ts DEFAULT_MODEL / DEFAULT_DIMENSIONS
 *   memory.chunking.*       ← MemoryIndexer.ts DEFAULT_CHUNK_CHARS / DEFAULT_OVERLAP_CHARS
 *   memory.search.*         ← MemorySearcher.ts DEFAULT_MAX_RESULTS / DEFAULT_MIN_SCORE / DEFAULT_*_WEIGHT
 *   prompt.*                ← SystemPromptBuilder.ts default params
 *   session.dir             ← SessionManager.ts SESSIONS_DIR
 *   tools.execTimeout       ← exec.ts DEFAULT_TIMEOUT_SECONDS
 *   tools.readMaxLines      ← read-file.ts DEFAULT_MAX_LINES
 *   tools.webFetch*         ← web-fetch.ts DEFAULT_TIMEOUT_MS / DEFAULT_MAX_CHARS
 *   workspace.agentDir      ← init.ts AGENT_DIR
 *   workspace.maxFileChars  ← loader.ts DEFAULT_MAX_FILE_CHARS
 *   workspace.maxTotalChars ← loader.ts DEFAULT_MAX_TOTAL_CHARS
 */
export const DEFAULT_AGENT_CONFIG: AgentDefaults = {
  llm: {
    // apiKey: undefined — 必须由 env 或配置文件提供
    // baseURL: undefined — 可选，不设则用 Anthropic 官方端点
    // model: undefined — 预留，当前 AnthropicClient 不支持选模型
    maxTokens: 4096,
    contextWindowTokens: 200_000,
  },

  runner: {
    maxToolRounds: 10,
    maxFollowUpRounds: 5,
  },

  memory: {
    enabled: true,
    dbPath: '.agent/memory.sqlite',
    embedding: {
      provider: 'local',
      model: 'Xenova/all-MiniLM-L6-v2',
      dimensions: 384,
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
    mode: 'full',
    safetyLevel: 'normal',
  },

  session: {
    dir: 'sessions',
  },

  tools: {
    execTimeout: 30,
    readMaxLines: 200,
    webFetchTimeout: 30_000,
    webFetchMaxChars: 50_000,
  },

  workspace: {
    agentDir: '.agent',
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
};
