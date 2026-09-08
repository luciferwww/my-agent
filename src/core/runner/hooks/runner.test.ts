import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  runAfterToolCall,
  runBeforeToolCall,
  runBeforeCompaction,
} from './runner.js';

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

describe('Hook runner', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('runs before_tool_call sequentially with transformed effective input', async () => {
    const seen: Record<string, unknown>[] = [];
    const result = await runBeforeToolCall([
      {
        unitId: 'a',
        contributionId: 'first',
        handler: ({ input }) => {
          seen.push(input);
          return { action: 'allow', input: { ...input, first: true } };
        },
      },
      {
        unitId: 'b',
        contributionId: 'second',
        handler: ({ input }) => {
          seen.push(input);
          return { action: 'allow', input: { ...input, second: true } };
        },
      },
    ], {
      toolName: 'demo',
      input: { start: true },
      turnId: 'turn',
      sessionKey: 'main',
      signal: new AbortController().signal,
    });

    expect(seen).toEqual([
      { start: true },
      { start: true, first: true },
    ]);
    expect(result).toEqual({
      action: 'allow',
      input: { start: true, first: true, second: true },
    });
  });

  it('stops the interceptor chain on deny and propagates interceptor failures', async () => {
    const later = vi.fn(() => ({ action: 'allow' as const }));
    await expect(runBeforeToolCall([
      {
        unitId: 'a',
        contributionId: 'deny',
        handler: () => ({ action: 'deny', reason: 'blocked' }),
      },
      { unitId: 'b', contributionId: 'later', handler: later },
    ], {
      toolName: 'demo',
      input: {},
      turnId: 'turn',
      sessionKey: 'main',
      signal: new AbortController().signal,
    })).resolves.toEqual({ action: 'deny', reason: 'blocked', input: {} });
    expect(later).not.toHaveBeenCalled();

    await expect(runBeforeToolCall([
      {
        unitId: 'a',
        contributionId: 'failure',
        handler: () => { throw new Error('hook failed'); },
      },
    ], {
      toolName: 'demo',
      input: {},
      turnId: 'turn',
      sessionKey: 'main',
      signal: new AbortController().signal,
    })).rejects.toThrow('hook failed');
  });

  it.each([
    null,
    [],
    { nested: undefined },
    { nested: Number.POSITIVE_INFINITY },
    Object.assign(Object.create({ inherited: true }), { own: true }),
  ])('fails closed on a non-JSON replacement input %#', async (replacement) => {
    const later = vi.fn(() => ({ action: 'allow' as const }));
    await expect(runBeforeToolCall([
      {
        unitId: 'a',
        contributionId: 'invalid-replacement',
        handler: () => ({ action: 'allow', input: replacement }) as never,
      },
      { unitId: 'b', contributionId: 'later', handler: later },
    ], {
      toolName: 'demo',
      input: {},
      turnId: 'turn',
      sessionKey: 'main',
      signal: new AbortController().signal,
    })).rejects.toThrow('returned a non-JSON object input');
    expect(later).not.toHaveBeenCalled();
  });

  it('runs observers concurrently and isolates rejection', async () => {
    const first = deferred();
    const second = deferred();
    const entered: string[] = [];
    const settlementsPromise = runAfterToolCall([
      {
        unitId: 'a',
        contributionId: 'first',
        handler: async () => {
          entered.push('first');
          await first.promise;
        },
      },
      {
        unitId: 'b',
        contributionId: 'second',
        handler: async () => {
          entered.push('second');
          await second.promise;
          throw new Error('observer failed');
        },
      },
    ], {
      toolName: 'demo',
      input: {},
      result: { callId: 'call', outcome: 'success', content: 'ok' },
      implementationStarted: true,
      turnId: 'turn',
      sessionKey: 'main',
    }, new AbortController().signal, 1_000);

    await vi.waitFor(() => expect(entered).toEqual(['first', 'second']));
    first.resolve();
    second.resolve();

    await expect(settlementsPromise).resolves.toEqual([
      { unitId: 'a', contributionId: 'first', outcome: 'fulfilled' },
      { unitId: 'b', contributionId: 'second', outcome: 'rejected' },
    ]);
  });

  it('settles each observer on its deadline and ignores late completion', async () => {
    vi.useFakeTimers();
    const late = deferred();
    const settlementsPromise = runBeforeCompaction([
      {
        unitId: 'a',
        contributionId: 'late',
        handler: async () => late.promise,
      },
    ], {
      trigger: 'preemptive',
      estimatedTokens: 100,
      turnId: 'turn',
      sessionKey: 'main',
    }, new AbortController().signal, 25);

    await vi.advanceTimersByTimeAsync(25);
    await expect(settlementsPromise).resolves.toEqual([
      { unitId: 'a', contributionId: 'late', outcome: 'timed_out' },
    ]);
    late.resolve();
    await Promise.resolve();
  });

  it('settles observers as aborted and aborts their local signals', async () => {
    const turn = new AbortController();
    let observerSignal: AbortSignal | undefined;
    const settlementsPromise = runBeforeCompaction([
      {
        unitId: 'a',
        contributionId: 'abort-aware',
        handler: ({ signal }) => {
          observerSignal = signal;
          return new Promise<void>(() => {});
        },
      },
    ], {
      trigger: 'overflow',
      estimatedTokens: 100,
      turnId: 'turn',
      sessionKey: 'main',
    }, turn.signal, 1_000);

    await vi.waitFor(() => expect(observerSignal).toBeDefined());
    turn.abort(new DOMException('aborted', 'AbortError'));
    await expect(settlementsPromise).resolves.toEqual([
      { unitId: 'a', contributionId: 'abort-aware', outcome: 'aborted' },
    ]);
    expect(observerSignal?.aborted).toBe(true);
  });
});
