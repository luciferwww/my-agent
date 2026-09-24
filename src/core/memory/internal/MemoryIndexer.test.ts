import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MemoryIndexer } from './MemoryIndexer.js';
import type { EmbeddingProvider, MemoryStore } from '../types.js';

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

describe('MemoryIndexer', () => {
  let agentHome = '';

  beforeEach(async () => {
    agentHome = await mkdtemp(join(tmpdir(), 'memory-indexer-'));
  });

  afterEach(async () => {
    if (agentHome) {
      await rm(agentHome, { recursive: true, force: true });
    }
  });

  it('indexes a file into chunks and stores file metadata', async () => {
    const store = createStore();
    const embeddingProvider: EmbeddingProvider = {
      embed: vi.fn().mockResolvedValue([[0.1, 0.2, 0.3]]),
      dimensions: 3,
      modelId: 'mini-test-model',
    };
    const indexer = new MemoryIndexer(store, embeddingProvider);
    const content = ['# Title', '', 'alpha', 'beta'].join('\n');

    await indexer.indexFile('memory/today.md', content);

    expect(store.deleteByPath).toHaveBeenCalledWith('memory/today.md');
    expect(embeddingProvider.embed).toHaveBeenCalledWith([content]);
    expect(store.upsertChunks).toHaveBeenCalledTimes(1);

    const chunks = vi.mocked(store.upsertChunks).mock.calls[0]?.[0];
    expect(chunks).toHaveLength(1);
    expect(chunks?.[0]).toMatchObject({
      id: 'memory:memory/today.md:1-4',
      path: 'memory/today.md',
      source: 'memory',
      content,
      startLine: 1,
      endLine: 4,
      embedding: [0.1, 0.2, 0.3],
      model: 'mini-test-model',
    });

    expect(store.upsertFile).toHaveBeenCalledWith(
      'memory/today.md',
      expect.objectContaining({
        source: 'memory',
        hash: createHash('sha256').update(content, 'utf-8').digest('hex'),
        size: Buffer.byteLength(content, 'utf-8'),
      }),
    );
    expect(store.setMeta).toHaveBeenCalledWith(
      'memory-chunking:memory/today.md',
      '1600:320',
    );
  });

  it('skips indexing when the file hash is unchanged', async () => {
    const content = 'same content';
    const store = createStore({
      getFile: vi.fn().mockReturnValue({
        source: 'memory',
        hash: createHash('sha256').update(content, 'utf-8').digest('hex'),
        mtime: 1,
        size: Buffer.byteLength(content, 'utf-8'),
      }),
      getMeta: vi.fn().mockReturnValue('1600:320'),
    });

    const embeddingProvider: EmbeddingProvider = {
      embed: vi.fn().mockResolvedValue([[1, 2, 3]]),
      dimensions: 3,
      modelId: 'mini-test-model',
    };
    const indexer = new MemoryIndexer(store, embeddingProvider);

    await indexer.indexFile('memory/stable.md', content);

    expect(store.deleteByPath).not.toHaveBeenCalled();
    expect(store.upsertChunks).not.toHaveBeenCalled();
    expect(store.upsertFile).not.toHaveBeenCalled();
    expect(embeddingProvider.embed).not.toHaveBeenCalled();
  });

  it('uses configured chunking values to change produced boundaries', async () => {
    const content = ['aaaa', 'bbbb', 'cccc', 'dddd'].join('\n');
    const defaultStore = createStore();
    const configuredStore = createStore();

    await new MemoryIndexer(defaultStore, null).indexFile('memory/chunks.md', content);
    await new MemoryIndexer(
      configuredStore,
      null,
      { chunkChars: 9, overlapChars: 1 },
    ).indexFile('memory/chunks.md', content);

    const defaultChunks = vi.mocked(defaultStore.upsertChunks).mock.calls[0]?.[0];
    const configuredChunks = vi.mocked(configuredStore.upsertChunks).mock.calls[0]?.[0];
    expect(defaultChunks?.map(({ startLine, endLine }) => [startLine, endLine]))
      .toEqual([[1, 4]]);
    expect(configuredChunks?.map(({ startLine, endLine }) => [startLine, endLine]))
      .toEqual([[1, 2], [2, 3], [3, 4]]);
  });

  it('reindexes unchanged content when chunking configuration changes', async () => {
    const content = ['aaaa', 'bbbb', 'cccc'].join('\n');
    const store = createStore({
      getFile: vi.fn().mockReturnValue({
        source: 'memory',
        hash: createHash('sha256').update(content, 'utf-8').digest('hex'),
        mtime: 1,
        size: Buffer.byteLength(content, 'utf-8'),
      }),
      getMeta: vi.fn().mockReturnValue('1600:320'),
    });

    await new MemoryIndexer(
      store,
      null,
      { chunkChars: 9, overlapChars: 1 },
    ).indexFile('memory/chunks.md', content);

    expect(store.deleteByPath).toHaveBeenCalledWith('memory/chunks.md');
    expect(store.upsertChunks).toHaveBeenCalled();
    expect(store.setMeta).toHaveBeenCalledWith('memory-chunking:memory/chunks.md', '9:1');
  });

  it('advances after a line longer than the chunk size', async () => {
    const store = createStore();
    const content = ['abcdefghijk', 'next', 'last'].join('\n');

    await new MemoryIndexer(
      store,
      null,
      { chunkChars: 10, overlapChars: 9 },
    ).indexFile('memory/oversized.md', content);

    const chunks = vi.mocked(store.upsertChunks).mock.calls[0]?.[0];
    expect(chunks?.map(({ startLine, endLine }) => [startLine, endLine]))
      .toEqual([[1, 1], [2, 3]]);
  });

  it('indexes MEMORY.md and top-level markdown files under memory/', async () => {
    await mkdir(join(agentHome, 'memory', 'nested'), { recursive: true });
    await writeFile(join(agentHome, 'MEMORY.md'), '# Root memory\n', 'utf-8');
    await writeFile(join(agentHome, 'memory', '2026-04-07.md'), '# Daily\n', 'utf-8');
    await writeFile(join(agentHome, 'memory', 'ignore.txt'), 'skip\n', 'utf-8');
    await writeFile(join(agentHome, 'memory', 'nested', 'deep.md'), '# Nested\n', 'utf-8');

    const indexer = new MemoryIndexer(createStore(), null);
    const indexFileSpy = vi.spyOn(indexer, 'indexFile').mockResolvedValue();

    await indexer.indexAll(agentHome);

    expect(indexFileSpy).toHaveBeenCalledTimes(2);
    expect(indexFileSpy).toHaveBeenCalledWith('MEMORY.md', '# Root memory\n');
    expect(indexFileSpy).toHaveBeenCalledWith('memory/2026-04-07.md', '# Daily\n');
  });

  it('removes a file from both chunk and file indexes', () => {
    const store = createStore();
    const indexer = new MemoryIndexer(store, null);

    indexer.removeFile('memory/old.md');

    expect(store.deleteByPath).toHaveBeenCalledWith('memory/old.md');
    expect(store.deleteFile).toHaveBeenCalledWith('memory/old.md');
  });
});