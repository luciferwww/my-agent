/**
 * exec yield continuation integration test.
 *
 * Usage:
 *   npx tsx scripts/test-exec-yield.ts
 *   npm run test:tool:yield
 */

import assert from 'node:assert/strict';
import process from 'node:process';

import { createToolExecutor, execTool, processTool } from '../src/tools/index.js';

type AsyncCase = () => Promise<void>;

let passed = 0;
let failed = 0;

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
  timeoutMs = 6000,
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

async function runCase(name: string, test: AsyncCase): Promise<void> {
  console.log(`\n${'='.repeat(64)}`);
  console.log(`🧪 ${name}`);
  console.log('='.repeat(64));

  try {
    await test();
    passed += 1;
    console.log(`✅ ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`❌ ${name}`);
    console.error(error instanceof Error ? error.message : String(error));
  }
}

const cwd = process.cwd();
const toolExecutor = createToolExecutor([execTool, processTool]);

console.log('\n🚀 Starting exec yield integration test');
console.log(`cwd: ${cwd}`);

await runCase('1. Short task completes within yieldMs without leaking a background record', async () => {
  const result = await toolExecutor('exec', {
    command: 'node -e "setTimeout(() => console.log(\'fast-done\'), 200)"',
    cwd,
    yieldMs: 1000,
  });

  assert.ok(!result.isError, `expected success, got: ${result.content}`);
  assert.match(result.content, /fast-done/);
  assert.ok(!/runId:/i.test(result.content), `expected no runId, got: ${result.content}`);

  const list = await toolExecutor('process', { action: 'list' });
  assert.ok(!list.isError, `expected list success, got: ${list.content}`);
  assert.equal(list.content.trim(), 'No background processes.');

  console.log(result.content.trim());
});

await runCase('2. Long task exceeds yieldMs, hands off to background, and completes', async () => {
  const started = await toolExecutor('exec', {
    command: 'node -e "let i=0; const t=setInterval(()=>{ console.log(\'tick\', ++i); if(i===5){ clearInterval(t); } }, 400)"',
    cwd,
    yieldMs: 150,
  });

  assert.ok(!started.isError, `expected yielded background start, got: ${started.content}`);
  const runId = extractRunId(started.content);

  const firstStatus = await toolExecutor('process', {
    action: 'status',
    runId,
  });

  assert.ok(!firstStatus.isError, `expected status success, got: ${firstStatus.content}`);
  assert.match(firstStatus.content, /status: (starting|running)/);

  await waitFor(async () => {
    const status = await toolExecutor('process', { action: 'status', runId });
    return !status.isError && /status: completed/.test(status.content);
  });

  const log = await toolExecutor('process', {
    action: 'log',
    runId,
  });

  assert.ok(!log.isError, `expected log success, got: ${log.content}`);
  assert.match(log.content, /tick\s+1/);
  assert.match(log.content, /tick\s+5/);

  const finalStatus = await toolExecutor('process', {
    action: 'status',
    runId,
  });

  assert.ok(!finalStatus.isError, `expected final status success, got: ${finalStatus.content}`);
  assert.match(finalStatus.content, /status: completed/);

  console.log(started.content.trim());
  console.log(finalStatus.content.trim());
});

await runCase('3. Long task exceeds yieldMs and fails through the background path', async () => {
  const started = await toolExecutor('exec', {
    command: 'node -e "setTimeout(() => { console.error(\'boom\'); process.exit(2); }, 600)"',
    cwd,
    yieldMs: 150,
  });

  assert.ok(!started.isError, `expected yielded background start, got: ${started.content}`);
  const runId = extractRunId(started.content);

  await waitFor(async () => {
    const status = await toolExecutor('process', { action: 'status', runId });
    return !status.isError && /status: failed/.test(status.content);
  });

  const log = await toolExecutor('process', {
    action: 'log',
    runId,
  });

  assert.ok(!log.isError, `expected log success, got: ${log.content}`);
  assert.match(log.content, /boom/);

  const finalStatus = await toolExecutor('process', {
    action: 'status',
    runId,
  });

  assert.ok(!finalStatus.isError, `expected final status success, got: ${finalStatus.content}`);
  assert.match(finalStatus.content, /status: failed/);

  console.log(started.content.trim());
  console.log(finalStatus.content.trim());
});

console.log(`\n📊 Test results: ${passed} passed / ${failed} failed`);

if (failed > 0) {
  process.exit(1);
}

console.log('✅ exec yield integration test complete\n');