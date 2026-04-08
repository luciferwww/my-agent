import { createRequire } from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

type SqliteMemoryStoreClass = typeof import('./sqlite-store.js').SqliteMemoryStore;
type SqliteMemoryStoreInstance = import('./sqlite-store.js').SqliteMemoryStore;

const require = createRequire(import.meta.url);
const hasBetterSqlite3 = canResolveBetterSqlite3();
const describeSqlite = hasBetterSqlite3 ? describe : describe.skip;

describeSqlite('SqliteMemoryStore', () => {
  let workspaceDir = '';
  let SqliteMemoryStore: SqliteMemoryStoreClass;
  let store: SqliteMemoryStoreInstance;

  beforeEach(async () => {
    ({ SqliteMemoryStore } = await import('./sqlite-store.js'));
    workspaceDir = await mkdtemp(join(tmpdir(), 'sqlite-memory-store-'));
    store = new SqliteMemoryStore(join(workspaceDir, 'memory.sqlite'));
  });

  afterEach(async () => {
    store.close();
    if (workspaceDir) {
      await rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it('stores and retrieves file metadata and meta values', () => {
    store.upsertFile('memory/today.md', {
      source: 'memory',
      hash: 'abc123',
      mtime: 123456,
      size: 42,
    });
    store.setMeta('embedding-model', 'mini-test-model');

    expect(store.getFile('memory/today.md')).toEqual({
      source: 'memory',
      hash: 'abc123',
      mtime: 123456,
      size: 42,
    });
    expect(store.getMeta('embedding-model')).toBe('mini-test-model');

    store.deleteFile('memory/today.md');

    expect(store.getFile('memory/today.md')).toBeUndefined();
  });

  it('supports FTS keyword search and path deletion', () => {
    store.upsertChunks([
      {
        id: 'memory:memory/alpha.md:1-2',
        path: 'memory/alpha.md',
        source: 'memory',
        content: 'alpha project roadmap',
        startLine: 1,
        endLine: 2,
        model: '',
        updatedAt: 1,
      },
      {
        id: 'memory:memory/beta.md:1-2',
        path: 'memory/beta.md',
        source: 'memory',
        content: 'beta rollout checklist',
        startLine: 1,
        endLine: 2,
        model: '',
        updatedAt: 1,
      },
    ]);

    const matches = store.searchByKeyword('alpha', 5);

    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatchObject({
      path: 'memory/alpha.md',
      content: 'alpha project roadmap',
      startLine: 1,
      endLine: 2,
    });
    expect(matches[0]?.score).toBeGreaterThan(0);

    store.deleteByPath('memory/alpha.md');

    expect(store.searchByKeyword('alpha', 5)).toEqual([]);
    expect(store.searchByKeyword('beta', 5)).toHaveLength(1);
  });

  it('searches stored vectors by cosine similarity and model id', () => {
    store.upsertChunks([
      {
        id: 'memory:memory/high.md:1-1',
        path: 'memory/high.md',
        source: 'memory',
        content: 'high similarity',
        startLine: 1,
        endLine: 1,
        embedding: [1, 0],
        model: 'model-a',
        updatedAt: 1,
      },
      {
        id: 'memory:memory/mid.md:1-1',
        path: 'memory/mid.md',
        source: 'memory',
        content: 'medium similarity',
        startLine: 1,
        endLine: 1,
        embedding: [0.6, 0.8],
        model: 'model-a',
        updatedAt: 1,
      },
      {
        id: 'memory:memory/other-model.md:1-1',
        path: 'memory/other-model.md',
        source: 'memory',
        content: 'filtered by model',
        startLine: 1,
        endLine: 1,
        embedding: [1, 0],
        model: 'model-b',
        updatedAt: 1,
      },
    ]);

    const matches = store.searchByVector([1, 0], 5, 'model-a');

    expect(matches).toHaveLength(2);
    expect(matches.map((match) => match.path)).toEqual(['memory/high.md', 'memory/mid.md']);
    expect(matches[0]?.score).toBeCloseTo(1);
    expect(matches[1]?.score).toBeCloseTo(0.6);
  });

  it('replaces existing chunks with the same id', () => {
    store.upsertChunks([
      {
        id: 'memory:memory/replace.md:1-1',
        path: 'memory/replace.md',
        source: 'memory',
        content: 'old content',
        startLine: 1,
        endLine: 1,
        model: '',
        updatedAt: 1,
      },
    ]);

    store.upsertChunks([
      {
        id: 'memory:memory/replace.md:1-1',
        path: 'memory/replace.md',
        source: 'memory',
        content: 'new content',
        startLine: 1,
        endLine: 1,
        model: '',
        updatedAt: 2,
      },
    ]);

    const matches = store.searchByKeyword('new', 5);
    expect(matches).toHaveLength(1);
    expect(matches[0]?.content).toBe('new content');
    expect(store.searchByKeyword('old', 5)).toEqual([]);
  });
});

function canResolveBetterSqlite3(): boolean {
  try {
    require.resolve('better-sqlite3');
    return true;
  } catch {
    return false;
  }
}