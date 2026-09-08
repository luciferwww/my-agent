import { describe, expect, it, vi } from 'vitest';
import type { RuntimeShutdownReport } from '../src/runtime/index.js';
import { createRuntimeHost } from './runtime-host.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((nextResolve) => { resolve = nextResolve; });
  return { promise, resolve };
}

const report: RuntimeShutdownReport = Object.freeze({
  outcome: 'completed',
  reason: 'first',
  startedAt: 1,
  finishedAt: 2,
  completed: Object.freeze([]),
  failed: Object.freeze([]),
  turns: Object.freeze({
    completedRequestIds: Object.freeze([]),
    abortedRequestIds: Object.freeze([]),
    nonconvergedRequestIds: Object.freeze([]),
    queuedCancelledRequestIds: Object.freeze([]),
    protectedGenerations: Object.freeze([]),
  }),
  instanceStops: Object.freeze({
    completedInstanceIds: Object.freeze([]),
    failedInstanceIds: Object.freeze([]),
    pendingInstanceIds: Object.freeze([]),
    skippedProtectedInstanceIds: Object.freeze([]),
  }),
  residuals: Object.freeze([]),
});

describe('runtime Host policy', () => {
  it('shares cooperative shutdown and removes Host signal listeners after settlement', async () => {
    const closeResult = deferred<RuntimeShutdownReport>();
    const close = vi.fn(() => closeResult.promise);
    const sigintBefore = process.listenerCount('SIGINT');
    const sigtermBefore = process.listenerCount('SIGTERM');
    const host = createRuntimeHost({ close }, { overallTimeoutMs: 1_000 });

    expect(process.listenerCount('SIGINT')).toBe(sigintBefore + 1);
    expect(process.listenerCount('SIGTERM')).toBe(sigtermBefore + 1);
    const first = host.shutdown('first');
    const second = host.shutdown('second');
    expect(first).toBe(second);
    expect(close).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledWith('first');

    closeResult.resolve(report);
    await expect(first).resolves.toBe(report);
    expect(process.listenerCount('SIGINT')).toBe(sigintBefore);
    expect(process.listenerCount('SIGTERM')).toBe(sigtermBefore);
  });

  it('forces exit on a second process signal while cooperative shutdown is pending', async () => {
    const closeResult = deferred<RuntimeShutdownReport>();
    const close = vi.fn(() => closeResult.promise);
    const forceExit = vi.fn((_code: number) => undefined as never);
    const host = createRuntimeHost(
      { close },
      { overallTimeoutMs: 1_000, onForceExit: forceExit },
    );

    process.emit('SIGINT');
    expect(close).toHaveBeenCalledWith('process interrupted');
    expect(forceExit).not.toHaveBeenCalled();

    process.emit('SIGTERM');
    expect(forceExit).toHaveBeenCalledWith(143);
    expect(close).toHaveBeenCalledTimes(1);

    closeResult.resolve(report);
    await host.shutdown('already stopping');
  });

  it('forces failure exit when cooperative shutdown exceeds the Host deadline', async () => {
    vi.useFakeTimers();
    const closeResult = deferred<RuntimeShutdownReport>();
    const forceExit = vi.fn((_code: number) => undefined as never);
    const host = createRuntimeHost(
      { close: () => closeResult.promise },
      { overallTimeoutMs: 1_000, onForceExit: forceExit },
    );

    const shutdown = host.shutdown('deadline test');
    await vi.advanceTimersByTimeAsync(999);
    expect(forceExit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(forceExit).toHaveBeenCalledWith(1);

    closeResult.resolve(report);
    await shutdown;
    vi.useRealTimers();
  });
});
