/**
 * Smoke test for calling builtin tools directly.
 *
 * Usage:
 *   npx tsx scripts/test-builtin-tools.ts
 */

import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { tmpdir } from 'node:os';
import process from 'node:process';

import {
  applyPatchTool,
  createToolExecutor,
  editFileTool,
  execTool,
  fileSearchTool,
  grepSearchTool,
  listDirTool,
  readFileTool,
  webFetchTool,
  writeFileTool,
} from '../src/tools/index.js';

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

const tempWorkspace = await mkdtemp(join(process.cwd(), '.tmp-builtin-tools-smoke-'));
const tempWorkspaceName = basename(tempWorkspace);
await writeFile(join(tempWorkspace, 'sample.txt'), 'alpha\nbeta\ngamma\n');

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

await runCase('5. Call listDirTool.execute() directly', async () => {
  const result = await listDirTool.execute({ path: tempWorkspace });

  assert.ok(!result.isError, `expected success, got: ${result.content}`);
  assert.match(result.content, /sample.txt/);
  console.log(result.content.trim());
});

await runCase('6. Call readFileTool through createToolExecutor', async () => {
  const toolExecutor = createToolExecutor([readFileTool]);
  const result = await toolExecutor('read_file', {
    path: join(tempWorkspace, 'sample.txt'),
    startLine: 2,
    endLine: 3,
  });

  assert.ok(!result.isError, `expected success, got: ${result.content}`);
  assert.match(result.content, /beta/);
  assert.match(result.content, /gamma/);
  console.log(result.content.trim());
});

await runCase('7. Call fileSearchTool.execute() directly', async () => {
  const result = await fileSearchTool.execute({ query: `${tempWorkspaceName}/sample.txt` });

  assert.ok(!result.isError, `expected success, got: ${result.content}`);
  assert.match(result.content, /sample.txt/);
  console.log(result.content.trim());
});

await runCase('8. Call grepSearchTool.execute() directly', async () => {
  const result = await grepSearchTool.execute({
    query: 'beta',
    isRegexp: false,
    includePattern: `${tempWorkspaceName}/sample.txt`,
  });

  assert.ok(!result.isError, `expected success, got: ${result.content}`);
  assert.match(result.content, /sample.txt:2: beta/);
  console.log(result.content.trim());
});

await runCase('9. Call applyPatchTool.execute() directly', async () => {
  const result = await applyPatchTool.execute({
    input: `*** Begin Patch\n*** Update File: ${tempWorkspaceName}/sample.txt\n@@\n alpha\n-beta\n+beta-patched\n gamma\n*** End Patch`,
  });

  assert.ok(!result.isError, `expected success, got: ${result.content}`);
  assert.match(result.content, /M .*sample.txt/);

  const verify = await readFileTool.execute({
    path: join(tempWorkspace, 'sample.txt'),
  });
  assert.ok(!verify.isError, `expected success, got: ${verify.content}`);
  assert.match(verify.content, /beta-patched/);
  console.log(result.content.trim());
});

await runCase('10. Call writeFileTool.execute() directly', async () => {
  const result = await writeFileTool.execute({
    path: join(tempWorkspace, 'created.txt'),
    content: 'created\nby write_file\n',
  });

  assert.ok(!result.isError, `expected success, got: ${result.content}`);
  assert.match(result.content, /created: true/);
  console.log(result.content.trim());
});

await runCase('11. Call editFileTool.execute() directly', async () => {
  const result = await editFileTool.execute({
    path: join(tempWorkspace, 'created.txt'),
    oldText: 'write_file',
    newText: 'edit_file',
  });

  assert.ok(!result.isError, `expected success, got: ${result.content}`);
  assert.match(result.content, /replacements: 1/);

  const verify = await readFileTool.execute({
    path: join(tempWorkspace, 'created.txt'),
  });
  assert.ok(!verify.isError, `expected success, got: ${verify.content}`);
  assert.match(verify.content, /edit_file/);
  console.log(result.content.trim());
});

await runCase('12. Call webFetchTool.execute() directly', async () => {
  const server = createServer((req, res) => {
    if (req.url === '/page') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end('<html><body><h1>Smoke</h1><p>web fetch works</p></body></html>');
      return;
    }

    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('missing');
  });

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve());
  });

  const address = server.address();
  assert.ok(address && typeof address !== 'string', 'expected server address');
  const url = `http://127.0.0.1:${address.port}/page`;

  try {
    const result = await webFetchTool.execute({ url, extractMode: 'text', maxChars: 2000 });
    assert.ok(!result.isError, `expected success, got: ${result.content}`);
    assert.match(result.content, /Smoke/);
    assert.match(result.content, /web fetch works/);
    console.log(result.content.trim());
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
});

await rm(tempWorkspace, { recursive: true, force: true });

console.log(`\n📊 Test results: ${passed} passed / ${failed} failed`);

if (failed > 0) {
  process.exit(1);
}

console.log('✅ Direct builtin tools test complete\n');
