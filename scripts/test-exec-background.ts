/**
 * exec + process background execution integration test.
 *
 * Usage:
 *   npx tsx scripts/test-exec-background.ts
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

async function main(): Promise<void> {
  const cwd = process.cwd();
  const toolExecutor = createToolExecutor([execTool, processTool]);
  const command = 'node -e "let i=0; const t=setInterval(()=>{ console.log(\'tick\', ++i); if(i===5){ clearInterval(t); } }, 1000)"';

  console.log('\n🚀 Starting exec background integration test');
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

  const firstStatus = await toolExecutor('process', {
    action: 'status',
    runId,
  });

  assert.ok(!firstStatus.isError, `expected status success, got: ${firstStatus.content}`);
  assert.match(firstStatus.content, /status: (starting|running)/);

  console.log('\n📍 Initial status:');
  console.log(firstStatus.content);

  console.log('\n📜 Log polling:');
  let lastLog = '';
  for (let attempt = 1; attempt <= 6; attempt += 1) {
    await sleep(1100);

    const logResult = await toolExecutor('process', {
      action: 'log',
      runId,
    });

    assert.ok(!logResult.isError, `expected log success, got: ${logResult.content}`);
    lastLog = logResult.content;

    console.log(`\n[log poll ${attempt}]`);
    console.log(lastLog || '(empty)');

    const statusResult = await toolExecutor('process', {
      action: 'status',
      runId,
    });

    assert.ok(!statusResult.isError, `expected status success, got: ${statusResult.content}`);
    console.log(`\n[status poll ${attempt}]`);
    console.log(statusResult.content);

    if (statusResult.content.includes('status: completed')) {
      break;
    }
  }

  assert.match(lastLog, /tick\s+1/);
  assert.match(lastLog, /tick\s+5/);

  const finalStatus = await toolExecutor('process', {
    action: 'status',
    runId,
  });

  assert.ok(!finalStatus.isError, `expected final status success, got: ${finalStatus.content}`);
  assert.match(finalStatus.content, /status: completed/);

  console.log('\n✅ Final status:');
  console.log(finalStatus.content);
  console.log('\n✅ exec background integration test complete\n');
}

await main();