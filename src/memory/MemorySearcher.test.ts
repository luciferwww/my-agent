import { describe, expect, it, vi } from 'vitest';

import { MemorySearcher } from './MemorySearcher.js';
import type { EmbeddingProvider, MemoryStore } from './types.js';

function createStore(overrides: Partial<MemoryStore> = {}): MemoryStore {
  return {
    upsertChunks: vi.fn(),
    deleteByPath: vi.fn(),
    searchByVector: vi.fn().mockReturnValue([]),
    searchByKeyword: vi.fn().mockReturnValue([]),
    getFile: vi.fn(),
    upsertFile: vi.fn(),
    deleteFile: vi.fn(),
    getMeta: vi.fn(),
    setMeta: vi.fn(),
    close: vi.fn(),
    ...overrides,
  };
}

describe('MemorySearcher', () => {
  it('falls back to keyword search when embeddings are unavailable', async () => {
    const store = createStore({
      searchByKeyword: vi.fn().mockReturnValue([
        {
          id: 'chunk-a',
          path: 'memory/a.md',
          source: 'memory',
          content: 'alpha beta',
          startLine: 1,
          endLine: 2,
          updatedAt: 0,
          score: 10,
        },
        {
          id: 'chunk-b',
          path: 'memory/b.md',
          source: 'memory',
          content: 'beta gamma',
          startLine: 3,
          endLine: 4,
          updatedAt: 0,
          score: 5,
        },
      ]),
    });

    const searcher = new MemorySearcher(store, null);
    const results = await searcher.search('alpha', { maxResults: 2, minScore: 0.1 });

    expect(store.searchByKeyword).toHaveBeenCalledWith('alpha', 2);
    expect(results).toEqual([
      {
        path: 'memory/a.md',
        content: 'alpha beta',
        startLine: 1,
        endLine: 2,
        score: 1,
        matchType: 'keyword',
      },
    ]);
  });

  it('returns an empty result set when keyword search throws', async () => {
    const store = createStore({
      searchByKeyword: vi.fn().mockImplementation(() => {
        throw new Error('invalid FTS query');
      }),
    });

    const searcher = new MemorySearcher(store, null);
    const results = await searcher.search('title:"[broken]"');

    expect(results).toEqual([]);
  });

  it('merges vector and keyword matches into ranked hybrid results', async () => {
    const store = createStore({
      searchByVector: vi.fn().mockReturnValue([
        {
          id: 'shared',
          path: 'memory/shared.md',
          source: 'memory',
          content: 'shared chunk',
          startLine: 1,
          endLine: 3,
          updatedAt: 0,
          score: 0.9,
        },
        {
          id: 'vector-only',
          path: 'memory/vector.md',
          source: 'memory',
          content: 'vector chunk',
          startLine: 4,
          endLine: 6,
          updatedAt: 0,
          score: 0.6,
        },
        {
          id: 'vector-low',
          path: 'memory/low.md',
          source: 'memory',
          content: 'low vector chunk',
          startLine: 7,
          endLine: 9,
          updatedAt: 0,
          score: 0.3,
        },
      ]),
      searchByKeyword: vi.fn().mockReturnValue([
        {
          id: 'shared',
          path: 'memory/shared.md',
          source: 'memory',
          content: 'shared chunk',
          startLine: 1,
          endLine: 3,
          updatedAt: 0,
          score: 8,
        },
        {
          id: 'keyword-only',
          path: 'memory/keyword.md',
          source: 'memory',
          content: 'keyword chunk',
          startLine: 10,
          endLine: 12,
          updatedAt: 0,
          score: 6,
        },
        {
          id: 'keyword-low',
          path: 'memory/other.md',
          source: 'memory',
          content: 'other keyword chunk',
          startLine: 13,
          endLine: 15,
          updatedAt: 0,
          score: 4,
        },
      ]),
    });
    const embeddingProvider: EmbeddingProvider = {
      embed: vi.fn().mockResolvedValue([[1, 0, 0]]),
      dimensions: 3,
      modelId: 'test-model',
    };

    const searcher = new MemorySearcher(store, embeddingProvider);
    const results = await searcher.search('shared topic', {
      maxResults: 3,
      minScore: 0.2,
      hybrid: { vectorWeight: 0.8, textWeight: 0.5 },
    });

    expect(embeddingProvider.embed).toHaveBeenCalledWith(['shared topic']);
    expect(store.searchByVector).toHaveBeenCalledWith([1, 0, 0], 6, 'test-model');
    expect(store.searchByKeyword).toHaveBeenCalledWith('shared topic', 6);

    expect(results.map((result) => result.path)).toEqual([
      'memory/shared.md',
      'memory/vector.md',
      'memory/keyword.md',
    ]);
    expect(results.map((result) => result.matchType)).toEqual(['hybrid', 'vector', 'keyword']);
    expect(results[0]?.score).toBeCloseTo(1.3);
    expect(results[1]?.score).toBeCloseTo(0.4);
    expect(results[2]?.score).toBeCloseTo(0.25);
  });
});