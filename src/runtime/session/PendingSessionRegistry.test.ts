import { describe, expect, it } from 'vitest';
import { PendingSessionRegistry } from './PendingSessionRegistry.js';

describe('PendingSessionRegistry', () => {
  it('creates process-local registrations with an injected identity and clock', () => {
    const registry = new PendingSessionRegistry({
      now: () => 100,
      generateSessionId: () => 'session-one',
    });

    expect(registry.create()).toEqual({ sessionId: 'session-one', createdAt: 100 });
    expect(registry.get('session-one')).toEqual({ sessionId: 'session-one', createdAt: 100 });
  });

  it('lazily expires registrations at the TTL boundary', () => {
    let now = 100;
    const registry = new PendingSessionRegistry({
      ttlMs: 50,
      now: () => now,
      generateSessionId: () => 'session-one',
    });
    registry.create();

    now = 149;
    expect(registry.get('session-one')).toBeDefined();
    now = 150;
    expect(registry.get('session-one')).toBeUndefined();
  });

  it('rejects capacity exhaustion without evicting live registrations', () => {
    let sequence = 0;
    const registry = new PendingSessionRegistry({
      capacity: 2,
      generateSessionId: () => `session-${sequence += 1}`,
    });
    registry.create();
    registry.create();

    expect(() => registry.create()).toThrowError(expect.objectContaining({
      code: 'SESSION_CAPACITY_EXCEEDED',
    }));
    expect(registry.get('session-1')).toBeDefined();
    expect(registry.get('session-2')).toBeDefined();
  });

  it('removes expired registrations before applying capacity', () => {
    let now = 0;
    let sequence = 0;
    const registry = new PendingSessionRegistry({
      ttlMs: 10,
      capacity: 1,
      now: () => now,
      generateSessionId: () => `session-${sequence += 1}`,
    });
    registry.create();

    now = 10;
    expect(registry.create()).toEqual({ sessionId: 'session-2', createdAt: 10 });
  });

  it('deletes a registration idempotently', () => {
    const registry = new PendingSessionRegistry({
      generateSessionId: () => 'session-one',
    });
    registry.create();

    expect(registry.delete('session-one')).toBe(true);
    expect(registry.delete('session-one')).toBe(false);
  });
});