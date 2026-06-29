import { describe, it, expect } from 'vitest';
import { resolveSubagentCapabilities } from './capabilities.js';
import { formatSubagentSessionKey } from './session-key.js';

describe('resolveSubagentCapabilities', () => {
  describe('maxDepth = 1', () => {
    it('classifies the main agent (depth=0) as main and allows spawn', () => {
      const caps = resolveSubagentCapabilities('main', 1);
      expect(caps.depth).toBe(0);
      expect(caps.role).toBe('main');
      expect(caps.canSpawn).toBe(true);
    });

    it('classifies a depth-1 subagent as leaf and forbids spawn', () => {
      const key = formatSubagentSessionKey({ rootLabel: 'main', runId: 'r1', depth: 1 });
      const caps = resolveSubagentCapabilities(key, 1);
      expect(caps.depth).toBe(1);
      expect(caps.role).toBe('leaf');
      expect(caps.canSpawn).toBe(false);
    });
  });

  describe('maxDepth = 2', () => {
    it('classifies depth-1 as orchestrator and allows spawn', () => {
      const key = formatSubagentSessionKey({ rootLabel: 'main', runId: 'r1', depth: 1 });
      const caps = resolveSubagentCapabilities(key, 2);
      expect(caps.depth).toBe(1);
      expect(caps.role).toBe('orchestrator');
      expect(caps.canSpawn).toBe(true);
    });

    it('classifies depth-2 as leaf and forbids spawn', () => {
      const key = `${formatSubagentSessionKey({ rootLabel: 'main', runId: 'r1', depth: 1 })}:subagent:r2:2`;
      const caps = resolveSubagentCapabilities(key, 2);
      expect(caps.depth).toBe(2);
      expect(caps.role).toBe('leaf');
      expect(caps.canSpawn).toBe(false);
    });
  });

  describe('maxDepth = 0 (no spawning allowed)', () => {
    it('classifies the main agent as leaf', () => {
      const caps = resolveSubagentCapabilities('main', 0);
      expect(caps.depth).toBe(0);
      expect(caps.role).toBe('leaf');
      expect(caps.canSpawn).toBe(false);
    });
  });

  describe('beyond maxDepth', () => {
    it('classifies depth=3 with maxDepth=2 as leaf', () => {
      const key =
        'main:subagent:r1:1:subagent:r2:2:subagent:r3:3';
      const caps = resolveSubagentCapabilities(key, 2);
      expect(caps.depth).toBe(3);
      expect(caps.role).toBe('leaf');
      expect(caps.canSpawn).toBe(false);
    });
  });
});
