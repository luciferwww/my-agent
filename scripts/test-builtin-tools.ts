/**
 * 直接调用 builtin tools 的冒烟测试。
 *
 * 用法：
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

console.log('\n🚀 builtin tools 直接调用测试开始');
console.log(`cwd: ${process.cwd()}`);

await runCase('1. 直接调用 execTool.execute()', async () => {
  const result = await execTool.execute({
    command: 'node -p "process.cwd()"',
    cwd: process.cwd(),
    timeout: 10,
  });

  assert.ok(!result.isError, `expected success, got: ${result.content}`);
  assert.equal(result.content.trim(), process.cwd());
  console.log(`返回目录: ${result.content.trim()}`);
});

await runCase('2. 通过 createToolExecutor 调用 builtin exec', async () => {
  const toolExecutor = createToolExecutor([execTool]);
  const result = await toolExecutor('exec', {
    command: 'node -e "console.log(\'executor-ok\')"',
    timeout: 10,
  });

  assert.ok(!result.isError, `expected success, got: ${result.content}`);
  assert.match(result.content, /executor-ok/);
  console.log(result.content.trim());
});

await runCase('3. 验证 stdout/stderr 合并输出', async () => {
  const result = await execTool.execute({
    command: 'node -e "console.log(\'stdout-line\'); console.error(\'stderr-line\')"',
    timeout: 10,
  });

  assert.ok(!result.isError, `expected success, got: ${result.content}`);
  assert.match(result.content, /stdout-line/);
  assert.match(result.content, /stderr-line/);
  console.log(result.content.trim());
});

await runCase('4. 非零退出码会返回 isError', async () => {
  const result = await execTool.execute({
    command: 'node -e "console.error(\'boom\'); process.exit(2)"',
    timeout: 10,
  });

  assert.equal(result.isError, true);
  assert.match(result.content, /boom/);
  assert.match(result.content, /Process exited with code 2/);
  console.log(result.content.trim());
});

console.log(`\n📊 测试结果：${passed} passed / ${failed} failed`);

if (failed > 0) {
  process.exit(1);
}

console.log('✅ builtin tools 直接调用测试完成\n');
