import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./store/sqlite-store.js', () => ({
  SqliteMemoryStore: vi.fn(),
}));

vi.mock('./embedding/LocalEmbeddingProvider.js', () => ({
  createEmbeddingProvider: vi.fn(),
}));

import { MemoryIndexer } from './MemoryIndexer.js';
import { MemoryManager } from './MemoryManager.js';
import { MemorySearcher } from './MemorySearcher.js';
import { RecallTracker } from './RecallTracker.js';
import { createEmbeddingProvider } from './embedding/LocalEmbeddingProvider.js';
import { SqliteMemoryStore } from './store/sqlite-store.js';
import type { MemorySearchResult, MemoryStore } from './types.js';

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

function createManager(
  workspaceDir: string,
  store: MemoryStore,
  indexer: Pick<MemoryIndexer, 'indexAll' | 'indexFile'>,
  searcher: Pick<MemorySearcher, 'search'>,
  recallTracker: Pick<RecallTracker, 'record'>,
): MemoryManager {
  return Reflect.construct(MemoryManager as unknown as Function, [
    workspaceDir,
    store,
    indexer,
    searcher,
    recallTracker,
    null,
  ]) as MemoryManager;
}

describe('MemoryManager', () => {
  let workspaceDir = '';

  beforeEach(async () => {
    workspaceDir = await mkdtemp(join(tmpdir(), 'memory-manager-'));
    vi.clearAllMocks();
  });

  afterEach(async () => {
    if (workspaceDir) {
      await rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it('delegates search and records recall summaries', async () => {
    const store = createStore();
    const searchResults: MemorySearchResult[] = [
      {
        path: 'memory/plan.md',
        content: 'plan',
        startLine: 2,
        endLine: 5,
        score: 0.91,
        matchType: 'hybrid',
      },
    ];
    const searcher = { search: vi.fn().mockResolvedValue(searchResults) };
    const recallTracker = { record: vi.fn() };
    const manager = createManager(
      workspaceDir,
      store,
      { indexAll: vi.fn(), indexFile: vi.fn() },
      searcher,
      recallTracker,
    );

    const results = await manager.search('plan');

    expect(results).toEqual(searchResults);
    expect(searcher.search).toHaveBeenCalledWith('plan', undefined);
    expect(recallTracker.record).toHaveBeenCalledWith(
      expect.objectContaining({
        query: 'plan',
        results: [
          {
            path: 'memory/plan.md',
            startLine: 2,
            endLine: 5,
            score: 0.91,
          },
        ],
      }),
    );
  });

  it('reads either the full file or a selected line window', async () => {
    const store = createStore();
    const manager = createManager(
      workspaceDir,
      store,
      { indexAll: vi.fn(), indexFile: vi.fn() },
      { search: vi.fn().mockResolvedValue([]) },
      { record: vi.fn() },
    );
    await writeFile(join(workspaceDir, 'memory.md'), ['one', 'two', 'three', 'four'].join('\n'), 'utf-8');

    await expect(manager.readFile('memory.md')).resolves.toBe('one\ntwo\nthree\nfour');
    await expect(manager.readFile('memory.md', 2, 2)).resolves.toBe('two\nthree');
  });

  it('overwrites a file and reindexes the new content', async () => {
    const store = createStore();
    const indexer = { indexAll: vi.fn(), indexFile: vi.fn().mockResolvedValue(undefined) };
    const manager = createManager(
      workspaceDir,
      store,
      indexer,
      { search: vi.fn().mockResolvedValue([]) },
      { record: vi.fn() },
    );

    await manager.writeFile('memory/daily.md', 'fresh entry', 'overwrite');

    const filePath = join(workspaceDir, 'memory', 'daily.md');
    await expect(readFile(filePath, 'utf-8')).resolves.toBe('fresh entry');
    expect(indexer.indexFile).toHaveBeenCalledWith('memory/daily.md', 'fresh entry');
  });

  it('appends content with a separating newline and reindexes the full file', async () => {
    const store = createStore();
    const indexer = { indexAll: vi.fn(), indexFile: vi.fn().mockResolvedValue(undefined) };
    const manager = createManager(
      workspaceDir,
      store,
      indexer,
      { search: vi.fn().mockResolvedValue([]) },
      { record: vi.fn() },
    );
    const filePath = join(workspaceDir, 'memory', 'append.md');

    await mkdir(join(workspaceDir, 'memory'), { recursive: true });
    await writeFile(filePath, 'first line', 'utf-8');
    await manager.writeFile('memory/append.md', 'second line', 'append');

    await expect(readFile(filePath, 'utf-8')).resolves.toBe('first line\nsecond line');
    expect(indexer.indexFile).toHaveBeenCalledWith('memory/append.md', 'first line\nsecond line');
  });

  it('reindexes the workspace and closes the backing store', async () => {
    const store = createStore();
    const indexer = { indexAll: vi.fn().mockResolvedValue(undefined), indexFile: vi.fn() };
    const manager = createManager(
      workspaceDir,
      store,
      indexer,
      { search: vi.fn().mockResolvedValue([]) },
      { record: vi.fn() },
    );

    await manager.reindex();
    manager.close();

    expect(indexer.indexAll).toHaveBeenCalledWith(workspaceDir);
    expect(store.close).toHaveBeenCalledTimes(1);
  });

  it('create() wires the default sqlite path, components, and initial indexing', async () => {
    const store = createStore();
    vi.mocked(SqliteMemoryStore).mockImplementation(() => store as never);
    vi.mocked(createEmbeddingProvider).mockResolvedValue(null);
    const indexAllSpy = vi.spyOn(MemoryIndexer.prototype, 'indexAll').mockResolvedValue(undefined);

    const manager = await MemoryManager.create({ workspaceDir });

    expect(createEmbeddingProvider).toHaveBeenCalledWith(undefined);
    expect(SqliteMemoryStore).toHaveBeenCalledWith(join(workspaceDir, '.agent', 'memory.sqlite'));
    expect(indexAllSpy).toHaveBeenCalledWith(workspaceDir);
    expect((manager as unknown as { workspaceDir: string }).workspaceDir).toBe(workspaceDir);
    expect((manager as unknown as { store: MemoryStore }).store).toBe(store);
    expect((manager as unknown as { embeddingProvider: unknown }).embeddingProvider).toBeNull();
  });

  it('create() respects a custom dbPath and passes through the embedding provider', async () => {
    const store = createStore();
    const embeddingProvider = { embed: vi.fn(), dimensions: 3, modelId: 'mock-model' };
    const dbPath = join(workspaceDir, 'var', 'memory', 'custom.sqlite');

    vi.mocked(SqliteMemoryStore).mockImplementation(() => store as never);
    vi.mocked(createEmbeddingProvider).mockResolvedValue(embeddingProvider);
    const indexAllSpy = vi.spyOn(MemoryIndexer.prototype, 'indexAll').mockResolvedValue(undefined);

    const manager = await MemoryManager.create({
      workspaceDir,
      dbPath,
      embedding: { provider: 'local', model: 'custom-model' },
    });

    expect(createEmbeddingProvider).toHaveBeenCalledWith({ provider: 'local', model: 'custom-model' });
    expect(SqliteMemoryStore).toHaveBeenCalledWith(dbPath);
    expect(indexAllSpy).toHaveBeenCalledWith(workspaceDir);
    expect((manager as unknown as { embeddingProvider: unknown }).embeddingProvider).toBe(embeddingProvider);
    await expect(readFile(dbPath, 'utf-8')).rejects.toThrow();
  });
});