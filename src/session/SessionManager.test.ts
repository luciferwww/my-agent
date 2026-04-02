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
});
