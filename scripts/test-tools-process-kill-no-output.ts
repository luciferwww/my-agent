/**
 * process.kill no-output integration test.
 *
 * Verifies that killing a background task with no stdout/stderr still marks the
 * task aborted and keeps the log contract stable across platforms.
 *
 * Usage:
 *   npx tsx scripts/test-process-kill-no-output.ts
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

async function main(): Promise<void> {
  const cwd = process.cwd();
  const toolExecutor = createToolExecutor([execTool, processTool]);
  const command = 'node -e "setInterval(() => {}, 1000)"';

  console.log('\nStarting process.kill no-output integration test');
  console.log(`cwd: ${cwd}`);
  console.log(`command: ${command}`);

  const started = await toolExecutor('exec', {
    command,
    cwd,
    background: true,
  });

  assert.ok(!started.isError, `expected background start success, got: ${started.content}`);
  const runId = extractRunId(started.content);

  const beforeKill = await toolExecutor('process', {
    action: 'status',
    runId,
  });

  assert.ok(!beforeKill.isError, `expected status success, got: ${beforeKill.content}`);
  assert.match(beforeKill.content, /status: (starting|running)/);

  const killed = await toolExecutor('process', {
    action: 'kill',
    runId,
  });

  assert.ok(!killed.isError, `expected kill success, got: ${killed.content}`);
  assert.match(killed.content, /status: aborted/);

  const afterKill = await toolExecutor('process', {
    action: 'status',
    runId,
  });

  assert.ok(!afterKill.isError, `expected status after kill, got: ${afterKill.content}`);
  assert.match(afterKill.content, /status: aborted/);

  const logAfterKill = await toolExecutor('process', {
    action: 'log',
    runId,
  });

  assert.ok(!logAfterKill.isError, `expected log success, got: ${logAfterKill.content}`);
  assert.equal(logAfterKill.content.trim(), 'No output has been produced yet.');

  const killedAgain = await toolExecutor('process', {
    action: 'kill',
    runId,
  });

  assert.ok(!killedAgain.isError, `expected second kill success, got: ${killedAgain.content}`);
  assert.match(killedAgain.content, /status: aborted/);

  console.log('\nNo-output kill result:');
  console.log(killed.content.trim());
  console.log('\nprocess.kill no-output integration test complete\n');
}

await main();