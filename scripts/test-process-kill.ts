/**
 * process.kill integration test.
 *
 * Usage:
 *   npx tsx scripts/test-process-kill.ts
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
  const command = 'node -e "let i=0; setInterval(()=>console.log(\'tick\', ++i), 200)"';

  console.log('\n🚀 Starting process.kill integration test');
  console.log(`cwd: ${cwd}`);
  console.log(`command: ${command}`);

  const started = await toolExecutor('exec', {
    command,
    cwd,
    background: true,
  });

  assert.ok(!started.isError, `expected background start success, got: ${started.content}`);
  const runId = extractRunId(started.content);

  console.log('\n📌 exec returned:');
  console.log(started.content);

  await waitFor(async () => {
    const logResult = await toolExecutor('process', {
      action: 'log',
      runId,
    });

    return !logResult.isError && /tick\s+1/.test(logResult.content);
  });

  const beforeKillStatus = await toolExecutor('process', {
    action: 'status',
    runId,
  });

  assert.ok(!beforeKillStatus.isError, `expected status success, got: ${beforeKillStatus.content}`);
  assert.match(beforeKillStatus.content, /status: (starting|running)/);

  console.log('\n📍 Status before kill:');
  console.log(beforeKillStatus.content);

  const killed = await toolExecutor('process', {
    action: 'kill',
    runId,
  });

  assert.ok(!killed.isError, `expected kill success, got: ${killed.content}`);
  assert.match(killed.content, /status: aborted/);

  console.log('\n🛑 First kill result:');
  console.log(killed.content);

  const statusAfterKill = await toolExecutor('process', {
    action: 'status',
    runId,
  });

  assert.ok(!statusAfterKill.isError, `expected status success, got: ${statusAfterKill.content}`);
  assert.match(statusAfterKill.content, /status: aborted/);

  const logAfterKill = await toolExecutor('process', {
    action: 'log',
    runId,
  });

  assert.ok(!logAfterKill.isError, `expected log success, got: ${logAfterKill.content}`);
  assert.match(logAfterKill.content, /tick\s+1/);

  console.log('\n📜 Log after kill:');
  console.log(logAfterKill.content);

  const killedAgain = await toolExecutor('process', {
    action: 'kill',
    runId,
  });

  assert.ok(!killedAgain.isError, `expected second kill success, got: ${killedAgain.content}`);
  assert.match(killedAgain.content, /status: aborted/);

  console.log('\n♻️ Second kill result (idempotent):');
  console.log(killedAgain.content);

  console.log('\n✅ process.kill integration test complete\n');
}

await main();