import { describe, expect, it } from 'vitest';

import { runCommand, settleWindowsExitState } from './run-command.js';

describe('runCommand', () => {
  it('captures stdout on success', async () => {
    const running = runCommand({
      command: 'node -e "console.log(\'hello\')"',
      cwd: process.cwd(),
      env: {},
    });

    const outcome = await running.completion;
    expect(outcome.status).toBe('completed');
    expect(outcome.output).toContain('hello');
  });

  it('maps non-zero exits to failed', async () => {
    const running = runCommand({
      command: 'node -e "process.exit(2)"',
      cwd: process.cwd(),
      env: {},
    });

    const outcome = await running.completion;
    expect(outcome.status).toBe('failed');
    expect(outcome.exitCode).toBe(2);
  });

  it('maps timeout to timed_out', async () => {
    const running = runCommand({
      command: 'node -e "setTimeout(() => console.log(\'late\'), 200)"',
      cwd: process.cwd(),
      env: {},
      timeoutMs: 50,
    });

    const outcome = await running.completion;
    expect(outcome.status).toBe('timed_out');
  });

  it('maps AbortSignal cancellation to aborted', async () => {
    const controller = new AbortController();
    const running = runCommand({
      command: 'node -e "setInterval(() => console.log(\'tick\'), 50)"',
      cwd: process.cwd(),
      env: {},
      signal: controller.signal,
    });

    setTimeout(() => controller.abort(), 50);

    const outcome = await running.completion;
    expect(outcome.status).toBe('aborted');
  });

  it('settles Windows exit state when close arrives before exitCode', async () => {
    const child = {
      exitCode: null as number | null,
      signalCode: null as NodeJS.Signals | null,
    };

    setTimeout(() => {
      child.exitCode = 0;
    }, 5);

    const settled = await settleWindowsExitState(child, null, null, {
      platform: 'win32',
      timeoutMs: 30,
      pollMs: 1,
    });

    expect(settled).toEqual({ code: 0, signal: null });
  });

  it('skips settle when platform is not Windows', async () => {
    const settled = await settleWindowsExitState(
      {
        exitCode: 7,
        signalCode: null,
      },
      7,
      null,
      {
        platform: 'linux',
      },
    );

    expect(settled).toEqual({ code: 7, signal: null });
  });
});