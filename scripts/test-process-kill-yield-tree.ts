/**
 * process.kill yielded tree-termination integration test.
 *
 * Verifies that a task which first handed off through exec yield mode can
 * still be killed as a whole process tree and retains yielded metadata.
 *
 * Usage:
 *   npx tsx scripts/test-process-kill-yield-tree.ts
 */

import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import os from 'node:os';
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

async function createTreeFixture(rootDir: string): Promise<{
  logPath: string;
  parentScriptPath: string;
  childScriptPath: string;
}> {
  const logPath = join(rootDir, 'tree.log');
  const parentScriptPath = join(rootDir, 'parent.cjs');
  const childScriptPath = join(rootDir, 'child.cjs');

  await writeFile(
    childScriptPath,
    [
      'const { appendFileSync } = require(\'node:fs\');',
      'const logPath = process.argv[2];',
      'setInterval(() => appendFileSync(logPath, "grandchild\\n"), 80);',
    ].join('\n'),
    'utf8',
  );

  await writeFile(
    parentScriptPath,
    [
      'const { spawn } = require(\'node:child_process\');',
      'const { appendFileSync } = require(\'node:fs\');',
      'const logPath = process.argv[2];',
      'const childScriptPath = process.argv[3];',
      'spawn(process.execPath, [childScriptPath, logPath], { stdio: "ignore" });',
      'setInterval(() => appendFileSync(logPath, "parent\\n"), 80);',
    ].join('\n'),
    'utf8',
  );

  return { logPath, parentScriptPath, childScriptPath };
}

async function main(): Promise<void> {
  const cwd = process.cwd();
  const toolExecutor = createToolExecutor([execTool, processTool]);
  const fixtureDir = await mkdtemp(join(os.tmpdir(), 'my-agent-yield-kill-tree-'));

  try {
    const { logPath, parentScriptPath, childScriptPath } = await createTreeFixture(fixtureDir);
    const command = `node "${parentScriptPath}" "${logPath}" "${childScriptPath}"`;

    console.log('\nStarting process.kill yielded tree integration test');
    console.log(`cwd: ${cwd}`);
    console.log(`command: ${command}`);

    const started = await toolExecutor('exec', {
      command,
      cwd,
      yieldMs: 150,
    });

    assert.ok(!started.isError, `expected yield handoff success, got: ${started.content}`);
    const runId = extractRunId(started.content);

    const yieldedStatus = await toolExecutor('process', {
      action: 'status',
      runId,
    });

    assert.ok(!yieldedStatus.isError, `expected yielded status success, got: ${yieldedStatus.content}`);
    assert.match(yieldedStatus.content, /yielded: true/);

    await waitFor(async () => {
      try {
        const fileLog = await readFile(logPath, 'utf8');
        return fileLog.includes('parent') && fileLog.includes('grandchild');
      } catch {
        return false;
      }
    });

    const killed = await toolExecutor('process', {
      action: 'kill',
      runId,
    });

    assert.ok(!killed.isError, `expected kill success, got: ${killed.content}`);
    assert.match(killed.content, /status: aborted/);
    assert.match(killed.content, /yielded: true/);

    await sleep(300);
    const firstLog = await readFile(logPath, 'utf8');

    await sleep(350);
    const secondLog = await readFile(logPath, 'utf8');

    assert.equal(
      secondLog,
      firstLog,
      'expected yielded process tree output to stop growing after kill',
    );

    console.log('\nYielded-tree kill result:');
    console.log(killed.content.trim());
    console.log('\nprocess.kill yielded tree integration test complete\n');
  } finally {
    await rm(fixtureDir, { recursive: true, force: true });
  }
}

await main();