import { describe, expect, it, vi } from 'vitest';
import type {
  ChannelCompletion,
  ChannelInstance,
  ChannelRuntimeHost,
} from '../core/channel/index.js';
import type { RuntimeContributionUnit } from '../core/registry/index.js';
import {
  prepareStagedUnitChannels,
  recheckPreparedUnitChannels,
} from './channel-lifecycle.js';
import { stageRegistryUnit } from './registry-builder.js';

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((next) => { resolve = next; });
  return { promise, resolve };
}

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

function channel(id: string, overrides: Partial<ChannelInstance> = {}) {
  const completion = deferred<ChannelCompletion>();
  const instance: ChannelInstance = {
    id,
    completion: completion.promise,
    send: vi.fn(),
    onMessage: vi.fn(),
    start: vi.fn(async () => {}),
    stop: vi.fn(async () => completion.resolve({ outcome: 'closed', reason: 'stopped' })),
    ...overrides,
  };
  return { instance, completion };
}

function unit(
  id: string,
  channels: readonly { readonly id: string; readonly create: () => ChannelInstance }[],
): RuntimeContributionUnit {
  return {
    id: `external-${id}`,
    source: 'external',
    register(api) {
      for (const contribution of channels) api.registerChannel(contribution);
    },
  };
}

describe('Channel candidate preparation', () => {
  it('keeps ingress closed until publication and closes it again on removal', async () => {
    let dispatch: ((request: { sessionKey: string; message: string }) => Promise<void>) | undefined;
    const fixture = channel('gated', {
      onMessage: vi.fn((handler) => { dispatch = handler; }),
    });
    const runtimeHost = host();
    const prepared = await prepareStagedUnitChannels({
      unit: stageRegistryUnit(unit('gated', [{ id: 'gated', create: () => fixture.instance }])),
      host: runtimeHost,
    });
    const request = { sessionKey: 'session', message: 'hello' };

    await expect(dispatch!(request)).rejects.toThrow('ingress is not published');
    prepared.activateIngress();
    await expect(dispatch!(request)).resolves.toBeUndefined();
    expect(runtimeHost.onMessage).toHaveBeenCalledTimes(1);
    prepared.deactivateIngress();
    await expect(dispatch!(request)).rejects.toThrow('ingress is not published');
  });

  it('waits for every Channel readiness result', async () => {
    const ready = deferred<void>();
    const fixture = channel('deferred', { start: vi.fn(() => ready.promise) });
    let settled = false;
    const preparation = prepareStagedUnitChannels({
      unit: stageRegistryUnit(unit('deferred', [{ id: 'deferred', create: () => fixture.instance }])),
      host: host(),
    }).then((result) => { settled = true; return result; });

    await Promise.resolve();
    expect(settled).toBe(false);
    ready.resolve();
    await expect(preparation).resolves.toEqual(expect.objectContaining({ accepted: true }));
  });

  it('rolls back completion-before-readiness even when start remains pending', async () => {
    const neverReady = deferred<void>();
    const fixture = channel('terminal-while-pending', {
      start: vi.fn(() => neverReady.promise),
    });
    const preparation = prepareStagedUnitChannels({
      unit: stageRegistryUnit(unit('pending', [{
        id: 'terminal-while-pending',
        create: () => fixture.instance,
      }])),
      host: host(),
    });

    await vi.waitFor(() => expect(fixture.instance.start).toHaveBeenCalledTimes(1));
    fixture.completion.resolve({ outcome: 'closed', reason: 'transport_closed' });
    const prepared = await preparation;

    expect(prepared.accepted).toBe(false);
    expect(prepared.diagnostics).toEqual([
      expect.objectContaining({ code: 'CHANNEL_START_FAILED' }),
    ]);
    expect(fixture.instance.stop).toHaveBeenCalledTimes(1);
    neverReady.resolve();
  });

  it('rolls back all sibling Channels when one start rejects', async () => {
    const pendingReady = deferred<void>();
    const pending = channel('pending', { start: vi.fn(() => pendingReady.promise) });
    const failed = channel('failed', {
      start: vi.fn(async () => { throw new Error('startup rejected'); }),
    });

    const prepared = await prepareStagedUnitChannels({
      unit: stageRegistryUnit(unit('siblings', [
        { id: 'pending', create: () => pending.instance },
        { id: 'failed', create: () => failed.instance },
      ])),
      host: host(),
    });

    expect(prepared.accepted).toBe(false);
    expect(pending.instance.stop).toHaveBeenCalledTimes(1);
    expect(failed.instance.stop).toHaveBeenCalledTimes(1);
    pendingReady.resolve();
  });

  it('rechecks a ready Channel immediately before ownership handoff', async () => {
    const fixture = channel('completed-before-handoff');
    const prepared = await prepareStagedUnitChannels({
      unit: stageRegistryUnit(unit('recheck', [{
        id: 'completed-before-handoff',
        create: () => fixture.instance,
      }])),
      host: host(),
    });
    fixture.completion.resolve({ outcome: 'closed', reason: 'transport_closed' });

    const checked = await recheckPreparedUnitChannels(prepared);

    expect(checked.accepted).toBe(false);
    expect(checked.bindings).toEqual([]);
    expect(fixture.instance.stop).toHaveBeenCalledTimes(1);
  });

  it('records rollback failure without exposing the failed candidate', async () => {
    const fixture = channel('rollback-failure', {
      start: vi.fn(async () => { throw new Error('startup failed'); }),
      stop: vi.fn(async () => { throw new Error('rollback failed'); }),
    });

    const prepared = await prepareStagedUnitChannels({
      unit: stageRegistryUnit(unit('rollback', [{
        id: 'rollback-failure',
        create: () => fixture.instance,
      }])),
      host: host(),
    });

    expect(prepared.accepted).toBe(false);
    expect(prepared.bindings).toEqual([]);
    expect(prepared.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'CHANNEL_START_FAILED' }),
      expect.objectContaining({ code: 'CHANNEL_ROLLBACK_FAILED' }),
    ]));
  });
});