import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { loadStore, updateStore } from './store.js';

describe('store', () => {
  let dir: string;
  let storePath: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'store-test-'));
    storePath = join(dir, 'sessions.json');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('returns empty object when file does not exist', () => {
    const store = loadStore(storePath);
    expect(store).toEqual({});
  });

  it('reads and writes correctly', async () => {
    await updateStore(storePath, (store) => {
      store['main'] = {
        sessionId: 'abc',
        sessionKey: 'main',
        sessionFile: 'abc.jsonl',
        createdAt: 1000,
        updatedAt: 1000,
      };
    });

    const store = loadStore(storePath);
    expect(store['main']).toBeDefined();
    expect(store['main']!.sessionId).toBe('abc');
  });

  it('handles concurrent writes without data loss', async () => {
    // 并发写入 3 个不同的 key
    await Promise.all([
      updateStore(storePath, (store) => {
        store['a'] = { sessionId: 'a', sessionKey: 'a', sessionFile: 'a.jsonl', createdAt: 1, updatedAt: 1 };
      }),
      updateStore(storePath, (store) => {
        store['b'] = { sessionId: 'b', sessionKey: 'b', sessionFile: 'b.jsonl', createdAt: 2, updatedAt: 2 };
      }),
      updateStore(storePath, (store) => {
        store['c'] = { sessionId: 'c', sessionKey: 'c', sessionFile: 'c.jsonl', createdAt: 3, updatedAt: 3 };
      }),
    ]);

    const store = loadStore(storePath);
    expect(Object.keys(store)).toHaveLength(3);
    expect(store['a']).toBeDefined();
    expect(store['b']).toBeDefined();
    expect(store['c']).toBeDefined();
  });
});
