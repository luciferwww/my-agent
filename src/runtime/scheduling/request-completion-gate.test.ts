import { describe, expect, it } from 'vitest';
import { RequestCompletionGate } from './request-completion-gate.js';

describe('RequestCompletionGate', () => {
  it('moves accepted to started to exactly one terminal settlement', async () => {
    const gate = new RequestCompletionGate<string>('request-1', 'origin-1');

    expect(gate.start('turn-1')).toBe(true);
    expect(gate.start('turn-2')).toBe(false);
    expect(gate.seal({ outcome: 'completed', value: 'first' })).toBe(true);
    expect(gate.seal({ outcome: 'failed', error: new Error('late') })).toBe(false);

    await expect(gate.terminal).resolves.toEqual({ outcome: 'completed', value: 'first' });
    expect(gate.turnId).toBe('turn-1');
    expect(gate.terminalOutcome).toBe('completed');
  });

  it('settles an unstarted queued request without a turn identity', async () => {
    const gate = new RequestCompletionGate<string>('request-queued', 'origin-queued');

    expect(gate.seal({ outcome: 'cancelled', reason: 'shutdown' })).toBe(true);
    expect(gate.turnId).toBeUndefined();
    await expect(gate.terminal).resolves.toEqual({
      outcome: 'cancelled',
      reason: 'shutdown',
    });
  });
});
