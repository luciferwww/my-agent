import { getEventListeners } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import type { QueuedUserMessage } from './queue-types.js';
import { SessionMessageScheduler } from './session-message-scheduler.js';

function message(requestId: string, sessionId = 'main'): QueuedUserMessage {
  return {
    requestId,
    sessionId,
    message: requestId,
    originMessageId: `message-${requestId}`,
    reasoningPolicy: { effort: 'medium' },
  };
}

describe('SessionMessageScheduler', () => {
  it('reserves one Session synchronously with FIFO selection', () => {
    const scheduler = new SessionMessageScheduler();
    const first = message('first');
    const second = message('second');
    scheduler.enqueue(first);
    scheduler.enqueue(second);

    expect(scheduler.isBusy('main')).toBe(true);
    expect(scheduler.isRunning('main')).toBe(false);
    expect(scheduler.takeNext('main')).toBe(first);
    const reentrantSelect = () => scheduler.takeNext('main');
    expect(reentrantSelect()).toBeUndefined();
    expect(scheduler.isRunning('main')).toBe(true);
    expect(scheduler.pendingCount('main')).toBe(1);
    expect(() => scheduler.reserve('main')).toThrow('already has a turn in flight');

    scheduler.release('main');
    expect(scheduler.isBusy('main')).toBe(true);
    expect(scheduler.takeNext('main')).toBe(second);
    expect(scheduler.pendingSessionIds()).toEqual([]);
    expect(scheduler.isBusy('main')).toBe(true);
    scheduler.release('main');
    expect(scheduler.isBusy('main')).toBe(false);
    expect(scheduler.takeNext('main')).toBeUndefined();
    expect(scheduler.isRunning('main')).toBe(false);
  });

  it('runs different Sessions independently and returns a detached pending-ID snapshot', () => {
    const scheduler = new SessionMessageScheduler();
    scheduler.enqueue(message('first'));
    const snapshot = scheduler.pendingSessionIds();
    scheduler.enqueue(message('other', 'other'));
    snapshot.push('not-a-session');

    expect(scheduler.pendingSessionIds()).toEqual(['main', 'other']);
    expect(scheduler.takeNext('main')?.requestId).toBe('first');
    expect(scheduler.takeNext('other')?.requestId).toBe('other');
    scheduler.release('main');
    expect(scheduler.isBusy('other')).toBe(true);
  });

  it('claims only a contiguous compatible prefix without skipping or replay', () => {
    const scheduler = new SessionMessageScheduler();
    scheduler.reserve('main');
    const first = message('first');
    const blocked = message('blocked');
    const later = message('later');
    scheduler.enqueue(first);
    scheduler.enqueue(blocked);
    scheduler.enqueue(later);
    const compatible = vi.fn((item: QueuedUserMessage) => item !== blocked);

    expect(scheduler.claimReady('main', compatible)).toEqual([first]);
    expect(compatible.mock.calls.map(([item]) => item.requestId)).toEqual(['first', 'blocked']);
    expect(scheduler.claimReady('main', compatible)).toEqual([]);
    expect(scheduler.pendingCount('main')).toBe(2);
    expect(scheduler.claimReady('main', () => true)).toEqual([blocked, later]);
    expect(scheduler.claimReady('main', () => true)).toEqual([]);
    expect(scheduler.isRunning('main')).toBe(true);
    expect(scheduler.pendingSessionIds()).toEqual([]);
  });

  it('leaves the FIFO untouched when compatibility evaluation fails', () => {
    const scheduler = new SessionMessageScheduler();
    scheduler.enqueue(message('first'));
    scheduler.enqueue(message('second'));

    expect(() => scheduler.claimReady('main', () => {
      throw new Error('compatibility failed');
    })).toThrow('compatibility failed');
    expect(scheduler.dropPending('main').map(item => item.requestId)).toEqual(['first', 'second']);
  });

  it('drops only pending input without releasing running or claimed ownership', () => {
    const scheduler = new SessionMessageScheduler();
    scheduler.enqueue(message('running'));
    scheduler.takeNext('main');
    scheduler.enqueue(message('claimed'));
    expect(scheduler.claimReady('main', () => true).map(item => item.requestId)).toEqual(['claimed']);
    scheduler.enqueue(message('drop'));
    scheduler.enqueue(message('other', 'other'));

    const dropped = scheduler.dropPending('main');
    expect(dropped.map(item => item.requestId)).toEqual(['drop']);
    expect(scheduler.dropPending('main')).toEqual([]);
    expect(scheduler.isRunning('main')).toBe(true);
    expect(scheduler.pendingSessionIds()).toEqual(['other']);
    scheduler.enqueue(message('new'));
    dropped.push(message('not-requeued'));
    expect(scheduler.pendingCount('main')).toBe(1);
  });

  it('wakes all same-Session waiters without claiming a synchronous burst', async () => {
    const scheduler = new SessionMessageScheduler();
    const firstSignal = new AbortController();
    const secondSignal = new AbortController();
    const otherSignal = new AbortController();
    const first = scheduler.waitUntilReady('main', firstSignal.signal);
    const second = scheduler.waitUntilReady('main', secondSignal.signal);
    const other = scheduler.waitUntilReady('other', otherSignal.signal);
    const otherOutcome = expect(other).rejects.toMatchObject({ name: 'AbortError' });

    scheduler.enqueue(message('first'));
    scheduler.enqueue(message('second'));
    await Promise.all([first, second]);
    expect(getEventListeners(firstSignal.signal, 'abort')).toHaveLength(0);
    expect(getEventListeners(secondSignal.signal, 'abort')).toHaveLength(0);
    expect(scheduler.claimReady('main', () => true).map(item => item.requestId)).toEqual(['first', 'second']);
    otherSignal.abort();
    await otherOutcome;
  });

  it('removes an aborted waiter without disrupting another or retaining it for a later wake', async () => {
    const scheduler = new SessionMessageScheduler();
    const cancelled = new AbortController();
    const retained = new AbortController();
    const rejected = expect(scheduler.waitUntilReady('main', cancelled.signal))
      .rejects.toMatchObject({ name: 'AbortError' });
    const ready = scheduler.waitUntilReady('main', retained.signal);
    expect(getEventListeners(cancelled.signal, 'abort')).toHaveLength(1);
    cancelled.abort();
    await rejected;
    expect(getEventListeners(cancelled.signal, 'abort')).toHaveLength(0);
    expect(getEventListeners(retained.signal, 'abort')).toHaveLength(1);

    scheduler.enqueue(message('wake'));
    await ready;
    expect(getEventListeners(retained.signal, 'abort')).toHaveLength(0);
    scheduler.dropPending('main');

    const next = new AbortController();
    const nextReady = scheduler.waitUntilReady('main', next.signal);
    scheduler.enqueue(message('wake-again'));
    await nextReady;
  });

  it('rejects a pre-aborted empty wait but preserves nonempty-FIFO precedence', async () => {
    const scheduler = new SessionMessageScheduler();
    const controller = new AbortController();
    controller.abort();

    await expect(scheduler.waitUntilReady('main', controller.signal))
      .rejects.toMatchObject({ name: 'AbortError' });
    scheduler.enqueue(message('ready'));
    await expect(scheduler.waitUntilReady('main', controller.signal)).resolves.toBeUndefined();
    expect(scheduler.pendingCount('main')).toBe(1);
  });
});
