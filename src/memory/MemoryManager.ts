import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, dirname, isAbsolute } from 'node:path';
import type {
  MemoryConfig,
  MemoryStore,
  MemorySearchResult,
  SearchOptions,
  EmbeddingProvider,
} from './types.js';
import { SqliteMemoryStore } from './sqlite-store.js';
import { createEmbeddingProvider } from './LocalEmbeddingProvider.js';
import { MemoryIndexer } from './MemoryIndexer.js';
import { MemorySearcher } from './MemorySearcher.js';
import { RecallTracker } from './RecallTracker.js';

const DEFAULT_DB_PATH = '.agent/memory.sqlite';
const RECALL_DIR = '.agent/memory/.recalls';

/**
 * Memory 模块统一入口。
 *
 * 串联所有组件（Store、Indexer、Searcher、RecallTracker），
 * 对外提供简洁的 search / readFile / writeFile API。
 */
export class MemoryManager {
  private workspaceDir: string;
  private store: MemoryStore;
  private indexer: MemoryIndexer;
  private searcher: MemorySearcher;
  private recallTracker: RecallTracker;
  private embeddingProvider: EmbeddingProvider | null;

  private constructor(
    workspaceDir: string,
    store: MemoryStore,
    indexer: MemoryIndexer,
    searcher: MemorySearcher,
    recallTracker: RecallTracker,
    embeddingProvider: EmbeddingProvider | null,
  ) {
    this.workspaceDir = workspaceDir;
    this.store = store;
    this.indexer = indexer;
    this.searcher = searcher;
    this.recallTracker = recallTracker;
    this.embeddingProvider = embeddingProvider;
  }

  /**
   * 异步工厂方法：初始化所有组件 + 首次索引。
   */
  static async create(config: MemoryConfig): Promise<MemoryManager> {
    const { workspaceDir } = config;

    // 1. 嵌入提供者（失败则为 null → 降级搜索）
    const embeddingProvider = await createEmbeddingProvider(config.embedding);

    // 2. SQLite 存储（相对路径以 workspaceDir 为基础，绝对路径直接使用）
    const resolvedDbPath = config.dbPath ?? DEFAULT_DB_PATH;
    const dbPath = isAbsolute(resolvedDbPath) ? resolvedDbPath : join(workspaceDir, resolvedDbPath);
    await mkdir(dirname(dbPath), { recursive: true });
    const store = new SqliteMemoryStore(dbPath);

    // 3. 组件
    const indexer = new MemoryIndexer(store, embeddingProvider);
    const searcher = new MemorySearcher(store, embeddingProvider);
    const recallTracker = new RecallTracker(join(workspaceDir, RECALL_DIR));

    const manager = new MemoryManager(
      workspaceDir,
      store,
      indexer,
      searcher,
      recallTracker,
      embeddingProvider,
    );

    // 4. 首次索引
    await indexer.indexAll(workspaceDir);

    return manager;
  }

  // ── 公共 API ──────────────────────────────────────────

  /**
   * 搜索记忆。搜索后异步记录召回日志。
   */
  async search(query: string, options?: SearchOptions): Promise<MemorySearchResult[]> {
    const results = await this.searcher.search(query, options);

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
    const fullPath = join(this.workspaceDir, path);
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
    const fullPath = join(this.workspaceDir, path);
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
    await this.indexer.indexAll(this.workspaceDir);
  }

  /**
   * 关闭资源。
   */
  close(): void {
    this.store.close();
  }
}

// ── 工具函数 ──────────────────────────────────────────────

async function readFileSafe(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, 'utf-8');
  } catch {
    return null;
  }
}
