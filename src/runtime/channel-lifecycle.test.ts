import { describe, expect, it, vi } from 'vitest';
import type {
  ChannelCompletion,
  ChannelInstance,
  ChannelRuntimeHost,
} from '../core/channel/index.js';
import type { RuntimeContributionUnit } from '../core/registry/index.js';
import type { Tool } from '../core/tools/types.js';
import { activateRegistryChannels } from './channel-lifecycle.js';
import { stageRegistryCandidate } from './registry-builder.js';
import { RuntimeLifecycleLedger } from './runtime-lifecycle.js';

function createDeferred<T>(): {
  promise: Promise<T>;
  resolve(value: T | PromiseLike<T>): void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function createHost(): ChannelRuntimeHost {
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

function createChannel(
  id: string,
  overrides: Partial<ChannelInstance> = {},
): {
  channel: ChannelInstance;
  completion: ReturnType<typeof createDeferred<ChannelCompletion>>;
} {
  const completion = createDeferred<ChannelCompletion>();
  const channel: ChannelInstance = {
    id,
    completion: completion.promise,
    send: vi.fn(),
    onMessage: vi.fn(),
    start: vi.fn(async () => {}),
    stop: vi.fn(async () => {
      completion.resolve({ outcome: 'closed', reason: 'stopped' });
    }),
    ...overrides,
  };
  return { channel, completion };
}

function channelUnit(
  id: string,
  source: 'builtin' | 'external',
  create: () => ChannelInstance,
  registerExtra?: RuntimeContributionUnit['register'],
): RuntimeContributionUnit {
  return {
    id: `${source}-${id}`,
    source,
    register(api) {
      registerExtra?.(api);
      api.registerChannel({ id, create });
    },
  };
}

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

describe('activateRegistryChannels', () => {
  it('publishes an immutable empty Channel projection when no Channels are contributed', async () => {
    const candidate = stageRegistryCandidate({ providers: [], units: [] });
    const activated = await activateRegistryChannels({ candidate, host: createHost() });

    expect(activated.snapshot.channels.bindings).toEqual([]);
    expect(Object.isFrozen(activated.snapshot.channels.bindings)).toBe(true);
    await expect(activated.lifecycle.runtimeConverged()).resolves.toEqual({
      completed: [],
      failed: [],
    });
  });

  it('activates an external Channel through the common path and retains its private resource', async () => {
    const privateResource = { sentinel: Symbol('external-resource') };
    const fixture = createChannel('external-test');
    const create = vi.fn(() => {
      expect(privateResource.sentinel.description).toBe('external-resource');
      return fixture.channel;
    });
    const candidate = stageRegistryCandidate({
      providers: [],
      units: [channelUnit('external-test', 'external', create)],
    });

    expect(create).not.toHaveBeenCalled();
    const activated = await activateRegistryChannels({ candidate, host: createHost() });

    expect(create).toHaveBeenCalledTimes(1);
    expect(fixture.channel.start).toHaveBeenCalledTimes(1);
    expect(activated.snapshot.channels.resolve('external-test')).toBeDefined();
    expect(Object.isFrozen(activated.snapshot.channels.bindings)).toBe(true);

    const first = activated.lifecycle.runtimeConverged();
    const second = activated.lifecycle.runtimeConverged();
    expect(first).toBe(second);
    await expect(first).resolves.toEqual({ completed: ['external-test'], failed: [] });
    expect(fixture.channel.stop).toHaveBeenCalledTimes(1);
  });

  it('hands accepted Channels to the injected generation lifecycle ledger before publication', async () => {
    const fixture = createChannel('ledger-channel');
    const lifecycleLedger = new RuntimeLifecycleLedger();
    const candidate = stageRegistryCandidate({
      providers: [],
      units: [channelUnit('ledger-channel', 'external', () => fixture.channel)],
    });

    const activated = await activateRegistryChannels({
      candidate,
      host: createHost(),
      lifecycleLedger,
    });

    expect(lifecycleLedger.view('channel:ledger-channel')).toMatchObject({
      unitId: 'external-ledger-channel',
      source: 'external',
      state: 'handed-off',
      generationMemberships: [1],
    });

    await activated.lifecycle.runtimeConverged();
    expect(lifecycleLedger.view('channel:ledger-channel')).toMatchObject({
      state: 'stopped',
      generationMemberships: [],
      stopAttempts: 1,
    });
  });

  it('does not publish and cleans every Channel once when ownership handoff fails', async () => {
    const first = createChannel('handoff-first');
    const second = createChannel('handoff-second');
    class FailingHandoffLedger extends RuntimeLifecycleLedger {
      override handoff(instanceId: string): void {
        if (instanceId === 'channel:handoff-second') {
          throw new Error('handoff failed');
        }
        super.handoff(instanceId);
      }
    }
    const candidate = stageRegistryCandidate({
      providers: [],
      units: [
        channelUnit('handoff-first', 'external', () => first.channel),
        channelUnit('handoff-second', 'external', () => second.channel),
      ],
    });

    await expect(activateRegistryChannels({
      candidate,
      host: createHost(),
      lifecycleLedger: new FailingHandoffLedger(),
    })).rejects.toThrow('handoff failed');

    expect(first.channel.stop).toHaveBeenCalledTimes(1);
    expect(second.channel.stop).toHaveBeenCalledTimes(1);
  });

  it('waits for Channel readiness before publishing the final Snapshot', async () => {
    const ready = createDeferred<void>();
    const fixture = createChannel('deferred', {
      start: vi.fn(async () => ready.promise),
    });
    const candidate = stageRegistryCandidate({
      providers: [],
      units: [channelUnit('deferred', 'builtin', () => fixture.channel)],
    });

    let settled = false;
    const activation = activateRegistryChannels({ candidate, host: createHost() }).then((result) => {
      settled = true;
      return result;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    ready.resolve();
    const activated = await activation;
    expect(activated.snapshot.channels.resolve('deferred')).toBeDefined();
    await activated.lifecycle.runtimeConverged();
  });

  it('rejects a Channel whose completion settles during start', async () => {
    const fixture = createChannel('early-completion');
    fixture.channel.start = vi.fn(async () => {
      fixture.completion.resolve({ outcome: 'closed', reason: 'transport_closed' });
    });
    const candidate = stageRegistryCandidate({
      providers: [],
      units: [channelUnit('early-completion', 'external', () => fixture.channel)],
    });

    const activated = await activateRegistryChannels({ candidate, host: createHost() });

    expect(activated.snapshot.channels.resolve('early-completion')).toBeUndefined();
    expect(fixture.channel.stop).toHaveBeenCalledTimes(1);
    await expect(activated.lifecycle.waitForChannelCompletion('early-completion')).resolves.toEqual(
      expect.objectContaining({ outcome: 'failed', phase: 'startup' }),
    );
  });

  it('rolls back completion-before-readiness even when start remains pending', async () => {
    const neverReady = createDeferred<void>();
    const fixture = createChannel('terminal-while-pending', {
      start: vi.fn(async () => neverReady.promise),
    });
    const candidate = stageRegistryCandidate({
      providers: [],
      units: [channelUnit('terminal-while-pending', 'external', () => fixture.channel)],
    });

    const activation = activateRegistryChannels({ candidate, host: createHost() });
    await vi.waitFor(() => expect(fixture.channel.start).toHaveBeenCalledTimes(1));
    fixture.completion.resolve({ outcome: 'closed', reason: 'transport_closed' });
    const activated = await activation;

    expect(activated.snapshot.channels.bindings).toEqual([]);
    expect(fixture.channel.stop).toHaveBeenCalledTimes(1);
    await expect(activated.lifecycle.waitForChannelCompletion('terminal-while-pending')).resolves.toEqual(
      expect.objectContaining({ outcome: 'failed', phase: 'startup' }),
    );
    neverReady.resolve();
  });

  it('rechecks ready Channels at the atomic handoff after another unit finishes starting', async () => {
    const slowReady = createDeferred<void>();
    const early = createChannel('early-between-units');
    const slow = createChannel('slow-start', {
      start: vi.fn(async () => slowReady.promise),
    });
    const candidate = stageRegistryCandidate({
      providers: [],
      units: [
        channelUnit('early-between-units', 'external', () => early.channel),
        channelUnit('slow-start', 'external', () => slow.channel),
      ],
    });

    const activation = activateRegistryChannels({ candidate, host: createHost() });
    await vi.waitFor(() => expect(slow.channel.start).toHaveBeenCalledTimes(1));
    early.completion.resolve({ outcome: 'closed', reason: 'transport_closed' });
    slowReady.resolve();
    const activated = await activation;

    expect(activated.snapshot.channels.resolve('early-between-units')).toBeUndefined();
    expect(activated.snapshot.channels.resolve('slow-start')).toBeDefined();
    expect(early.channel.stop).toHaveBeenCalledTimes(1);
    await activated.lifecycle.runtimeConverged();
  });

  it('rolls back every Channel and hides every contribution when one Channel in a unit fails', async () => {
    const ready = createChannel('unit-ready');
    const failed = createChannel('unit-failed', {
      start: vi.fn(async () => {
        throw new Error('second Channel failed');
      }),
    });
    const multiChannelUnit: RuntimeContributionUnit = {
      id: 'external-multi-channel',
      source: 'external',
      register(api) {
        api.registerTool(tool('multi_hidden_tool'));
        api.registerChannel({ id: 'unit-ready', create: () => ready.channel });
        api.registerChannel({ id: 'unit-failed', create: () => failed.channel });
      },
    };
    const candidate = stageRegistryCandidate({ providers: [], units: [multiChannelUnit] });

    const activated = await activateRegistryChannels({ candidate, host: createHost() });

    expect(activated.snapshot.channels.bindings).toEqual([]);
    expect(activated.snapshot.tools.resolve('multi_hidden_tool')).toBeUndefined();
    expect(ready.channel.stop).toHaveBeenCalledTimes(1);
    expect(failed.channel.stop).toHaveBeenCalledTimes(1);
  });

  it('starts rollback on the first rejection without waiting for a pending sibling start', async () => {
    const neverReady = createDeferred<void>();
    const pending = createChannel('pending-start', {
      start: vi.fn(async () => neverReady.promise),
    });
    const failed = createChannel('rejected-start', {
      start: vi.fn(async () => {
        throw new Error('startup rejected');
      }),
    });
    const candidate = stageRegistryCandidate({
      providers: [],
      units: [{
        id: 'external-pending-sibling',
        source: 'external',
        register(api) {
          api.registerChannel({ id: 'pending-start', create: () => pending.channel });
          api.registerChannel({ id: 'rejected-start', create: () => failed.channel });
        },
      }],
    });

    const activated = await activateRegistryChannels({ candidate, host: createHost() });

    expect(activated.snapshot.channels.bindings).toEqual([]);
    expect(pending.channel.stop).toHaveBeenCalledTimes(1);
    expect(failed.channel.stop).toHaveBeenCalledTimes(1);
    neverReady.resolve();
  });

  it('rolls back a failed unit atomically while preserving an independent Channel', async () => {
    const startupError = new Error('failed to listen');
    const failed = createChannel('failed', {
      start: vi.fn(async () => {
        throw startupError;
      }),
    });
    const successful = createChannel('successful');
    const candidate = stageRegistryCandidate({
      providers: [],
      units: [
        channelUnit('failed', 'external', () => failed.channel, (api) => {
          api.registerTool(tool('hidden_tool'));
          api.registerHook({
            id: 'hidden_hook',
            hookName: 'before_tool_call',
            handler: () => ({ action: 'allow' as const }),
          });
        }),
        channelUnit('successful', 'external', () => successful.channel),
      ],
    });

    const activated = await activateRegistryChannels({ candidate, host: createHost() });

    expect(activated.snapshot.channels.resolve('failed')).toBeUndefined();
    expect(activated.snapshot.channels.resolve('successful')).toBeDefined();
    expect(activated.snapshot.tools.resolve('hidden_tool')).toBeUndefined();
    expect(activated.snapshot.hooks.beforeToolCall).toEqual([]);
    expect(activated.snapshot.diagnostics).toEqual([
      expect.objectContaining({
        unitId: 'external-failed',
        contributionId: 'failed',
        phase: 'start',
        code: 'CHANNEL_START_FAILED',
      }),
    ]);
    expect(failed.channel.stop).toHaveBeenCalledTimes(1);
    await expect(activated.lifecycle.waitForChannelCompletion('failed')).resolves.toEqual({
      outcome: 'failed',
      phase: 'startup',
      error: startupError,
    });

    await expect(activated.lifecycle.runtimeConverged()).resolves.toEqual({
      completed: ['successful'],
      failed: [],
    });
    expect(failed.channel.stop).toHaveBeenCalledTimes(1);
  });

  it('records create and rollback failures and reports shutdown failures deterministically', async () => {
    const rollbackFailure = createChannel('rollback-failure', {
      start: vi.fn(async () => {
        throw new Error('startup failed');
      }),
      stop: vi.fn(async () => {
        throw new Error('rollback failed');
      }),
    });
    const slowStop = createDeferred<void>();
    const first = createChannel('first', {
      stop: vi.fn(async () => slowStop.promise),
    });
    const second = createChannel('second', {
      stop: vi.fn(async () => {
        throw new Error('shutdown failed');
      }),
    });
    const candidate = stageRegistryCandidate({
      providers: [],
      units: [
        channelUnit('rollback-failure', 'external', () => rollbackFailure.channel),
        channelUnit('first', 'external', () => first.channel),
        channelUnit('second', 'external', () => second.channel),
        channelUnit('create-failure', 'external', () => {
          throw new Error('create failed');
        }),
      ],
    });

    const activated = await activateRegistryChannels({ candidate, host: createHost() });
    expect(activated.snapshot.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'CHANNEL_CREATE_FAILED', contributionId: 'create-failure' }),
      expect.objectContaining({ code: 'CHANNEL_ROLLBACK_FAILED', contributionId: 'rollback-failure' }),
    ]));

    const shutdown = activated.lifecycle.runtimeConverged();
    await Promise.resolve();
    slowStop.resolve();
    await expect(shutdown).resolves.toEqual({
      completed: ['first'],
      failed: [{ channelId: 'second', message: 'shutdown failed' }],
    });
  });
});
