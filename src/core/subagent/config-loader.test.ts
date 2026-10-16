import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import {
  loadConfiguredAgentProfiles as loadSubagentProfiles,
  buildGeneralPurposeProfile,
} from './config-loader.js';

const WS = '/tmp/ws';
const REGISTERED = new Set<string>([
  'read_file',
  'write_file',
  'exec',
  'grep_search',
  'task',
]);

type ConfiguredAgentEntry = Parameters<typeof loadSubagentProfiles>[0][number];

function entry(overrides: Partial<ConfiguredAgentEntry>): ConfiguredAgentEntry {
  return {
    id: 'reviewer',
    description: 'reviews code',
    ...overrides,
  };
}

// ── id validation ────────────────────────────────────────────

describe('loadSubagentProfiles — id validation', () => {
  it('accepts a typical kebab-case id', () => {
    const profiles = loadSubagentProfiles([entry({ id: 'code-reviewer' })], WS, REGISTERED);
    expect(profiles).toHaveLength(1);
    expect(profiles[0]!.id).toBe('code-reviewer');
  });

  it('accepts snake_case and digits', () => {
    expect(
      loadSubagentProfiles([entry({ id: 'reviewer_v2' })], WS, REGISTERED),
    ).toHaveLength(1);
    expect(
      loadSubagentProfiles([entry({ id: 'agent7' })], WS, REGISTERED),
    ).toHaveLength(1);
  });

  it('rejects an empty id', () => {
    expect(() => loadSubagentProfiles([entry({ id: '' })], WS, REGISTERED)).toThrow(
      /invalid id/i,
    );
  });

  it('rejects an id with uppercase or special characters', () => {
    expect(() =>
      loadSubagentProfiles([entry({ id: 'Reviewer' })], WS, REGISTERED),
    ).toThrow(/invalid id/i);
    expect(() =>
      loadSubagentProfiles([entry({ id: 'code reviewer' })], WS, REGISTERED),
    ).toThrow(/invalid id/i);
    expect(() =>
      loadSubagentProfiles([entry({ id: 'code.reviewer' })], WS, REGISTERED),
    ).toThrow(/invalid id/i);
  });

  it('rejects an id that does not start with alnum', () => {
    expect(() =>
      loadSubagentProfiles([entry({ id: '-reviewer' })], WS, REGISTERED),
    ).toThrow(/invalid id/i);
    expect(() =>
      loadSubagentProfiles([entry({ id: '_reviewer' })], WS, REGISTERED),
    ).toThrow(/invalid id/i);
  });

  it('rejects an id longer than 64 chars', () => {
    const tooLong = 'a'.repeat(65);
    expect(() =>
      loadSubagentProfiles([entry({ id: tooLong })], WS, REGISTERED),
    ).toThrow(/invalid id/i);
  });

  it('accepts an id exactly 64 chars long', () => {
    const justRight = 'a'.repeat(64);
    expect(
      loadSubagentProfiles([entry({ id: justRight })], WS, REGISTERED),
    ).toHaveLength(1);
  });
});

// ── reserved / duplicate ─────────────────────────────────────

describe('loadSubagentProfiles — reserved & duplicate ids', () => {
  it('rejects the reserved id "general-purpose"', () => {
    expect(() =>
      loadSubagentProfiles([entry({ id: 'general-purpose' })], WS, REGISTERED),
    ).toThrow(/reserved id/i);
  });

  it('rejects duplicate ids in the same list', () => {
    expect(() =>
      loadSubagentProfiles(
        [entry({ id: 'reviewer' }), entry({ id: 'reviewer' })],
        WS,
        REGISTERED,
      ),
    ).toThrow(/duplicate id/i);
  });
});

// ── description ──────────────────────────────────────────────

describe('loadSubagentProfiles — description', () => {
  it('rejects an empty description', () => {
    expect(() =>
      loadSubagentProfiles([entry({ description: '' })], WS, REGISTERED),
    ).toThrow(/description is required/i);
  });
});

// ── tools.allow ──────────────────────────────────────────────

describe('loadSubagentProfiles — tools.allow', () => {
  it('accepts the registered task Tool and leaves depth enforcement to execution', () => {
    const profiles = loadSubagentProfiles(
      [entry({ tools: { allow: ['read_file', 'task'] } })],
      WS,
      REGISTERED,
    );
    expect(profiles[0]!.tools?.allow).toEqual(['read_file', 'task']);
  });

  it('rejects an exact name that is not in registeredToolNames', () => {
    expect(() =>
      loadSubagentProfiles(
        [entry({ tools: { allow: ['nonexistent_tool'] } })],
        WS,
        REGISTERED,
      ),
    ).toThrow(/unknown tool "nonexistent_tool"/i);
  });

  it('accepts glob entries containing "*" without name lookup', () => {
    const profiles = loadSubagentProfiles(
      [entry({ tools: { allow: ['fs_*', 'grep_*'] } })],
      WS,
      REGISTERED,
    );
    expect(profiles[0]!.tools?.allow).toEqual(['fs_*', 'grep_*']);
  });

  it('accepts glob entries containing "?" without name lookup', () => {
    const profiles = loadSubagentProfiles(
      [entry({ tools: { allow: ['exec?'] } })],
      WS,
      REGISTERED,
    );
    expect(profiles[0]!.tools?.allow).toEqual(['exec?']);
  });

  it('accepts allow entries that ARE in registeredToolNames', () => {
    const profiles = loadSubagentProfiles(
      [entry({ tools: { allow: ['read_file', 'exec'] } })],
      WS,
      REGISTERED,
    );
    expect(profiles[0]!.tools?.allow).toEqual(['read_file', 'exec']);
  });
});

// ── projection to SubagentProfile ────────────────────────────

describe('loadSubagentProfiles — projection', () => {
  it('derives agentDir as <agentHome>/agents/<id>/', () => {
    const profiles = loadSubagentProfiles(
      [entry({ id: 'reviewer' })],
      '/work/space',
      REGISTERED,
    );
    expect(profiles[0]!.agentDir).toBe(join('/work/space', 'agents', 'reviewer'));
  });

  it('preserves model and tools verbatim', () => {
    const profiles = loadSubagentProfiles(
      [
        entry({
          id: 'reviewer',
          model: { providerId: 'openai', modelId: 'gpt-5' },
          tools: { allow: ['read_file'], deny: ['exec'] },
        }),
      ],
      WS,
      REGISTERED,
    );
    expect(profiles[0]!.model).toEqual({ providerId: 'openai', modelId: 'gpt-5' });
    expect(profiles[0]!.tools).toEqual({ allow: ['read_file'], deny: ['exec'] });
  });

  it('returns multiple profiles in input order', () => {
    const profiles = loadSubagentProfiles(
      [entry({ id: 'a' }), entry({ id: 'b' }), entry({ id: 'c' })],
      WS,
      REGISTERED,
    );
    expect(profiles.map((p) => p.id)).toEqual(['a', 'b', 'c']);
  });

  it('returns an empty array for an empty list', () => {
    expect(loadSubagentProfiles([], WS, REGISTERED)).toEqual([]);
  });
});

// ── buildGeneralPurposeProfile ───────────────────────────────

describe('buildGeneralPurposeProfile', () => {
  it('returns a profile with id="general-purpose"', () => {
    const profile = buildGeneralPurposeProfile('/work/space');
    expect(profile.id).toBe('general-purpose');
  });

  it('explicitly inherits the Parent model while leaving other settings unset', () => {
    const profile = buildGeneralPurposeProfile('/work/space');
    expect(profile.model).toBe('inherit');
    expect(profile.tools).toBeUndefined();
  });

  it('derives agentDir via the same rule as named profiles', () => {
    const profile = buildGeneralPurposeProfile('/work/space');
    expect(profile.agentDir).toBe(
      join('/work/space', 'agents', 'general-purpose'),
    );
  });

  it('has a non-empty description', () => {
    const profile = buildGeneralPurposeProfile('/work/space');
    expect(profile.description.length).toBeGreaterThan(0);
  });
});

describe('loadSubagentProfiles — model selection', () => {
  it('maps omitted Model to Parent inheritance and rejects legacy raw strings', () => {
    expect(loadSubagentProfiles([
      { id: 'missing', description: 'missing model' },
    ], WS, REGISTERED)[0]!.model).toBe('inherit');
    expect(() => loadSubagentProfiles([
      { id: 'legacy', description: 'legacy model', model: 'gpt-5' as never },
    ], WS, REGISTERED)).toThrow(/model must/i);
  });

  it('normalizes Provider ID and preserves opaque Model ID', () => {
    expect(loadSubagentProfiles([entry({
      model: { providerId: ' provider ', modelId: ' model ' },
    })], WS, REGISTERED)[0]!.model).toEqual({ providerId: 'provider', modelId: ' model ' });
  });

  it('rejects blank or non-string Model IDs, blank Provider IDs, and unknown fields', () => {
    expect(() => loadSubagentProfiles([entry({
      model: { providerId: 'provider', modelId: '' },
    })], WS, REGISTERED)).toThrow(/modelId must be nonblank/i);
    expect(() => loadSubagentProfiles([entry({
      model: { providerId: 'provider', modelId: 42 } as never,
    })], WS, REGISTERED)).toThrow(/modelId must be nonblank/i);
    expect(() => loadSubagentProfiles([entry({
      model: { modelId: 'model' } as never,
    })], WS, REGISTERED)).toThrow(/providerId must be nonblank/i);
    expect(() => loadSubagentProfiles([entry({
      model: { providerId: 'provider', modelId: 'model', extra: true } as never,
    })], WS, REGISTERED)).toThrow(/unknown field/i);
  });
});
