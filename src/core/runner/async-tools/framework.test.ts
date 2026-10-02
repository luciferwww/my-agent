import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SessionManager } from '../../session/index.js';
import type { SupervisedToolExecutionContext, ToolExecutionOutput } from '../../tools/index.js';
import { getToolTurnAuthority } from '../../tools/execution.js';
import { DefaultAsyncToolExecutionFramework } from './framework.js';
import { ToolExecutionRuntimeState } from './runtime-state.js';

const SESSION_ID = '00000000-0000-4000-8000-000000000301';

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe('DefaultAsyncToolExecutionFramework', () => {
  let agentHome: string;
  let sessionManager: SessionManager;
  let runtimeState: ToolExecutionRuntimeState;
  let nextExecutionId: number;

  beforeEach(async () => {
    agentHome = await mkdtemp(join(tmpdir(), 'async-tool-framework-'));
    sessionManager = new SessionManager(agentHome);
    runtimeState = new ToolExecutionRuntimeState();
    nextExecutionId = 0;
    await sessionManager.materializeSession({
      sessionId: SESSION_ID,
      createdAt: Date.now(),
    });
  });

  afterEach(async () => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    await rm(agentHome, { recursive: true, force: true });
  });

  function framework() {
    return new DefaultAsyncToolExecutionFramework({
      sessionManager,
      runtimeState,
      createExecutionId: () => `execution-${++nextExecutionId}`,
    });
  }

  function context(signal = new AbortController().signal) {
    return {
      sessionId: SESSION_ID,
      turnId: 'turn-1',
      subagentDepth: 0,
      signal,
    };
  }

  function call(
    callId: string,
    execute: (
      input: Readonly<Record<string, unknown>>,
      executionContext: SupervisedToolExecutionContext,
    ) => Promise<ToolExecutionOutput>,
  ) {
    return {
      callId,
      toolName: 'demo',
      unitId: 'builtin-demo',
      input: { callId },
      execute,
    };
  }

  it('persists accepted ownership before starting and emits one terminal event', async () => {
    const pending = deferred<ToolExecutionOutput>();
    const execute = vi.fn(() => pending.promise);
    const subject = framework();

    const receipt = await subject.submit(call('call-1', execute), context());

    expect(receipt).toEqual({ executionId: 'execution-1', status: 'accepted' });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(sessionManager.getAsyncToolRecords(SESSION_ID)).toEqual([
      expect.objectContaining({
        type: 'tool_execution_accepted',
        executionId: 'execution-1',
      }),
    ]);
    expect(subject.hasUnsettledWork()).toBe(true);
    expect(runtimeState.occupiedSlotCount).toBe(1);

    pending.resolve({ outcome: 'success', content: 'done' });
    await expect(subject.waitForNextEvent(new AbortController().signal)).resolves.toMatchObject({
      type: 'execution_terminal',
      executionId: 'execution-1',
      callId: 'call-1',
      outcome: 'success',
      content: 'done',
      implementationStarted: true,
    });

    expect(subject.hasUnsettledWork()).toBe(false);
    expect(runtimeState.occupiedSlotCount).toBe(0);
    expect(sessionManager.getAsyncToolRecords(SESSION_ID).at(-1)).toMatchObject({
      type: 'tool_execution_terminal',
      outcome: 'success',
    });
  });

  it('starts independent calls before any sibling Promise settles', async () => {
    const pending = [deferred<ToolExecutionOutput>(), deferred<ToolExecutionOutput>(), deferred<ToolExecutionOutput>()];
    const started: string[] = [];
    const subject = framework();

    await Promise.all(pending.map((item, index) => subject.submit(
      call(`call-${index + 1}`, async (input) => {
        started.push(String(input.callId));
        return item.promise;
      }),
      context(),
    )));

    expect(started).toEqual(['call-1', 'call-2', 'call-3']);
    expect(runtimeState.occupiedSlotCount).toBe(3);

    pending.forEach((item, index) => {
      item.resolve({ outcome: 'success', content: `done-${index + 1}` });
    });
    const events = await Promise.all([
      subject.waitForNextEvent(new AbortController().signal),
      subject.waitForNextEvent(new AbortController().signal),
      subject.waitForNextEvent(new AbortController().signal),
    ]);
    expect(events).toHaveLength(3);
    expect(runtimeState.occupiedSlotCount).toBe(0);
  });

  it('preserves Parent Turn authority separately from execution cancellation', async () => {
    const rootController = new AbortController();
    const pending = deferred<ToolExecutionOutput>();
    let executionContext!: SupervisedToolExecutionContext;
    const subject = framework();

    await subject.submit(call('call-1', async (_input, receivedContext) => {
      executionContext = receivedContext;
      return pending.promise;
    }), context(rootController.signal));

    expect(executionContext.signal).not.toBe(rootController.signal);
    expect(getToolTurnAuthority(executionContext)).toBe(rootController.signal);

    pending.resolve({ outcome: 'success', content: 'done' });
    await subject.waitForNextEvent(new AbortController().signal);
  });

  it('rejects capacity immediately without an accepted record or queue', async () => {
    runtimeState = new ToolExecutionRuntimeState(1);
    const pending = deferred<ToolExecutionOutput>();
    const subject = framework();
    await subject.submit(call('call-1', () => pending.promise), context());

    await expect(subject.submit(
      call('call-2', async () => ({ outcome: 'success', content: 'unexpected' })),
      context(),
    )).rejects.toMatchObject({
      name: 'ToolExecutionUnavailableError',
      reason: 'capacity',
    });
    expect(sessionManager.getAsyncToolRecords(SESSION_ID)).toHaveLength(1);

    pending.resolve({ outcome: 'success', content: 'done' });
    await subject.waitForNextEvent(new AbortController().signal);
  });

  it('releases capacity and does not invoke the Tool when accepted persistence fails', async () => {
    vi.spyOn(sessionManager, 'appendToolExecutionAccepted')
      .mockRejectedValueOnce(new Error('disk failed'));
    const execute = vi.fn(async () => ({ outcome: 'success' as const, content: 'unexpected' }));
    const subject = framework();

    await expect(subject.submit(call('call-1', execute), context()))
      .rejects.toThrow('disk failed');
    expect(execute).not.toHaveBeenCalled();
    expect(runtimeState.occupiedSlotCount).toBe(0);
    expect(subject.hasUnsettledWork()).toBe(false);
  });

  it('terminalizes an already-aborted Turn without invoking the Tool', async () => {
    const controller = new AbortController();
    controller.abort();
    const execute = vi.fn(async () => ({ outcome: 'success' as const, content: 'unexpected' }));
    const subject = framework();

    await subject.submit(call('call-1', execute), context(controller.signal));
    await expect(subject.waitForNextEvent(new AbortController().signal)).resolves.toMatchObject({
      type: 'execution_terminal',
      outcome: 'aborted',
      implementationStarted: false,
    });

    expect(execute).not.toHaveBeenCalled();
    expect(runtimeState.occupiedSlotCount).toBe(0);
    expect(sessionManager.getAsyncToolRecords(SESSION_ID).at(-1)).toMatchObject({
      type: 'tool_execution_terminal',
      outcome: 'aborted',
      reason: 'start_interrupted',
    });
  });

  it('converges after terminal persistence fails', async () => {
    vi.spyOn(sessionManager, 'appendToolExecutionTerminal')
      .mockRejectedValueOnce(new Error('terminal disk failed'));
    const subject = framework();

    await subject.submit(
      call('call-1', async () => ({ outcome: 'success', content: 'done' })),
      context(),
    );
    await expect(subject.waitForNextEvent(new AbortController().signal)).resolves.toMatchObject({
      type: 'execution_persistence_failed',
      executionId: 'execution-1',
      error: expect.objectContaining({ message: 'terminal disk failed' }),
    });

    expect(subject.hasUnsettledWork()).toBe(false);
    expect(runtimeState.occupiedSlotCount).toBe(0);
  });

  it('refreshes the idle deadline only when the Tool reports activity', async () => {
    vi.useFakeTimers();
    const pending = deferred<ToolExecutionOutput>();
    let executionContext!: SupervisedToolExecutionContext;
    const subject = framework();
    await subject.submit(call('call-1', async (_input, receivedContext) => {
      executionContext = receivedContext;
      return pending.promise;
    }), context());

    await vi.advanceTimersByTimeAsync(5 * 60_000 - 1);
    expect(executionContext.signal.aborted).toBe(false);
    executionContext.reportActivity();
    await vi.advanceTimersByTimeAsync(5 * 60_000 - 1);
    expect(executionContext.signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(executionContext.signal.aborted).toBe(true);

    pending.resolve({ outcome: 'success', content: 'settled during grace' });
    await expect(subject.waitForNextEvent(new AbortController().signal)).resolves.toMatchObject({
      type: 'execution_terminal',
      outcome: 'success',
    });
  });

  it('quarantines after cancellation grace and ignores late settlement', async () => {
    vi.useFakeTimers();
    const pending = deferred<ToolExecutionOutput>();
    const subject = framework();
    const receipt = await subject.submit(call('call-1', () => pending.promise), context());

    await subject.cancel(receipt.executionId, 'root_abort');
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(subject.waitForNextEvent(new AbortController().signal)).resolves.toMatchObject({
      type: 'execution_terminal',
      outcome: 'outcome_unknown',
    });
    expect(subject.hasUnsettledWork()).toBe(false);
    expect(runtimeState.occupiedSlotCount).toBe(1);
    expect(runtimeState.quarantineCount).toBe(1);
    expect(runtimeState.isUnitDisabled('builtin-demo')).toBe(true);

    pending.resolve({ outcome: 'success', content: 'late success' });
    await Promise.resolve();
    await Promise.resolve();

    expect(runtimeState.occupiedSlotCount).toBe(0);
    expect(runtimeState.quarantineCount).toBe(0);
    expect(runtimeState.isUnitDisabled('builtin-demo')).toBe(true);
    expect(sessionManager.getAsyncToolRecords(SESSION_ID).filter(
      (record) => record.type === 'tool_execution_terminal',
    )).toHaveLength(1);
  });

  it('detaches and disables the Tool registration when quarantine transfer fails', async () => {
    vi.useFakeTimers();
    const pending = deferred<ToolExecutionOutput>();
    vi.spyOn(runtimeState, 'moveToQuarantine').mockImplementationOnce(() => {
      throw new Error('quarantine invariant failed');
    });
    const subject = framework();
    const receipt = await subject.submit(call('call-1', () => pending.promise), context());

    await subject.cancel(receipt.executionId, 'root_abort');
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(subject.waitForNextEvent(new AbortController().signal)).resolves.toMatchObject({
      type: 'execution_invariant_failed',
      executionId: 'execution-1',
      error: expect.objectContaining({ message: 'quarantine invariant failed' }),
    });

    expect(subject.hasUnsettledWork()).toBe(false);
    expect(runtimeState.occupiedSlotCount).toBe(1);
    expect(runtimeState.quarantineCount).toBe(0);
    expect(runtimeState.isUnitDisabled('builtin-demo')).toBe(true);

    pending.resolve({ outcome: 'success', content: 'late success' });
    await Promise.resolve();
    await Promise.resolve();
    expect(runtimeState.occupiedSlotCount).toBe(0);
  });
});
