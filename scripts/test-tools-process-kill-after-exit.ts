/**
 * process.kill terminal-state integration test.
 *
 * Verifies that killing a task after it has already exited remains idempotent
 * and preserves the terminal status instead of rewriting it to aborted.
 *
 * Usage:
 *   npx tsx scripts/test-process-kill-after-exit.ts
 */

import assert from 'node:assert/strict';
import process from 'node:process';

import { createToolExecutor, execTool, processTool } from '../src/tools/index.js';

function extractRunId(content: string): string {
  const match = content.match(/runId:\s*(\S+)/);
  if (!match) {
    throw new Error(`runId not found in content: ${content}`);
  }

  return match[1]!;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(
  predicate: () => Promise<boolean> | boolean,
  timeoutMs = 4000,
): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await predicate()) {
      return;
    }

    await sleep(50);
  }

  throw new Error('Timed out waiting for condition');
}

async function main(): Promise<void> {
  const cwd = process.cwd();
  const toolExecutor = createToolExecutor([execTool, processTool]);
  const command = 'node -e "setTimeout(() => console.log(\'done\'), 120)"';

  console.log('\nStarting process.kill terminal-state integration test');
  console.log(`cwd: ${cwd}`);
  console.log(`command: ${command}`);

  const started = await toolExecutor('exec', {
    command,
    cwd,
    background: true,
  });

  assert.ok(!started.isError, `expected background start success, got: ${started.content}`);
  const runId = extractRunId(started.content);

  await waitFor(async () => {
    const status = await toolExecutor('process', { action: 'status', runId });
    return !status.isError && /status: completed/.test(status.content);
  });

  const statusBeforeKill = await toolExecutor('process', {
    action: 'status',
    runId,
  });

  assert.ok(!statusBeforeKill.isError, `expected completed status, got: ${statusBeforeKill.content}`);
  assert.match(statusBeforeKill.content, /status: completed/);

  const killed = await toolExecutor('process', {
    action: 'kill',
    runId,
  });

  assert.ok(!killed.isError, `expected kill to stay idempotent, got: ${killed.content}`);
  assert.match(killed.content, /status: completed/);

  const log = await toolExecutor('process', {
    action: 'log',
    runId,
  });

  assert.ok(!log.isError, `expected log success, got: ${log.content}`);
  assert.match(log.content, /done/);

  console.log('\nCompleted-task kill result:');
  console.log(killed.content.trim());
  console.log('\nprocess.kill terminal-state integration test complete\n');
}

await main();