import { describe, expect, it } from 'vitest';
import type { RegistrySnapshot } from '../core/registry/index.js';
import { CompositionCoordinator } from './composition-coordinator.js';

function snapshot(generation: number): RegistrySnapshot {
  return Object.freeze({
    generation,
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

  it('requires monotonic process-local generations', () => {
    const coordinator = new CompositionCoordinator();
    expect(() => coordinator.commitPublish(snapshot(2))).toThrow('must be 1');
    coordinator.commitPublish(snapshot(1));
    expect(() => coordinator.commitPublish(snapshot(3))).toThrow('must be 2');
  });
});
