/**
 * exec integration test that lists files in the current working directory.
 *
 * Usage:
 *   npx tsx scripts/test-exec-list-cwd.ts
 */

import assert from 'node:assert/strict';
import process from 'node:process';

import { createToolExecutor, execTool } from '../src/tools/index.js';

function getListCommand(): string {
  return process.platform === 'win32' ? 'dir' : 'ls';
}

async function main(): Promise<void> {
  const cwd = process.cwd();
  const command = getListCommand();
  const toolExecutor = createToolExecutor([execTool]);

  console.log('\n🚀 Starting exec integration test');
  console.log(`cwd: ${cwd}`);
  console.log(`command: ${command}`);

  const result = await toolExecutor('exec', {
    command,
    cwd,
    timeout: 10,
  });

  assert.ok(!result.isError, `expected success, got: ${result.content}`);

  const output = result.content.trim();
  assert.ok(output.length > 0, 'expected directory listing output');

  // Smoke assertion: the project root should expose at least one stable entry.
  assert.match(output, /package\.json|src|docs/i);

  console.log('\n📂 Directory listing output:');
  console.log(output);
  console.log('\n✅ exec integration test complete\n');
}

await main();