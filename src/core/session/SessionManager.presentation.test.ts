import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rename, rm, rmdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Logger } from '../../platform/logger/index.js';
import { SessionManager } from './SessionManager.js';
import * as sessionStore from './store.js';
import { loadTranscript } from './transcript.js';
import type { SubagentPresentationIdentity } from './types.js';

describe('ancestor presentation retention', () => {
  let directory: string;
  let manager: SessionManager;
  let root: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'ancestor-presentation-'));
    manager = new SessionManager(directory);
    root = randomUUID();
    await manager.materializeSession({ sessionId: root, createdAt: 1 });
    await manager.appendMessage(root, {
      turnId: 'root-turn', role: 'assistant',
      content: [{ type: 'tool_use', id: 'root-task', name: 'task', input: {} }],
    });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await manager.close();
    await rm(directory, { recursive: true, force: true });
  });

  async function child(
    callerSessionId = root,
    parentTurnId = 'root-turn',
    parentToolUseId = 'root-task',
    depth = 1,
  ): Promise<SubagentPresentationIdentity> {
    const identity = {
      sessionId: randomUUID(), turnId: randomUUID(), callerSessionId,
      parentTurnId, parentToolUseId, runId: randomUUID(), depth, subagentType: 'test',
    };
    const registration = { sessionId: identity.sessionId, callerSessionId, createdAt: Date.now() };
    manager.registerPreparingSubagentSession(registration);
    await manager.beginSubagentPresentation(identity);
    await manager.createTransientSubagentTranscript(registration);
    return identity;
  }

  function copies(sessionId: string) {
    return [...loadTranscript(join(directory, 'sessions', `${sessionId}.jsonl`)).byId.values()]
      .filter(record => record.type === 'presentation');
  }

  it('retains each descendant once in every ancestor without changing Context or leaf', async () => {
    const parentLeaf = manager.getLeafId(root);
    const a = await child();
    await manager.appendMessage(a.sessionId, {
      turnId: a.turnId, messageId: 'a-message', role: 'assistant', llmRound: 0,
      content: [{ type: 'tool_use', id: 'a-task', name: 'task', input: {} }],
    });
    const b = await child(a.sessionId, a.turnId, 'a-task', 2);
    expect(manager.getSubagentPresentationRoute(b.sessionId)).toEqual({
      rootTurnId: 'root-turn', ancestorSessionIds: [a.sessionId, root],
    });
    expect(Object.isFrozen(manager.getSubagentPresentationRoute(b.sessionId))).toBe(true);
    expect(Object.isFrozen(manager.getSubagentPresentationRoute(b.sessionId)?.ancestorSessionIds)).toBe(true);
    const message = await manager.appendMessage(b.sessionId, {
      turnId: b.turnId, messageId: 'b-message', role: 'assistant', content: 'B answer', llmRound: 0,
    });
    await manager.endSubagentPresentation({
      ...b, outcome: 'ok', durationMs: 1, usage: { inputTokens: 1, outputTokens: 1 },
    });
    expect(copies(a.sessionId).filter(record => record.sourceEntryId === message.id)).toHaveLength(1);
    await manager.endSubagentPresentation({
      ...a, outcome: 'ok', durationMs: 2, usage: { inputTokens: 2, outputTokens: 2 },
    });
    await manager.deleteTransientSubagentTranscript(b.sessionId);
    await manager.deleteTransientSubagentTranscript(a.sessionId);
    expect(manager.getSubagentPresentationRoute(b.sessionId)).toBeUndefined();

    expect(manager.getLeafId(root)).toBe(parentLeaf);
    expect(manager.getMessages(root)).toHaveLength(1);
    expect(copies(root).filter(record => record.sourceEntryId === message.id)).toHaveLength(1);
    expect(copies(root).find(record => record.sourceEntryId === message.id)).toMatchObject({
      parentId: parentLeaf, sourceSessionId: b.sessionId,
      body: { type: 'message', messageId: 'b-message', content: 'B answer', llmRound: 0 },
    });
    const reloaded = new SessionManager(directory);
    expect(reloaded.getMessages(root)).toHaveLength(1);
    expect(reloaded.getHistory({ sessionId: root, limit: 1 })).toMatchObject({
      hasMore: false,
      items: expect.arrayContaining([expect.objectContaining({
        sourceSessionId: b.sessionId, sourceEntryId: message.id, messageId: 'b-message', llmRound: 0,
      })]),
      scopes: expect.arrayContaining([
        expect.objectContaining({ sessionId: a.sessionId, status: 'terminal', outcome: 'ok' }),
        expect.objectContaining({ sessionId: b.sessionId, status: 'terminal', outcome: 'ok' }),
      ]),
    });
    await reloaded.close();
  });

  it('copies immutable Tool facts idempotently and keeps the original delegation anchor', async () => {
    const anchor = manager.getLeafId(root);
    const a = await child();
    await manager.appendMessage(root, {
      turnId: 'root-turn', role: 'user', content: 'steering',
    });
    await manager.appendMessage(a.sessionId, {
      turnId: a.turnId, role: 'assistant',
      content: [{ type: 'tool_use', id: 'call', name: 'work', input: {} }],
    });
    const input = {
      turnId: a.turnId, callId: 'call', executionId: 'execution', toolName: 'work',
    };
    const acceptedId = await manager.appendToolExecutionAccepted(a.sessionId, input);
    await manager.appendToolExecutionAccepted(a.sessionId, input);
    const terminal = { executionId: 'execution', outcome: 'success' as const, content: 'done' };
    const terminalId = await manager.appendToolExecutionTerminal(a.sessionId, terminal);
    await manager.appendToolExecutionTerminal(a.sessionId, terminal);

    expect(copies(root).filter(record => record.sourceEntryId === acceptedId)).toHaveLength(1);
    expect(copies(root).filter(record => record.sourceEntryId === terminalId)).toHaveLength(1);
    expect(copies(root).every(record => record.parentId === anchor)).toBe(true);
    expect(manager.getHistory({ sessionId: root }).items.find(item =>
      item.sourceSessionId === a.sessionId)?.content).toEqual([
      expect.objectContaining({ id: 'call', execution_id: 'execution', status: 'success', result_content: 'done' }),
    ]);
    const reloaded = new SessionManager(directory);
    expect(reloaded.getMessages(root).at(-1)?.message.content).toBe('steering');
    expect(reloaded.getHistory({ sessionId: root }).scopes?.[0]?.status).toBe('unknown');
    await reloaded.close();
  });

  it('isolates identical message, call and execution IDs in sibling sources', async () => {
    const children = [await child(), await child()];
    for (const [index, identity] of children.entries()) {
      await manager.appendMessage(identity.sessionId, {
        turnId: identity.turnId, messageId: 'same-message', role: 'assistant',
        content: [{ type: 'tool_use', id: 'same-call', name: 'work', input: {} }],
      });
      await manager.appendToolExecutionAccepted(identity.sessionId, {
        turnId: identity.turnId, callId: 'same-call', executionId: 'same-execution', toolName: 'work',
      });
      await manager.appendToolExecutionTerminal(identity.sessionId, {
        executionId: 'same-execution', outcome: 'success', content: `result-${index}`,
      });
    }
    const page = manager.getHistory({ sessionId: root, limit: 1 });
    expect(page.items).toHaveLength(3);
    expect(page.items.slice(1).map(item => item.content)).toEqual([
      [expect.objectContaining({ result_content: 'result-0' })],
      [expect.objectContaining({ result_content: 'result-1' })],
    ]);
  });

  it('retains one input copy per source and Turn across concurrent retry writes in every ancestor', async () => {
    const a = await child();
    await manager.appendMessage(a.sessionId, {
      turnId: a.turnId, role: 'assistant',
      content: [{ type: 'tool_use', id: 'a-task', name: 'task', input: {} }],
    });
    const b = await child(a.sessionId, a.turnId, 'a-task', 2);
    const input = {
      turnId: b.turnId, role: 'user' as const, messageId: 'input', content: 'submitted once',
    };
    const attempts = await Promise.all([
      manager.appendMessage(b.sessionId, input),
      manager.appendMessage(b.sessionId, input),
    ]);
    expect(attempts[0]?.id).not.toBe(attempts[1]?.id);
    for (const ancestor of [a.sessionId, root]) {
      expect(copies(ancestor).filter(record => record.body.type === 'message'
        && record.body.messageId === 'input')).toHaveLength(1);
    }
    await manager.appendMessage(b.sessionId, { ...input, turnId: 'other-turn' });
    await manager.appendMessage(a.sessionId, { ...input, turnId: a.turnId });
    await manager.appendMessage(b.sessionId, { ...input, role: 'assistant' });
    await manager.appendMessage(b.sessionId, { ...input, messageId: 'different-input' });
    for (let index = 0; index < 2; index++) {
      await manager.appendMessage(b.sessionId, {
        turnId: b.turnId, role: 'user', content: 'legacy input',
      });
    }
    const retained = manager.getHistory({ sessionId: root }).items;
    expect(retained.filter(item => item.messageId === 'input')).toHaveLength(4);
    expect(retained.filter(item => item.messageId === 'different-input')).toHaveLength(1);
    expect(retained.filter(item => item.content === 'legacy input')).toHaveLength(2);
    await manager.deleteTransientSubagentTranscript(b.sessionId);
    await manager.deleteTransientSubagentTranscript(a.sessionId);
    const reloaded = new SessionManager(directory);
    try {
      expect(reloaded.getHistory({ sessionId: root }).items).toEqual(retained);
    } finally {
      await reloaded.close();
    }
  });

  it('rejects conflicting content for an already copied input identity', async () => {
    const a = await child();
    const input = { turnId: a.turnId, role: 'user' as const, messageId: 'input', content: 'original' };
    await manager.appendMessage(a.sessionId, input);
    const logged = vi.spyOn(Logger.get('SessionManager'), 'error');
    await expect(manager.appendMessage(a.sessionId, { ...input, content: 'changed' }))
      .rejects.toMatchObject({ code: 'SESSION_PERSISTENCE_FAILED' });
    expect(logged).toHaveBeenCalledWith('ancestor presentation persistence failed', expect.objectContaining({
      sourceSessionId: a.sessionId,
      targetSessionId: root,
      phase: 'validate_target',
      errorCode: 'SESSION_DATA_INVALID',
      error: expect.stringContaining('conflicts with its copy'),
    }));
    expect(manager.getHistory({ sessionId: root }).items.filter(item => item.messageId === 'input'))
      .toEqual([expect.objectContaining({ content: 'original' })]);
  });

  it('retains submitted input after source-tail cleanup and only copies its retry once', async () => {
    const a = await child();
    const parentId = manager.getLeafId(a.sessionId)!;
    const input = { turnId: a.turnId, role: 'user' as const, messageId: 'input', content: 'submitted' };
    const first = await manager.appendMessage(a.sessionId, input);
    manager.branch(a.sessionId, parentId);
    expect(manager.getHistory({ sessionId: a.sessionId }).items).toHaveLength(0);
    expect(manager.getHistory({ sessionId: root }).items).toContainEqual(
      expect.objectContaining({ sourceEntryId: first.id, messageId: 'input' }),
    );
    const retry = await manager.appendMessage(a.sessionId, input);
    expect(manager.getHistory({ sessionId: a.sessionId }).items)
      .toEqual([expect.objectContaining({ entryId: retry.id, messageId: 'input' })]);
    await manager.deleteTransientSubagentTranscript(a.sessionId);
    const reloaded = new SessionManager(directory);
    try {
      expect(reloaded.getHistory({ sessionId: root }).items.filter(item => item.messageId === 'input'))
        .toEqual([expect.objectContaining({ sourceEntryId: first.id, messageId: 'input' })]);
    } finally {
      await reloaded.close();
    }
  });

  it('retains only presentation-safe Thinking and never provider replay metadata', async () => {
    const a = await child();
    await manager.appendMessage(a.sessionId, {
      turnId: a.turnId, role: 'assistant', messageId: 'thinking-message',
      invocation: {
        id: 'private-invocation', source: {
          providerId: 'test', connectionId: 'private-connection', requestModelId: 'test',
          wireProtocol: 'openai-responses',
        },
        completion: { status: 'complete', stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 } },
      },
      content: [
        { type: 'thinking', id: 'thought', text: 'visible', status: 'complete',
          replay: { format: 'test', payload: { secret: 'private-provider-state' } } },
        { type: 'text', text: 'answer' },
      ],
    });
    const raw = await readFile(join(directory, 'sessions', `${root}.jsonl`), 'utf8');
    expect(raw).toContain('visible');
    expect(raw).not.toContain('private-provider-state');
    expect(raw).not.toContain('"replay"');
    expect(raw).not.toContain('private-invocation');
    expect(raw).not.toContain('private-connection');
    expect(loadTranscript(join(directory, 'sessions', `${a.sessionId}.jsonl`)).version).toBe(3);
  });

  it.each([1, 2])('atomically upgrades a v%i ancestor without replacing native IDs', async version => {
    const path = join(directory, 'sessions', `${root}.jsonl`);
    const records = [...loadTranscript(path).byId.values()];
    const nativeIds = records.map(record => record.id);
    await manager.close();
    await writeFile(path, records.map(record => JSON.stringify(record.type === 'session'
      ? { ...record, version } : record)).join('\n') + '\n');
    manager = new SessionManager(directory);
    await child();
    const state = loadTranscript(path);
    expect(state.version).toBe(3);
    expect([...state.byId.keys()].slice(0, nativeIds.length)).toEqual(nativeIds);
  });

  it('forks current retained facts but excludes facts produced after an explicit cut', async () => {
    const cut = manager.getLeafId(root)!;
    const a = await child();
    await manager.appendMessage(a.sessionId, {
      turnId: a.turnId, role: 'assistant', content: 'retained child',
    });
    const snapshot = await manager.forkSession(root);
    expect(manager.getHistory({ sessionId: root }).scopes?.[0]?.status).toBe('running');
    expect(manager.getHistory({ sessionId: snapshot.sessionId }).scopes?.[0]?.status).toBe('unknown');
    await manager.endSubagentPresentation({
      ...a, outcome: 'ok', durationMs: 1, usage: { inputTokens: 1, outputTokens: 1 },
    });
    const whole = await manager.forkSession(root);
    const earlier = await manager.forkSession(root, cut);
    await manager.deleteTransientSubagentTranscript(a.sessionId);
    expect(manager.getHistory({ sessionId: earlier.sessionId }).items).toHaveLength(1);
    expect(manager.getHistory({ sessionId: whole.sessionId }).items).toHaveLength(2);
    const reloaded = new SessionManager(directory);
    expect(reloaded.getHistory({ sessionId: whole.sessionId }).scopes?.[0]?.status).toBe('terminal');
    await reloaded.close();
  });

  it('excludes off-branch facts from History and forks', async () => {
    const original = manager.getLeafId(root)!;
    const abandoned = await manager.appendMessage(root, {
      turnId: 'abandoned', role: 'assistant',
      content: [{ type: 'tool_use', id: 'abandoned-task', name: 'task', input: {} }],
    });
    const a = await child(root, 'abandoned', 'abandoned-task');
    await manager.appendMessage(a.sessionId, {
      turnId: a.turnId, role: 'assistant', content: 'off-branch child',
    });
    manager.branch(root, original);
    await manager.appendMessage(root, { turnId: 'active', role: 'user', content: 'new branch' });
    expect(manager.getHistory({ sessionId: root }).items).toHaveLength(2);
    expect(() => manager.getHistory({ sessionId: root, beforeEntryId: abandoned.id }))
      .toThrow(expect.objectContaining({ code: 'SESSION_HISTORY_CURSOR_INVALID' }));
    const fork = await manager.forkSession(root);
    expect(copies(fork.sessionId)).toHaveLength(0);
  });

  it.each([false, true])('reparents direct fork scopes without changing source identities (terminal=%s)', async terminal => {
    const a = await child();
    const anchor = await manager.appendMessage(a.sessionId, {
      turnId: a.turnId, role: 'assistant',
      content: [{ type: 'tool_use', id: 'a-task', name: 'task', input: {} }],
    });
    const b = await child(a.sessionId, a.turnId, 'a-task', 2);
    await manager.appendMessage(b.sessionId, {
      turnId: b.turnId, role: 'assistant', content: 'nested answer',
    });
    if (terminal) {
      for (const identity of [b, a]) {
        await manager.endSubagentPresentation({
          ...identity, outcome: 'ok', durationMs: 1, usage: { inputTokens: 1, outputTokens: 1 },
        });
      }
    }
    const cut = await manager.appendMessage(root, {
      turnId: 'root-turn', role: 'assistant', content: 'before task completion',
    });
    const sourceCopies = copies(root);
    for (const entryId of [undefined, cut.id]) {
      const fork = await manager.forkSession(root, entryId);
      expect(copies(fork.sessionId)).toEqual(sourceCopies.map(record => ({
        ...record,
        body: (record.body.type === 'subagent_start' || record.body.type === 'subagent_end')
          && record.body.callerSessionId === root
          ? { ...record.body, callerSessionId: fork.sessionId } : record.body,
      })));
      const reloaded = new SessionManager(directory);
      try {
        const page = reloaded.getHistory({ sessionId: fork.sessionId });
        expect(page.scopes).toEqual(expect.arrayContaining([
          expect.objectContaining({ sessionId: a.sessionId, callerSessionId: fork.sessionId }),
          expect.objectContaining({ sessionId: b.sessionId, callerSessionId: a.sessionId }),
        ]));
        expect(page.items).toContainEqual(expect.objectContaining({
          sourceSessionId: a.sessionId, sourceEntryId: anchor.id,
        }));
      } finally {
        await reloaded.close();
      }
    }
    expect(manager.getHistory({ sessionId: root }).scopes).toContainEqual(
      expect.objectContaining({ sessionId: a.sessionId, callerSessionId: root }),
    );
    expect(copies(root)).toEqual(sourceCopies);
  });

  it.each([
    [15, 10, 25], [0, 50, 50], [0, 10, 10], [0, 105, 105],
  ])('accumulates complete Turns: older=%i latest=%i returns=%i', async (older, latest, expected) => {
    const total = older + latest;
    for (let index = 1; index < total; index++) {
      await manager.appendMessage(root, {
        turnId: older > 0 && index >= older ? 'latest-turn' : 'root-turn',
        role: 'user', content: `message-${index}`,
      });
    }
    const page = manager.getHistory({ sessionId: root, limit: 20 });
    expect(page.items).toHaveLength(expected);
    expect(page.hasMore).toBe(false);
    expect(page.nextCursor).toBeNull();
    expect(() => manager.getHistory({ sessionId: root, beforeEntryId: page.items[1]!.entryId }))
      .toThrow(expect.objectContaining({ code: 'SESSION_HISTORY_CURSOR_INVALID' }));
  });

  it('surfaces ancestor write failures after source persistence and releases locks', async () => {
    const a = await child();
    const logged = vi.spyOn(Logger.get('SessionManager'), 'error');
    const path = join(directory, 'sessions', `${root}.jsonl`);
    const backup = `${path}.backup`;
    await rename(path, backup);
    await mkdir(path);
    try {
      await expect(manager.appendMessage(a.sessionId, {
        turnId: a.turnId, role: 'assistant', content: 'source survives',
      })).rejects.toMatchObject({
        code: 'SESSION_PERSISTENCE_FAILED',
        message: expect.stringContaining(root),
      });
      expect(manager.getMessages(a.sessionId).at(-1)?.message.content).toBe('source survives');
      expect(logged).toHaveBeenCalledWith('ancestor presentation persistence failed', expect.objectContaining({
        sourceSessionId: a.sessionId,
        targetSessionId: root,
        phase: 'append_transcript',
      }));
      expect(JSON.stringify(logged.mock.calls)).not.toContain('source survives');
    } finally {
      await rmdir(path);
      await rename(backup, path);
    }
    await manager.appendMessage(a.sessionId, {
      turnId: a.turnId, role: 'assistant', content: 'next write',
    });
    expect(await readFile(path, 'utf8')).toContain('next write');
  });

  it('diagnoses metadata failures even when the terminal presentation is already durable', async () => {
    const a = await child();
    await manager.appendMessage(a.sessionId, {
      turnId: a.turnId, role: 'assistant',
      content: [{ type: 'tool_use', id: 'call', name: 'work', input: {} }],
    });
    await manager.appendToolExecutionAccepted(a.sessionId, {
      turnId: a.turnId, callId: 'call', executionId: 'execution', toolName: 'work',
    });
    const failure = Object.assign(new Error('EPERM: operation not permitted, rename sessions.json'), {
      code: 'EPERM', syscall: 'rename',
    });
    const logged = vi.spyOn(Logger.get('SessionManager'), 'error');
    vi.spyOn(sessionStore, 'updateStore').mockRejectedValueOnce(failure);
    const terminal = { executionId: 'execution', outcome: 'success' as const, content: 'private tool output' };

    await expect(manager.appendToolExecutionTerminal(a.sessionId, terminal)).rejects.toMatchObject({
      code: 'SESSION_PERSISTENCE_FAILED',
      cause: failure,
    });
    const retained = copies(root).filter(record => record.body.type === 'tool_execution_terminal');
    expect(retained).toHaveLength(1);
    const sourceEntryId = retained[0]!.sourceEntryId;
    expect(manager.getAsyncToolRecords(a.sessionId)).toContainEqual(expect.objectContaining({
      id: sourceEntryId, type: 'tool_execution_terminal', ...terminal,
    }));
    expect(logged).toHaveBeenCalledExactlyOnceWith('ancestor presentation persistence failed', {
      sourceSessionId: a.sessionId,
      sourceEntryId,
      targetSessionId: root,
      phase: 'update_metadata',
      error: failure.message,
      errorName: 'Error',
      errorCode: 'EPERM',
      syscall: 'rename',
    });
    expect(JSON.stringify(logged.mock.calls)).not.toContain(terminal.content);

    expect(await manager.appendToolExecutionTerminal(a.sessionId, terminal)).toBe(sourceEntryId);
    expect(copies(root).filter(record => record.sourceEntryId === sourceEntryId)).toHaveLength(1);
  });

  it('replays a partially copied lifecycle using the same fact identity in every ancestor', async () => {
    const a = await child();
    await manager.appendMessage(a.sessionId, {
      turnId: a.turnId, role: 'assistant',
      content: [{ type: 'tool_use', id: 'nested-task', name: 'task', input: {} }],
    });
    const b = await child(a.sessionId, a.turnId, 'nested-task', 2);
    const terminal = { ...b, outcome: 'ok' as const, durationMs: 1, usage: { inputTokens: 1, outputTokens: 1 } };
    const path = join(directory, 'sessions', `${root}.jsonl`);
    const backup = `${path}.backup`;
    await rename(path, backup);
    await mkdir(path);
    try {
      await expect(manager.endSubagentPresentation(terminal)).rejects.toMatchObject({
        code: 'SESSION_PERSISTENCE_FAILED',
      });
    } finally {
      await rmdir(path);
      await rename(backup, path);
    }
    await manager.endSubagentPresentation(terminal);
    const localEnds = copies(a.sessionId).filter(record => record.body.type === 'subagent_end');
    const rootEnds = copies(root).filter(record => record.body.type === 'subagent_end');
    expect(localEnds).toHaveLength(1);
    expect(rootEnds).toHaveLength(1);
    expect(rootEnds[0]?.sourceEntryId).toBe(localEnds[0]?.sourceEntryId);
  });

  it('serializes competing source and ancestor writes without holding cross-Session locks', async () => {
    const a = await child();
    const b = await child();
    await Promise.all([
      manager.appendMessage(a.sessionId, { turnId: a.turnId, role: 'assistant', content: 'A' }),
      manager.appendMessage(b.sessionId, { turnId: b.turnId, role: 'assistant', content: 'B' }),
      manager.appendMessage(root, { turnId: 'root-turn', role: 'user', content: 'steering' }),
    ]);
    expect(manager.getHistory({ sessionId: root }).items).toHaveLength(4);
    expect(manager.getMessages(root).at(-1)?.message.content).toBe('steering');
  });
});
