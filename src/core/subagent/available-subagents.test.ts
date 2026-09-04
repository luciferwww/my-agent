import { describe, it, expect } from 'vitest';
import {
  collectAvailableSubagents,
  renderAvailableSubagentsSection,
  type AvailableSubagentEntry,
} from './available-subagents.js';
import type { SubagentProfile } from './types.js';

function profile(id: string, description: string): SubagentProfile {
  return {
    id,
    description,
    agentDir: `/tmp/ws/.agent/subagents/${id}`,
    model: 'inherit',
  };
}

// ── collectAvailableSubagents ────────────────────────────────

describe('collectAvailableSubagents', () => {
  it('projects each profile to { id, description }', () => {
    const map = new Map<string, SubagentProfile>([
      ['a', profile('a', 'A desc')],
      ['b', profile('b', 'B desc')],
    ]);
    expect(collectAvailableSubagents(map)).toEqual([
      { id: 'a', description: 'A desc' },
      { id: 'b', description: 'B desc' },
    ]);
  });

  it('drops profile fields other than id and description', () => {
    const map = new Map<string, SubagentProfile>([
      [
        'a',
        {
          id: 'a',
          description: 'A',
          agentDir: '/tmp/ws/.agent/subagents/a',
          model: { providerId: 'openai', modelId: 'gpt-5' },
          tools: { allow: ['read_file'] },
          maxLlmCalls: 8,
        },
      ],
    ]);
    expect(collectAvailableSubagents(map)).toEqual([{ id: 'a', description: 'A' }]);
  });

  it('returns an empty array for an empty map', () => {
    expect(collectAvailableSubagents(new Map())).toEqual([]);
  });

  it('preserves Map insertion order', () => {
    const map = new Map<string, SubagentProfile>();
    map.set('general-purpose', profile('general-purpose', 'fallback'));
    map.set('reviewer', profile('reviewer', 'review code'));
    map.set('planner', profile('planner', 'plan tasks'));
    expect(collectAvailableSubagents(map).map((e) => e.id)).toEqual([
      'general-purpose',
      'reviewer',
      'planner',
    ]);
  });
});

// ── renderAvailableSubagentsSection ──────────────────────────

describe('renderAvailableSubagentsSection', () => {
  it('returns "" for an empty list (caller can append unconditionally)', () => {
    expect(renderAvailableSubagentsSection([])).toBe('');
  });

  it('wraps entries in <available-subagents> ... </available-subagents>', () => {
    const out = renderAvailableSubagentsSection([{ id: 'a', description: 'A' }]);
    expect(out.startsWith('<available-subagents>')).toBe(true);
    expect(out.endsWith('</available-subagents>')).toBe(true);
  });

  it('renders entries in input order as "- <id>: <description>"', () => {
    const entries: AvailableSubagentEntry[] = [
      { id: 'general-purpose', description: 'fallback' },
      { id: 'reviewer', description: 'review code' },
    ];
    const out = renderAvailableSubagentsSection(entries);
    const idxFirst = out.indexOf('- general-purpose: fallback');
    const idxSecond = out.indexOf('- reviewer: review code');
    expect(idxFirst).toBeGreaterThan(0);
    expect(idxSecond).toBeGreaterThan(idxFirst);
  });

  it('includes the `task` tool delegation hint and blocking-call guideline', () => {
    const out = renderAvailableSubagentsSection([{ id: 'a', description: 'A' }]);
    expect(out).toContain('`task` tool');
    expect(out).toContain('Each `task` call is blocking.');
  });

  it('includes the "Available subagent types:" header', () => {
    const out = renderAvailableSubagentsSection([{ id: 'a', description: 'A' }]);
    expect(out).toContain('Available subagent types:');
  });
});
