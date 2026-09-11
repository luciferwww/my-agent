import { describe, expect, it, vi } from 'vitest';
import type { ProviderProjectionEntry } from '../core/model-resolution/index.js';
import type { RuntimeContributionUnit } from '../core/registry/index.js';
import type { ApplicationToolPolicy, Tool } from '../core/tools/types.js';
import {
  finalizeRegistrySnapshot,
  resolveStagedRegistryCandidate,
  stageRegistryUnit,
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

function provider(id: string): ProviderProjectionEntry {
  return {
    id,
    models: [{ modelId: 'test-model' }],
    protocol: 'test',
    invocationPort: {} as never,
    resolveConnection: () => ({
      ok: false,
      category: 'connection_missing',
      message: 'not used',
    }),
    resolveModel: () => ({
      ok: false,
      category: 'model_rejected',
      message: 'not used',
    }),
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

function buildTestSnapshot(units: readonly RuntimeContributionUnit[]) {
  const candidate = resolveStagedRegistryCandidate({
    providers: [],
    units: units.map(stageRegistryUnit),
  });
  return finalizeRegistrySnapshot({
    candidate,
    acceptedUnits: candidate.units,
    channelBindings: [],
    generation: 1,
  });
}

describe('Registry staging and finalization', () => {
  it('reuses staged bindings without rerunning unchanged Unit registration', () => {
    const register = vi.fn((api: Parameters<RuntimeContributionUnit['register']>[0]) => {
      api.registerTool(tool('stable_tool'));
    });
    const staged = stageRegistryUnit(unit('stable', 'external', register));

    const candidate = resolveStagedRegistryCandidate({ providers: [], units: [staged] });

    expect(register).toHaveBeenCalledTimes(1);
    expect(candidate.units[0]).toBe(staged);
    expect(candidate.units[0]?.tools[0]).toBe(staged.tools[0]);
  });

  it('publishes Provider contributions through the common Unit path', () => {
    const snapshot = buildTestSnapshot([
      unit('provider-unit', 'builtin', (api) => {
        api.registerProvider(provider('primary'));
      }),
    ]);

    expect(snapshot.providers.map((entry) => entry.id)).toEqual(['primary']);
    expect(Object.isFrozen(snapshot.providers)).toBe(true);
  });

  it('validates, defensively copies, and deeply freezes Provider model Catalogs', () => {
    const sourceModel = { modelId: 'mutable-model.1', displayName: 'Mutable Model' };
    const sourceModels = [sourceModel];
    const sourceProvider = { ...provider('primary'), models: sourceModels };
    const staged = stageRegistryUnit(unit('provider-unit', 'builtin', (api) => {
      api.registerProvider(sourceProvider);
    }));
    const published = staged.providers[0]!;

    sourceModel.displayName = 'Changed';
    sourceModels.push({ modelId: 'late-model', displayName: 'Late' });

    expect(published.models).toEqual([
      { modelId: 'mutable-model.1', displayName: 'Mutable Model' },
    ]);
    expect(Object.isFrozen(published)).toBe(true);
    expect(Object.isFrozen(published.models)).toBe(true);
    expect(Object.isFrozen(published.models[0])).toBe(true);
    expect(published.invocationPort).toBe(sourceProvider.invocationPort);
  });

  it('preserves arbitrary Provider-owned Model ID strings', () => {
    const modelIds = ['', ' ', ' model/vendor:v1?x=1\n\u0000 ', 'x'.repeat(512)];
    const staged = stageRegistryUnit(unit('opaque-models', 'builtin', (api) => {
      api.registerProvider({
        ...provider('opaque-provider'),
        models: modelIds.map((modelId) => ({ modelId })),
      });
    }));

    expect(staged.providers[0]?.models.map((model) => model.modelId)).toEqual(modelIds);
  });

  it('rejects missing, duplicate, and non-string Provider model Catalog entries', () => {
    expect(() => stageRegistryUnit(unit('missing', 'builtin', (api) => {
      api.registerProvider({ ...provider('missing-provider'), models: undefined as never });
    }))).toThrow('must publish a model Catalog');
    expect(() => stageRegistryUnit(unit('duplicate', 'builtin', (api) => {
      api.registerProvider({
        ...provider('duplicate-provider'),
        models: [{ modelId: 'same' }, { modelId: 'same' }],
      });
    }))).toThrow('published duplicate model');
    expect(() => stageRegistryUnit(unit('invalid', 'builtin', (api) => {
      api.registerProvider({ ...provider('invalid-provider'), models: [{ modelId: 42 as never }] });
    }))).toThrow('Model identity');
  });

  it('does not widen application-owned Unit identity rules for opaque Model IDs', () => {
    expect(() => stageRegistryUnit(unit('invalid.provider-unit', 'builtin', (api) => {
      api.registerProvider(provider('valid-provider'));
    }))).toThrow('unit identity');
  });

  it('isolates an external Unit with a conflicting Provider identity atomically', () => {
    const snapshot = buildTestSnapshot([
        unit('builtin-provider', 'builtin', (api) => {
          api.registerProvider(provider('shared'));
        }),
        unit('external-provider', 'external', (api) => {
          api.registerProvider(provider('shared'));
          api.registerTool(tool('must_remain_hidden'));
        }),
    ]);

    expect(snapshot.providers.map((entry) => entry.id)).toEqual(['shared']);
    expect(snapshot.tools.resolve('must_remain_hidden')).toBeUndefined();
    expect(snapshot.diagnostics).toEqual([
      expect.objectContaining({ unitId: 'external-provider', code: 'UNIT_CONFLICT' }),
    ]);
  });

  it('publishes immutable Tool/Hook projections with deterministic Hook ordering', () => {
    const snapshot = buildTestSnapshot([
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
    ]);

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
    const snapshot = buildTestSnapshot([
      unit('builtin', 'builtin', (api) => {
        api.registerTool(tool('visible'));
        api.registerTool(tool('denied'));
      }),
    ]);
    const policy: ApplicationToolPolicy = {
      isDenied: (name) => name === 'denied',
      decide: () => 'deny',
    };

    expect(snapshot.tools.visibleDefinitions(policy).map((definition) => definition.name))
      .toEqual(['visible']);
    expect(snapshot.tools.resolve('denied')).toBeDefined();
    expect(snapshot.tools.visibleDefinitions(allowAll)).toHaveLength(2);
  });

  it('rejects an invalid staged unit without exposing partial contributions', () => {
    expect(() => buildTestSnapshot([unit('external-bad', 'external', (api) => {
        api.registerTool(tool('would_be_partial'));
        api.registerTool({
          ...tool('invalid'),
          inputSchema: { type: 'object', oneOf: [] },
        });
    })])).toThrow();
  });

  it('isolates a cross-unit Hook identity conflict within the same Hook kind', () => {
    const snapshot = buildTestSnapshot([
        unit('builtin-a', 'builtin', (api) => {
          api.registerHook({ id: 'audit', hookName: 'after_tool_call', handler: () => {} });
        }),
        unit('external-b', 'external', (api) => {
          api.registerTool(tool('isolated_tool'));
          api.registerHook({ id: 'audit', hookName: 'after_tool_call', handler: () => {} });
        }),
    ]);

    expect(snapshot.hooks.afterToolCall).toHaveLength(1);
    expect(snapshot.tools.resolve('isolated_tool')).toBeUndefined();
    expect(snapshot.diagnostics).toEqual([
      expect.objectContaining({ unitId: 'external-b', code: 'UNIT_CONFLICT' }),
    ]);
  });

  it('allows the same Hook contribution ID in different Hook kinds', () => {
    const snapshot = buildTestSnapshot([
      unit('builtin-a', 'builtin', (api) => {
        api.registerHook({ id: 'audit', hookName: 'before_compaction', handler: () => {} });
        api.registerHook({ id: 'audit', hookName: 'after_compaction', handler: () => {} });
      }),
    ]);

    expect(snapshot.hooks.beforeCompaction).toHaveLength(1);
    expect(snapshot.hooks.afterCompaction).toHaveLength(1);
  });

  it('fails startup for an invalid builtin unit', () => {
    expect(() => buildTestSnapshot([
      unit('builtin-bad', 'builtin', (api) => {
        api.registerTool({ ...tool('bad'), description: '' });
      }),
    ])).toThrow();
  });

  it('uses builtin-first and deterministic external acquisition conflict rules', () => {
    const snapshot = buildTestSnapshot([
        unit('external-z', 'external', (api) => api.registerTool(tool('shared')), 'z'),
        unit('external-a', 'external', (api) => api.registerTool(tool('shared')), 'a'),
        unit('builtin', 'builtin', (api) => api.registerTool(tool('builtin_only'))),
    ]);

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
    const candidate = resolveStagedRegistryCandidate({
      providers: [],
      units: [stageRegistryUnit(unit('channel-unit', 'builtin', (api) => {
        api.registerChannel({ id: 'cli', create });
      }))],
    });

    expect(create).not.toHaveBeenCalled();
    expect(candidate.units[0]?.channels.map((channel) => channel.id)).toEqual(['cli']);
  });

  it('isolates an external unit with a conflicting Channel identity atomically', () => {
    const candidate = resolveStagedRegistryCandidate({
      providers: [],
      units: [
        stageRegistryUnit(unit('builtin-channel', 'builtin', (api) => {
          api.registerChannel({ id: 'shared', create: vi.fn() });
        })),
        stageRegistryUnit(unit('external-channel', 'external', (api) => {
          api.registerTool(tool('must_remain_hidden'));
          api.registerChannel({ id: 'shared', create: vi.fn() });
        })),
      ],
    });

    expect(candidate.units.map((staged) => staged.unit.id)).toEqual(['builtin-channel']);
    expect(candidate.diagnostics).toEqual([
      expect.objectContaining({ unitId: 'external-channel', code: 'UNIT_CONFLICT' }),
    ]);
  });
});
