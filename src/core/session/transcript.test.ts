import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, readFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { loadTranscript, resolveLinearPath, appendToTranscript, findLastCompaction } from './transcript.js';
import type { MessageRecord, SessionRecord, CompactionRecord } from './types.js';

describe('transcript', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'transcript-test-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  describe('loadTranscript', () => {
    it('returns empty state when file does not exist', () => {
      const state = loadTranscript(join(dir, 'nonexistent.jsonl'));
      expect(state.byId.size).toBe(0);
      expect(state.leafId).toBeNull();
    });

    it('loads linear messages correctly', async () => {
      const filePath = join(dir, 'test.jsonl');
      const lines = [
        JSON.stringify({ type: 'session', id: 's1', parentId: null, timestamp: '2026-04-02T00:00:00Z', version: 1 }),
        JSON.stringify({ type: 'message', id: 'm1', parentId: 's1', timestamp: '2026-04-02T00:00:01Z', message: { role: 'user', content: 'hi' } }),
        JSON.stringify({ type: 'message', id: 'm2', parentId: 'm1', timestamp: '2026-04-02T00:00:02Z', message: { role: 'assistant', content: 'hello' } }),
      ];
      await writeFile(filePath, lines.join('\n') + '\n', 'utf-8');

      const state = loadTranscript(filePath);
      expect(state.byId.size).toBe(3);
      expect(state.leafId).toBe('m2');
    });

    it('loads branched messages correctly', async () => {
      const filePath = join(dir, 'branch.jsonl');
      const lines = [
        JSON.stringify({ type: 'session', id: 's1', parentId: null, timestamp: '2026-04-02T00:00:00Z', version: 1 }),
        JSON.stringify({ type: 'message', id: 'm1', parentId: 's1', timestamp: '2026-04-02T00:00:01Z', message: { role: 'user', content: 'hi' } }),
        JSON.stringify({ type: 'message', id: 'm2', parentId: 'm1', timestamp: '2026-04-02T00:00:02Z', message: { role: 'assistant', content: 'branch A' } }),
        JSON.stringify({ type: 'message', id: 'm3', parentId: 'm1', timestamp: '2026-04-02T00:00:03Z', message: { role: 'assistant', content: 'branch B' } }),
      ];
      await writeFile(filePath, lines.join('\n') + '\n', 'utf-8');

      const state = loadTranscript(filePath);
      expect(state.byId.size).toBe(4);
      // leafId 是最后一条记录
      expect(state.leafId).toBe('m3');
    });

    it('skips empty lines and malformed JSON', async () => {
      const filePath = join(dir, 'messy.jsonl');
      const content = [
        JSON.stringify({ type: 'session', id: 's1', parentId: null, timestamp: '2026-04-02T00:00:00Z', version: 1 }),
        '',
        'not valid json',
        JSON.stringify({ type: 'message', id: 'm1', parentId: 's1', timestamp: '2026-04-02T00:00:01Z', message: { role: 'user', content: 'hi' } }),
        '   ',
      ].join('\n');
      await writeFile(filePath, content, 'utf-8');

      const state = loadTranscript(filePath);
      expect(state.byId.size).toBe(2);
      expect(state.leafId).toBe('m1');
    });
  });

  describe('resolveLinearPath', () => {
    it('returns empty array when leafId is null', () => {
      const state = { byId: new Map(), leafId: null };
      const path = resolveLinearPath(state, null);
      expect(path).toEqual([]);
    });

    it('returns linear path from leaf to root (messages only)', () => {
      const session: SessionRecord = { type: 'session', id: 's1', parentId: null, timestamp: '2026-04-02T00:00:00Z', version: 1 };
      const m1: MessageRecord = { type: 'message', id: 'm1', parentId: 's1', timestamp: '2026-04-02T00:00:01Z', message: { role: 'user', content: 'hi' } };
      const m2: MessageRecord = { type: 'message', id: 'm2', parentId: 'm1', timestamp: '2026-04-02T00:00:02Z', message: { role: 'assistant', content: 'hello' } };

      const byId = new Map<string, any>([['s1', session], ['m1', m1], ['m2', m2]]);
      const path = resolveLinearPath({ byId, leafId: 'm2' }, 'm2');

      expect(path).toHaveLength(2);
      expect((path[0] as MessageRecord).id).toBe('m1');
      expect((path[1] as MessageRecord).id).toBe('m2');
    });

    it('resolves correct branch when there are multiple branches', () => {
      const session: SessionRecord = { type: 'session', id: 's1', parentId: null, timestamp: '2026-04-02T00:00:00Z', version: 1 };
      const m1: MessageRecord = { type: 'message', id: 'm1', parentId: 's1', timestamp: '2026-04-02T00:00:01Z', message: { role: 'user', content: 'hi' } };
      const m2a: MessageRecord = { type: 'message', id: 'm2a', parentId: 'm1', timestamp: '2026-04-02T00:00:02Z', message: { role: 'assistant', content: 'branch A' } };
      const m2b: MessageRecord = { type: 'message', id: 'm2b', parentId: 'm1', timestamp: '2026-04-02T00:00:03Z', message: { role: 'assistant', content: 'branch B' } };

      const byId = new Map<string, any>([['s1', session], ['m1', m1], ['m2a', m2a], ['m2b', m2b]]);

      // 从分支 A 的末端回溯
      const pathA = resolveLinearPath({ byId, leafId: 'm2a' }, 'm2a');
      expect(pathA).toHaveLength(2);
      expect((pathA[1] as MessageRecord).message.content).toBe('branch A');

      // 从分支 B 的末端回溯
      const pathB = resolveLinearPath({ byId, leafId: 'm2b' }, 'm2b');
      expect(pathB).toHaveLength(2);
      expect((pathB[1] as MessageRecord).message.content).toBe('branch B');
    });
  });

  describe('appendToTranscript', () => {
    it('appends a record to file', async () => {
      const filePath = join(dir, 'append.jsonl');
      await writeFile(filePath, '', 'utf-8');

      const record: MessageRecord = {
        type: 'message',
        id: 'm1',
        parentId: null,
        timestamp: '2026-04-02T00:00:00Z',
        message: { role: 'user', content: 'hello' },
      };

      await appendToTranscript(filePath, record);

      const raw = await readFile(filePath, 'utf-8');
      const lines = raw.trim().split('\n');
      expect(lines).toHaveLength(1);
      expect(JSON.parse(lines[0]!).id).toBe('m1');
    });

    it('handles concurrent appends in order', async () => {
      const filePath = join(dir, 'concurrent.jsonl');
      await writeFile(filePath, '', 'utf-8');

      const records = Array.from({ length: 5 }, (_, i) => ({
        type: 'message' as const,
        id: `m${i}`,
        parentId: i === 0 ? null : `m${i - 1}`,
        timestamp: new Date().toISOString(),
        message: { role: 'user' as const, content: `msg-${i}` },
      }));

      await Promise.all(records.map((r) => appendToTranscript(filePath, r)));

      const raw = await readFile(filePath, 'utf-8');
      const lines = raw.trim().split('\n');
      expect(lines).toHaveLength(5);
    });
  });

  // ── findLastCompaction ────────────────────────────────────

  describe('findLastCompaction', () => {
    /** 构造一条 CompactionRecord（parentId 可选） */
    function makeCompactionRecord(id: string, timestamp: string): CompactionRecord {
      return {
        type: 'compaction',
        id,
        parentId: null,
        timestamp,
        summary: `Summary from ${id}`,
        firstKeptEntryId: 'm1',
        tokensBefore: 1000,
        tokensAfter: 200,
        trigger: 'overflow',
        droppedMessages: 5,
      };
    }

    it('returns null when byId contains no compaction records', () => {
      const session: SessionRecord = {
        type: 'session', id: 's1', parentId: null,
        timestamp: '2026-04-01T00:00:00Z', version: 1,
      };
      const m1: MessageRecord = {
        type: 'message', id: 'm1', parentId: 's1',
        timestamp: '2026-04-01T00:00:01Z',
        message: { role: 'user', content: 'hi' },
      };
      const state = { byId: new Map([['s1', session], ['m1', m1]]), leafId: 'm1' };

      expect(findLastCompaction(state)).toBeNull();
    });

    it('returns the single compaction record when only one exists', () => {
      const c1 = makeCompactionRecord('c1', '2026-04-01T10:00:00Z');
      const state = { byId: new Map([['c1', c1]]), leafId: null };

      const result = findLastCompaction(state);
      expect(result).not.toBeNull();
      expect(result!.id).toBe('c1');
      expect(result!.summary).toBe('Summary from c1');
    });

    it('returns the most recent compaction record when multiple exist', () => {
      // c2 的 timestamp 晚于 c1，应该返回 c2
      const c1 = makeCompactionRecord('c1', '2026-04-01T08:00:00Z');
      const c2 = makeCompactionRecord('c2', '2026-04-01T12:00:00Z');
      const state = { byId: new Map([['c1', c1], ['c2', c2]]), leafId: null };

      const result = findLastCompaction(state);
      expect(result!.id).toBe('c2');
    });

    it('uses ISO 8601 string comparison (lexicographic order)', () => {
      // 两条记录同一天，不同时间
      const c1 = makeCompactionRecord('c1', '2026-04-01T23:59:59Z');
      const c2 = makeCompactionRecord('c2', '2026-04-02T00:00:01Z');
      const state = { byId: new Map([['c1', c1], ['c2', c2]]), leafId: null };

      // c2 的字典序更大（"2026-04-02..." > "2026-04-01..."）
      expect(findLastCompaction(state)!.id).toBe('c2');
    });

    it('ignores non-compaction records (message, session)', () => {
      const session: SessionRecord = {
        type: 'session', id: 's1', parentId: null,
        timestamp: '2026-04-01T00:00:00Z', version: 1,
      };
      const m1: MessageRecord = {
        type: 'message', id: 'm1', parentId: 's1',
        timestamp: '2026-04-01T00:00:01Z',
        message: { role: 'user', content: 'hi' },
      };
      const c1 = makeCompactionRecord('c1', '2026-04-01T10:00:00Z');
      const state = { byId: new Map([['s1', session], ['m1', m1], ['c1', c1]]), leafId: 'm1' };

      const result = findLastCompaction(state);
      expect(result!.id).toBe('c1');
      expect(result!.type).toBe('compaction');
    });

    it('persists compaction record to JSONL and can be reloaded', async () => {
      const filePath = join(dir, 'with-compaction.jsonl');
      const session: SessionRecord = {
        type: 'session', id: 's1', parentId: null,
        timestamp: '2026-04-01T00:00:00Z', version: 1,
      };
      const c1 = makeCompactionRecord('c1', '2026-04-01T10:00:00Z');

      await appendToTranscript(filePath, session);
      await appendToTranscript(filePath, c1);

      // 重新从磁盘加载，验证持久化后仍可查询
      const loaded = loadTranscript(filePath);
      const result = findLastCompaction(loaded);
      expect(result).not.toBeNull();
      expect(result!.id).toBe('c1');
      expect(result!.trigger).toBe('overflow');
      expect(result!.droppedMessages).toBe(5);
    });
  });
});
