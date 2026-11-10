import { describe, expect, it } from 'vitest';
import type { RegistrySnapshot } from '../core/registry/index.js';
import { CompositionCoordinator } from './composition-coordinator.js';
import { RuntimeLifecycleLedger } from './runtime-lifecycle.js';

function snapshot(generation: number): RegistrySnapshot {
  return Object.freeze({
    generation,
    units: Object.freeze([]),
    providers: Object.freeze([]),
    tools: Object.freeze({
      definitions: Object.freeze([]),
      resolve: () => undefined,
      visibleDefinitions: () => Object.freeze([]),
    }),
    hooks: Object.freeze({
      beforeToolCall: Object.freeze([]),
      afterToolCall: Object.freeze([]),
      beforeCompaction: Object.freeze([]),
      afterCompaction: Object.freeze([]),
    }),
    channels: Object.freeze({
      bindings: Object.freeze([]),
      resolve: () => undefined,
    }),
    diagnostics: Object.freeze([]),
  });
}

describe('CompositionCoordinator', () => {
  it('adds candidate memberships atomically and exposes retiring instance identities', () => {
    const ledger = new RuntimeLifecycleLedger();
    for (const instanceId of ['shared', 'old-only', 'new-only']) {
      ledger.create({ instanceId, unitId: instanceId, source: 'external' });
      ledger.markStarting(instanceId);
      ledger.markReady(instanceId);
      ledger.handoff(instanceId);
    }
    const coordinator = new CompositionCoordinator(ledger);
    coordinator.commitPublish(snapshot(1), ['shared', 'old-only']);

    const publication = coordinator.commitPublish(snapshot(2), ['shared', 'new-only']);

    expect(publication.retiringInstanceIds).toEqual(['shared', 'old-only']);
    expect(ledger.view('shared').generationMemberships).toEqual([1, 2]);
    expect(ledger.view('old-only').generationMemberships).toEqual([1]);
    expect(ledger.view('new-only').generationMemberships).toEqual([2]);
  });

  it('linearizes capture before publish without mutating the captured generation', () => {
    const coordinator = new CompositionCoordinator();
    coordinator.commitPublish(snapshot(1));

    const pin = coordinator.captureRootGeneration();
    coordinator.commitPublish(snapshot(2));

    expect(pin.generation).toBe(1);
    expect(pin.snapshot.generation).toBe(1);
    expect(coordinator.current?.generation).toBe(2);
    expect(coordinator.pinCount(1)).toBe(1);
    pin.release();
    pin.release();
    expect(coordinator.pinCount(1)).toBe(0);
  });

  it('linearizes publish before capture onto the new generation', () => {
    const coordinator = new CompositionCoordinator();
    coordinator.commitPublish(snapshot(1));
    coordinator.commitPublish(snapshot(2));

    const pin = coordinator.captureRootGeneration();
    expect(pin.generation).toBe(2);
    expect(coordinator.pinCount(1)).toBe(0);
    expect(coordinator.pinCount(2)).toBe(1);
  });

  it('rejects capture and publish after shutdown admission', () => {
    const coordinator = new CompositionCoordinator();
    coordinator.commitPublish(snapshot(1));
    coordinator.beginShutdown();

    expect(() => coordinator.captureRootGeneration()).toThrow('closing');
    expect(() => coordinator.commitPublish(snapshot(2))).toThrow('closing');
  });

  it('completes publish before a later shutdown admission', () => {
    const coordinator = new CompositionCoordinator();
    coordinator.commitPublish(snapshot(1));

    coordinator.commitPublish(snapshot(2));
    coordinator.beginShutdown();

    expect(coordinator.current?.generation).toBe(2);
    expect(coordinator.generationState(2)).toBe('current');
    expect(() => coordinator.captureRootGeneration()).toThrow('closing');
  });

  it('requires monotonic process-local generations', () => {
    const coordinator = new CompositionCoordinator();
    expect(() => coordinator.commitPublish(snapshot(2))).toThrow('must be 1');
    coordinator.commitPublish(snapshot(1));
    expect(() => coordinator.commitPublish(snapshot(3))).toThrow('must be 2');
  });

  it('waits for pinned Roots without polling', async () => {
    const coordinator = new CompositionCoordinator();
    coordinator.commitPublish(snapshot(1));
    const pin = coordinator.captureRootGeneration();

    expect(coordinator.commitPublish(snapshot(2))).toEqual(expect.objectContaining({
      retiringGeneration: 1,
    }));
    expect(coordinator.generationState(1)).toBe('retiring');
    expect(coordinator.generationState(2)).toBe('current');

    let converged = false;
    const convergence = coordinator.waitForZeroPins(1).then(() => { converged = true; });
    await Promise.resolve();
    expect(converged).toBe(false);

    pin.release();
    await convergence;
    expect(converged).toBe(true);
    coordinator.completeRetirement(1);
    expect(coordinator.generationState(1)).toBe('retired');
    expect(coordinator.retiring).toBeUndefined();

    coordinator.commitPublish(snapshot(3));
    expect(coordinator.current?.generation).toBe(3);
  });

  it('publishes while older generations are pinned and retires them independently', () => {
    const coordinator = new CompositionCoordinator();
    coordinator.commitPublish(snapshot(1));
    const first = coordinator.captureRootGeneration();
    coordinator.commitPublish(snapshot(2));
    const second = coordinator.captureRootGeneration();
    coordinator.commitPublish(snapshot(3));

    expect(first.snapshot.generation).toBe(1);
    expect(second.snapshot.generation).toBe(2);
    expect(coordinator.current?.generation).toBe(3);
    expect(coordinator.retiring).toBe(1);
    second.release();
    coordinator.completeRetirement(2);
    expect(coordinator.retiring).toBe(1);
    expect(() => coordinator.completeRetirement(1)).toThrow('active pins');
    first.release();
    coordinator.completeRetirement(1);
    expect(coordinator.retiring).toBeUndefined();
  });

  it('preserves an attributable failed-residual retirement state', () => {
    const coordinator = new CompositionCoordinator();
    coordinator.commitPublish(snapshot(1));
    coordinator.commitPublish(snapshot(2));

    coordinator.failRetirement(1, 'unit stop failed');

    expect(coordinator.generationState(1)).toBe('failed-residual');
    expect(coordinator.retirementFailure(1)).toBe('unit stop failed');
    expect(coordinator.current?.generation).toBe(2);
  });

  it('keeps only lightweight historical generation records after repeated retirement', () => {
    const coordinator = new CompositionCoordinator();
    coordinator.commitPublish(snapshot(1));
    const expectedRecords = new Map<number, {
      instanceIds: readonly string[];
      state: 'current' | 'retired';
    }>();
    for (let generation = 2; generation <= 50; generation += 1) {
      const pin = coordinator.captureRootGeneration();
      coordinator.commitPublish(snapshot(generation));
      expect(pin.snapshot.generation).toBe(generation - 1);
      pin.release();
      coordinator.completeRetirement(generation - 1);
      expectedRecords.set(generation - 1, { instanceIds: [], state: 'retired' });
      expectedRecords.set(generation, { instanceIds: [], state: 'current' });
      expect(Reflect.get(coordinator, 'generations')).toEqual(expectedRecords);
    }
    expect(coordinator.current?.generation).toBe(50);
  });
});
