/**
 * process.list lifecycle integration test.
 *
 * Verifies that process.list only exposes background-visible tasks and keeps
 * stable summaries across running, completed, aborted, and yielded lifecycles.
 *
 * Usage:
 *   npx tsx scripts/test-process-list-lifecycle.ts
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

function listContains(content: string, runId: string, status?: string): boolean {
  const statusPattern = status ? `\\| ${status} \\|` : '\\|';
  return new RegExp(`^- ${runId} ${statusPattern}`, 'm').test(content);
}

const cwd = process.cwd();
const toolExecutor = createToolExecutor([execTool, processTool]);

console.log('\n🚀 Starting process.list lifecycle integration test');
console.log(`cwd: ${cwd}`);

await runCase('1. Foreground and short yield tasks do not leak into process.list', async () => {
  const initialList = await toolExecutor('process', { action: 'list' });
  assert.ok(!initialList.isError, `expected empty list success, got: ${initialList.content}`);
  assert.equal(initialList.content.trim(), 'No background processes.');

  const foreground = await toolExecutor('exec', {
    command: 'node -e "console.log(\'fg-ok\')"',
    cwd,
  });

  assert.ok(!foreground.isError, `expected foreground success, got: ${foreground.content}`);

  const shortYield = await toolExecutor('exec', {
    command: 'node -e "setTimeout(() => console.log(\'yield-fast\'), 80)"',
    cwd,
    yieldMs: 500,
  });

  assert.ok(!shortYield.isError, `expected short yield success, got: ${shortYield.content}`);
  assert.ok(!/runId:/i.test(shortYield.content), `expected no background handoff, got: ${shortYield.content}`);

  const finalList = await toolExecutor('process', { action: 'list' });
  assert.ok(!finalList.isError, `expected empty list success, got: ${finalList.content}`);
  assert.equal(finalList.content.trim(), 'No background processes.');
});

await runCase('2. Background task appears in list while running and remains after completion', async () => {
  const started = await toolExecutor('exec', {
    command: 'node -e "let i=0; const t=setInterval(() => { console.log(\'tick\', ++i); if(i===3){ clearInterval(t); } }, 120)"',
    cwd,
    background: true,
  });

  assert.ok(!started.isError, `expected background start success, got: ${started.content}`);
  const runId = extractRunId(started.content);

  await waitFor(async () => {
    const list = await toolExecutor('process', { action: 'list' });
    return !list.isError && listContains(list.content, runId);
  });

  const runningList = await toolExecutor('process', { action: 'list' });
  assert.ok(!runningList.isError, `expected running list success, got: ${runningList.content}`);
  assert.ok(listContains(runningList.content, runId), `expected runId in list, got: ${runningList.content}`);

  await waitFor(async () => {
    const status = await toolExecutor('process', { action: 'status', runId });
    return !status.isError && /status: completed/.test(status.content);
  });

  const completedList = await toolExecutor('process', { action: 'list' });
  assert.ok(!completedList.isError, `expected completed list success, got: ${completedList.content}`);
  assert.ok(
    listContains(completedList.content, runId, 'completed'),
    `expected completed entry in list, got: ${completedList.content}`,
  );
});

await runCase('3. Killed task remains listed as aborted', async () => {
  const started = await toolExecutor('exec', {
    command: 'node -e "setInterval(() => {}, 1000)"',
    cwd,
    background: true,
  });

  assert.ok(!started.isError, `expected background start success, got: ${started.content}`);
  const runId = extractRunId(started.content);

  const killed = await toolExecutor('process', {
    action: 'kill',
    runId,
  });

  assert.ok(!killed.isError, `expected kill success, got: ${killed.content}`);
  assert.match(killed.content, /status: aborted/);

  const abortedList = await toolExecutor('process', { action: 'list' });
  assert.ok(!abortedList.isError, `expected aborted list success, got: ${abortedList.content}`);
  assert.ok(
    listContains(abortedList.content, runId, 'aborted'),
    `expected aborted entry in list, got: ${abortedList.content}`,
  );
});

await runCase('4. Yielded handoff tasks appear in list after promotion to background', async () => {
  const started = await toolExecutor('exec', {
    command: 'node -e "setTimeout(() => console.log(\'late\'), 1000)"',
    cwd,
    yieldMs: 100,
  });

  assert.ok(!started.isError, `expected yielded background start, got: ${started.content}`);
  const runId = extractRunId(started.content);

  const yieldedStatus = await toolExecutor('process', {
    action: 'status',
    runId,
  });

  assert.ok(!yieldedStatus.isError, `expected yielded status success, got: ${yieldedStatus.content}`);
  assert.match(yieldedStatus.content, /yielded: true/);

  const yieldedList = await toolExecutor('process', { action: 'list' });
  assert.ok(!yieldedList.isError, `expected yielded list success, got: ${yieldedList.content}`);
  assert.ok(
    listContains(yieldedList.content, runId),
    `expected yielded runId in list, got: ${yieldedList.content}`,
  );

  const killed = await toolExecutor('process', {
    action: 'kill',
    runId,
  });

  assert.ok(!killed.isError, `expected yield kill success, got: ${killed.content}`);
});

console.log(`\n📊 Test results: ${passed} passed / ${failed} failed`);

if (failed > 0) {
  process.exit(1);
}

console.log('✅ process.list lifecycle integration test complete\n');
