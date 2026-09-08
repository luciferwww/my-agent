import { describe, expect, it, vi } from 'vitest';
import type { RuntimeContributionUnit } from '../core/registry/index.js';
import {
  RuntimeUnitCatalog,
  createLoadedRuntimeUnit,
  type LoadedRuntimeUnit,
} from './runtime-unit.js';

function unit(
  unitId: string,
  options: Partial<Omit<LoadedRuntimeUnit, 'unitId' | 'create'>> = {},
): LoadedRuntimeUnit {
  const registration: RuntimeContributionUnit = {
    id: unitId,
    source: options.source ?? 'external',
    orderKey: options.orderKey ?? unitId,
    register: vi.fn(),
  };
  return {
    unitId,
    source: options.source ?? 'external',
    orderKey: options.orderKey ?? unitId,
    required: options.required ?? false,
    initiallyEnabled: options.initiallyEnabled ?? true,
    dependencies: options.dependencies ?? [],
    create: vi.fn(async () => ({
      registration,
      start: vi.fn(),
      stop: vi.fn(),
    })),
  };
}

describe('RuntimeUnitCatalog', () => {
  it('orders startup units by dependencies, source, orderKey, and identity', () => {
    const catalog = new RuntimeUnitCatalog([
      unit('external-z', { orderKey: 'z' }),
      unit('builtin-dependent', {
        source: 'builtin',
        orderKey: 'a',
        dependencies: ['builtin-base'],
      }),
      unit('external-a', { orderKey: 'a' }),
      unit('builtin-base', { source: 'builtin', orderKey: 'z' }),
    ]);

    expect(catalog.initialUnitIds()).toEqual([
      'builtin-base',
      'builtin-dependent',
      'external-a',
      'external-z',
    ]);
  });

  it.each([
    {
      name: 'duplicate identity',
      units: [unit('same'), unit('same')],
      message: 'Duplicate loaded Runtime Unit "same".',
    },
    {
      name: 'unknown dependency',
      units: [unit('dependent', { dependencies: ['missing'] })],
      message: 'Runtime Unit "dependent" requires unknown Unit "missing".',
    },
    {
      name: 'dependency cycle',
      units: [
        unit('first', { dependencies: ['second'] }),
        unit('second', { dependencies: ['first'] }),
      ],
      message: 'Runtime Unit dependency cycle includes',
    },
    {
      name: 'disabled required unit',
      units: [unit('required', { required: true, initiallyEnabled: false })],
      message: 'Required Runtime Unit "required" must be initially enabled.',
    },
    {
      name: 'disabled startup dependency',
      units: [
        unit('base', { initiallyEnabled: false }),
        unit('dependent', { dependencies: ['base'] }),
      ],
      message: 'Initially enabled Runtime Unit "dependent" requires disabled Unit "base".',
    },
  ])('rejects invalid catalog metadata: $name', ({ units, message }) => {
    expect(() => new RuntimeUnitCatalog(units)).toThrow(message);
  });

  it('returns no-op and unknown-unit decisions without invoking factories', () => {
    const loaded = unit('optional', { initiallyEnabled: false });
    const catalog = new RuntimeUnitCatalog([loaded]);

    expect(catalog.planChange(
      { operation: 'disable', unitId: 'optional' },
      new Set(),
    )).toEqual(expect.objectContaining({ outcome: 'no-op', code: 'ALREADY_SATISFIED' }));
    expect(catalog.planChange(
      { operation: 'enable', unitId: 'missing' },
      new Set(),
    )).toEqual(expect.objectContaining({ outcome: 'rejected', category: 'UNIT_UNKNOWN' }));
    expect(loaded.create).not.toHaveBeenCalled();
  });

  it('plans enable only when all required dependencies are active', () => {
    const catalog = new RuntimeUnitCatalog([
      unit('base'),
      unit('optional', { initiallyEnabled: false, dependencies: ['base'] }),
    ]);

    expect(catalog.planChange(
      { operation: 'enable', unitId: 'optional' },
      new Set(),
    )).toEqual(expect.objectContaining({
      outcome: 'rejected',
      category: 'UNIT_DEPENDENCY_INACTIVE',
    }));
    expect(catalog.planChange(
      { operation: 'enable', unitId: 'optional' },
      new Set(['base']),
    )).toEqual({ outcome: 'proceed', desiredUnitIds: ['base', 'optional'] });
  });

  it('rejects required or depended-on disable operations', () => {
    const catalog = new RuntimeUnitCatalog([
      unit('required', { required: true }),
      unit('base'),
      unit('dependent', { dependencies: ['base'] }),
    ]);
    const active = new Set(['required', 'base', 'dependent']);

    expect(catalog.planChange(
      { operation: 'disable', unitId: 'required' },
      active,
    )).toEqual(expect.objectContaining({ outcome: 'rejected', category: 'UNIT_REQUIRED' }));
    expect(catalog.planChange(
      { operation: 'disable', unitId: 'base' },
      active,
    )).toEqual(expect.objectContaining({
      outcome: 'rejected',
      category: 'UNIT_REQUIRED_BY_ACTIVE',
    }));
    expect(catalog.planChange(
      { operation: 'disable', unitId: 'dependent' },
      active,
    )).toEqual({
      outcome: 'proceed',
      desiredUnitIds: ['base', 'required'],
    });
  });
});

describe('createLoadedRuntimeUnit', () => {
  it('adapts a registration recipe without executing it during catalog construction', async () => {
    const registration: RuntimeContributionUnit = {
      id: 'builtin-test',
      source: 'builtin',
      register: vi.fn(),
    };
    const start = vi.fn();
    const stop = vi.fn();
    const loaded = createLoadedRuntimeUnit({ registration, required: true, start, stop });
    const catalog = new RuntimeUnitCatalog([loaded]);

    expect(registration.register).not.toHaveBeenCalled();
    const instance = await catalog.get('builtin-test')!.create(new AbortController().signal);
    expect(instance.registration).toBe(registration);
    await instance.start(new AbortController().signal);
    await instance.stop();
    expect(start).toHaveBeenCalledTimes(1);
    expect(stop).toHaveBeenCalledTimes(1);
  });
});
