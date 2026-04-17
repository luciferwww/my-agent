import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { SessionManager } from './SessionManager.js';

describe('SessionManager', () => {
  let workspaceDir: string;
  let manager: SessionManager;

  beforeEach(async () => {
    workspaceDir = await mkdtemp(join(tmpdir(), 'session-mgr-test-'));
    manager = new SessionManager(workspaceDir);
  });

  afterEach(async () => {
    await rm(workspaceDir, { recursive: true, force: true });
  });

  // ── Session CRUD ────────────────────────────────────

  describe('createSession', () => {
    it('creates a session with UUID and JSONL file', async () => {
      const entry = await manager.createSession('main');
      expect(entry.sessionId).toBeDefined();
      expect(entry.sessionKey).toBe('main');
      expect(entry.sessionFile).toContain('.jsonl');
      expect(entry.createdAt).toBeGreaterThan(0);
    });

    it('throws on duplicate key', async () => {
      await manager.createSession('main');
      await expect(manager.createSession('main')).rejects.toThrow('already exists');
    });

    it('sets spawnedBy when provided', async () => {
      await manager.createSession('main');
      const sub = await manager.createSession('sub', { spawnedBy: 'main' });
      expect(sub.spawnedBy).toBe('main');
    });
  });

  describe('getSession', () => {
    it('returns entry when exists', async () => {
      await manager.createSession('main');
      const entry = manager.getSession('main');
      expect(entry).toBeDefined();
      expect(entry!.sessionKey).toBe('main');
    });

    it('returns undefined when not exists', () => {
      const entry = manager.getSession('nonexistent');
      expect(entry).toBeUndefined();
    });
  });

  describe('listSessions', () => {
    it('returns all sessions', async () => {
      await manager.createSession('a');
      await manager.createSession('b');
      const list = manager.listSessions();
      expect(list).toHaveLength(2);
    });

    it('returns empty array when no sessions', () => {
      const list = manager.listSessions();
      expect(list).toHaveLength(0);
    });
  });

  describe('updateSession', () => {
    it('updates specified fields', async () => {
      await manager.createSession('main');
      await manager.updateSession('main', { totalTokens: 1500, status: 'done' });

      const entry = manager.getSession('main');
      expect(entry!.totalTokens).toBe(1500);
      expect(entry!.status).toBe('done');
    });

    it('updates updatedAt automatically', async () => {
      const entry = await manager.createSession('main');
      const originalUpdatedAt = entry.updatedAt;

      await new Promise((r) => setTimeout(r, 10));
      await manager.updateSession('main', { totalTokens: 100 });

      const updated = manager.getSession('main');
      expect(updated!.updatedAt).toBeGreaterThan(originalUpdatedAt);
    });

    it('throws when session not found', async () => {
      await expect(manager.updateSession('nonexistent', {})).rejects.toThrow('not found');
    });
  });

  describe('deleteSession', () => {
    it('removes store entry and JSONL file', async () => {
      await manager.createSession('main');
      await manager.deleteSession('main');

      const entry = manager.getSession('main');
      expect(entry).toBeUndefined();
    });

    it('does not throw when session does not exist', async () => {
      await expect(manager.deleteSession('nonexistent')).resolves.not.toThrow();
    });
  });

  // ── 消息操作（线性） ──────────────────────────────────

  describe('appendMessage', () => {
    it('appends message and returns id', async () => {
      await manager.createSession('main');
      const id = await manager.appendMessage('main', {
        role: 'user',
        content: 'Hello',
      });
      expect(id).toBeDefined();
      expect(typeof id).toBe('string');
    });

    it('chains messages with parentId', async () => {
      await manager.createSession('main');
      await manager.appendMessage('main', { role: 'user', content: 'Hello' });
      await manager.appendMessage('main', {
        role: 'assistant',
        content: [{ type: 'text', text: 'Hi!' }],
      });

      const messages = manager.getMessages('main');
      expect(messages).toHaveLength(2);
      expect(messages[0]!.message.role).toBe('user');
      expect(messages[1]!.message.role).toBe('assistant');
      // 第二条消息的 parentId 应该是第一条的 id
      expect(messages[1]!.parentId).toBe(messages[0]!.id);
    });

    it('updates leafId after append', async () => {
      await manager.createSession('main');
      const id = await manager.appendMessage('main', { role: 'user', content: 'Hello' });
      expect(manager.getLeafId('main')).toBe(id);
    });
  });

  describe('getMessages', () => {
    it('returns messages in correct order', async () => {
      await manager.createSession('main');
      await manager.appendMessage('main', { role: 'user', content: 'first' });
      await manager.appendMessage('main', { role: 'assistant', content: 'second' });
      await manager.appendMessage('main', { role: 'user', content: 'third' });

      const messages = manager.getMessages('main');
      expect(messages).toHaveLength(3);
      expect(messages[0]!.message.content).toBe('first');
      expect(messages[1]!.message.content).toBe('second');
      expect(messages[2]!.message.content).toBe('third');
    });

    it('returns empty array for new session', async () => {
      await manager.createSession('main');
      const messages = manager.getMessages('main');
      expect(messages).toHaveLength(0);
    });
  });

  // ── 分支操作 ──────────────────────────────────────────

  describe('branch', () => {
    it('moves leafId to specified entry', async () => {
      await manager.createSession('main');
      const id1 = await manager.appendMessage('main', { role: 'user', content: 'msg-1' });
      const id2 = await manager.appendMessage('main', { role: 'assistant', content: 'msg-2' });
      await manager.appendMessage('main', { role: 'user', content: 'msg-3' });

      // 回退到 msg-1
      manager.branch('main', id1);
      expect(manager.getLeafId('main')).toBe(id1);
    });

    it('getMessages returns path to branch point after branch', async () => {
      await manager.createSession('main');
      const id1 = await manager.appendMessage('main', { role: 'user', content: 'shared' });
      await manager.appendMessage('main', { role: 'assistant', content: 'branch-A' });

      // 回退到 shared，展开新分支
      manager.branch('main', id1);
      await manager.appendMessage('main', { role: 'assistant', content: 'branch-B' });

      const messages = manager.getMessages('main');
      expect(messages).toHaveLength(2);
      expect(messages[0]!.message.content).toBe('shared');
      expect(messages[1]!.message.content).toBe('branch-B');
    });

    it('new messages after branch have correct parentId', async () => {
      await manager.createSession('main');
      const id1 = await manager.appendMessage('main', { role: 'user', content: 'shared' });
      await manager.appendMessage('main', { role: 'assistant', content: 'old' });

      manager.branch('main', id1);
      await manager.appendMessage('main', { role: 'assistant', content: 'new' });

      const messages = manager.getMessages('main');
      const newMsg = messages[messages.length - 1]!;
      expect(newMsg.parentId).toBe(id1);
    });

    it('throws when entryId does not exist', async () => {
      await manager.createSession('main');
      expect(() => manager.branch('main', 'nonexistent')).toThrow('not found');
    });

    it('supports multiple branches from same point', async () => {
      await manager.createSession('main');
      const id1 = await manager.appendMessage('main', { role: 'user', content: 'root' });

      // 分支 A
      await manager.appendMessage('main', { role: 'assistant', content: 'A' });

      // 回退，分支 B
      manager.branch('main', id1);
      await manager.appendMessage('main', { role: 'assistant', content: 'B' });

      // 回退，分支 C
      manager.branch('main', id1);
      await manager.appendMessage('main', { role: 'assistant', content: 'C' });

      const messages = manager.getMessages('main');
      expect(messages).toHaveLength(2);
      expect(messages[0]!.message.content).toBe('root');
      expect(messages[1]!.message.content).toBe('C'); // 最后一个分支
    });
  });

  // ── 持久化 ────────────────────────────────────────────

  describe('persistence', () => {
    it('messages survive reload from disk', async () => {
      await manager.createSession('main');
      await manager.appendMessage('main', { role: 'user', content: 'persisted' });

      // 创建新 manager 实例（模拟重启）
      const manager2 = new SessionManager(workspaceDir);
      const messages = manager2.getMessages('main');
      expect(messages).toHaveLength(1);
      expect(messages[0]!.message.content).toBe('persisted');
    });
  });

  // ── 压缩记录操作 ──────────────────────────────────────

  describe('appendCompactionRecord', () => {
    /**
     * 构建 appendCompactionRecord 所需的最小记录（不含 parentId / firstKeptEntryId，
     * 这两个字段由 appendCompactionRecord 内部填入）
     */
    function makeCompactionInput(overrides?: Record<string, unknown>) {
      return {
        type: 'compaction' as const,
        id: 'c1',
        timestamp: new Date().toISOString(),
        summary: 'Test summary.',
        tokensBefore: 2000,
        tokensAfter: 400,
        trigger: 'overflow' as const,
        droppedMessages: 4,
        ...overrides,
      };
    }

    it('writes the record so getLastCompactionRecord returns it', async () => {
      await manager.createSession('main');
      const id1 = await manager.appendMessage('main', { role: 'user', content: 'msg 1' });
      await manager.appendMessage('main', { role: 'assistant', content: 'reply 1' });

      // 记录保留区第一条消息的 ID
      await manager.appendCompactionRecord('main', makeCompactionInput(), id1);

      const record = manager.getLastCompactionRecord('main');
      expect(record).not.toBeNull();
      expect(record!.id).toBe('c1');
      expect(record!.summary).toBe('Test summary.');
      expect(record!.firstKeptEntryId).toBe(id1);
    });

    it('does NOT update leafId after writing compaction record', async () => {
      await manager.createSession('main');
      await manager.appendMessage('main', { role: 'user', content: 'msg' });
      const leafBefore = manager.getLeafId('main');

      await manager.appendCompactionRecord('main', makeCompactionInput(), 'some-id');

      // leafId 仍应保持不变——压缩记录是"标记节点"，不加入消息链
      expect(manager.getLeafId('main')).toBe(leafBefore);
    });

    it('increments compactionCount in session store', async () => {
      await manager.createSession('main');
      const before = manager.getSession('main')!.compactionCount ?? 0;

      await manager.appendCompactionRecord('main', makeCompactionInput(), 'some-id');

      const after = manager.getSession('main')!.compactionCount ?? 0;
      expect(after).toBe(before + 1);
    });

    it('sets parentId to current leafId at time of compaction', async () => {
      await manager.createSession('main');
      const leafId = await manager.appendMessage('main', { role: 'user', content: 'msg' });

      await manager.appendCompactionRecord('main', makeCompactionInput(), leafId);

      const record = manager.getLastCompactionRecord('main');
      // parentId 应该等于写入时的 leafId
      expect(record!.parentId).toBe(leafId);
    });

    it('compaction record survives session reload from disk', async () => {
      await manager.createSession('main');
      const id1 = await manager.appendMessage('main', { role: 'user', content: 'msg 1' });

      await manager.appendCompactionRecord('main', makeCompactionInput({ id: 'c-persist' }), id1);

      // 模拟重启：新 manager 实例从磁盘加载
      const manager2 = new SessionManager(workspaceDir);
      const record = manager2.getLastCompactionRecord('main');
      expect(record).not.toBeNull();
      expect(record!.id).toBe('c-persist');
      expect(record!.trigger).toBe('overflow');
      expect(record!.droppedMessages).toBe(4);
    });

    it('getLastCompactionRecord returns the most recent when multiple records exist', async () => {
      await manager.createSession('main');
      const id1 = await manager.appendMessage('main', { role: 'user', content: 'msg 1' });

      // 写入两条压缩记录，c2 的 timestamp 更晚
      await manager.appendCompactionRecord(
        'main',
        makeCompactionInput({ id: 'c1', timestamp: '2026-04-01T08:00:00Z' }),
        id1,
      );
      await manager.appendCompactionRecord(
        'main',
        makeCompactionInput({ id: 'c2', timestamp: '2026-04-01T12:00:00Z' }),
        id1,
      );

      const record = manager.getLastCompactionRecord('main');
      expect(record!.id).toBe('c2');
    });
  });

  describe('getLastCompactionRecord', () => {
    it('returns null when session has never been compacted', async () => {
      await manager.createSession('main');
      await manager.appendMessage('main', { role: 'user', content: 'hi' });

      expect(manager.getLastCompactionRecord('main')).toBeNull();
    });
  });

  // ── capToolResults（写盘截断）────────────────────────

  describe('capToolResults (SessionManagerOptions)', () => {
    it('does not cap when options not provided (default constructor)', async () => {
      // manager 由 beforeEach 创建，未传 options
      await manager.createSession('main');
      const longContent = 'A'.repeat(50_000);
      const msgId = await manager.appendMessage('main', {
        role: 'toolResult',
        content: [{ type: 'tool_result', content: longContent }],
      });

      // 重新加载后内容应原样保留
      const manager2 = new SessionManager(workspaceDir);
      const msgs = manager2.getMessages('main');
      const record = msgs.find((m) => m.id === msgId);
      const block = (record!.message.content as Array<{ type: string; content: string }>)[0]!;
      expect(block.content).toBe(longContent);
    });

    it('caps tool result content when toolResultHeadChars + toolResultTailChars configured', async () => {
      const cappedManager = new SessionManager(workspaceDir, {
        toolResultHeadChars: 100,
        toolResultTailChars: 50,
      });
      await cappedManager.createSession('capped');
      const longContent = 'H'.repeat(100) + 'M'.repeat(200) + 'T'.repeat(50);

      await cappedManager.appendMessage('capped', {
        role: 'toolResult',
        content: [{ type: 'tool_result', content: longContent }],
      });

      // 重新加载，验证磁盘上已经是裁剪后的数据
      const manager2 = new SessionManager(workspaceDir);
      const msgs = manager2.getMessages('capped');
      const block = (msgs[0]!.message.content as Array<{ type: string; content: string }>)[0]!;
      expect(block.content).toContain('[Tool result trimmed:');
      expect(block.content).toContain('H'.repeat(100));      // head
      expect(block.content).toContain('T'.repeat(50));       // tail
      expect(block.content).not.toContain('M'.repeat(200));  // middle dropped
    });

    it('does not cap when content length <= head + tail', async () => {
      const cappedManager = new SessionManager(workspaceDir, {
        toolResultHeadChars: 100,
        toolResultTailChars: 50,
      });
      await cappedManager.createSession('small');
      const shortContent = 'X'.repeat(149); // exactly at maxChars threshold

      await cappedManager.appendMessage('small', {
        role: 'toolResult',
        content: [{ type: 'tool_result', content: shortContent }],
      });

      const manager2 = new SessionManager(workspaceDir);
      const msgs = manager2.getMessages('small');
      const block = (msgs[0]!.message.content as Array<{ type: string; content: string }>)[0]!;
      expect(block.content).toBe(shortContent);
    });

    it('passes through non-tool_result blocks unchanged', async () => {
      const cappedManager = new SessionManager(workspaceDir, {
        toolResultHeadChars: 10,
        toolResultTailChars: 5,
      });
      await cappedManager.createSession('mixed');
      const longText = 'Z'.repeat(1000);

      await cappedManager.appendMessage('mixed', {
        role: 'toolResult',
        content: [{ type: 'text', content: longText }],
      });

      const manager2 = new SessionManager(workspaceDir);
      const msgs = manager2.getMessages('mixed');
      const block = (msgs[0]!.message.content as Array<{ type: string; content: string }>)[0]!;
      // type !== 'tool_result' → not capped
      expect(block.content).toBe(longText);
    });
  });
});