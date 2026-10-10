import { describe, expect, it, vi } from 'vitest';
import type { ApprovalRequest } from '../../core/channel/index.js';
import { TurnInteractionManager } from './TurnInteractionManager.js';

const testLog = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

function createManager(): TurnInteractionManager {
  return new TurnInteractionManager(testLog);
}

function requestApproval(manager: TurnInteractionManager, signal: AbortSignal) {
  return manager.request({
    request: {
      callId: 'call-1',
      toolName: 'demo_tool',
      input: {},
      sessionId: 'main',
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
    const manager = createManager();
    const controller = new AbortController();
    const closed = vi.fn();
    manager.onClose((value, outcome) => {
      expect(manager.getPending()).toEqual([]);
      closed(value, outcome);
    });
    let request: ApprovalRequest | undefined;
    manager.onRequest((value) => {
      request = value;
      return { status: 'accepted' };
    });

    const result = requestApproval(manager, controller.signal);
    manager.resolve(request!.id, decision);
    expect(manager.settle(request!.id, { outcome: 'aborted', reason: 'turn' })).toBe(false);
    await expect(result).resolves.toEqual(expected);
    expect(closed).toHaveBeenCalledExactlyOnceWith(request, expected);
  });

  it('queries global or exact Session pending state with isolated nested inputs and origin context', async () => {
    const manager = createManager();
    const controller = new AbortController();
    manager.onRequest(() => ({ status: 'accepted' }));
    const first = manager.request({
      request: {
        callId: 'first-call',
        toolName: 'demo_tool',
        input: { nested: { value: 1 } },
        sessionId: 'main',
        turnId: 'first-turn',
        originChannelId: 'websocket',
        originClientId: 'client-a',
      },
      signal: controller.signal,
    });
    const second = manager.request({
      request: {
        callId: 'second-call',
        toolName: 'demo_tool',
        input: {},
        sessionId: 'other',
        turnId: 'second-turn',
      },
      signal: controller.signal,
    });
    expect(manager.getPending()).toHaveLength(2);
    expect(manager.getPending('missing')).toEqual([]);
    const [snapshot] = manager.getPending('main');
    expect(snapshot).toMatchObject({
      originChannelId: 'websocket',
      originClientId: 'client-a',
    });
    expect(snapshot.input.nested).not.toBe(manager.getPending('main')[0].input.nested);
    snapshot.input.nested = { value: 99 };
    snapshot.sessionId = 'changed';
    expect(manager.getPending('main')[0].input).toEqual({ nested: { value: 1 } });
    manager.resolve(snapshot.id, 'allow');
    expect(manager.getPending('main')).toEqual([]);
    await expect(first).resolves.toEqual({ outcome: 'approved' });
    manager.close();
    expect(manager.getPending()).toEqual([]);
    await expect(second).resolves.toEqual({ outcome: 'aborted', reason: 'shutdown' });
  });

  it('keeps unanswered approval pending after 120 seconds', async () => {
    vi.useFakeTimers();
    const manager = createManager();
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
    const manager = createManager();
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
    const manager = createManager();
    const controller = new AbortController();
    manager.onRequest(() => ({ status: 'accepted' }));
    manager.onClose(() => {
      throw new Error('closure transport failed');
    });

    const result = requestApproval(manager, controller.signal);
    expect(() => controller.abort('turn')).not.toThrow();
    await expect(result).resolves.toEqual({ outcome: 'aborted', reason: 'turn' });
  });

  it('authorizes only pending approvals in the selected Session', async () => {
    const manager = createManager();
    const controller = new AbortController();
    manager.onRequest(() => ({ status: 'accepted' }));
    const first = requestApproval(manager, controller.signal);
    const other = manager.request({
      request: {
        callId: 'call-2',
        toolName: 'demo_tool',
        input: {},
        sessionId: 'other',
        turnId: 'turn-2',
      },
      signal: controller.signal,
    });

    expect(manager.authorizeSession('main')).toBe(1);
    await expect(first).resolves.toEqual({
      outcome: 'approved',
      source: 'session_allow_all',
    });

    controller.abort('turn');
    await expect(other).resolves.toEqual({ outcome: 'aborted', reason: 'turn' });
  });
});