/**
 * exec timeout tree-termination integration test.
 *
 * Verifies that the timeout path reuses kill-tree semantics and stops both
 * parent and descendant processes.
 *
 * Usage:
 *   npx tsx scripts/test-exec-timeout-tree.ts
 */

import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import os from 'node:os';
import process from 'node:process';

import { createToolExecutor, execTool } from '../src/tools/index.js';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
      'setInterval(() => appendFileSync(logPath, \"grandchild\\n\"), 80);',
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
      'spawn(process.execPath, [childScriptPath, logPath], { stdio: \"ignore\" });',
      'setInterval(() => appendFileSync(logPath, \"parent\\n\"), 80);',
    ].join('\n'),
    'utf8',
  );

  return { logPath, parentScriptPath, childScriptPath };
}

async function main(): Promise<void> {
  const toolExecutor = createToolExecutor([execTool]);
  const cwd = process.cwd();
  const fixtureDir = await mkdtemp(join(os.tmpdir(), 'my-agent-timeout-tree-'));

  try {
    const { logPath, parentScriptPath, childScriptPath } = await createTreeFixture(fixtureDir);
    const command = `node "${parentScriptPath}" "${logPath}" "${childScriptPath}"`;

    console.log('\nStarting exec timeout tree integration test');
    console.log(`cwd: ${cwd}`);
    console.log(`command: ${command}`);

    const result = await toolExecutor('exec', {
      command,
      cwd,
      timeout: 1,
    });

    assert.ok(result.isError, `expected timeout error, got: ${result.content}`);
    assert.match(result.content, /timed out/i);

    await sleep(150);
    const firstLog = await readFile(logPath, 'utf8');
    assert.match(firstLog, /parent/);
    assert.match(firstLog, /grandchild/);

    await sleep(400);
    const secondLog = await readFile(logPath, 'utf8');

    assert.equal(
      secondLog,
      firstLog,
      'expected timeout to stop the whole process tree so the log stops growing',
    );

    console.log('\nTimeout result:');
    console.log(result.content.trim());
    console.log('\nTree log stabilized after timeout.');
    console.log('\nexec timeout tree integration test complete\n');
  } finally {
    await rm(fixtureDir, { recursive: true, force: true });
  }
}

await main();