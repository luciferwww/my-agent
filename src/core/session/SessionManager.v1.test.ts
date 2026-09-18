import { randomUUID } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SessionError } from './errors.js';
import { withFileLock } from './lock.js';
import { SessionManager } from './SessionManager.js';

describe('SessionManager v1 persistence', () => {
  let agentHome: string;
  let manager: SessionManager;
  let now: number;

  beforeEach(async () => {
    agentHome = await mkdtemp(join(tmpdir(), 'session-manager-v1-test-'));
    now = 200;
    manager = new SessionManager(agentHome, { now: () => now });
  });

  afterEach(async () => {
    await rm(agentHome, { recursive: true, force: true });
  });

  async function materialize(title?: string): Promise<string> {
    const sessionId = randomUUID();
    await manager.materializeSession({
      sessionId,
      createdAt: 100,
      ...(title === undefined ? {} : { title }),
    });
    await manager.appendMessage(sessionId, { role: 'user', content: 'hello' });
    return sessionId;
  }

  it('materializes metadata and a Transcript root without writing a user message', async () => {
    const sessionId = randomUUID();
    await manager.materializeSession({ sessionId, createdAt: 100, title: 'First' });

    expect(manager.getSession(sessionId)).toEqual({
      sessionId,
      title: 'First',
      createdAt: 100,
      updatedAt: 200,
    });
    expect(manager.getMessages(sessionId)).toEqual([]);

    const transcript = await readFile(
      join(agentHome, 'sessions', `${sessionId}.jsonl`),
      'utf8',
    );
    expect(transcript.trim().split('\n')).toHaveLength(1);
  });

  it('lists active and archived Sessions separately and deterministically', async () => {
    const firstId = await materialize('Same title');
    now = 300;
    const secondId = await materialize('Same title');
    await manager.archiveSession(secondId);

    expect(manager.listSessions().map((entry) => entry.sessionId)).toEqual([firstId]);
    expect(manager.listSessions({ archived: true }).map((entry) => entry.sessionId)).toEqual([
      secondId,
    ]);

    now = 400;
    await manager.unarchiveSession(secondId);
    expect(manager.listSessions().map((entry) => entry.sessionId)).toEqual([
      secondId,
      firstId,
    ]);
  });

  it('keeps a transient Subagent Transcript out of Session discovery', async () => {
    const callerSessionId = await materialize('Caller');
    const childSessionId = randomUUID();

    await manager.createTransientSubagentTranscript({
      sessionId: childSessionId,
      callerSessionId,
      createdAt: 250,
    });

    expect(manager.getSession(childSessionId)).toBeUndefined();
    expect(manager.listSessions().map((entry) => entry.sessionId)).toEqual([callerSessionId]);
    expect(manager.getMessages(childSessionId)).toEqual([]);

    await manager.appendMessage(childSessionId, { role: 'user', content: 'delegated work' });
    expect(manager.getMessages(childSessionId)[0]?.message.content).toBe('delegated work');

    const transcriptPath = join(agentHome, 'sessions', `${childSessionId}.jsonl`);
    const [root] = (await readFile(transcriptPath, 'utf8')).trim().split('\n');
    expect(JSON.parse(root!)).toMatchObject({
      type: 'session',
      provenance: { type: 'subagent', callerSessionId },
    });

    await manager.appendMessage(childSessionId, { role: 'assistant', content: 'done' });
    expect(manager.getMessages(childSessionId)).toHaveLength(2);

    await manager.deleteTransientSubagentTranscript(childSessionId);
    await expect(access(transcriptPath)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(() => manager.getMessages(childSessionId)).toThrowError(SessionError);
  });

  it('renames and clears a title without exposing arbitrary metadata updates', async () => {
    const sessionId = await materialize();
    now = 300;

    await expect(manager.renameSession(sessionId, { title: '   ' })).rejects.toMatchObject({
      code: 'SESSION_TITLE_INVALID',
    });
    expect(await manager.renameSession(sessionId, { title: '  Renamed  ' })).toMatchObject({
      title: 'Renamed',
      updatedAt: 300,
    });
    expect(await manager.renameSession(sessionId, { title: null })).not.toHaveProperty('title');
  });

  it('rejects unknown or malformed identities without creating resources', async () => {
    await expect(manager.renameSession(randomUUID(), { title: 'Nope' })).rejects.toMatchObject({
      code: 'SESSION_NOT_FOUND',
    });
    await expect(manager.materializeSession({
      sessionId: '../outside',
      createdAt: 100,
    })).rejects.toBeInstanceOf(SessionError);
    expect(manager.listSessions()).toEqual([]);
  });

  it('forks selected linear history and protects the source from deletion', async () => {
    const sourceId = await materialize('Source');
    const secondMessageId = await manager.appendMessage(sourceId, {
      role: 'assistant',
      content: 'reply',
    });
    await manager.appendMessage(sourceId, { role: 'user', content: 'later' });

    const fork = await manager.forkSession(sourceId, secondMessageId);

    expect(fork).toMatchObject({ forkedFromSessionId: sourceId, title: 'Source' });
    expect(manager.getMessages(fork.sessionId).map((message) => message.message.content)).toEqual([
      'hello',
      'reply',
    ]);
    await expect(manager.deleteSession(sourceId)).rejects.toMatchObject({
      code: 'SESSION_HAS_DESCENDANTS',
    });
  });

  it('removes temporary and unindexed Transcript artifacts at initialization', async () => {
    const indexedId = await materialize();
    const orphanId = randomUUID();
    const sessionsDir = join(agentHome, 'sessions');
    await mkdir(sessionsDir, { recursive: true });
    await writeFile(join(sessionsDir, `${orphanId}.jsonl`), 'orphan\n');
    await writeFile(join(sessionsDir, `${orphanId}.${randomUUID()}.tmp`), 'temporary\n');

    await manager.initialize();

    expect(await readdir(sessionsDir)).toEqual(expect.arrayContaining([
      `${indexedId}.jsonl`,
      'sessions.json',
    ]));
    expect(await readdir(sessionsDir)).not.toEqual(expect.arrayContaining([
      `${orphanId}.jsonl`,
    ]));
    expect((await readdir(sessionsDir)).some((name) => name.endsWith('.tmp'))).toBe(false);
  });

  it('leaves no visible Session after Store commit failure and permits retry', async () => {
    const sessionId = randomUUID();
    const sessionsDir = join(agentHome, 'sessions');
    const storePath = join(sessionsDir, 'sessions.json');
    const transcriptPath = join(sessionsDir, `${sessionId}.jsonl`);
    await mkdir(sessionsDir);

    let materialization!: Promise<unknown>;
    await withFileLock(storePath, async () => {
      materialization = manager.materializeSession({
        sessionId,
        createdAt: 100,
      });
      await waitForPath(transcriptPath);
      await mkdir(storePath);
    });

    await expect(materialization).rejects.toMatchObject({ code: 'SESSION_PERSISTENCE_FAILED' });
  await rm(storePath, { recursive: true });
    expect(manager.getSession(sessionId)).toBeUndefined();
    await expect(access(transcriptPath)).rejects.toMatchObject({ code: 'ENOENT' });

    await expect(manager.materializeSession({
      sessionId,
      createdAt: 100,
    })).resolves.toMatchObject({ sessionId });
    expect(manager.getMessages(sessionId)).toHaveLength(0);
  });
});

async function waitForPath(path: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      await access(path);
      return;
    } catch {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }
  throw new Error(`Timed out waiting for ${path}.`);
}