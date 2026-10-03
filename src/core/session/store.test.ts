import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { loadStore, SessionDataError, updateStore } from './store.js';

describe('Session Store', () => {
  let root: string;
  let storePath: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'session-store-test-'));
    const sessionsDir = join(root, 'sessions');
    await mkdir(sessionsDir);
    storePath = join(sessionsDir, 'sessions.json');
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('returns an empty versioned Store when the file is absent', () => {
    expect(loadStore(storePath)).toEqual({ version: 1, sessions: {} });
  });

  it('atomically persists the versioned Store wrapper', async () => {
    const sessionId = randomUUID();
    await updateStore(storePath, (store) => {
      store.sessions[sessionId] = {
        sessionId,
        title: 'First session',
        createdAt: 10,
        updatedAt: 10,
      };
    });

    expect(loadStore(storePath).sessions[sessionId]).toEqual({
      sessionId,
      title: 'First session',
      createdAt: 10,
      updatedAt: 10,
    });
    expect(JSON.parse(await readFile(storePath, 'utf8'))).toHaveProperty('version', 1);
  });

  it('rejects the prior unversioned Store format', async () => {
    const sessionId = randomUUID();
    await writeFile(storePath, JSON.stringify({
      main: { sessionId, sessionKey: 'main', sessionFile: `${sessionId}.jsonl` },
    }));

    expect(() => loadStore(storePath)).toThrowError(SessionDataError);
  });

  it('rejects key mismatches and unknown fork source references', async () => {
    const sessionId = randomUUID();
    const otherId = randomUUID();
    await writeFile(storePath, JSON.stringify({
      version: 1,
      sessions: {
        [sessionId]: {
          sessionId: otherId,
          createdAt: 10,
          updatedAt: 10,
        },
      },
    }));
    expect(() => loadStore(storePath)).toThrowError(SessionDataError);

    await writeFile(storePath, JSON.stringify({
      version: 1,
      sessions: {
        [sessionId]: {
          sessionId,
          createdAt: 10,
          updatedAt: 10,
          forkedFromSessionId: otherId,
        },
      },
    }));
    expect(() => loadStore(storePath)).toThrowError(SessionDataError);
  });

  it('serializes concurrent writes without data loss', async () => {
    const sessionIds = [randomUUID(), randomUUID(), randomUUID()];
    await Promise.all(sessionIds.map((sessionId, index) => (
      updateStore(storePath, (store) => {
        store.sessions[sessionId] = {
          sessionId,
          createdAt: index + 1,
          updatedAt: index + 1,
        };
      })
    )));

    const store = loadStore(storePath);
    expect(Object.keys(store.sessions)).toHaveLength(3);
    for (const sessionId of sessionIds) {
      expect(store.sessions[sessionId]).toBeDefined();
    }
  });
});
