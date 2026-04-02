import { readFile, writeFile } from 'fs/promises';
import { withFileLock } from './lock.js';
import type { SessionStore } from './types.js';

/**
 * 读取 sessions.json。文件不存在返回空对象。
 */
export function loadStore(storePath: string): SessionStore {
  try {
    const { readFileSync } = require('fs') as typeof import('fs');
    const raw = readFileSync(storePath, 'utf-8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as SessionStore;
    }
    return {};
  } catch {
    return {};
  }
}

/**
 * 原子写入 sessions.json（带锁）。
 * 使用 mutator 函数模式，确保读-改-写的原子性。
 *
 * 参考 OpenClaw 的 updateSessionStore()（src/config/sessions/store.ts）。
 */
export async function updateStore<T>(
  storePath: string,
  mutator: (store: SessionStore) => T,
): Promise<T> {
  return withFileLock(storePath, async () => {
    const store = loadStore(storePath);
    const result = mutator(store);
    await writeFile(storePath, JSON.stringify(store, null, 2) + '\n', 'utf-8');
    return result;
  });
}
