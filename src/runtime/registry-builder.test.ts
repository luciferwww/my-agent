import { describe, expect, it, vi } from 'vitest';
import type { RuntimeContributionUnit } from '../core/registry/index.js';
import type { ApplicationToolPolicy, Tool } from '../core/tools/types.js';
import {
  buildRegistrySnapshot,
  RegistryBuildError,
  stageRegistryCandidate,
} from './registry-builder.js';

function tool(name: string): Tool {
  return {
    name,
    description: `${name} description`,
    inputSchema: { type: 'object', properties: {} },
    async execute() {
      return { outcome: 'success', content: name };
    },
  };
}

function unit(
  id: string,
  source: 'builtin' | 'external',
  register: RuntimeContributionUnit['register'],
  orderKey = id,
): RuntimeContributionUnit {
  return { id, source, orderKey, register };
}

const allowAll: ApplicationToolPolicy = {
  isDenied: () => false,
  decide: () => 'allow',
};

describe('buildRegistrySnapshot', () => {
  it('publishes immutable Tool/Hook projections with deterministic Hook ordering', () => {
    const snapshot = buildRegistrySnapshot({
      providers: [],
      units: [
        unit('unit-z', 'external', (api) => {
          api.registerTool(tool('z_tool'));
          api.registerHook({
            id: 'same-priority-z',
            hookName: 'before_tool_call',
            priority: 5,
            handler: () => ({ action: 'allow' as const }),
          });
        }),
        unit('unit-a', 'builtin', (api) => {
          api.registerTool(tool('a_tool'));
          api.registerHook({
            id: 'higher',
            hookName: 'before_tool_call',
            priority: 10,
            handler: () => ({ action: 'allow' as const }),
          });
          api.registerHook({
            id: 'same-priority-a',
            hookName: 'before_tool_call',
            priority: 5,
            handler: () => ({ action: 'allow' as const }),
          });
        }),
      ],
    });

    expect(snapshot.tools.definitions.map((definition) => definition.name)).toEqual([
      'a_tool',
      'z_tool',
    ]);
    expect(snapshot.hooks.beforeToolCall.map((hook) => [
      hook.priority,
      hook.unitId,
      hook.contributionId,
    ])).toEqual([
      [10, 'unit-a', 'higher'],
      [5, 'unit-a', 'same-priority-a'],
      [5, 'unit-z', 'same-priority-z'],
    ]);
    expect(snapshot.tools.resolve('a_tool')?.validator.validate({}).valid).toBe(true);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.tools.definitions)).toBe(true);
  });

  it('hides explicit deny definitions without removing their implementation', () => {
    const snapshot = buildRegistrySnapshot({
      providers: [],
      units: [unit('builtin', 'builtin', (api) => {
        api.registerTool(tool('visible'));
        api.registerTool(tool('denied'));
      })],
    });
    const policy: ApplicationToolPolicy = {
      isDenied: (name) => name === 'denied',
      decide: () => 'deny',
    };

    expect(snapshot.tools.visibleDefinitions(policy).map((definition) => definition.name))
      .toEqual(['visible']);
    expect(snapshot.tools.resolve('denied')).toBeDefined();
    expect(snapshot.tools.visibleDefinitions(allowAll)).toHaveLength(2);
  });

  it('isolates an invalid external unit atomically', () => {
    const snapshot = buildRegistrySnapshot({
      providers: [],
      units: [unit('external-bad', 'external', (api) => {
        api.registerTool(tool('would_be_partial'));
        api.registerTool({
          ...tool('invalid'),
          inputSchema: { type: 'object', oneOf: [] },
        });
      })],
    });

    expect(snapshot.tools.definitions).toEqual([]);
    expect(snapshot.diagnostics).toEqual([
      expect.objectContaining({ unitId: 'external-bad', code: 'UNIT_INVALID' }),
    ]);
  });

  it('isolates a cross-unit Hook identity conflict within the same Hook kind', () => {
    const snapshot = buildRegistrySnapshot({
      providers: [],
      units: [
        unit('builtin-a', 'builtin', (api) => {
          api.registerHook({ id: 'audit', hookName: 'after_tool_call', handler: () => {} });
        }),
        unit('external-b', 'external', (api) => {
          api.registerTool(tool('isolated_tool'));
          api.registerHook({ id: 'audit', hookName: 'after_tool_call', handler: () => {} });
        }),
      ],
    });

    expect(snapshot.hooks.afterToolCall).toHaveLength(1);
    expect(snapshot.tools.resolve('isolated_tool')).toBeUndefined();
    expect(snapshot.diagnostics).toEqual([
      expect.objectContaining({ unitId: 'external-b', code: 'UNIT_CONFLICT' }),
    ]);
  });

  it('allows the same Hook contribution ID in different Hook kinds', () => {
    const snapshot = buildRegistrySnapshot({
      providers: [],
      units: [unit('builtin-a', 'builtin', (api) => {
        api.registerHook({ id: 'audit', hookName: 'before_compaction', handler: () => {} });
        api.registerHook({ id: 'audit', hookName: 'after_compaction', handler: () => {} });
      })],
    });

    expect(snapshot.hooks.beforeCompaction).toHaveLength(1);
    expect(snapshot.hooks.afterCompaction).toHaveLength(1);
  });

  it('fails startup for an invalid builtin unit', () => {
    expect(() => buildRegistrySnapshot({
      providers: [],
      units: [unit('builtin-bad', 'builtin', (api) => {
        api.registerTool({ ...tool('bad'), description: '' });
      })],
    })).toThrow(RegistryBuildError);
  });

  it('uses builtin-first and deterministic external acquisition conflict rules', () => {
    const snapshot = buildRegistrySnapshot({
      providers: [],
      units: [
        unit('external-z', 'external', (api) => api.registerTool(tool('shared')), 'z'),
        unit('external-a', 'external', (api) => api.registerTool(tool('shared')), 'a'),
        unit('builtin', 'builtin', (api) => api.registerTool(tool('builtin_only'))),
      ],
    });

    expect(snapshot.tools.definitions.map((definition) => definition.name)).toEqual([
      'builtin_only',
      'shared',
    ]);
    expect(snapshot.tools.resolve('shared')?.unitId).toBe('external-a');
    expect(snapshot.diagnostics).toEqual([
      expect.objectContaining({ unitId: 'external-z', code: 'UNIT_CONFLICT' }),
    ]);
  });

  it('stages Channel factories without creating concrete instances', () => {
    const create = vi.fn();
    const candidate = stageRegistryCandidate({
      providers: [],
      units: [unit('channel-unit', 'builtin', (api) => {
        api.registerChannel({ id: 'cli', create });
      })],
    });

    expect(create).not.toHaveBeenCalled();
    expect(candidate.units[0]?.channels.map((channel) => channel.id)).toEqual(['cli']);
    expect(() => buildRegistrySnapshot({
      providers: [],
      units: [unit('channel-unit', 'builtin', (api) => {
        api.registerChannel({ id: 'cli', create });
      })],
    })).toThrow('Channel contributions require startup activation');
  });

  it('isolates an external unit with a conflicting Channel identity atomically', () => {
    const candidate = stageRegistryCandidate({
      providers: [],
      units: [
        unit('builtin-channel', 'builtin', (api) => {
          api.registerChannel({ id: 'shared', create: vi.fn() });
        }),
        unit('external-channel', 'external', (api) => {
          api.registerTool(tool('must_remain_hidden'));
          api.registerChannel({ id: 'shared', create: vi.fn() });
        }),
      ],
    });

    expect(candidate.units.map((staged) => staged.unit.id)).toEqual(['builtin-channel']);
    expect(candidate.diagnostics).toEqual([
      expect.objectContaining({ unitId: 'external-channel', code: 'UNIT_CONFLICT' }),
    ]);
  });
});
