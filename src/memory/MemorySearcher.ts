import type { MemoryStore, MemorySearchResult, SearchOptions, EmbeddingProvider } from './types.js';

const DEFAULT_MAX_RESULTS = 6;
const DEFAULT_MIN_SCORE = 0.25;
const DEFAULT_VECTOR_WEIGHT = 0.7;
const DEFAULT_TEXT_WEIGHT = 0.3;

/**
 * 混合搜索器。
 *
 * 同时利用向量语义搜索和 BM25 关键词搜索，加权合并结果。
 * 无嵌入能力时自动降级为纯关键词搜索。
 */
export class MemorySearcher {
  private store: MemoryStore;
  private embeddingProvider: EmbeddingProvider | null;

  constructor(store: MemoryStore, embeddingProvider: EmbeddingProvider | null) {
    this.store = store;
    this.embeddingProvider = embeddingProvider;
  }

  async search(query: string, options?: SearchOptions): Promise<MemorySearchResult[]> {
    const maxResults = options?.maxResults ?? DEFAULT_MAX_RESULTS;
    const minScore = options?.minScore ?? DEFAULT_MIN_SCORE;
    const vectorWeight = options?.hybrid?.vectorWeight ?? DEFAULT_VECTOR_WEIGHT;
    const textWeight = options?.hybrid?.textWeight ?? DEFAULT_TEXT_WEIGHT;

    if (!this.embeddingProvider) {
      // 降级：纯关键词搜索
      return this.keywordOnly(query, maxResults, minScore);
    }

    // 混合搜索
    return this.hybridSearch(query, maxResults, minScore, vectorWeight, textWeight);
  }

  // ── 内部方法 ──────────────────────────────────────────

  private async hybridSearch(
    query: string,
    maxResults: number,
    minScore: number,
    vectorWeight: number,
    textWeight: number,
  ): Promise<MemorySearchResult[]> {
    const provider = this.embeddingProvider!;
    const fetchK = maxResults * 2; // 多取一些，合并后再截取

    // 1. 查询向量化
    const [queryVector] = await provider.embed([query]);

    // 2. 并行：向量搜索 + 关键词搜索
    const [vectorResults, keywordResults] = await Promise.all([
      Promise.resolve(this.store.searchByVector(queryVector, fetchK, provider.modelId)),
      Promise.resolve(this.safeKeywordSearch(query, fetchK)),
    ]);

    // 3. 分数归一化到 0-1
    const normalizedVector = normalizeScores(vectorResults.map((r) => ({ id: r.id, score: r.score })));
    const normalizedKeyword = normalizeScores(keywordResults.map((r) => ({ id: r.id, score: r.score })));

    // 4. 加权合并 + 去重
    const merged = new Map<string, { score: number; matchType: MemorySearchResult['matchType'] }>();

    for (const item of normalizedVector) {
      const existing = merged.get(item.id);
      const weighted = item.score * vectorWeight;
      if (!existing || weighted > existing.score) {
        merged.set(item.id, { score: weighted, matchType: 'vector' });
      }
    }

    for (const item of normalizedKeyword) {
      const existing = merged.get(item.id);
      const weighted = item.score * textWeight;
      if (existing) {
        // 两路都命中 → hybrid，分数相加
        merged.set(item.id, {
          score: existing.score + weighted,
          matchType: 'hybrid',
        });
      } else {
        merged.set(item.id, { score: weighted, matchType: 'keyword' });
      }
    }

    // 5. 构建结果，从原始数据中获取内容
    const allResults = [...vectorResults, ...keywordResults];
    const contentMap = new Map(allResults.map((r) => [r.id, r]));

    const results: MemorySearchResult[] = [];
    for (const [id, { score, matchType }] of merged) {
      if (score < minScore) continue;

      const chunk = contentMap.get(id);
      if (!chunk) continue;

      results.push({
        path: chunk.path,
        content: chunk.content,
        startLine: chunk.startLine,
        endLine: chunk.endLine,
        score,
        matchType,
      });
    }

    // 6. 排序 + 截取
    results.sort((a, b) => b.score - a.score);
    return results.slice(0, maxResults);
  }

  private keywordOnly(
    query: string,
    maxResults: number,
    minScore: number,
  ): MemorySearchResult[] {
    const results = this.safeKeywordSearch(query, maxResults);
    const normalized = normalizeScores(results.map((r) => ({ id: r.id, score: r.score })));
    const scoreMap = new Map(normalized.map((n) => [n.id, n.score]));

    return results
      .map((r) => ({
        path: r.path,
        content: r.content,
        startLine: r.startLine,
        endLine: r.endLine,
        score: scoreMap.get(r.id) ?? 0,
        matchType: 'keyword' as const,
      }))
      .filter((r) => r.score >= minScore)
      .slice(0, maxResults);
  }

  /**
   * 安全的关键词搜索。FTS5 MATCH 语法对特殊字符敏感，
   * 出错时返回空数组而非抛异常。
   */
  private safeKeywordSearch(query: string, topK: number) {
    try {
      return this.store.searchByKeyword(query, topK);
    } catch {
      return [];
    }
  }
}

// ── 工具函数 ──────────────────────────────────────────────

/** Min-max 归一化分数到 0-1 */
function normalizeScores(items: Array<{ id: string; score: number }>): Array<{ id: string; score: number }> {
  if (items.length === 0) return [];

  const scores = items.map((i) => i.score);
  const min = Math.min(...scores);
  const max = Math.max(...scores);
  const range = max - min;

  if (range === 0) {
    // 所有分数相同，全部归一化为 1
    return items.map((i) => ({ id: i.id, score: 1 }));
  }

  return items.map((i) => ({
    id: i.id,
    score: (i.score - min) / range,
  }));
}
