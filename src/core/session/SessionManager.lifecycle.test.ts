import { randomUUID } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionError } from './errors.js';
import { withFileLock } from './lock.js';
import { SessionManager } from './SessionManager.js';

describe('SessionManager lifecycle persistence', () => {
  let agentHome: string;
  let manager: SessionManager;
  let now: number;

  beforeEach(async () => {
    agentHome = await mkdtemp(join(tmpdir(), 'session-manager-lifecycle-test-'));
    now = 200;
    manager = new SessionManager(agentHome, { now: () => now });
  });

  afterEach(async () => {
    vi.useRealTimers();
    await manager.close().catch(() => undefined);
    await rm(agentHome, { recursive: true, force: true });
  });

  async function materialize(title?: string): Promise<string> {
    const sessionId = randomUUID();
    await manager.materializeSession({
      sessionId,
      createdAt: 100,
      ...(title === undefined ? {} : { title }),
    });
    await manager.appendMessage(sessionId, {
      turnId: 'turn-materialize',
      role: 'user',
      content: 'hello',
    });
    return sessionId;
  }

  it('materializes metadata and a Transcript root without writing a user message', async () => {
    const sessionId = randomUUID();
    await manager.materializeSession({ sessionId, createdAt: 100, title: 'First' });

    expect(manager.getPersistedSession(sessionId)).toEqual({
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

    manager.registerPreparingSubagentSession({
      sessionId: childSessionId,
      callerSessionId,
      createdAt: 250,
    });
    expect(manager.resolveSession(childSessionId)).toEqual({
      kind: 'subagent',
      sessionId: childSessionId,
    });
    await manager.createTransientSubagentTranscript({
      sessionId: childSessionId,
      callerSessionId,
      createdAt: 250,
    });

    expect(manager.getPersistedSession(childSessionId)).toBeUndefined();
    expect(manager.resolveSession(childSessionId)).toEqual({
      kind: 'subagent',
      sessionId: childSessionId,
      entry: { sessionId: childSessionId, callerSessionId, createdAt: 250 },
    });
    expect(manager.listSessions().map((entry) => entry.sessionId)).toEqual([callerSessionId]);
    expect(manager.getMessages(childSessionId)).toEqual([]);
    const store = JSON.parse(await readFile(
      join(agentHome, 'sessions', 'sessions.json'),
      'utf8',
    ));
    expect(store.sessions[childSessionId]).toEqual({
      kind: 'subagent',
      sessionId: childSessionId,
      callerSessionId,
      createdAt: 250,
      updatedAt: 250,
    });

    await manager.appendMessage(childSessionId, {
      turnId: 'child-turn',
      role: 'user',
      content: 'delegated work',
    });
    expect(manager.getMessages(childSessionId)[0]?.message.content).toBe('delegated work');

    const transcriptPath = join(agentHome, 'sessions', `${childSessionId}.jsonl`);
    const [root] = (await readFile(transcriptPath, 'utf8')).trim().split('\n');
    expect(JSON.parse(root!)).toMatchObject({
      type: 'session',
      provenance: { type: 'subagent', callerSessionId },
    });

    await manager.appendMessage(childSessionId, {
      turnId: 'child-turn',
      role: 'assistant',
      content: 'done',
    });
    expect(manager.getMessages(childSessionId)).toHaveLength(2);

    await manager.deleteTransientSubagentTranscript(childSessionId);
    await expect(access(transcriptPath)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(() => manager.getMessages(childSessionId)).toThrowError(SessionError);
  });

  it('retains a terminal Subagent Transcript for 24 hours without extending on reads', async () => {
    vi.useFakeTimers();
    const callerSessionId = await materialize('Caller');
    const childSessionId = randomUUID();
    manager.registerPreparingSubagentSession({
      sessionId: childSessionId,
      callerSessionId,
      createdAt: 250,
    });
    await manager.createTransientSubagentTranscript({
      sessionId: childSessionId,
      callerSessionId,
      createdAt: 250,
    });
    await manager.appendMessage(childSessionId, {
      turnId: 'child-turn',
      role: 'assistant',
      content: 'retained result',
    });

    await manager.retainTransientSubagentTranscript(childSessionId);
    await vi.advanceTimersByTimeAsync(12 * 60 * 60 * 1000);
    expect(manager.resolveSession(childSessionId)?.kind).toBe('subagent');
    expect(manager.getMessages(childSessionId)[0]?.message.content).toBe('retained result');

    await vi.advanceTimersByTimeAsync((12 * 60 * 60 * 1000) - 1);
    expect(manager.resolveSession(childSessionId)?.kind).toBe('subagent');

    await vi.advanceTimersByTimeAsync(1);
    await vi.waitFor(() => expect(manager.resolveSession(childSessionId)).toBeUndefined());
    expect(() => manager.getMessages(childSessionId)).toThrowError(SessionError);
  });

  it('cancels retention when a transient Subagent Transcript is deleted explicitly', async () => {
    vi.useFakeTimers();
    const callerSessionId = await materialize('Caller');
    const childSessionId = randomUUID();
    manager.registerPreparingSubagentSession({
      sessionId: childSessionId,
      callerSessionId,
      createdAt: 250,
    });
    await manager.createTransientSubagentTranscript({
      sessionId: childSessionId,
      callerSessionId,
      createdAt: 250,
    });
    await manager.retainTransientSubagentTranscript(childSessionId);

    await manager.deleteTransientSubagentTranscript(childSessionId);
    expect(vi.getTimerCount()).toBe(0);
    expect(manager.resolveSession(childSessionId)).toBeUndefined();
    await expect(access(join(agentHome, 'sessions', `${childSessionId}.jsonl`)))
      .rejects.toMatchObject({ code: 'ENOENT' });
    const store = JSON.parse(await readFile(
      join(agentHome, 'sessions', 'sessions.json'),
      'utf8',
    ));
    expect(store.sessions[childSessionId]).toBeUndefined();
  });

  it('restores an unexpired retained Subagent after the manager restarts', async () => {
    vi.useFakeTimers();
    const callerSessionId = await materialize('Caller');
    const childSessionId = randomUUID();
    manager.registerPreparingSubagentSession({
      sessionId: childSessionId,
      callerSessionId,
      createdAt: 250,
    });
    await manager.createTransientSubagentTranscript({
      sessionId: childSessionId,
      callerSessionId,
      createdAt: 250,
    });
    await manager.appendMessage(childSessionId, {
      turnId: 'child-turn',
      role: 'assistant',
      content: 'retained across restart',
    });
    now = 1_000;
    await manager.retainTransientSubagentTranscript(childSessionId, 'ok');
    const storedBeforeRestart = JSON.parse(
      await readFile(join(agentHome, 'sessions', 'sessions.json'), 'utf8'),
    );
    const expiresAt = storedBeforeRestart.sessions[childSessionId].expiresAt as number;

    await manager.close();

    expect(manager.resolveSession(childSessionId)).toBeUndefined();
    await expect(access(join(agentHome, 'sessions', `${childSessionId}.jsonl`))).resolves
      .toBeUndefined();

    now = expiresAt - 1;
    manager = new SessionManager(agentHome, { now: () => now });
    await manager.initialize();
    expect(manager.resolveSession(childSessionId)?.kind).toBe('subagent');
    expect(manager.getMessages(childSessionId)[0]?.message.content).toBe(
      'retained across restart',
    );

    await vi.advanceTimersByTimeAsync(1);
    await vi.waitFor(() => expect(manager.resolveSession(childSessionId)).toBeUndefined());
  });

  it('marks a nonterminal Subagent interrupted when the manager restarts', async () => {
    const callerSessionId = await materialize('Caller');
    const childSessionId = randomUUID();
    manager.registerPreparingSubagentSession({
      sessionId: childSessionId,
      callerSessionId,
      createdAt: 250,
    });
    await manager.createTransientSubagentTranscript({
      sessionId: childSessionId,
      callerSessionId,
      createdAt: 250,
    });
    await manager.appendMessage(childSessionId, {
      turnId: 'child-turn',
      role: 'assistant',
      content: 'partial result',
    });

    await manager.close();
    now = 500;
    manager = new SessionManager(agentHome, { now: () => now });
    await manager.initialize();

    expect(manager.resolveSession(childSessionId)?.kind).toBe('subagent');
    expect(manager.getMessages(childSessionId)[0]?.message.content).toBe('partial result');
    const store = JSON.parse(await readFile(
      join(agentHome, 'sessions', 'sessions.json'),
      'utf8',
    ));
    expect(store.sessions[childSessionId]).toMatchObject({
      kind: 'subagent',
      completedAt: 500,
      outcome: 'interrupted',
    });
    expect(store.sessions[childSessionId].expiresAt).toBe(500 + 24 * 60 * 60 * 1000);
  });

  it('removes expired and missing-file Subagent entries at initialization', async () => {
    const callerSessionId = await materialize('Caller');
    const expiredSessionId = randomUUID();
    const missingSessionId = randomUUID();
    for (const childSessionId of [expiredSessionId, missingSessionId]) {
      manager.registerPreparingSubagentSession({
        sessionId: childSessionId,
        callerSessionId,
        createdAt: 250,
      });
      await manager.createTransientSubagentTranscript({
        sessionId: childSessionId,
        callerSessionId,
        createdAt: 250,
      });
      now = 300;
      await manager.retainTransientSubagentTranscript(childSessionId, 'ok');
    }
    const expiredPath = join(agentHome, 'sessions', `${expiredSessionId}.jsonl`);
    const missingPath = join(agentHome, 'sessions', `${missingSessionId}.jsonl`);
    await manager.close();
    await rm(missingPath);

    now = 300 + 24 * 60 * 60 * 1000;
    manager = new SessionManager(agentHome, { now: () => now });
    await manager.initialize();

    expect(manager.resolveSession(expiredSessionId)).toBeUndefined();
    expect(manager.resolveSession(missingSessionId)).toBeUndefined();
    await expect(access(expiredPath)).rejects.toMatchObject({ code: 'ENOENT' });
    const store = JSON.parse(await readFile(
      join(agentHome, 'sessions', 'sessions.json'),
      'utf8',
    ));
    expect(store.sessions[expiredSessionId]).toBeUndefined();
    expect(store.sessions[missingSessionId]).toBeUndefined();
  });

  it('rejects Chat lifecycle operations for a persisted Subagent entry', async () => {
    const callerSessionId = await materialize('Caller');
    const childSessionId = randomUUID();
    manager.registerPreparingSubagentSession({
      sessionId: childSessionId,
      callerSessionId,
      createdAt: 250,
    });
    await manager.createTransientSubagentTranscript({
      sessionId: childSessionId,
      callerSessionId,
      createdAt: 250,
    });
    const transcriptPath = join(agentHome, 'sessions', `${childSessionId}.jsonl`);
    const transcriptBeforeConflict = await readFile(transcriptPath, 'utf8');

    await expect(manager.materializeSession({
      sessionId: childSessionId,
      createdAt: 300,
    })).rejects.toMatchObject({ code: 'SESSION_PERSISTENCE_FAILED' });
    await expect(manager.renameSession(childSessionId, { title: 'Child' })).rejects
      .toMatchObject({ code: 'SESSION_NOT_FOUND' });
    await expect(manager.archiveSession(childSessionId)).rejects
      .toMatchObject({ code: 'SESSION_NOT_FOUND' });
    await expect(manager.deleteSession(childSessionId)).rejects
      .toMatchObject({ code: 'SESSION_NOT_FOUND' });
    await expect(manager.forkSession(childSessionId)).rejects
      .toMatchObject({ code: 'SESSION_NOT_FOUND' });
    expect(await readFile(transcriptPath, 'utf8')).toBe(transcriptBeforeConflict);
  });

  it('does not touch the Session Store when appending to a transient Transcript', async () => {
    const callerSessionId = await materialize('Caller');
    const childSessionId = randomUUID();
    manager.registerPreparingSubagentSession({
      sessionId: childSessionId,
      callerSessionId,
      createdAt: 250,
    });
    await manager.createTransientSubagentTranscript({
      sessionId: childSessionId,
      callerSessionId,
      createdAt: 250,
    });

    await writeFile(join(agentHome, 'sessions', 'sessions.json'), '{invalid');
    await manager.appendMessage(childSessionId, {
      turnId: 'child-turn',
      role: 'user',
      content: 'delegated work',
    });

    expect(manager.getMessages(childSessionId)[0]?.message.content).toBe('delegated work');
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
    await manager.appendMessage(sourceId, {
      turnId: 'turn-reply',
      role: 'assistant',
      content: 'reply',
    });

    const laterMessageId = (await manager.appendMessage(sourceId, {
      turnId: 'turn-later',
      role: 'user',
      content: 'later',
      reasoning: { effort: 'high' },
    })).id;

    const fork = await manager.forkSession(sourceId, laterMessageId);

    expect(fork).toMatchObject({ forkedFromSessionId: sourceId, title: 'Source' });
    expect(manager.getMessages(fork.sessionId).map((message) => message.message.content)).toEqual([
      'hello',
      'reply',
      'later',
    ]);
    expect(manager.getMessages(fork.sessionId).at(-1)?.message.reasoning)
      .toEqual({ effort: 'high' });
    await expect(manager.deleteSession(sourceId)).rejects.toMatchObject({
      code: 'SESSION_HAS_DESCENDANTS',
    });
  });

  it('preserves internal Thinking replay across forks while keeping History safe', async () => {
    const sourceId = await materialize('Thinking history');
    const assistantId = (await manager.appendMessage(sourceId, {
      turnId: 'thinking-turn',
      role: 'assistant',
      content: [{
        type: 'thinking',
        id: 'invocation-1:thinking-0',
        status: 'complete',
        text: 'visible summary',
        replay: {
          format: 'provider.reasoning.v1',
          payload: { opaque: 'private replay state' },
        },
      }, {
        type: 'text',
        text: 'answer',
      }],
      invocation: {
        id: 'invocation-1',
        source: {
          providerId: 'provider',
          connectionId: 'connection',
          requestModelId: 'model',
          wireProtocol: 'openai-responses',
        },
        completion: {
          status: 'complete',
          stopReason: 'end_turn',
          usage: { inputTokens: 1, outputTokens: 2 },
        },
      },
    })).id;

    const fork = await manager.forkSession(sourceId, assistantId);
    const forkedMessage = manager.getMessages(fork.sessionId).at(-1)?.message;
    expect(forkedMessage).toMatchObject({
      invocation: { id: 'invocation-1' },
      content: [{
        type: 'thinking',
        replay: { payload: { opaque: 'private replay state' } },
      }, {
        type: 'text',
        text: 'answer',
      }],
    });

    const history = manager.getHistory({ sessionId: fork.sessionId });
    expect(history.items.at(-1)?.content).toEqual([{
      type: 'thinking',
      id: 'invocation-1:thinking-0',
      status: 'complete',
      text: 'visible summary',
    }, {
      type: 'text',
      text: 'answer',
    }]);
    expect(JSON.stringify(history)).not.toContain('private replay state');
  });

  it('projects terminal Tool status into History and preserves it across a fork', async () => {
    const sourceId = await materialize('Tool history');
    const assistantId = (await manager.appendMessage(sourceId, {
      turnId: 'tool-turn',
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'call-1', name: 'demo', input: {} }],
    })).id;
    await manager.appendToolExecutionAccepted(sourceId, {
      turnId: 'tool-turn',
      callId: 'call-1',
      executionId: 'execution-1',
      toolName: 'demo',
    });
    await manager.appendToolExecutionTerminal(sourceId, {
      executionId: 'execution-1',
      outcome: 'failed',
      content: 'demo failed',
    });
    await manager.appendHostTaskCompletion(sourceId, {
      turnId: 'tool-turn',
      completion: {
        executionId: 'execution-1',
        toolName: 'demo',
        status: 'failed',
        content: 'demo failed',
      },
    });

    const expected = [{
      type: 'tool_use',
      id: 'call-1',
      name: 'demo',
      input: {},
      execution_id: 'execution-1',
      status: 'error',
      result_content: 'demo failed',
    }];
    expect(manager.getHistory({ sessionId: sourceId }).items.at(-1)?.content).toEqual(expected);

    const fork = await manager.forkSession(sourceId, assistantId);
    expect(manager.getHistory({ sessionId: fork.sessionId }).items.at(-1)?.content)
      .toEqual(expected);

    const nestedFork = await manager.forkSession(fork.sessionId);
    expect(manager.getHistory({ sessionId: nestedFork.sessionId }).items.at(-1)?.content)
      .toEqual(expected);
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
    expect(manager.getPersistedSession(sessionId)).toBeUndefined();
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