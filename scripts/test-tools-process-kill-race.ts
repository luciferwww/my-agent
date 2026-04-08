/**
 * process.kill fast-exit race integration test.
 *
 * Verifies that killing a background task immediately after exec returns stays
 * well-defined even when the process is racing natural completion.
 *
 * Usage:
 *   npx tsx scripts/test-process-kill-race.ts
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

function extractStatus(content: string): string {
  const match = content.match(/^status:\s*(\S+)/m);
  if (!match) {
    throw new Error(`status not found in content: ${content}`);
  }

  return match[1]!;
}

function isExpectedTerminalStatus(status: string): boolean {
  return status === 'aborted' || status === 'completed';
}

async function main(): Promise<void> {
  const cwd = process.cwd();
  const toolExecutor = createToolExecutor([execTool, processTool]);
  const command = 'node -e "setTimeout(() => console.log(\'race-done\'), 80)"';

  console.log('\nStarting process.kill race integration test');
  console.log(`cwd: ${cwd}`);
  console.log(`command: ${command}`);

  const started = await toolExecutor('exec', {
    command,
    cwd,
    background: true,
  });

  assert.ok(!started.isError, `expected background start success, got: ${started.content}`);
  const runId = extractRunId(started.content);

  const firstKill = await toolExecutor('process', {
    action: 'kill',
    runId,
  });

  assert.ok(!firstKill.isError, `expected race kill success, got: ${firstKill.content}`);
  const firstStatus = extractStatus(firstKill.content);
  assert.ok(
    isExpectedTerminalStatus(firstStatus),
    `expected completed or aborted, got: ${firstKill.content}`,
  );

  const statusAfterKill = await toolExecutor('process', {
    action: 'status',
    runId,
  });

  assert.ok(!statusAfterKill.isError, `expected status success, got: ${statusAfterKill.content}`);
  const settledStatus = extractStatus(statusAfterKill.content);
  assert.ok(
    isExpectedTerminalStatus(settledStatus),
    `expected completed or aborted status, got: ${statusAfterKill.content}`,
  );

  const secondKill = await toolExecutor('process', {
    action: 'kill',
    runId,
  });

  assert.ok(!secondKill.isError, `expected second kill success, got: ${secondKill.content}`);
  const secondStatus = extractStatus(secondKill.content);
  assert.equal(secondStatus, settledStatus);

  const list = await toolExecutor('process', {
    action: 'list',
  });

  assert.ok(!list.isError, `expected list success, got: ${list.content}`);
  assert.match(list.content, new RegExp(`- ${runId} \\| ${settledStatus} \\|`));

  const log = await toolExecutor('process', {
    action: 'log',
    runId,
  });

  assert.ok(!log.isError, `expected log success, got: ${log.content}`);
  if (settledStatus === 'completed') {
    assert.match(log.content, /race-done/);
  }

  console.log('\nFirst kill result:');
  console.log(firstKill.content.trim());
  console.log('\nSettled status:');
  console.log(statusAfterKill.content.trim());
  console.log('\nprocess.kill race integration test complete\n');
}

await main();