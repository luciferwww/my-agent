import { describe, it, expect } from 'vitest';
import { resolveSubagentTools } from './profile-tools.js';
import type { SubagentProfile } from './types.js';

function profile(overrides: Partial<SubagentProfile> = {}): SubagentProfile {
  return {
    id: 'reviewer',
    description: 'reviews code',
    agentDir: '/tmp/ws/.agent/subagents/reviewer',
    ...overrides,
  };
}

const PARENT_ALLOW = Object.freeze(['read_file', 'grep_search']) as readonly string[];
const PARENT_DENY = Object.freeze(['exec']) as readonly string[];

// ── allow inheritance ────────────────────────────────────────

describe('resolveSubagentTools — allow', () => {
  it('inherits parent allow when the child does not set tools.allow', () => {
    const { allow } = resolveSubagentTools(profile(), PARENT_ALLOW, PARENT_DENY);
    expect(allow).toEqual(['read_file', 'grep_search']);
  });

  it('replaces parent allow when the child sets tools.allow', () => {
    const { allow } = resolveSubagentTools(
      profile({ tools: { allow: ['write_file'] } }),
      PARENT_ALLOW,
      PARENT_DENY,
    );
    expect(allow).toEqual(['write_file']);
  });

  it('replaces with an empty allow when the child explicitly sets allow:[]', () => {
    const { allow } = resolveSubagentTools(
      profile({ tools: { allow: [] } }),
      PARENT_ALLOW,
      PARENT_DENY,
    );
    expect(allow).toEqual([]);
  });

  it('returns a fresh array that does not alias parent allow', () => {
    const parent = ['read_file'];
    const { allow } = resolveSubagentTools(profile(), parent, PARENT_DENY);
    expect(allow).not.toBe(parent);
    allow.push('mutated');
    expect(parent).toEqual(['read_file']);
  });
});

// ── deny inheritance ─────────────────────────────────────────

describe('resolveSubagentTools — deny', () => {
  it('inherits parent deny when the child does not set tools.deny', () => {
    const { deny } = resolveSubagentTools(profile(), PARENT_ALLOW, PARENT_DENY);
    expect(deny).toEqual(['exec']);
  });

  it('appends child deny on top of parent deny', () => {
    const { deny } = resolveSubagentTools(
      profile({ tools: { deny: ['write_file'] } }),
      PARENT_ALLOW,
      PARENT_DENY,
    );
    expect(deny).toEqual(['exec', 'write_file']);
  });

  it('keeps duplicate entries when child re-lists a parent deny', () => {
    // Per spec the merge is a simple concat — duplicates are tolerated
    // because deny matching is set-based at run time.
    const { deny } = resolveSubagentTools(
      profile({ tools: { deny: ['exec', 'rm'] } }),
      PARENT_ALLOW,
      PARENT_DENY,
    );
    expect(deny).toEqual(['exec', 'exec', 'rm']);
  });

  it('child deny:[] does not inherit parent deny (explicit empty replaces append target)', () => {
    // tools.deny !== undefined branch: parent deny is still copied first, then
    // an empty child array contributes nothing => result === parent deny.
    const { deny } = resolveSubagentTools(
      profile({ tools: { deny: [] } }),
      PARENT_ALLOW,
      PARENT_DENY,
    );
    expect(deny).toEqual(['exec']);
  });

  it('returns a fresh array that does not alias parent deny', () => {
    const parent = ['exec'];
    const { deny } = resolveSubagentTools(profile(), PARENT_ALLOW, parent);
    expect(deny).not.toBe(parent);
    deny.push('mutated');
    expect(parent).toEqual(['exec']);
  });
});

// ── no cross-filter (deny precedence is enforced elsewhere) ──

describe('resolveSubagentTools — no cross-filter', () => {
  it('does NOT strip names that appear in both allow and deny', () => {
    // Per spec decision 5, deny precedence is enforced by applyDenyFilter
    // at tool-registration time AND resolveToolPolicy at run time.
    // This function must NOT duplicate that filter.
    const result = resolveSubagentTools(
      profile({ tools: { allow: ['read_file', 'exec'], deny: ['exec'] } }),
      PARENT_ALLOW,
      PARENT_DENY,
    );
    expect(result.allow).toContain('exec');
    expect(result.deny).toContain('exec');
  });

  it('passes glob entries through verbatim', () => {
    const result = resolveSubagentTools(
      profile({ tools: { allow: ['fs_*'], deny: ['*_dangerous'] } }),
      PARENT_ALLOW,
      PARENT_DENY,
    );
    expect(result.allow).toEqual(['fs_*']);
    expect(result.deny).toEqual(['exec', '*_dangerous']);
  });
});
