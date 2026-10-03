import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '../../../src/core/model-invocation/types.js';
import { finalProjection, ProjectionTurn, type Result } from './projection.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => { resolve = settle; });
  return { promise, resolve };
}

describe('offline pending-call projection', () => {
  it('AP-3/4: steering cancels only the current scope and waits for cleanup before continuation', async () => {
    const cleanup = deferred<void>();
    const root = new AbortController();
    const executions: string[] = [];
    let childSignal: AbortSignal | undefined;
    let cancellations = 0;
    const turn = new ProjectionTurn(
      [{ role: 'user', content: 'Synthetic work' }],
      [
        { id: 'call-1', name: 'fixture', input: {} },
        { id: 'call-2', name: 'fixture', input: {} },
      ],
      async (call, context) => {
        executions.push(call.id);
        childSignal = context.signal;
        await new Promise<void>(resolve => {
          context.signal.addEventListener('abort', () => {
            cancellations++;
            resolve();
          }, { once: true });
        });
        await cleanup.promise;
        return { outcome: 'cancelled', content: 'Cooperative cleanup completed' };
      },
      async () => ({ reply: 'Stop this route; wait for cleanup.', action: 'cancel' }),
      root.signal,
    );
    const running = turn.start();
    try {
      await turn.steer('redirect', 'Stop research and use another route.');
      expect(childSignal?.aborted).toBe(true);
      expect(root.signal.aborted).toBe(false);
      expect(cancellations).toBe(1);
      expect(executions).toEqual(['call-1']);
      expect(turn.snapshot().facts.filter(fact => fact.kind === 'result')).toHaveLength(0);
      expect(() => finalProjection(turn.snapshot())).toThrow('Pending/unknown');
    } finally {
      turn.cancel('steering');
      cleanup.resolve();
      await running;
    }
    expect(root.signal.aborted).toBe(false);
    expect(executions).toEqual(['call-1']);
    expect(turn.snapshot().facts.filter(fact => fact.kind === 'result').map(fact => fact.result.outcome))
      .toEqual(['cancelled', 'not_executed']);
    expect(() => finalProjection(turn.snapshot())).not.toThrow();
  });

  it('AP-6: cancellation cannot fabricate a terminal result for an uncooperative executor', async () => {
    const tool = deferred<Result>();
    const root = new AbortController();
    let signal: AbortSignal | undefined;
    const turn = new ProjectionTurn(
      [],
      [{ id: 'call-1', name: 'fixture', input: {} }],
      async (_call, context) => {
        signal = context.signal;
        return tool.promise;
      },
      async () => ({ reply: 'Cancellation requested.', action: 'cancel' }),
      root.signal,
    );
    const running = turn.start();
    try {
      await turn.steer('redirect', 'Stop this route.');
      expect(signal?.aborted).toBe(true);
      expect(root.signal.aborted).toBe(false);
      expect(turn.snapshot().facts.filter(fact => fact.kind === 'result')).toHaveLength(0);
      expect(() => finalProjection(turn.snapshot())).toThrow('Pending/unknown');
    } finally {
      tool.resolve({ outcome: 'success', content: 'Actually completed despite cancellation' });
      await running;
    }
    expect(turn.snapshot().facts.filter(fact => fact.kind === 'result').map(fact => fact.result.outcome))
      .toEqual(['success']);
  });

  it('AP-5: completion during a control reply wins over its later cancel decision', async () => {
    const tool = deferred<Result>();
    const decision = deferred<{ reply: string; action: 'cancel' }>();
    const entered = deferred<void>();
    const root = new AbortController();
    let signal: AbortSignal | undefined;
    const result: Result = { outcome: 'success', content: 'Real result' };
    const turn = new ProjectionTurn(
      [],
      [{ id: 'call-1', name: 'fixture', input: {} }],
      async (_call, context) => {
        signal = context.signal;
        return tool.promise;
      },
      async () => {
        entered.resolve();
        return decision.promise;
      },
      root.signal,
    );
    const running = turn.start();
    const steering = turn.steer('redirect', 'Stop if still running.');
    try {
      await entered.promise;
      tool.resolve(result);
      await running;
      expect(() => finalProjection(turn.snapshot())).toThrow('Control reply pending');
    } finally {
      tool.resolve(result);
      decision.resolve({ reply: 'Request cancellation if still pending.', action: 'cancel' });
      await Promise.all([running, steering]);
    }
    expect(signal?.aborted).toBe(false);
    expect(root.signal.aborted).toBe(false);
    expect(turn.acceptResult('call-1', result)).toBe(false);
    expect(turn.snapshot().facts.filter(fact => fact.kind === 'result')).toHaveLength(1);
    expect(turn.snapshot().facts.filter(fact => fact.kind === 'cancel_requested')).toHaveLength(0);
    expect(() => finalProjection(turn.snapshot())).not.toThrow();
  });

  it('AP-1/2: replies to two steering messages before the real Tool result', async () => {
    const tool = deferred<Result>();
    const requests: ChatMessage[][] = [];
    let signal: AbortSignal | undefined;
    const turn = new ProjectionTurn(
      [{ role: 'user', content: 'Synthetic work' }],
      [{ id: 'call-1', name: 'fixture', input: {} }],
      async (_call, context) => {
        signal = context.signal;
        context.reportActivity();
        return tool.promise;
      },
      async (messages) => {
        requests.push(messages);
        return { reply: 'Acknowledged; still running.', action: 'keep' };
      },
      new AbortController().signal,
    );
    const running = turn.start();
    try {
      await turn.steer('note-1', 'NOTE: report when finished');
      await turn.steer('note-2', 'How is progress?');
      expect(requests).toHaveLength(2);
      expect(signal?.aborted).toBe(false);
      expect(turn.snapshot().facts.filter((fact) => fact.kind === 'result')).toHaveLength(0);
      expect(requests.every((messages) => messages.every((message) => typeof message.content === 'string'))).toBe(true);
      expect(() => finalProjection(turn.snapshot())).toThrow('Pending/unknown');
    } finally {
      tool.resolve({ outcome: 'success', content: 'Actual completed work' });
      await running;
    }
    const messages = finalProjection(turn.snapshot());
    expect(messages).toHaveLength(7);
    expect(JSON.stringify(messages)).toContain('results unavailable at that time');
    expect(turn.snapshot().facts.filter((fact) => fact.kind === 'result')).toHaveLength(1);
  });
});
