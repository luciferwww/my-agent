import { ChildProcess, spawn } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { killProcessTree } from './kill-process-tree.js';
import { runCommand, settleWindowsExitState } from './run-command.js';

vi.mock('node:child_process', async (importOriginal) => ({
  ...await importOriginal<typeof import('node:child_process')>(),
  spawn: vi.fn(),
}));

vi.mock('./kill-process-tree.js', () => ({
  killProcessTree: vi.fn(),
}));

let child: ChildProcess;

beforeEach(() => {
  vi.useFakeTimers();
  child = new ChildProcess();
  Object.defineProperty(child, 'pid', { value: 123 });
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  vi.mocked(spawn).mockReturnValue(child);
  vi.mocked(killProcessTree).mockImplementation(async () => {
    child.emit('close', 1, null);
    return { ok: true, attemptedForce: true, method: 'windows-taskkill' };
  });
});

afterEach(() => {
  child.stdout?.destroy();
  child.stderr?.destroy();
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe('runCommand', () => {
  it('captures stdout on success', async () => {
    const running = runCommand({
      command: 'test-command', cwd: process.cwd(), env: {},
    });
    child.emit('spawn');
    child.stdout?.emit('data', Buffer.from('hello\n'));
    child.emit('close', 0, null);

    await expect(running.started).resolves.toBe(123);
    const outcome = await running.completion;
    expect(outcome.status).toBe('completed');
    expect(outcome.output).toContain('hello');
    expect(killProcessTree).not.toHaveBeenCalled();
  });

  it('maps non-zero exits to failed', async () => {
    const running = runCommand({
      command: 'test-command', cwd: process.cwd(), env: {},
    });
    child.emit('close', 2, null);

    const outcome = await running.completion;
    expect(outcome.status).toBe('failed');
    expect(outcome.exitCode).toBe(2);
  });

  it('maps timeout to timed_out', async () => {
    const running = runCommand({
      command: 'test-command', cwd: process.cwd(), env: {}, timeoutMs: 50,
    });
    await vi.advanceTimersByTimeAsync(50);

    const outcome = await running.completion;
    expect(outcome.status).toBe('timed_out');
    expect(killProcessTree).toHaveBeenCalledExactlyOnceWith({
      pid: 123, child, reason: 'timeout',
    });
  });

  it('maps AbortSignal cancellation to aborted', async () => {
    const controller = new AbortController();
    const running = runCommand({
      command: 'test-command', cwd: process.cwd(), env: {}, signal: controller.signal,
    });
    controller.abort();

    const outcome = await running.completion;
    expect(outcome.status).toBe('aborted');
    expect(killProcessTree).toHaveBeenCalledExactlyOnceWith({
      pid: 123, child, reason: 'abort',
    });
  });

  it('settles Windows exit state when close arrives before exitCode', async () => {
    const exitState = {
      exitCode: null as number | null,
      signalCode: null as NodeJS.Signals | null,
    };
    const pending = settleWindowsExitState(exitState, null, null, {
      platform: 'win32', timeoutMs: 30, pollMs: 1,
    });
    setTimeout(() => { exitState.exitCode = 0; }, 5);
    await vi.advanceTimersByTimeAsync(5);

    await expect(pending).resolves.toEqual({ code: 0, signal: null });
  });

  it('skips settle when platform is not Windows', async () => {
    const settled = await settleWindowsExitState(
      { exitCode: 7, signalCode: null }, 7, null, { platform: 'linux' },
    );
    expect(settled).toEqual({ code: 7, signal: null });
  });
});
