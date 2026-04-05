import { describe, expect, it } from 'vitest';

import { runCommand } from './run-command.js';

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
});