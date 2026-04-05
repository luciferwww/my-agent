/**
 * Smoke test for calling builtin tools directly.
 *
 * Usage:
 *   npx tsx scripts/test-builtin-tools.ts
 *   npm run test:tool:direct
 */

import assert from 'node:assert/strict';
import process from 'node:process';

import { createToolExecutor, execTool } from '../src/tools/index.js';

type AsyncTest = () => Promise<void>;

let passed = 0;
let failed = 0;

async function runCase(name: string, test: AsyncTest): Promise<void> {
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

console.log('\n🚀 Starting direct builtin tools test');
console.log(`cwd: ${process.cwd()}`);

await runCase('1. Call execTool.execute() directly', async () => {
  const result = await execTool.execute({
    command: 'node -p "process.cwd()"',
    cwd: process.cwd(),
    timeout: 10,
  });

  assert.ok(!result.isError, `expected success, got: ${result.content}`);
  assert.equal(result.content.trim(), process.cwd());
  console.log(`Returned directory: ${result.content.trim()}`);
});

await runCase('2. Call builtin exec through createToolExecutor', async () => {
  const toolExecutor = createToolExecutor([execTool]);
  const result = await toolExecutor('exec', {
    command: 'node -e "console.log(\'executor-ok\')"',
    timeout: 10,
  });

  assert.ok(!result.isError, `expected success, got: ${result.content}`);
  assert.match(result.content, /executor-ok/);
  console.log(result.content.trim());
});

await runCase('3. Verify merged stdout/stderr output', async () => {
  const result = await execTool.execute({
    command: 'node -e "console.log(\'stdout-line\'); console.error(\'stderr-line\')"',
    timeout: 10,
  });

  assert.ok(!result.isError, `expected success, got: ${result.content}`);
  assert.match(result.content, /stdout-line/);
  assert.match(result.content, /stderr-line/);
  console.log(result.content.trim());
});

await runCase('4. Non-zero exit codes return isError', async () => {
  const result = await execTool.execute({
    command: 'node -e "console.error(\'boom\'); process.exit(2)"',
    timeout: 10,
  });

  assert.equal(result.isError, true);
  assert.match(result.content, /boom/);
  assert.match(result.content, /Process exited with code 2/);
  console.log(result.content.trim());
});

console.log(`\n📊 Test results: ${passed} passed / ${failed} failed`);

if (failed > 0) {
  process.exit(1);
}

console.log('✅ Direct builtin tools test complete\n');
