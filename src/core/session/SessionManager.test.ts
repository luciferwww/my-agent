import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SessionManager } from './SessionManager.js';

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

  async function materialize(
    target: SessionManager = manager,
    content = 'initial message',
  ): Promise<string> {
    const sessionId = randomUUID();
    await target.materializeSession({
      sessionId,
      createdAt: Date.now(),
    });
    await target.appendMessage(sessionId, { role: 'user', content });
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
    const assistantId = await manager.appendMessage(sessionId, {
      role: 'assistant',
      content: 'second',
    });
    await manager.appendMessage(sessionId, { role: 'user', content: 'third' });

    const reloaded = new SessionManager(agentHome);
    const messages = reloaded.getMessages(sessionId);
    expect(messages.map((message) => message.message.content)).toEqual([
      'first',
      'second',
      'third',
    ]);
    expect(messages[1]?.id).toBe(assistantId);
    expect(messages[2]?.parentId).toBe(assistantId);
  });

  it('preserves abort metadata across reload', async () => {
    const sessionId = await materialize();
    await manager.appendMessage(sessionId, {
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

  it('moves the active leaf to form an alternate branch', async () => {
    const sessionId = await materialize(manager, 'shared');
    const sharedId = manager.getMessages(sessionId)[0]!.id;
    await manager.appendMessage(sessionId, { role: 'assistant', content: 'branch A' });

    manager.branch(sessionId, sharedId);
    await manager.appendMessage(sessionId, { role: 'assistant', content: 'branch B' });

    expect(manager.getMessages(sessionId).map((message) => message.message.content)).toEqual([
      'shared',
      'branch B',
    ]);
    expect(() => manager.branch(sessionId, 'missing')).toThrow('not found');
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
    const messageId = await manager.appendMessage(sessionId, {
      role: 'toolResult',
      content: [{ type: 'tool_result', tool_use_id: 'tool', content: longContent }],
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
    await capped.appendMessage(sessionId, {
      role: 'toolResult',
      content: [
        { type: 'tool_result', tool_use_id: 'tool', content: longContent },
        { type: 'text', text: longText },
      ],
    });

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
    await capped.appendMessage(sessionId, {
      role: 'toolResult',
      content: [{ type: 'tool_result', tool_use_id: 'tool', content }],
    });

    const block = new SessionManager(agentHome).getMessages(sessionId).at(-1)!
      .message.content as Array<{ content: string }>;
    expect(block[0]?.content).toBe(content);
  });
});