import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SessionManager } from './SessionManager.js';
import type { SessionMessageInput } from './SessionManager.js';

describe('SessionManager transcript behavior', () => {
  let agentHome: string;
  let manager: SessionManager;

  beforeEach(async () => {
    agentHome = await mkdtemp(join(tmpdir(), 'session-manager-test-'));
    manager = new SessionManager(agentHome);
  });

  afterEach(async () => {
    await rm(agentHome, { recursive: true, force: true });
  });

  function appendMessage(
    sessionId: string,
    message: Omit<SessionMessageInput, 'turnId'>,
    target: SessionManager = manager,
  ) {
    return target.appendMessage(sessionId, { turnId: 'test-turn', ...message });
  }

  async function materialize(
    target: SessionManager = manager,
    content = 'initial message',
  ): Promise<string> {
    const sessionId = randomUUID();
    await target.materializeSession({
      sessionId,
      createdAt: Date.now(),
    });
    await appendMessage(sessionId, { role: 'user', content }, target);
    return sessionId;
  }

  function makeCompactionInput(overrides?: Record<string, unknown>) {
    return {
      type: 'compaction' as const,
      id: randomUUID(),
      timestamp: new Date().toISOString(),
      summary: 'Test summary.',
      tokensBefore: 2000,
      tokensAfter: 400,
      trigger: 'overflow' as const,
      droppedMessages: 4,
      ...overrides,
    };
  }

  it('appends and reloads a linear message chain', async () => {
    const sessionId = await materialize(manager, 'first');
    const assistantId = await appendMessage(sessionId, {
      role: 'assistant',
      content: 'second',
    });
    await appendMessage(sessionId, { role: 'user', content: 'third' });

    const reloaded = new SessionManager(agentHome);
    const messages = reloaded.getMessages(sessionId);
    expect(messages.map((message) => message.message.content)).toEqual([
      'first',
      'second',
      'third',
    ]);
    expect(messages[1]?.id).toBe(assistantId);
    expect(messages[2]?.parentId).toBe(assistantId);
    expect(messages.every((message) => message.turnId === 'test-turn')).toBe(true);
    expect(messages.every((message) => !Object.hasOwn(message.message, 'turnId'))).toBe(true);
  });

  it('preserves abort metadata across reload', async () => {
    const sessionId = await materialize();
    await appendMessage(sessionId, {
      role: 'assistant',
      content: [{ type: 'text', text: 'partial…' }],
      abortMeta: { partial: true, stopReason: 'aborted' },
    });

    const messages = new SessionManager(agentHome).getMessages(sessionId);
    expect(messages.at(-1)?.message.abortMeta).toEqual({
      partial: true,
      stopReason: 'aborted',
    });
  });

  it('rejects max_llm_calls metadata on a non-Assistant message before persistence', async () => {
    const sessionId = await materialize();

    await expect(manager.appendMessage(sessionId, {
      turnId: 'test-turn',
      role: 'user',
      content: 'continue',
      turnStopReason: 'max_llm_calls',
    })).rejects.toThrow('turnStopReason can only be set on an Assistant message');

    expect(manager.getMessages(sessionId)).toHaveLength(1);
  });

  it('persists async Tool lifecycle facts idempotently across reload', async () => {
    const sessionId = await materialize();
    const accepted = {
      turnId: 'test-turn',
      callId: 'call-1',
      executionId: 'execution-1',
      toolName: 'demo',
    };

    const [firstAcceptedId, duplicateAcceptedId] = await Promise.all([
      manager.appendToolExecutionAccepted(sessionId, accepted),
      manager.appendToolExecutionAccepted(sessionId, accepted),
    ]);
    expect(duplicateAcceptedId).toBe(firstAcceptedId);

    const terminal = {
      executionId: 'execution-1',
      outcome: 'success' as const,
      content: 'done',
    };
    const firstTerminalId = await manager.appendToolExecutionTerminal(sessionId, terminal);
    const duplicateTerminalId = await manager.appendToolExecutionTerminal(sessionId, terminal);
    expect(duplicateTerminalId).toBe(firstTerminalId);

    const completion = {
      turnId: 'test-turn',
      completion: {
        executionId: 'execution-1',
        toolName: 'demo',
        status: 'success' as const,
        content: 'done',
      },
    };
    const firstCompletionId = await manager.appendHostTaskCompletion(sessionId, completion);
    const duplicateCompletionId = await manager.appendHostTaskCompletion(sessionId, completion);
    expect(duplicateCompletionId).toBe(firstCompletionId);

    const firstAbortedId = await manager.appendTurnAborted(sessionId, 'aborted-turn');
    const duplicateAbortedId = await manager.appendTurnAborted(sessionId, 'aborted-turn');
    expect(duplicateAbortedId).toBe(firstAbortedId);

    const reloaded = new SessionManager(agentHome);
    expect(reloaded.getAsyncToolRecords(sessionId)).toEqual([
      expect.objectContaining({ type: 'tool_execution_accepted', executionId: 'execution-1' }),
      expect.objectContaining({ type: 'tool_execution_terminal', outcome: 'success' }),
      expect.objectContaining({
        type: 'host_task_completion',
        completion: expect.objectContaining({ status: 'success' }),
      }),
      expect.objectContaining({ type: 'turn_aborted', turnId: 'aborted-turn' }),
    ]);
  });

  it('fails closed on missing or conflicting async Tool lifecycle facts', async () => {
    const sessionId = await materialize();

    await expect(manager.appendToolExecutionTerminal(sessionId, {
      executionId: 'execution-1',
      outcome: 'failed',
      content: 'failed',
    })).rejects.toMatchObject({ code: 'SESSION_DATA_INVALID' });

    await manager.appendToolExecutionAccepted(sessionId, {
      turnId: 'test-turn',
      callId: 'call-1',
      executionId: 'execution-1',
      toolName: 'demo',
    });
    await expect(manager.appendToolExecutionAccepted(sessionId, {
      turnId: 'test-turn',
      callId: 'call-2',
      executionId: 'execution-1',
      toolName: 'other',
    })).rejects.toMatchObject({ code: 'SESSION_DATA_INVALID' });

    await manager.appendToolExecutionTerminal(sessionId, {
      executionId: 'execution-1',
      outcome: 'success',
      content: 'done',
    });
    await expect(manager.appendToolExecutionTerminal(sessionId, {
      executionId: 'execution-1',
      outcome: 'failed',
      content: 'different',
    })).rejects.toMatchObject({ code: 'SESSION_DATA_INVALID' });

    await expect(manager.appendHostTaskCompletion(sessionId, {
      turnId: 'test-turn',
      completion: {
        executionId: 'execution-1',
        toolName: 'other',
        status: 'success',
        content: 'done',
      },
    })).rejects.toMatchObject({ code: 'SESSION_DATA_INVALID' });

    expect(manager.getAsyncToolRecords(sessionId)).toHaveLength(2);
  });

  it('maps outcome_unknown only to an aborted Host completion', async () => {
    const sessionId = await materialize();
    await manager.appendToolExecutionAccepted(sessionId, {
      turnId: 'test-turn',
      callId: 'call-1',
      executionId: 'execution-1',
      toolName: 'demo',
    });
    await manager.appendToolExecutionTerminal(sessionId, {
      executionId: 'execution-1',
      outcome: 'outcome_unknown',
      reason: 'host_recovery',
      content: 'Supervision was lost.',
    });

    await expect(manager.appendHostTaskCompletion(sessionId, {
      turnId: 'test-turn',
      completion: {
        executionId: 'execution-1',
        toolName: 'demo',
        status: 'failed',
        content: 'Supervision was lost.',
      },
    })).rejects.toMatchObject({ code: 'SESSION_DATA_INVALID' });

    await expect(manager.appendHostTaskCompletion(sessionId, {
      turnId: 'test-turn',
      completion: {
        executionId: 'execution-1',
        toolName: 'demo',
        status: 'aborted',
        content: 'Supervision was lost.',
      },
    })).resolves.toEqual(expect.any(String));
  });

  it('moves the active leaf to form an alternate branch', async () => {
    const sessionId = await materialize(manager, 'shared');
    const sharedId = manager.getMessages(sessionId)[0]!.id;
    await appendMessage(sessionId, { role: 'assistant', content: 'branch A' });

    manager.branch(sessionId, sharedId);
    await appendMessage(sessionId, { role: 'assistant', content: 'branch B' });

    expect(manager.getMessages(sessionId).map((message) => message.message.content)).toEqual([
      'shared',
      'branch B',
    ]);
    expect(() => manager.branch(sessionId, 'missing')).toThrow('not found');
  });

  it('returns chronological active-branch History pages with exclusive cursors', async () => {
    const sessionId = await materialize(manager, 'first');
    await appendMessage(sessionId, { role: 'assistant', content: 'second' });
    await appendMessage(sessionId, { role: 'user', content: 'third' });

    const latest = manager.getHistory({ sessionId, limit: 2 });
    expect(latest.items.map((item) => item.content)).toEqual(['second', 'third']);
    expect(latest.items.every((item) => item.turnId === 'test-turn')).toBe(true);
    expect(latest.hasMore).toBe(true);
    expect(latest.nextCursor).toBe(latest.items[0]?.entryId);

    const earlier = manager.getHistory({
      sessionId,
      beforeEntryId: latest.nextCursor!,
      limit: 2,
    });
    expect(earlier.items.map((item) => item.content)).toEqual(['first']);
    expect(earlier).toMatchObject({ hasMore: false, nextCursor: null });
  });

  it('rejects off-branch History cursors and preserves images', async () => {
    const sessionId = await materialize(manager, 'shared');
    const sharedId = manager.getMessages(sessionId)[0]!.id;
    const abandonedId = await appendMessage(sessionId, {
      role: 'assistant',
      content: 'abandoned',
    });
    manager.branch(sessionId, sharedId);
    await appendMessage(sessionId, {
      role: 'user',
      content: [{
        type: 'image',
        source: { type: 'base64', media_type: 'image/png', data: 'secret' },
        dimensions: { width: 1280, height: 720 },
      }],
    });

    expect(() => manager.getHistory({ sessionId, beforeEntryId: abandonedId }))
      .toThrowError(expect.objectContaining({ code: 'SESSION_HISTORY_CURSOR_INVALID' }));
    expect(manager.getHistory({ sessionId }).items.at(-1)?.content).toEqual([
      {
        type: 'image',
        source: { type: 'base64', media_type: 'image/png', data: 'secret' },
        dimensions: { width: 1280, height: 720 },
      },
    ]);
  });

  it('persists Compaction records without storing summary counters', async () => {
    const sessionId = await materialize();
    const firstMessageId = manager.getMessages(sessionId)[0]!.id;
    const leafBefore = manager.getLeafId(sessionId);
    await manager.appendCompactionRecord(
      sessionId,
      makeCompactionInput({ id: 'compaction-one' }),
      firstMessageId,
    );

    expect(manager.getLeafId(sessionId)).toBe(leafBefore);
    const reloaded = new SessionManager(agentHome);
    expect(reloaded.getLastCompactionRecord(sessionId)).toMatchObject({
      id: 'compaction-one',
      firstKeptEntryId: firstMessageId,
    });
    expect(reloaded.getLeafId(sessionId)).toBe(leafBefore);

    const store = JSON.parse(await readFile(
      join(agentHome, 'sessions', 'sessions.json'),
      'utf8',
    )) as { sessions: Record<string, Record<string, unknown>> };
    expect(store.sessions[sessionId]).not.toHaveProperty('compactionCount');
  });

  it('returns the most recent Compaction record', async () => {
    const sessionId = await materialize();
    const firstMessageId = manager.getMessages(sessionId)[0]!.id;
    await manager.appendCompactionRecord(
      sessionId,
      makeCompactionInput({ id: 'c1', timestamp: '2026-04-01T08:00:00Z' }),
      firstMessageId,
    );
    await manager.appendCompactionRecord(
      sessionId,
      makeCompactionInput({ id: 'c2', timestamp: '2026-04-01T12:00:00Z' }),
      firstMessageId,
    );

    expect(manager.getLastCompactionSummary(sessionId)).toBe('Test summary.');
    expect(manager.getLastCompactionRecord(sessionId)?.id).toBe('c2');
  });

  it('does not cap tool results when limits are absent', async () => {
    const sessionId = await materialize();
    const longContent = 'A'.repeat(50_000);
    const messageId = await appendMessage(sessionId, {
      role: 'toolResult',
      content: [{
        type: 'tool_result',
        tool_use_id: 'tool',
        content: longContent,
        status: 'success',
      }],
    });

    const record = new SessionManager(agentHome)
      .getMessages(sessionId)
      .find((message) => message.id === messageId);
    const block = (record!.message.content as Array<{ content: string }>)[0]!;
    expect(block.content).toBe(longContent);
  });

  it('caps configured tool results but leaves other blocks unchanged', async () => {
    const capped = new SessionManager(agentHome, {
      toolResultHeadChars: 100,
      toolResultTailChars: 50,
    });
    const sessionId = await materialize(capped);
    const longContent = 'H'.repeat(100) + 'M'.repeat(200) + 'T'.repeat(50);
    const longText = 'Z'.repeat(1000);
    await appendMessage(sessionId, {
      role: 'toolResult',
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'tool',
          content: longContent,
          status: 'success',
        },
        { type: 'text', text: longText },
      ],
    }, capped);

    const blocks = new SessionManager(agentHome).getMessages(sessionId).at(-1)!
      .message.content as Array<{ type: string; content?: string; text?: string }>;
    expect(blocks[0]?.content).toContain('[Tool result trimmed:');
    expect(blocks[0]?.content).toContain('H'.repeat(100));
    expect(blocks[0]?.content).toContain('T'.repeat(50));
    expect(blocks[0]?.content).not.toContain('M'.repeat(200));
    expect(blocks[1]?.text).toBe(longText);
  });

  it('does not cap tool results at or below the configured threshold', async () => {
    const capped = new SessionManager(agentHome, {
      toolResultHeadChars: 100,
      toolResultTailChars: 50,
    });
    const sessionId = await materialize(capped);
    const content = 'X'.repeat(150);
    await appendMessage(sessionId, {
      role: 'toolResult',
      content: [{ type: 'tool_result', tool_use_id: 'tool', content, status: 'success' }],
    }, capped);

    const block = new SessionManager(agentHome).getMessages(sessionId).at(-1)!
      .message.content as Array<{ content: string }>;
    expect(block[0]?.content).toBe(content);
  });
});