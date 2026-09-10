import { describe, expect, it, vi } from 'vitest';
import type {
  Channel,
  ChannelCompletion,
  ChannelRunRequest,
  ChannelRuntimeHost,
} from '../core/channel/index.js';
import type { RuntimeContributionUnit } from '../core/registry/index.js';
import type { ProviderProjectionEntry } from '../core/model-resolution/index.js';
import type { Tool } from '../core/tools/index.js';
import { CompositionCoordinator } from './composition-coordinator.js';
import { RuntimeCompositionManager } from './runtime-composition-manager.js';
import type { RuntimeCompositionManagerOptions } from './runtime-composition-manager.js';
import type { RuntimeReloadDeadlineDriver } from './reload-coordinator.js';
import { RuntimeLifecycleLedger } from './runtime-lifecycle.js';
import { RuntimeUnitCatalog, type LoadedRuntimeUnit } from './runtime-unit.js';

function host(): ChannelRuntimeHost {
  return {
    onMessage: vi.fn(async () => {}),
    onInteractionResponse: vi.fn(),
    onInteractionUnavailable: vi.fn(),
    abortHooks: {
      querySessionsNeedingAbort: vi.fn(() => []),
      abortTurn: vi.fn(() => ({ aborted: false, dropped: 0 })),
    },
  };
}

function tool(name: string): Tool {
  return {
    name,
    description: name,
    inputSchema: { type: 'object', properties: {} },
    async execute() {
      return { outcome: 'success', content: name };
    },
  };
}

function loadedUnit(params: {
  id: string;
  initiallyEnabled: boolean;
  required?: boolean;
  dependencies?: readonly string[];
  toolName?: string;
  stop?: () => void | Promise<void>;
  create?: () => void;
}): LoadedRuntimeUnit {
  return {
    unitId: params.id,
    source: params.required ? 'builtin' : 'external',
    orderKey: params.id,
    required: params.required ?? false,
    initiallyEnabled: params.initiallyEnabled,
    dependencies: params.dependencies ?? [],
    async create() {
      params.create?.();
      const registration: RuntimeContributionUnit = {
        id: params.id,
        source: params.required ? 'builtin' : 'external',
        register(api) {
          if (params.toolName) api.registerTool(tool(params.toolName));
        },
      };
      return {
        registration,
        start: vi.fn(),
        stop: params.stop ?? vi.fn(),
      };
    },
  };
}

function harness(
  units: readonly LoadedRuntimeUnit[],
  options: Omit<RuntimeCompositionManagerOptions, 'createInstanceId'> = {},
) {
  const ledger = new RuntimeLifecycleLedger();
  const coordinator = new CompositionCoordinator(ledger);
  let id = 0;
  const manager = new RuntimeCompositionManager(
    new RuntimeUnitCatalog(units),
    coordinator,
    ledger,
    host(),
    { ...options, createInstanceId: (unitId) => `unit:${unitId}:${++id}` },
  );
  return { coordinator, ledger, manager };
}

describe('RuntimeCompositionManager', () => {
  it('isolates an invalid optional external Unit during startup', async () => {
    const invalid = loadedUnit({
      id: 'invalid-external',
      initiallyEnabled: true,
      create: () => {},
    });
    const originalCreate = invalid.create;
    const invalidUnit: LoadedRuntimeUnit = {
      ...invalid,
      async create(signal) {
        const instance = await originalCreate(signal);
        return {
          ...instance,
          registration: {
            id: 'invalid-external',
            source: 'external',
            register(api) {
              api.registerTool(tool('duplicate'));
              api.registerTool(tool('duplicate'));
            },
          },
        };
      },
    };
    const { manager } = harness([
      loadedUnit({ id: 'base', initiallyEnabled: true, required: true }),
      invalidUnit,
    ]);

    const snapshot = await manager.start();

    expect(snapshot.units.map((unit) => unit.unitId)).toEqual(['base']);
    expect(snapshot.diagnostics).toEqual([
      expect.objectContaining({ unitId: 'invalid-external', code: 'UNIT_INVALID' }),
    ]);
    await manager.shutdown();
  });

  it('rolls back a Channel that completes while a later Unit is becoming ready', async () => {
    const earlyCompletion = deferred<ChannelCompletion>();
    const slowReadiness = deferred<void>();
    const earlyStop = vi.fn(async () => {});
    const earlyUnitStop = vi.fn(async () => {});
    const earlyChannel: Channel = {
      id: 'early-channel',
      completion: earlyCompletion.promise,
      send: vi.fn(),
      onMessage: vi.fn(),
      start: vi.fn(async () => {}),
      stop: earlyStop,
    };
    const slowChannel: Channel = {
      id: 'slow-channel',
      completion: new Promise(() => undefined),
      send: vi.fn(),
      onMessage: vi.fn(),
      start: vi.fn(() => slowReadiness.promise),
      stop: vi.fn(async () => {}),
    };
    const channelUnit = (
      id: string,
      channel: Channel,
      stop: () => Promise<void>,
    ): LoadedRuntimeUnit => ({
      unitId: id,
      source: 'external',
      orderKey: id,
      required: false,
      initiallyEnabled: true,
      dependencies: [],
      async create() {
        return {
          registration: {
            id,
            source: 'external',
            register(api) { api.registerChannel({ id: channel.id, create: () => channel }); },
          },
          start: async () => {},
          stop,
        };
      },
    });
    const { manager } = harness([
      channelUnit('a-early', earlyChannel, earlyUnitStop),
      channelUnit('z-slow', slowChannel, async () => {}),
    ]);

    const startup = manager.start();
    await vi.waitFor(() => expect(slowChannel.start).toHaveBeenCalledTimes(1));
    earlyCompletion.resolve({ outcome: 'closed', reason: 'transport_closed' });
    slowReadiness.resolve();
    const snapshot = await startup;

    expect(snapshot.channels.resolve('early-channel')).toBeUndefined();
    expect(snapshot.channels.resolve('slow-channel')).toBeDefined();
    expect(earlyStop).toHaveBeenCalledTimes(1);
    expect(earlyUnitStop).toHaveBeenCalledTimes(1);
    await expect(manager.waitForChannelCompletion('early-channel')).resolves.toEqual(
      expect.objectContaining({ outcome: 'failed', phase: 'startup' }),
    );
    await manager.shutdown();
  });

  it('reuses unchanged Provider and Channel bindings across generations', async () => {
    const provider: ProviderProjectionEntry = {
      id: 'stable-provider',
      protocol: 'test',
      models: [{ modelId: 'stable-model' }],
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
    const providerCreate = vi.fn();
    const channelCreate = vi.fn();
    const channelStart = vi.fn();
    const channelStop = vi.fn();
    const unitStop = vi.fn();
    const completion = deferred<ChannelCompletion>();
    const channel: Channel = {
      id: 'stable-channel',
      completion: completion.promise,
      send: vi.fn(),
      onMessage: vi.fn(),
      start: channelStart,
      stop: channelStop,
    };
    const unchanged: LoadedRuntimeUnit = {
      unitId: 'unchanged',
      source: 'builtin',
      orderKey: 'unchanged',
      required: true,
      initiallyEnabled: true,
      dependencies: [],
      async create() {
        providerCreate();
        return {
          registration: {
            id: 'unchanged',
            source: 'builtin',
            register(api) {
              api.registerProvider(provider);
              api.registerTool(tool('stable-tool'));
              api.registerHook({
                id: 'stable-hook',
                hookName: 'before_tool_call',
                handler: () => ({ action: 'allow' as const }),
              });
              api.registerChannel({
                id: 'stable-channel',
                create: () => {
                  channelCreate();
                  return channel;
                },
              });
            },
          },
          start: vi.fn(),
          stop: unitStop,
        };
      },
    };
    const { coordinator, ledger, manager } = harness([
      unchanged,
      loadedUnit({ id: 'new-unit', initiallyEnabled: false, toolName: 'new_tool' }),
    ]);
    const startup = await manager.start();
    const providerBinding = startup.providers[0];
    const channelBinding = startup.channels.bindings[0];
    const toolBinding = startup.tools.resolve('stable-tool');
    const hookBinding = startup.hooks.beforeToolCall[0];

    await expect(manager.compositionControl().enableUnit('new-unit')).resolves.toEqual(
      expect.objectContaining({ outcome: 'published', generation: 2 }),
    );
    await vi.waitFor(() => expect(coordinator.generationState(1)).toBe('retired'));

    expect(manager.currentSnapshot().providers[0]).toBe(providerBinding);
    expect(manager.currentSnapshot().channels.bindings[0]).toBe(channelBinding);
    expect(manager.currentSnapshot().tools.resolve('stable-tool')?.execute).toBe(toolBinding?.execute);
    expect(manager.currentSnapshot().hooks.beforeToolCall[0]?.handler).toBe(hookBinding?.handler);
    expect(providerCreate).toHaveBeenCalledTimes(1);
    expect(channelCreate).toHaveBeenCalledTimes(1);
    expect(channelStart).toHaveBeenCalledTimes(1);
    expect(channelStop).not.toHaveBeenCalled();
    expect(unitStop).not.toHaveBeenCalled();
    expect(ledger.view('unit:unchanged:1')?.generationMemberships).toEqual([2]);

    await manager.shutdown();
    expect(channelStop).toHaveBeenCalledTimes(1);
    expect(unitStop).toHaveBeenCalledTimes(1);
  });

  it('publishes a deterministic conflict winner and retires the displaced Unit', async () => {
    const displacedStop = vi.fn();
    const conflictUnit = (
      id: string,
      initiallyEnabled: boolean,
      stop: () => void = () => {},
    ): LoadedRuntimeUnit => ({
      unitId: id,
      source: 'external',
      orderKey: id,
      required: false,
      initiallyEnabled,
      dependencies: [],
      async create() {
        return {
          registration: {
            id,
            source: 'external',
            orderKey: id,
            register(api) { api.registerTool(tool('shared_tool')); },
          },
          start: vi.fn(),
          stop,
        };
      },
    });
    const { manager } = harness([
      loadedUnit({ id: 'base', initiallyEnabled: true, required: true }),
      conflictUnit('z-loser', true, displacedStop),
      conflictUnit('a-winner', false),
    ]);
    await manager.start();

    await expect(manager.compositionControl().enableUnit('a-winner')).resolves.toEqual(
      expect.objectContaining({
        outcome: 'published',
        generation: 2,
        retiredUnitIds: ['z-loser'],
      }),
    );
    await vi.waitFor(() => expect(displacedStop).toHaveBeenCalledTimes(1));
    expect(manager.currentSnapshot().units.map((unit) => unit.unitId))
      .toEqual(['base', 'a-winner']);
  });

  it('publishes, retires, and recreates a loaded Channel Unit', async () => {
    const handlers: Array<(request: ChannelRunRequest) => Promise<void>> = [];
    const stops: Array<ReturnType<typeof vi.fn>> = [];
    let channelSequence = 0;
    const channelUnit: LoadedRuntimeUnit = {
      unitId: 'reload-channel',
      source: 'external',
      orderKey: 'reload-channel',
      required: false,
      initiallyEnabled: false,
      dependencies: [],
      async create() {
        const completion = deferred<ChannelCompletion>();
        const stop = vi.fn(async () => {
          completion.resolve({ outcome: 'closed', reason: 'stopped' });
        });
        stops.push(stop);
        const channel: Channel = {
          id: 'reload-channel',
          completion: completion.promise,
          send: vi.fn(),
          onMessage(handler) { handlers.push(handler); },
          start: vi.fn(),
          stop,
        };
        channelSequence += 1;
        return {
          registration: {
            id: 'reload-channel',
            source: 'external',
            register(api) {
              api.registerChannel({ id: 'reload-channel', create: () => channel });
            },
          },
          start: vi.fn(),
          stop: vi.fn(),
        };
      },
    };
    const { manager } = harness([
      loadedUnit({ id: 'base', initiallyEnabled: true, required: true }),
      channelUnit,
    ]);
    await manager.start();

    await expect(manager.compositionControl().enableUnit('reload-channel')).resolves.toEqual(
      expect.objectContaining({ outcome: 'published', generation: 2 }),
    );
    await expect(handlers[0]!({ sessionKey: 'one', message: 'first' })).resolves.toBeUndefined();

    await expect(manager.compositionControl().disableUnit('reload-channel')).resolves.toEqual(
      expect.objectContaining({ outcome: 'published', generation: 3 }),
    );
    await vi.waitFor(() => expect(stops[0]).toHaveBeenCalledTimes(1));
    await expect(handlers[0]!({ sessionKey: 'one', message: 'late' }))
      .rejects.toThrow('ingress is not published');
    await expect(manager.waitForChannelCompletion('reload-channel'))
      .rejects.toThrow('CHANNEL_NOT_FOUND');

    await expect(manager.compositionControl().enableUnit('reload-channel')).resolves.toEqual(
      expect.objectContaining({ outcome: 'published', generation: 4 }),
    );
    expect(channelSequence).toBe(2);
    await expect(handlers[1]!({ sessionKey: 'two', message: 'second' })).resolves.toBeUndefined();
  });

  it('publishes startup and reload candidates while reusing unchanged Unit instances', async () => {
    const baseCreate = vi.fn();
    const optionalCreate = vi.fn();
    const optionalStop = vi.fn();
    const { manager } = harness([
      loadedUnit({
        id: 'base',
        initiallyEnabled: true,
        required: true,
        toolName: 'base_tool',
        create: baseCreate,
      }),
      loadedUnit({
        id: 'optional',
        initiallyEnabled: false,
        dependencies: ['base'],
        toolName: 'optional_tool',
        create: optionalCreate,
        stop: optionalStop,
      }),
    ]);

    const startup = await manager.start();
    expect(startup.generation).toBe(1);
    expect(startup.tools.definitions.map((entry) => entry.name)).toEqual(['base_tool']);
    expect(startup.units).toEqual([expect.objectContaining({
      unitId: 'base',
      instanceId: 'unit:base:1',
      dependencies: [],
    })]);

    const enabled = await manager.compositionControl().enableUnit('optional');
    expect(enabled).toEqual(expect.objectContaining({
      outcome: 'published',
      previousGeneration: 1,
      generation: 2,
    }));
    expect(manager.currentSnapshot().tools.definitions.map((entry) => entry.name))
      .toEqual(['base_tool', 'optional_tool']);
    expect(baseCreate).toHaveBeenCalledTimes(1);
    expect(optionalCreate).toHaveBeenCalledTimes(1);

    await expect(manager.compositionControl().disableUnit('optional')).resolves.toEqual(
      expect.objectContaining({ outcome: 'published', generation: 3 }),
    );
    await vi.waitFor(() => expect(optionalStop).toHaveBeenCalledTimes(1));
    expect(baseCreate).toHaveBeenCalledTimes(1);
    expect(manager.currentSnapshot().tools.definitions.map((entry) => entry.name))
      .toEqual(['base_tool']);
  });

  it('holds one pending reload until the retiring generation pin is released', async () => {
    const { coordinator, manager } = harness([
      loadedUnit({ id: 'base', initiallyEnabled: true, required: true }),
      loadedUnit({ id: 'first', initiallyEnabled: false }),
      loadedUnit({ id: 'second', initiallyEnabled: false }),
    ]);
    await manager.start();
    const oldPin = coordinator.captureRootGeneration();

    await expect(manager.compositionControl().enableUnit('first')).resolves.toEqual(
      expect.objectContaining({ outcome: 'published', generation: 2 }),
    );
    const pending = manager.compositionControl().enableUnit('second');
    let settled = false;
    void pending.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);

    oldPin.release();
    await expect(pending).resolves.toEqual(expect.objectContaining({
      outcome: 'published',
      generation: 3,
    }));
  });

  it('linearizes reload admission and shutdown before candidate user code', async () => {
    const candidateCreate = vi.fn();
    const { coordinator, manager } = harness([
      loadedUnit({ id: 'base', initiallyEnabled: true, required: true }),
      loadedUnit({ id: 'candidate', initiallyEnabled: false, create: candidateCreate }),
    ]);
    await manager.start();

    const request = manager.compositionControl().enableUnit('candidate');
    expect(candidateCreate).not.toHaveBeenCalled();
    manager.beginShutdown();

    await expect(request).resolves.toEqual(expect.objectContaining({
      outcome: 'shutdown/cancelled',
    }));
    expect(() => coordinator.captureRootGeneration()).toThrow('closing');
    await Promise.resolve();
    expect(candidateCreate).not.toHaveBeenCalled();
    await manager.shutdown();
  });

  it('linearizes production capture-before-publish and publish-before-capture barriers', async () => {
    const { coordinator, manager } = harness([
      loadedUnit({ id: 'base', initiallyEnabled: true, required: true }),
      loadedUnit({ id: 'candidate', initiallyEnabled: false }),
    ]);
    await manager.start();

    const capturedBeforePublish = coordinator.captureRootGeneration();
    await expect(manager.compositionControl().enableUnit('candidate')).resolves.toEqual(
      expect.objectContaining({ outcome: 'published', generation: 2 }),
    );
    const capturedAfterPublish = coordinator.captureRootGeneration();

    expect(capturedBeforePublish.generation).toBe(1);
    expect(capturedAfterPublish.generation).toBe(2);
    capturedBeforePublish.release();
    capturedAfterPublish.release();
    await vi.waitFor(() => expect(coordinator.generationState(1)).toBe('retired'));
    await manager.shutdown();
  });

  it('completes production publish before a later shutdown admission', async () => {
    const { coordinator, manager } = harness([
      loadedUnit({ id: 'base', initiallyEnabled: true, required: true }),
      loadedUnit({ id: 'candidate', initiallyEnabled: false }),
    ]);
    await manager.start();

    await expect(manager.compositionControl().enableUnit('candidate')).resolves.toEqual(
      expect.objectContaining({ outcome: 'published', generation: 2 }),
    );
    manager.beginShutdown();

    expect(manager.currentSnapshot().generation).toBe(2);
    expect(() => coordinator.captureRootGeneration()).toThrow('closing');
    await expect(manager.compositionControl().disableUnit('candidate')).resolves.toEqual(
      expect.objectContaining({ outcome: 'shutdown/cancelled', generation: 2 }),
    );
    await manager.shutdown();
  });

  it('aborts only the retiring generation then blocks on pin nonconvergence', async () => {
    const deadlineDriver: RuntimeReloadDeadlineDriver = {
      wait: vi.fn(async () => ({ outcome: 'timed-out' })) as RuntimeReloadDeadlineDriver['wait'],
    };
    const { coordinator, manager } = harness([
      loadedUnit({ id: 'base', initiallyEnabled: true, required: true }),
      loadedUnit({ id: 'optional', initiallyEnabled: false }),
    ], {
      retirementDrainTimeoutMs: 30,
      retirementAbortTimeoutMs: 10,
      deadlineDriver,
    });
    await manager.start();
    coordinator.captureRootGeneration();
    const abortGeneration = vi.fn(() => ['turn-old']);
    manager.setGenerationConvergence({
      abortGeneration,
      blockingTurnIds: () => ['turn-old'],
    });

    await expect(manager.compositionControl().enableUnit('optional')).resolves.toEqual(
      expect.objectContaining({ outcome: 'published', generation: 2 }),
    );
    await expect(manager.compositionControl().disableUnit('optional')).resolves.toEqual(
      expect.objectContaining({
        outcome: 'blocked',
        blocker: expect.objectContaining({
          phase: 'retirement-abort-convergence',
          generation: 1,
          blockingTurnIds: ['turn-old'],
        }),
      }),
    );
    expect(abortGeneration).toHaveBeenCalledWith(1);
    expect(coordinator.generationState(1)).toBe('failed-residual');
  });

  it('returns no-op and rejected preflight results without creating instances', async () => {
    const optionalCreate = vi.fn();
    const { manager } = harness([
      loadedUnit({ id: 'base', initiallyEnabled: true, required: true }),
      loadedUnit({
        id: 'optional',
        initiallyEnabled: false,
        dependencies: ['base'],
        create: optionalCreate,
      }),
    ]);
    await manager.start();

    await expect(manager.compositionControl().enableUnit('base')).resolves.toEqual(
      expect.objectContaining({ outcome: 'no-op', generation: 1 }),
    );
    await expect(manager.compositionControl().disableUnit('base')).resolves.toEqual(
      expect.objectContaining({ outcome: 'rejected', category: 'UNIT_REQUIRED' }),
    );
    await expect(manager.compositionControl().enableUnit('missing')).resolves.toEqual(
      expect.objectContaining({ outcome: 'rejected', category: 'UNIT_UNKNOWN' }),
    );
    expect(optionalCreate).not.toHaveBeenCalled();
  });

  it('blocks reload when creator cleanup after readiness failure does not converge', async () => {
    const failing: LoadedRuntimeUnit = {
      unitId: 'failing-candidate',
      source: 'external',
      orderKey: 'failing-candidate',
      required: false,
      initiallyEnabled: false,
      dependencies: [],
      async create() {
        return {
          registration: {
            id: 'failing-candidate',
            source: 'external',
            register() {},
          },
          start: async () => { throw new Error('readiness failed'); },
          stop: async () => { throw new Error('creator cleanup failed'); },
        };
      },
    };
    const { manager } = harness([
      loadedUnit({ id: 'base', initiallyEnabled: true, required: true }),
      failing,
    ]);
    await manager.start();

    await expect(manager.compositionControl().enableUnit('failing-candidate')).resolves.toEqual(
      expect.objectContaining({
        outcome: 'blocked',
        generation: 1,
        blocker: expect.objectContaining({
          phase: 'candidate-cleanup',
          unitId: 'failing-candidate',
          message: 'creator cleanup failed',
        }),
      }),
    );
    await expect(manager.compositionControl().enableUnit('failing-candidate')).resolves.toEqual(
      expect.objectContaining({ outcome: 'blocked' }),
    );
  });

  it('blocks future reload when retirement stop fails without rolling back publication', async () => {
    const { manager } = harness([
      loadedUnit({ id: 'base', initiallyEnabled: true, required: true }),
      loadedUnit({
        id: 'failing',
        initiallyEnabled: true,
        stop: vi.fn(async () => { throw new Error('stop failed'); }),
      }),
    ]);
    await manager.start();

    const published = await manager.compositionControl().disableUnit('failing');
    expect(published).toEqual(expect.objectContaining({ outcome: 'published', generation: 2 }));
    await vi.waitFor(() => expect(manager.currentSnapshot().generation).toBe(2));

    await expect(manager.compositionControl().enableUnit('failing')).resolves.toEqual(
      expect.objectContaining({
        outcome: 'blocked',
        blocker: expect.objectContaining({ phase: 'retirement-stop', message: 'stop failed' }),
      }),
    );
    expect(manager.currentSnapshot().generation).toBe(2);
  });

  it('retries an old-generation stop failure once during shutdown', async () => {
    const stop = vi.fn()
      .mockRejectedValueOnce(new Error('retirement stop failed'))
      .mockResolvedValueOnce(undefined);
    const { manager } = harness([
      loadedUnit({ id: 'base', initiallyEnabled: true, required: true }),
      loadedUnit({ id: 'retryable', initiallyEnabled: true, stop }),
    ]);
    await manager.start();
    await expect(manager.compositionControl().disableUnit('retryable')).resolves.toEqual(
      expect.objectContaining({ outcome: 'published', generation: 2 }),
    );
    await vi.waitFor(() => expect(stop).toHaveBeenCalledTimes(1));

    const report = await manager.shutdown();

    expect(stop).toHaveBeenCalledTimes(2);
    expect(report.failed).toEqual([]);
    expect(report.completed).toContain('unit:retryable:2');
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((nextResolve) => { resolve = nextResolve; });
  return { promise, resolve };
}
