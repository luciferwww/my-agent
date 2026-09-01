import { describe, expect, it, vi } from 'vitest';
import { TurnInteractionManager } from './TurnInteractionManager.js';
import type { ApprovalRequest } from './types.js';

function requestApproval(manager: TurnInteractionManager, signal: AbortSignal) {
  return manager.request({
    request: {
      toolName: 'demo_tool',
      input: {},
      sessionKey: 'main',
      turnId: 'turn-1',
    },
    signal,
  });
}

describe('TurnInteractionManager approval lifecycle', () => {
  it.each([
    ['allow', { outcome: 'approved' }],
    ['deny', { outcome: 'denied', reason: 'user' }],
  ] as const)('settles %s exactly once and ignores a late competing result', async (decision, expected) => {
    const manager = new TurnInteractionManager();
    const controller = new AbortController();
    let request: ApprovalRequest | undefined;
    manager.onRequest((value) => {
      request = value;
      return { status: 'accepted' };
    });

    const result = requestApproval(manager, controller.signal);
    manager.resolve(request!.id, decision);
    expect(manager.settle(request!.id, { outcome: 'aborted', reason: 'turn' })).toBe(false);
    await expect(result).resolves.toEqual(expected);
  });

  it('keeps unanswered approval pending after 120 seconds', async () => {
    vi.useFakeTimers();
    const manager = new TurnInteractionManager();
    const controller = new AbortController();
    let settled = false;
    manager.onRequest(() => ({ status: 'accepted' }));

    const result = requestApproval(manager, controller.signal).then((value) => {
      settled = true;
      return value;
    });

    await vi.advanceTimersByTimeAsync(120_000);
    expect(settled).toBe(false);

    controller.abort('turn');
    await expect(result).resolves.toEqual({ outcome: 'aborted', reason: 'turn' });
    vi.useRealTimers();
  });

  it('settles exactly once when a decision races Turn abort', async () => {
    const manager = new TurnInteractionManager();
    const controller = new AbortController();
    let request: ApprovalRequest | undefined;
    manager.onRequest((value) => {
      request = value;
      return { status: 'accepted' };
    });

    const result = requestApproval(manager, controller.signal);
    expect(request).toBeDefined();

    controller.abort('shutdown');
    expect(manager.resolve(request!.id, 'allow')).toBeUndefined();
    await expect(result).resolves.toEqual({ outcome: 'aborted', reason: 'shutdown' });
  });

  it('contains close handler failures after settlement', async () => {
    const manager = new TurnInteractionManager();
    const controller = new AbortController();
    manager.onRequest(() => ({ status: 'accepted' }));
    manager.onClose(() => {
      throw new Error('closure transport failed');
    });

    const result = requestApproval(manager, controller.signal);
    expect(() => controller.abort('turn')).not.toThrow();
    await expect(result).resolves.toEqual({ outcome: 'aborted', reason: 'turn' });
  });
});