import Database from 'better-sqlite3';
import type { MemoryStore, MemoryChunk, IndexedFileInfo } from '../types.js';

/**
 * 基于 SQLite 的记忆存储实现。
 *
 * 使用 better-sqlite3（同步 API），包含：
 * - chunks 表：分块文本 + 向量 BLOB
 * - chunks_fts 虚拟表：FTS5 全文搜索
 * - files 表：已索引文件状态跟踪
 * - meta 表：元数据（provider 标识等）
 */
export class SqliteMemoryStore implements MemoryStore {
  private db: Database.Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('busy_timeout = 5000');
    this.initSchema();
  }

  // ── Chunks ──────────────────────────────────────────────

  upsertChunks(chunks: MemoryChunk[]): void {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO chunks (id, path, source, start_line, end_line, model, content, embedding, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const ftsStmt = this.db.prepare(`
      INSERT OR REPLACE INTO chunks_fts (id, content, path, source, model, start_line, end_line)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    const tx = this.db.transaction((items: MemoryChunk[]) => {
      for (const chunk of items) {
        const embeddingBlob = chunk.embedding
          ? Buffer.from(new Float32Array(chunk.embedding).buffer)
          : null;

        stmt.run(
          chunk.id,
          chunk.path,
          chunk.source,
          chunk.startLine,
          chunk.endLine,
          chunk.model ?? '',
          chunk.content,
          embeddingBlob,
          chunk.updatedAt,
        );

        ftsStmt.run(
          chunk.id,
          chunk.content,
          chunk.path,
          chunk.source,
          chunk.model ?? '',
          chunk.startLine,
          chunk.endLine,
        );
      }
    });

    tx(chunks);
  }

  deleteByPath(path: string): void {
    // 先删 FTS 中对应的行，再删主表
    this.db.prepare('DELETE FROM chunks_fts WHERE path = ?').run(path);
    this.db.prepare('DELETE FROM chunks WHERE path = ?').run(path);
  }

  searchByVector(
    embedding: number[],
    topK: number,
    model: string,
  ): Array<MemoryChunk & { score: number }> {
    // 加载指定 model 的所有含 embedding 的行
    const rows = this.db.prepare(`
      SELECT id, path, source, start_line, end_line, model, content, embedding, updated_at
      FROM chunks
      WHERE model = ? AND embedding IS NOT NULL
    `).all(model) as Array<{
      id: string;
      path: string;
      source: string;
      start_line: number;
      end_line: number;
      model: string;
      content: string;
      embedding: Buffer;
      updated_at: number;
    }>;

    // 逐条计算余弦相似度
    const scored = rows.map((row) => {
      const stored = new Float32Array(row.embedding.buffer, row.embedding.byteOffset, row.embedding.byteLength / 4);
      const score = cosineSimilarity(embedding, stored);
      return {
        id: row.id,
        path: row.path,
        source: row.source,
        content: row.content,
        startLine: row.start_line,
        endLine: row.end_line,
        model: row.model,
        updatedAt: row.updated_at,
        score,
      };
    });

    // 排序取 topK
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, topK);
  }

  searchByKeyword(
    query: string,
    topK: number,
  ): Array<MemoryChunk & { score: number }> {
    const rows = this.db.prepare(`
      SELECT id, path, source, model, start_line, end_line, content, bm25(chunks_fts) AS rank
      FROM chunks_fts
      WHERE chunks_fts MATCH ?
      ORDER BY rank
      LIMIT ?
    `).all(query, topK) as Array<{
      id: string;
      path: string;
      source: string;
      model: string;
      start_line: number;
      end_line: number;
      content: string;
      rank: number;
    }>;

    return rows.map((row) => ({
      id: row.id,
      path: row.path,
      source: row.source,
      content: row.content,
      startLine: row.start_line,
      endLine: row.end_line,
      model: row.model,
      updatedAt: 0,
      score: -row.rank, // bm25() 返回负数，越小越好，取反变成越大越好
    }));
  }

  // ── Files ───────────────────────────────────────────────

  getFile(path: string): IndexedFileInfo | undefined {
    const row = this.db.prepare(
      'SELECT source, hash, mtime, size FROM files WHERE path = ?',
    ).get(path) as { source: string; hash: string; mtime: number; size: number } | undefined;

    return row ?? undefined;
  }

  upsertFile(path: string, info: IndexedFileInfo): void {
    this.db.prepare(`
      INSERT OR REPLACE INTO files (path, source, hash, mtime, size)
      VALUES (?, ?, ?, ?, ?)
    `).run(path, info.source, info.hash, info.mtime, info.size);
  }

  deleteFile(path: string): void {
    this.db.prepare('DELETE FROM files WHERE path = ?').run(path);
  }

  // ── Meta ────────────────────────────────────────────────

  getMeta(key: string): string | undefined {
    const row = this.db.prepare(
      'SELECT value FROM meta WHERE key = ?',
    ).get(key) as { value: string } | undefined;

    return row?.value;
  }

  setMeta(key: string, value: string): void {
    this.db.prepare(
      'INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)',
    ).run(key, value);
  }

  // ── Lifecycle ───────────────────────────────────────────

  close(): void {
    this.db.close();
  }

  // ── Schema 初始化 ──────────────────────────────────────

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS files (
        path        TEXT PRIMARY KEY,
        source      TEXT NOT NULL DEFAULT 'memory',
        hash        TEXT NOT NULL,
        mtime       INTEGER NOT NULL,
        size        INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS chunks (
        id          TEXT PRIMARY KEY,
        path        TEXT NOT NULL,
        source      TEXT NOT NULL DEFAULT 'memory',
        start_line  INTEGER NOT NULL,
        end_line    INTEGER NOT NULL,
        model       TEXT NOT NULL,
        content     TEXT NOT NULL,
        embedding   BLOB,
        updated_at  INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_chunks_path ON chunks(path);
      CREATE INDEX IF NOT EXISTS idx_chunks_source ON chunks(source);

      CREATE TABLE IF NOT EXISTS meta (
        key   TEXT PRIMARY KEY,
        value TEXT
      );
    `);

    // FTS5 虚拟表（独立表模式，含 UNINDEXED 元数据列）
    this.db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
        content,
        id UNINDEXED,
        path UNINDEXED,
        source UNINDEXED,
        model UNINDEXED,
        start_line UNINDEXED,
        end_line UNINDEXED,
        tokenize='unicode61'
      );
    `);
  }
}

// ── 工具函数 ──────────────────────────────────────────────

/** 计算两个向量的余弦相似度 */
function cosineSimilarity(a: number[] | Float32Array, b: number[] | Float32Array): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}
