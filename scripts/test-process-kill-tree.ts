/**
 * process.kill tree-termination integration test.
 *
 * Usage:
 *   npx tsx scripts/test-process-kill-tree.ts
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
  timeoutMs = 5000,
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
  const command = 'node -e "const { spawn } = require(\'node:child_process\'); spawn(process.execPath, [\'-e\', \'setInterval(() => console.log(\\\'grandchild\\\'), 120)\'], { stdio: \'inherit\' }); setInterval(() => console.log(\'parent\'), 120)"';

  console.log('\nStarting process.kill tree integration test');
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
    const logs = await toolExecutor('process', { action: 'log', runId });
    return !logs.isError && logs.content.includes('parent') && logs.content.includes('grandchild');
  });

  const beforeKill = await toolExecutor('process', {
    action: 'log',
    runId,
  });

  assert.ok(!beforeKill.isError, `expected log success before kill, got: ${beforeKill.content}`);

  const killed = await toolExecutor('process', {
    action: 'kill',
    runId,
  });

  assert.ok(!killed.isError, `expected kill success, got: ${killed.content}`);
  assert.match(killed.content, /status: aborted/);

  await sleep(300);
  const afterKillA = await toolExecutor('process', {
    action: 'log',
    runId,
  });
  assert.ok(!afterKillA.isError, `expected first post-kill log success, got: ${afterKillA.content}`);

  await sleep(350);
  const afterKillB = await toolExecutor('process', {
    action: 'log',
    runId,
  });
  assert.ok(!afterKillB.isError, `expected second post-kill log success, got: ${afterKillB.content}`);

  assert.equal(
    afterKillB.content,
    afterKillA.content,
    'expected process tree output to stop growing after kill',
  );

  console.log('\nTree-termination log stabilized after kill.');
  console.log('\nprocess.kill tree integration test complete\n');
}

await main();