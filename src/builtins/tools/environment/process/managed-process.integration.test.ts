import { afterEach, describe, expect, it } from 'vitest';

import { TEST_TOOL_CONTEXT } from '../../../../core/tools/test-utils.js';
import type { RunningCommand } from './exec-types.js';
import { createExecTool } from './exec-tool.js';
import { processRegistry } from './process-registry.js';
import { processTool } from './process-tool.js';
import { runCommand } from './run-command.js';

const command = 'node -e "console.log(\'ready\'); setInterval(() => {}, 1000)"';
const context = { ...TEST_TOOL_CONTEXT, sessionId: 'managed-process-integration' };
const runningCommands: RunningCommand[] = [];

afterEach(async () => {
  await processRegistry.cleanupSession(context.sessionId);
  for (const running of runningCommands.splice(0)) {
    if (!running.control.released) await running.control.terminate('abort');
    await running.completion;
  }
});

describe('managed process operating-system integration', () => {
  it('kills a real background command and retains its aborted status', async () => {
    const started = await createExecTool(process.cwd()).execute({
      command, background: true,
    }, context);
    expect(started.outcome).toBe('success');
    const runId = /runId:\s*(\S+)/u.exec(started.content)?.[1];
    if (!runId) throw new Error('Background command did not return a runId.');
    const record = processRegistry.get(runId, context.sessionId);
    if (!record?.pid) throw new Error('Background command has no owned process PID.');
    const pid = record.pid;
    await expect.poll(async () => {
      const logs = await processTool.execute({ action: 'log', runId }, context);
      return logs.content;
    }).toContain('ready');

    const killed = await processTool.execute({ action: 'kill', runId }, context);
    expect(killed.outcome).toBe('success');
    expect(killed.content).toContain('status: aborted');
    const status = await processTool.execute({ action: 'status', runId }, context);
    expect(status.content).toContain('status: aborted');
    expect(() => process.kill(pid, 0)).toThrow();
  }, 10_000);

  it('maps real AbortSignal termination to aborted', async () => {
    const controller = new AbortController();
    let output = '';
    const running = runCommand({
      command, cwd: process.cwd(), env: {}, signal: controller.signal,
      onStdout: chunk => { output += chunk.text; },
    });
    runningCommands.push(running);
    const pid = await running.started;
    await expect.poll(() => output).toContain('ready');
    controller.abort();

    await expect(running.completion).resolves.toMatchObject({ status: 'aborted' });
    expect(() => process.kill(pid, 0)).toThrow();
  }, 10_000);

  it('maps real command deadline termination to timed_out', async () => {
    const running = runCommand({
      command, cwd: process.cwd(), env: {}, timeoutMs: 50,
    });
    runningCommands.push(running);
    const pid = await running.started;

    await expect(running.completion).resolves.toMatchObject({
      status: 'timed_out', errorMessage: 'Process timed out after 0.05 seconds',
    });
    expect(() => process.kill(pid, 0)).toThrow();
  }, 10_000);
});
