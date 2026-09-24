import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type {
  MemoryStore,
  MemorySearchResult,
  SearchOptions,
  EmbeddingProvider,
} from './types.js';
import {
  DEFAULT_MEMORY_CONFIG,
  type ChunkingConfig,
  type EmbeddingConfig,
  type MemorySearchConfig,
} from './config.js';
import { SqliteMemoryStore } from './internal/sqlite-store.js';
import { createEmbeddingProvider } from './internal/LocalEmbeddingProvider.js';
import { MemoryIndexer } from './internal/MemoryIndexer.js';
import { MemorySearcher } from './internal/MemorySearcher.js';
import { RecallTracker } from './internal/RecallTracker.js';
import { Logger } from '../../platform/logger/index.js';

const log = Logger.get('MemoryManager');

const DB_FILE = 'memory.sqlite';
const RECALL_DIR = 'memory-recalls';

export interface MemoryManagerConfig {
  readonly agentHome: string;
  readonly enabled?: boolean;
  readonly embedding?: Partial<EmbeddingConfig>;
  readonly chunking?: ChunkingConfig;
  readonly search?: MemorySearchConfig;
}

/**
 * Memory 模块统一入口。
 *
 * 串联所有组件（Store、Indexer、Searcher、RecallTracker），
 * 对外提供简洁的 search / readFile / writeFile API。
 */
export class MemoryManager {
  private agentHome: string;
  private store: MemoryStore;
  private indexer: MemoryIndexer;
  private searcher: MemorySearcher;
  private recallTracker: RecallTracker;
  private embeddingProvider: EmbeddingProvider | null;

  private constructor(
    agentHome: string,
    store: MemoryStore,
    indexer: MemoryIndexer,
    searcher: MemorySearcher,
    recallTracker: RecallTracker,
    embeddingProvider: EmbeddingProvider | null,
  ) {
    this.agentHome = agentHome;
    this.store = store;
    this.indexer = indexer;
    this.searcher = searcher;
    this.recallTracker = recallTracker;
    this.embeddingProvider = embeddingProvider;
  }

  /**
   * 异步工厂方法：初始化所有组件 + 首次索引。
   */
  static async create(config: MemoryManagerConfig): Promise<MemoryManager> {
    const { agentHome } = config;

    // 1. 嵌入提供者（失败则为 null → 降级搜索）
    const embeddingProvider = await createEmbeddingProvider(
      config.embedding ?? DEFAULT_MEMORY_CONFIG.embedding,
    );
    log.info('Embedding provider', { provider: embeddingProvider ? embeddingProvider.modelId : 'none (keyword-only)' });

    // 2. SQLite 存储（路径固定在 <agentHome>/memory.sqlite，不可配）
    const dbPath = join(agentHome, DB_FILE);
    await mkdir(dirname(dbPath), { recursive: true });
    const store = new SqliteMemoryStore(dbPath);
    log.info('MemoryManager init', { dbPath });

    // 3. 组件
    const indexer = new MemoryIndexer(
      store,
      embeddingProvider,
      config.chunking ?? DEFAULT_MEMORY_CONFIG.chunking,
    );
    const searcher = new MemorySearcher(
      store,
      embeddingProvider,
      config.search ?? DEFAULT_MEMORY_CONFIG.search,
    );
    const recallTracker = new RecallTracker(join(agentHome, RECALL_DIR));

    const manager = new MemoryManager(
      agentHome,
      store,
      indexer,
      searcher,
      recallTracker,
      embeddingProvider,
    );

    // 4. 首次索引
    await indexer.indexAll(agentHome);
    log.info('MemoryManager ready');

    return manager;
  }

  // ── 公共 API ──────────────────────────────────────────

  /**
   * 搜索记忆。搜索后异步记录召回日志。
   */
  async search(query: string, options?: SearchOptions): Promise<MemorySearchResult[]> {
    log.debug('search', { query, maxResults: options?.maxResults, minScore: options?.minScore });
    const results = await this.searcher.search(query, options);
    log.debug('search results', { count: results.length });

    // 异步记录召回（fire-and-forget）
    this.recallTracker.record({
      query,
      timestamp: new Date().toISOString(),
      results: results.map((r) => ({
        path: r.path,
        startLine: r.startLine,
        endLine: r.endLine,
        score: r.score,
      })),
    });

    return results;
  }

  /**
   * 读取记忆文件，可指定行范围。
   */
  async readFile(path: string, from?: number, lines?: number): Promise<string> {
    const fullPath = resolveAgentHomePath(this.agentHome, path);
    const content = await readFile(fullPath, 'utf-8');

    if (from === undefined) return content;

    const allLines = content.split('\n');
    const start = Math.max(0, from - 1); // 1-based → 0-based
    const end = lines !== undefined ? start + lines : allLines.length;
    return allLines.slice(start, end).join('\n');
  }

  /**
   * 写入记忆文件 + 自动重索引。
   */
  async writeFile(path: string, content: string, mode: 'append' | 'overwrite'): Promise<void> {
    log.debug('writeFile', { path, mode });
    const fullPath = resolveAgentHomePath(this.agentHome, path);
    await mkdir(dirname(fullPath), { recursive: true });

    if (mode === 'append') {
      const existing = await readFileSafe(fullPath);
      const newContent = existing ? existing + '\n' + content : content;
      await writeFile(fullPath, newContent, 'utf-8');
    } else {
      await writeFile(fullPath, content, 'utf-8');
    }

    // 重索引该文件
    const fileContent = await readFile(fullPath, 'utf-8');
    await this.indexer.indexFile(path, fileContent);
  }

  /**
   * 重建所有索引。
   */
  async reindex(): Promise<void> {
    log.info('reindex triggered');
    await this.indexer.indexAll(this.agentHome);
  }

  /**
   * 关闭资源。
   */
  close(): void {
    this.store.close();
  }
}

// ── 工具函数 ──────────────────────────────────────────────

function resolveAgentHomePath(agentHome: string, path: string): string {
  const root = resolve(agentHome);
  const candidate = resolve(root, path);
  const relativePath = relative(root, candidate);
  if (
    relativePath === ''
    || (!isAbsolute(relativePath)
      && relativePath !== '..'
      && !relativePath.startsWith(`..${sep}`))
  ) {
    return candidate;
  }
  throw new Error(`Memory path must stay within Agent Home: ${path}`);
}

async function readFileSafe(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, 'utf-8');
  } catch {
    return null;
  }
}
