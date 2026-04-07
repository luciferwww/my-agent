import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { readdir, stat } from 'node:fs/promises';
import type { MemoryStore, MemoryChunk, EmbeddingProvider } from './types.js';

const DEFAULT_CHUNK_CHARS = 1600;   // ~400 tokens
const DEFAULT_OVERLAP_CHARS = 320;  // ~80 tokens
const MEMORY_SOURCE = 'memory';

/**
 * 记忆文件索引器。
 *
 * 职责：读取 Markdown 文件 → 按行边界分块 → 生成嵌入 → 写入存储。
 * 支持增量索引（文件 hash 不变时跳过）。
 */
export class MemoryIndexer {
  private store: MemoryStore;
  private embeddingProvider: EmbeddingProvider | null;

  constructor(store: MemoryStore, embeddingProvider: EmbeddingProvider | null) {
    this.store = store;
    this.embeddingProvider = embeddingProvider;
  }

  /**
   * 索引单个文件。增量：对比内容 hash，未变则跳过。
   */
  async indexFile(relativePath: string, content: string): Promise<void> {
    const hash = sha256(content);
    const existing = this.store.getFile(relativePath);

    if (existing && existing.hash === hash) {
      return; // 文件未变，跳过
    }

    // 分块
    const rawChunks = splitIntoChunks(content, DEFAULT_CHUNK_CHARS, DEFAULT_OVERLAP_CHARS);

    // 嵌入
    const modelId = this.embeddingProvider?.modelId ?? '';
    let embeddings: number[][] | null = null;
    if (this.embeddingProvider && rawChunks.length > 0) {
      embeddings = await this.embeddingProvider.embed(rawChunks.map((c) => c.text));
    }

    // 构建 MemoryChunk[]
    const now = Date.now();
    const chunks: MemoryChunk[] = rawChunks.map((raw, i) => ({
      id: `${MEMORY_SOURCE}:${relativePath}:${raw.startLine}-${raw.endLine}`,
      path: relativePath,
      source: MEMORY_SOURCE,
      content: raw.text,
      startLine: raw.startLine,
      endLine: raw.endLine,
      embedding: embeddings ? embeddings[i] : undefined,
      model: modelId,
      updatedAt: now,
    }));

    // 先删旧块，再写新块
    this.store.deleteByPath(relativePath);
    if (chunks.length > 0) {
      this.store.upsertChunks(chunks);
    }

    // 更新文件状态
    this.store.upsertFile(relativePath, {
      source: MEMORY_SOURCE,
      hash,
      mtime: now,
      size: Buffer.byteLength(content, 'utf-8'),
    });
  }

  /**
   * 索引所有记忆文件（MEMORY.md + memory/*.md）。
   */
  async indexAll(workspaceDir: string): Promise<void> {
    // 索引 MEMORY.md
    const memoryPath = join(workspaceDir, 'MEMORY.md');
    const memoryContent = await readFileSafe(memoryPath);
    if (memoryContent !== null) {
      await this.indexFile('MEMORY.md', memoryContent);
    }

    // 索引 memory/*.md
    const memoryDir = join(workspaceDir, 'memory');
    const entries = await readdirSafe(memoryDir);
    for (const entry of entries) {
      if (!entry.endsWith('.md')) continue;
      const filePath = join(memoryDir, entry);
      const fileStat = await stat(filePath);
      if (!fileStat.isFile()) continue;

      const content = await readFileSafe(filePath);
      if (content !== null) {
        await this.indexFile(`memory/${entry}`, content);
      }
    }
  }

  /**
   * 删除某个文件的所有块。
   */
  removeFile(relativePath: string): void {
    this.store.deleteByPath(relativePath);
    this.store.deleteFile(relativePath);
  }
}

// ── 分块逻辑 ──────────────────────────────────────────────

interface RawChunk {
  text: string;
  startLine: number;
  endLine: number;
}

/**
 * 将文本按行边界切分为块。
 *
 * - 目标块大小：~chunkChars 字符
 * - 重叠：~overlapChars 字符
 * - 不在行中间断开
 */
function splitIntoChunks(content: string, chunkChars: number, overlapChars: number): RawChunk[] {
  const lines = content.split('\n');
  if (lines.length === 0) return [];

  const chunks: RawChunk[] = [];
  let startIdx = 0;

  while (startIdx < lines.length) {
    let charCount = 0;
    let endIdx = startIdx;

    // 向前推进直到达到块大小或文件结束
    while (endIdx < lines.length && charCount < chunkChars) {
      charCount += lines[endIdx].length + 1; // +1 for newline
      endIdx++;
    }

    const chunkLines = lines.slice(startIdx, endIdx);
    const text = chunkLines.join('\n').trim();

    if (text) {
      chunks.push({
        text,
        startLine: startIdx + 1,  // 1-based
        endLine: endIdx,           // 1-based, inclusive
      });
    }

    // 下一个块的起始位置：回退 overlap 的行数
    if (endIdx >= lines.length) break;

    let overlapCount = 0;
    let newStart = endIdx;
    while (newStart > startIdx && overlapCount < overlapChars) {
      newStart--;
      overlapCount += lines[newStart].length + 1;
    }

    startIdx = newStart;
  }

  return chunks;
}

// ── 工具函数 ──────────────────────────────────────────────

function sha256(content: string): string {
  return createHash('sha256').update(content, 'utf-8').digest('hex');
}

async function readFileSafe(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, 'utf-8');
  } catch {
    return null;
  }
}

async function readdirSafe(dirPath: string): Promise<string[]> {
  try {
    return await readdir(dirPath);
  } catch {
    return [];
  }
}
