import { describe, expect, it, vi } from 'vitest';
import { RuntimeLifecycleLedger } from './runtime-lifecycle.js';
import { RuntimeDeadlineBudget, resolveRuntimeDeadlinePolicy } from '../runtime-deadline.js';

describe('RuntimeLifecycleLedger', () => {
  it('requires ownership handoff before generation publication', () => {
    const ledger = new RuntimeLifecycleLedger();
    ledger.create({
      instanceId: 'instance-a',
      unitId: 'unit-a',
      source: 'builtin',
      owner: { stop: vi.fn() },
    });
    ledger.markStarting('instance-a');
    ledger.markReady('instance-a');

    expect(ledger.canPublish(['instance-a'])).toBe(false);
    expect(() => ledger.addGenerationMembership('instance-a', 1))
      .toThrow('must be handed off before publication');

    ledger.handoff('instance-a');
    expect(ledger.canPublish(['instance-a'])).toBe(true);
    ledger.addGenerationMembership('instance-a', 1);
    expect(ledger.view('instance-a').generationMemberships).toEqual([1]);
  });

  it('stops eligible instances once in reverse dependency order', async () => {
    const order: string[] = [];
    const ledger = new RuntimeLifecycleLedger();
    for (const descriptor of [
      { instanceId: 'core-1', unitId: 'core', dependencies: [] },
      { instanceId: 'tools-1', unitId: 'tools', dependencies: ['core'] },
      { instanceId: 'channel-1', unitId: 'channel', dependencies: ['tools'] },
    ]) {
      ledger.create({
        ...descriptor,
        source: 'builtin',
        owner: { stop: () => { order.push(descriptor.unitId); } },
      });
      ledger.markStarting(descriptor.instanceId);
      ledger.markReady(descriptor.instanceId);
      ledger.handoff(descriptor.instanceId);
    }

    const report = await ledger.stopEligible(['core-1', 'tools-1', 'channel-1']);
    expect(report).toEqual({
      completed: ['channel-1', 'tools-1', 'core-1'],
      failed: [],
      pending: [],
      skippedProtected: [],
    });
    expect(order).toEqual(['channel', 'tools', 'core']);

    const repeated = await ledger.stopEligible(['core-1', 'tools-1', 'channel-1']);
    expect(repeated).toEqual({ completed: [], failed: [], pending: [], skippedProtected: [] });
    expect(order).toEqual(['channel', 'tools', 'core']);
  });

  it('protects generation members and permits one later retry after stop failure', async () => {
    const stop = vi.fn()
      .mockRejectedValueOnce(new Error('first stop failed'))
      .mockResolvedValueOnce(undefined);
    const ledger = new RuntimeLifecycleLedger();
    ledger.create({
      instanceId: 'external-1',
      unitId: 'external',
      source: 'external',
      owner: { stop },
    });
    ledger.markStarting('external-1');
    ledger.markReady('external-1');
    ledger.handoff('external-1');
    ledger.addGenerationMembership('external-1', 1);

    expect(await ledger.stopEligible(['external-1'])).toEqual({
      completed: [],
      failed: [],
      pending: [],
      skippedProtected: ['external-1'],
    });
    expect(stop).not.toHaveBeenCalled();
    expect(ledger.view('external-1')).toMatchObject({ ownerRetained: true });

    ledger.removeGenerationMembership('external-1', 1);
    expect(await ledger.stopEligible(['external-1'])).toEqual({
      completed: [],
      failed: [{ instanceId: 'external-1', message: 'first stop failed' }],
      pending: [],
      skippedProtected: [],
    });
    expect(ledger.view('external-1')).toMatchObject({
      state: 'stop-failed',
      stopAttempts: 1,
      stopError: 'first stop failed',
      ownerRetained: true,
    });

    expect(await ledger.stopEligible(['external-1'], { retryFailed: true })).toEqual({
      completed: ['external-1'],
      failed: [],
      pending: [],
      skippedProtected: [],
    });
    expect(ledger.view('external-1')).toMatchObject({
      state: 'stopped',
      stopAttempts: 2,
      ownerRetained: false,
    });
  });

  it('bounds persistent stop failure to one later retry', async () => {
    const stop = vi.fn(async () => { throw new Error('persistent failure'); });
    const ledger = new RuntimeLifecycleLedger();
    ledger.create({
      instanceId: 'failed-1',
      unitId: 'failed',
      source: 'external',
      owner: { stop },
    });
    ledger.markStarting('failed-1');
    ledger.markReady('failed-1');
    ledger.handoff('failed-1');

    const failure = [{ instanceId: 'failed-1', message: 'persistent failure' }];
    expect((await ledger.stopEligible(['failed-1'])).failed).toEqual(failure);
    expect((await ledger.stopEligible(['failed-1'])).failed).toEqual(failure);
    expect(stop).toHaveBeenCalledTimes(1);
    expect((await ledger.stopEligible(['failed-1'], { retryFailed: true })).failed).toEqual(failure);
    expect((await ledger.stopEligible(['failed-1'], { retryFailed: true })).failed).toEqual(failure);

    expect(stop).toHaveBeenCalledTimes(2);
    expect(ledger.view('failed-1')).toMatchObject({
      state: 'stop-failed',
      stopAttempts: 2,
      stopError: 'persistent failure',
    });
  });

  it('reports a nonresponsive stop as pending and never starts a concurrent retry', async () => {
    const stop = vi.fn(() => new Promise<void>(() => undefined));
    const ledger = new RuntimeLifecycleLedger();
    ledger.create({
      instanceId: 'pending-1',
      unitId: 'pending',
      source: 'external',
      owner: { stop },
    });
    ledger.markStarting('pending-1');
    ledger.markReady('pending-1');
    ledger.handoff('pending-1');
    const budget = new RuntimeDeadlineBudget({
      now: () => 0,
      race: async () => ({ outcome: 'deadline-exhausted' }),
    }, resolveRuntimeDeadlinePolicy(undefined));

    const first = await ledger.stopEligible(['pending-1'], { budget });
    expect(first).toEqual({
      completed: [],
      failed: [],
      pending: ['pending-1'],
      skippedProtected: [],
    });
    expect(ledger.view('pending-1')).toMatchObject({ state: 'stop-pending', stopAttempts: 1 });

    const repeated = await ledger.stopEligible(['pending-1'], { budget, retryFailed: true });
    expect(repeated.pending).toEqual(['pending-1']);
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it('continues stopping independent instances after one failure', async () => {
    const secondStop = vi.fn();
    const ledger = new RuntimeLifecycleLedger();
    for (const descriptor of [
      {
        instanceId: 'a-1',
        unitId: 'a',
        owner: { stop: () => { throw new Error('a failed'); } },
      },
      { instanceId: 'b-1', unitId: 'b', owner: { stop: secondStop } },
    ]) {
      ledger.create({ ...descriptor, source: 'external' });
      ledger.markStarting(descriptor.instanceId);
      ledger.markReady(descriptor.instanceId);
      ledger.handoff(descriptor.instanceId);
    }

    const report = await ledger.stopEligible(['a-1', 'b-1']);
    expect(report.completed).toEqual(['b-1']);
    expect(report.failed).toEqual([{ instanceId: 'a-1', message: 'a failed' }]);
    expect(secondStop).toHaveBeenCalledOnce();
  });

  it('supports multiple concrete instances owned by one Unit', async () => {
    const stopped: string[] = [];
    const ledger = new RuntimeLifecycleLedger();
    for (const instanceId of ['channel:a', 'channel:b']) {
      ledger.create({
        instanceId,
        unitId: 'multi-channel-unit',
        source: 'external',
        owner: { stop: () => { stopped.push(instanceId); } },
      });
      ledger.markStarting(instanceId);
      ledger.markReady(instanceId);
      ledger.handoff(instanceId);
    }

    const report = await ledger.stopEligible(['channel:a', 'channel:b']);

    expect(report.failed).toEqual([]);
    expect(new Set(report.completed)).toEqual(new Set(['channel:a', 'channel:b']));
    expect(new Set(stopped)).toEqual(new Set(['channel:a', 'channel:b']));
  });

  it('does not retain successfully stopped owners across repeated generations', async () => {
    const ledger = new RuntimeLifecycleLedger();
    const instanceIds: string[] = [];
    for (let generation = 1; generation <= 50; generation += 1) {
      const instanceId = `instance-${generation}`;
      instanceIds.push(instanceId);
      ledger.create({
        instanceId,
        unitId: 'changing-unit',
        source: 'external',
        owner: { stop: vi.fn() },
      });
      ledger.markStarting(instanceId);
      ledger.markReady(instanceId);
      ledger.handoff(instanceId);
      ledger.addGenerationMembership(instanceId, generation);
      expect(ledger.view(instanceId)).toMatchObject({ ownerRetained: true });
      ledger.removeGenerationMembership(instanceId, generation);
      await ledger.stopEligible([instanceId]);
      expect(instanceIds.filter((id) => ledger.view(id).ownerRetained)).toHaveLength(0);
    }
  });

  it.each(['completed', 'failed'] as const)(
    'retains a pending owner until its late stop has %s',
    async (outcome) => {
      let resolveStop!: () => void;
      let rejectStop!: (reason: Error) => void;
      const stop = new Promise<void>((resolve, reject) => {
        resolveStop = resolve;
        rejectStop = reject;
      });
      const ledger = new RuntimeLifecycleLedger();
      ledger.create({
        instanceId: 'late-instance',
        unitId: 'late-unit',
        source: 'external',
        owner: { stop: () => stop },
      });
      ledger.markStarting('late-instance');
      ledger.markReady('late-instance');
      ledger.handoff('late-instance');
      const budget = new RuntimeDeadlineBudget({
        now: () => 0,
        race: async () => ({ outcome: 'deadline-exhausted' }),
      }, resolveRuntimeDeadlinePolicy(undefined));

      await ledger.stopEligible(['late-instance'], { budget });
      expect(ledger.view('late-instance')).toMatchObject({
        state: 'stop-pending',
        ownerRetained: true,
      });

      if (outcome === 'completed') resolveStop();
      else rejectStop(new Error('late stop failed'));
      await stop.catch(() => undefined);
      await Promise.resolve();
      expect(ledger.view('late-instance')).toMatchObject({
        state: outcome === 'completed' ? 'stopped' : 'stop-failed',
        ownerRetained: outcome !== 'completed',
      });
    },
  );
});
