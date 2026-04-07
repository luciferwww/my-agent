// ── Embedding ─────────────────────────────────────────────

/** 嵌入提供者接口。V1 实现本地模型，后续可扩展远程 API。 */
export interface EmbeddingProvider {
  /** 批量嵌入文本，返回对应的向量数组。 */
  embed(texts: string[]): Promise<number[][]>;
  /** 向量维度（如 384、1536）。 */
  readonly dimensions: number;
  /** 模型标识（如 "all-MiniLM-L6-v2"）。 */
  readonly modelId: string;
}

// ── Memory Chunk ──────────────────────────────────────────

/** 存储的记忆块。对应 SQLite chunks 表的一行。 */
export interface MemoryChunk {
  /** 块 ID，格式: "${source}:${path}:${startLine}-${endLine}" */
  id: string;
  /** 相对路径，如 "MEMORY.md" 或 "memory/2026-04-07.md" */
  path: string;
  /** 来源命名空间，V1 固定为 "memory"，后续可扩展 "sessions" 等 */
  source: string;
  /** 块文本内容 */
  content: string;
  /** 起始行号（1-based） */
  startLine: number;
  /** 结束行号（1-based, inclusive） */
  endLine: number;
  /** 嵌入向量（降级模式下为 undefined） */
  embedding?: number[];
  /** 生成 embedding 的模型标识（如 "all-MiniLM-L6-v2"） */
  model?: string;
  /** 最后更新时间戳（ms since epoch） */
  updatedAt: number;
}

// ── Search ────────────────────────────────────────────────

/** 搜索结果 */
export interface MemorySearchResult {
  path: string;
  content: string;
  startLine: number;
  endLine: number;
  /** 相关度分数，0-1，越高越相关 */
  score: number;
  /** 匹配方式 */
  matchType: 'vector' | 'keyword' | 'hybrid';
}

/** 搜索选项 */
export interface SearchOptions {
  /** 最大结果数，默认 6 */
  maxResults?: number;
  /** 最低分数阈值，默认 0.25 */
  minScore?: number;
  /** 混合搜索权重配置 */
  hybrid?: {
    /** 向量搜索权重，默认 0.7 */
    vectorWeight?: number;
    /** 关键词搜索权重，默认 0.3 */
    textWeight?: number;
  };
}

// ── Recall Tracking ───────────────────────────────────────

/** 召回记录，每次 memory_search 后异步写入 */
export interface RecallEntry {
  /** 搜索查询文本 */
  query: string;
  /** ISO 8601 时间戳 */
  timestamp: string;
  /** 命中结果摘要 */
  results: Array<{
    path: string;
    startLine: number;
    endLine: number;
    score: number;
  }>;
}

// ── File Tracking ─────────────────────────────────────────

/** 已索引文件的状态信息，对应 SQLite files 表 */
export interface IndexedFileInfo {
  source: string;
  hash: string;
  mtime: number;
  size: number;
}

// ── Store Interface ───────────────────────────────────────

/** 记忆存储接口。V1 用 SQLite 实现，接口抽象方便后续替换。 */
export interface MemoryStore {
  /** 批量插入/更新块 */
  upsertChunks(chunks: MemoryChunk[]): void;
  /** 删除指定路径的所有块 */
  deleteByPath(path: string): void;
  /** 向量相似度搜索，仅匹配指定 model 的块 */
  searchByVector(embedding: number[], topK: number, model: string): Array<MemoryChunk & { score: number }>;
  /** BM25 关键词搜索 */
  searchByKeyword(query: string, topK: number): Array<MemoryChunk & { score: number }>;
  /** 获取已索引文件信息 */
  getFile(path: string): IndexedFileInfo | undefined;
  /** 更新已索引文件信息 */
  upsertFile(path: string, info: IndexedFileInfo): void;
  /** 删除已索引文件记录 */
  deleteFile(path: string): void;
  /** 读取元数据 */
  getMeta(key: string): string | undefined;
  /** 写入元数据 */
  setMeta(key: string, value: string): void;
  /** 关闭数据库连接 */
  close(): void;
}

// ── Configuration ─────────────────────────────────────────

/** Memory 模块配置 */
export interface MemoryConfig {
  /** 工作区根目录 */
  workspaceDir: string;
  /** SQLite 数据库路径，默认 `<workspaceDir>/.agent/memory.sqlite` */
  dbPath?: string;
  /** 嵌入配置 */
  embedding?: {
    /** 提供者类型，默认 'local'。后续可扩展 'openai' 等 */
    provider?: 'local' | 'openai';
    /** 模型标识 */
    model?: string;
  };
  /** 搜索默认选项 */
  search?: SearchOptions;
  /** 是否启用 memory 模块，默认 true */
  enabled?: boolean;
}
