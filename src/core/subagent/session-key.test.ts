import { describe, it, expect } from 'vitest';
import {
  formatSubagentSessionKey,
  isSubagentSessionKey,
  getSubagentDepth,
  parseSubagentSessionKey,
} from './session-key.js';

describe('formatSubagentSessionKey', () => {
  it('produces the canonical <rootLabel>:subagent:<runId>:<depth> format', () => {
    expect(formatSubagentSessionKey({ rootLabel: 'main', runId: 'abc', depth: 1 })).toBe(
      'main:subagent:abc:1',
    );
  });

  it('preserves rootLabel that already contains :subagent: nesting', () => {
    expect(
      formatSubagentSessionKey({
        rootLabel: 'main:subagent:abc:1',
        runId: 'def',
        depth: 2,
      }),
    ).toBe('main:subagent:abc:1:subagent:def:2');
  });

  it('preserves rootLabel that contains colons (channel:id form)', () => {
    expect(
      formatSubagentSessionKey({ rootLabel: 'channel:cid-42', runId: 'r1', depth: 1 }),
    ).toBe('channel:cid-42:subagent:r1:1');
  });
});

describe('isSubagentSessionKey', () => {
  it('returns false for non-subagent keys', () => {
    expect(isSubagentSessionKey('main')).toBe(false);
    expect(isSubagentSessionKey('channel:cid-42')).toBe(false);
  });

  it('returns true for any depth >= 1', () => {
    expect(isSubagentSessionKey('main:subagent:abc:1')).toBe(true);
    expect(isSubagentSessionKey('main:subagent:abc:1:subagent:def:2')).toBe(true);
  });
});

describe('getSubagentDepth', () => {
  it('returns 0 for a top-level (non-subagent) key', () => {
    expect(getSubagentDepth('main')).toBe(0);
    expect(getSubagentDepth('channel:cid-42')).toBe(0);
  });

  it('returns 1 for a single :subagent: separator', () => {
    expect(getSubagentDepth('main:subagent:abc:1')).toBe(1);
  });

  it('returns 2 for a nested subagent key', () => {
    expect(getSubagentDepth('main:subagent:abc:1:subagent:def:2')).toBe(2);
  });

  it('returns 3 for a deeper nesting', () => {
    expect(
      getSubagentDepth('main:subagent:a:1:subagent:b:2:subagent:c:3'),
    ).toBe(3);
  });
});

describe('parseSubagentSessionKey', () => {
  it('is the inverse of formatSubagentSessionKey for a single-level key', () => {
    const key = formatSubagentSessionKey({ rootLabel: 'main', runId: 'abc', depth: 1 });
    const parsed = parseSubagentSessionKey(key);
    expect(parsed.rootLabel).toBe('main');
    expect(parsed.runId).toBe('abc');
    expect(parsed.depth).toBe(1);
  });

  it('reports rootLabel as everything before the FIRST :subagent: separator', () => {
    const key = 'main:subagent:abc:1:subagent:def:2';
    const parsed = parseSubagentSessionKey(key);
    expect(parsed.rootLabel).toBe('main');
  });

  it('reports runId/depth from the LAST :subagent:<id>:<depth> segment', () => {
    const key = 'main:subagent:abc:1:subagent:def:2';
    const parsed = parseSubagentSessionKey(key);
    expect(parsed.runId).toBe('def');
    expect(parsed.depth).toBe(2);
  });

  it('returns NaN depth for a non-subagent key (caller must guard with isSubagentSessionKey)', () => {
    const parsed = parseSubagentSessionKey('main');
    expect(parsed.depth).toBeNaN();
  });
});
