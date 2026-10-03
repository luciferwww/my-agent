import { describe, expect, it, vi } from 'vitest';
import { SessionPermissionRegistry } from './SessionPermissionRegistry.js';

describe('SessionPermissionRegistry', () => {
  it('initializes a Session to Manual and returns stable state', () => {
    const registry = new SessionPermissionRegistry({ now: () => 10 });

    const first = registry.get('session-1');
    const second = registry.get('session-1');

    expect(first).toEqual({
      sessionId: 'session-1',
      mode: 'manual',
      changedAt: 10,
    });
    expect(second).toBe(first);
  });

  it('stores Allow All in memory and notifies listeners once per change', () => {
    let now = 10;
    const registry = new SessionPermissionRegistry({ now: () => now });
    const listener = vi.fn();
    registry.onChange(listener);
    registry.initialize('session-1');
    now = 20;

    const state = registry.set('session-1', 'allow_all', 'client-1');

    expect(state).toEqual({
      sessionId: 'session-1',
      mode: 'allow_all',
      changedAt: 20,
      changedByClientId: 'client-1',
    });
    expect(registry.set('session-1', 'allow_all', 'client-2')).toBe(state);
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('removes Session state without affecting other Sessions', () => {
    const registry = new SessionPermissionRegistry({ now: () => 10 });
    registry.set('session-1', 'allow_all');
    const other = registry.set('session-2', 'allow_all');

    registry.delete('session-1');

    expect(registry.peek('session-1')).toBeUndefined();
    expect(registry.peek('session-2')).toBe(other);
  });
});
