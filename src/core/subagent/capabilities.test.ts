import { describe, it, expect } from 'vitest';
import { resolveSubagentCapabilities } from './capabilities.js';

describe('resolveSubagentCapabilities', () => {
  describe('maxDepth = 1', () => {
    it('classifies the main agent (depth=0) as main and allows spawn', () => {
      const caps = resolveSubagentCapabilities(0, 1);
      expect(caps.depth).toBe(0);
      expect(caps.role).toBe('main');
      expect(caps.canSpawn).toBe(true);
    });

    it('classifies a depth-1 subagent as leaf and forbids spawn', () => {
      const caps = resolveSubagentCapabilities(1, 1);
      expect(caps.depth).toBe(1);
      expect(caps.role).toBe('leaf');
      expect(caps.canSpawn).toBe(false);
    });
  });

  describe('maxDepth = 2', () => {
    it('classifies depth-1 as orchestrator and allows spawn', () => {
      const caps = resolveSubagentCapabilities(1, 2);
      expect(caps.depth).toBe(1);
      expect(caps.role).toBe('orchestrator');
      expect(caps.canSpawn).toBe(true);
    });

    it('classifies depth-2 as leaf and forbids spawn', () => {
      const caps = resolveSubagentCapabilities(2, 2);
      expect(caps.depth).toBe(2);
      expect(caps.role).toBe('leaf');
      expect(caps.canSpawn).toBe(false);
    });
  });

  describe('maxDepth = 0 (no spawning allowed)', () => {
    it('classifies the main agent as leaf', () => {
      const caps = resolveSubagentCapabilities(0, 0);
      expect(caps.depth).toBe(0);
      expect(caps.role).toBe('leaf');
      expect(caps.canSpawn).toBe(false);
    });
  });

  describe('beyond maxDepth', () => {
    it('classifies depth=3 with maxDepth=2 as leaf', () => {
      const caps = resolveSubagentCapabilities(3, 2);
      expect(caps.depth).toBe(3);
      expect(caps.role).toBe('leaf');
      expect(caps.canSpawn).toBe(false);
    });
  });
});
