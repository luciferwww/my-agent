/**
 * Builtin tools integration test.
 *
 * Verifies that the exported builtin tools can be wired through a single
 * ToolExecutor and complete a realistic file-edit + command + web workflow.
 *
 * Usage:
 *   npx tsx scripts/test-builtin-tools-integration.ts
 */

import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import process from 'node:process';

import {
  applyPatchTool,
  createToolExecutor,
  editFileTool,
  execTool,
  fileSearchTool,
  getToolDefinitions,
  grepSearchTool,
  listDirTool,
  processTool,
  readFileTool,
  webFetchTool,
  writeFileTool,
} from '../src/tools/index.js';
import type { Tool } from '../src/tools/index.js';

type AsyncStep = () => Promise<void>;

const tools: Tool[] = [
  listDirTool,
  readFileTool,
  fileSearchTool,
  grepSearchTool,
  applyPatchTool,
  writeFileTool,
  editFileTool,
  execTool,
  processTool,
  webFetchTool,
];

const executor = createToolExecutor(tools);

let backgroundRunId: string | undefined;

let passed = 0;
let failed = 0;

async function runStep(name: string, step: AsyncStep): Promise<void> {
  console.log(`\n${'-'.repeat(72)}`);
  console.log(`STEP: ${name}`);
  console.log('-'.repeat(72));

  try {
    await step();
    passed += 1;
    console.log(`OK: ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`FAILED: ${name}`);
    console.error(error instanceof Error ? error.message : String(error));
  }
}

async function waitForBackgroundRunToFinish(runId: string, timeoutMs = 3000): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const status = await executor('process', { action: 'status', runId });
    if (status.isError) {
      throw new Error(status.content);
    }

    if (/status: (completed|failed|timed_out|aborted)/.test(status.content)) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  throw new Error(`Timed out waiting for background process ${runId} to finish`);
}

console.log('\n🧪 Builtin tools integration test');

const workspaceDir = await mkdtemp(join(process.cwd(), '.tmp-builtin-integration-'));
const workspaceName = basename(workspaceDir);

await mkdir(join(workspaceDir, 'src'), { recursive: true });
await writeFile(
  join(workspaceDir, 'src', 'main.ts'),
  ['export function greet(name: string) {', '  return `hello ${name}`;', '}', ''].join('\n'),
  'utf8',
);

await runStep('tool definitions include builtin workflow tools', async () => {
  const defs = getToolDefinitions(tools);
  const names = defs.map((tool) => tool.name);
  assert.deepEqual(names, [
    'list_dir',
    'read_file',
    'file_search',
    'grep_search',
    'apply_patch',
    'write_file',
    'edit_file',
    'exec',
    'process',
    'web_fetch',
  ]);
});

await runStep('list_dir discovers workspace structure', async () => {
  const result = await executor('list_dir', { path: workspaceName });
  assert.ok(!result.isError, result.content);
  assert.match(result.content, /src\//);
});

await runStep('file_search finds target source file', async () => {
  const result = await executor('file_search', { query: `${workspaceName}/src/main.ts` });
  assert.ok(!result.isError, result.content);
  assert.match(result.content, /src\/main\.ts/);
});

await runStep('grep_search locates the old implementation', async () => {
  const result = await executor('grep_search', {
    query: 'hello',
    isRegexp: false,
    includePattern: `${workspaceName}/src/*.ts`,
  });
  assert.ok(!result.isError, result.content);
  assert.match(result.content, /src\/main\.ts:2:/);
});

await runStep('read_file returns the current implementation', async () => {
  const result = await executor('read_file', {
    path: join(workspaceDir, 'src', 'main.ts'),
    startLine: 1,
    endLine: 3,
  });
  assert.ok(!result.isError, result.content);
  assert.match(result.content, /return `hello/);
});

await runStep('apply_patch updates the implementation', async () => {
  const result = await executor('apply_patch', {
    input: [
      '*** Begin Patch',
      `*** Update File: ${workspaceName}/src/main.ts`,
      '@@',
      ' export function greet(name: string) {',
      '-  return `hello ${name}`;',
      '+  return `hello, ${name}!`;',
      ' }',
      '*** End Patch',
    ].join('\n'),
  });
  assert.ok(!result.isError, result.content);
  assert.match(result.content, /M .*src\/main\.ts/);
});

await runStep('write_file creates a companion file', async () => {
  const result = await executor('write_file', {
    path: join(workspaceDir, 'README.generated.md'),
    content: '# Generated\nThis file was created by write_file.\n',
  });
  assert.ok(!result.isError, result.content);
  assert.match(result.content, /created: true/);
});

await runStep('edit_file performs a precise single replacement', async () => {
  const result = await executor('edit_file', {
    path: join(workspaceDir, 'README.generated.md'),
    oldText: 'write_file',
    newText: 'edit_file',
  });
  assert.ok(!result.isError, result.content);
  assert.match(result.content, /replacements: 1/);
});

await runStep('exec verifies the modified code', async () => {
  const result = await executor('exec', {
    command: 'node -e "import(\'./src/main.ts\').then((m) => console.log(m.greet(\'Ada\')))"',
    cwd: workspaceDir,
    timeout: 10,
  });
  assert.ok(!result.isError, result.content);
  assert.match(result.content, /hello, Ada!/i);
});

await runStep('exec background and process status work together', async () => {
  const started = await executor('exec', {
    command: 'node -e "setTimeout(() => console.log(\'background-finished\'), 120)"',
    cwd: workspaceDir,
    background: true,
  });
  assert.ok(!started.isError, started.content);
  const runIdMatch = started.content.match(/runId:\s*(\S+)/);
  assert.ok(runIdMatch, started.content);
  const runId = runIdMatch[1]!;
  backgroundRunId = runId;

  const status = await executor('process', { action: 'status', runId });
  assert.ok(!status.isError, status.content);
  assert.match(status.content, new RegExp(`runId: ${runId}`));
});

await runStep('web_fetch retrieves readable remote content', async () => {
  const server = createServer((req, res) => {
    if (req.url === '/doc') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end('<html><body><h1>Integration</h1><p>builtin tools workflow</p></body></html>');
      return;
    }

    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('missing');
  });

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve());
  });

  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const url = `http://127.0.0.1:${address.port}/doc`;

  try {
    const result = await executor('web_fetch', { url, extractMode: 'text', maxChars: 2000 });
    assert.ok(!result.isError, result.content);
    assert.match(result.content, /Integration/);
    assert.match(result.content, /builtin tools workflow/);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
});

if (backgroundRunId) {
  await waitForBackgroundRunToFinish(backgroundRunId);
}

await rm(workspaceDir, { recursive: true, force: true });

console.log(`\n📊 Integration results: ${passed} passed / ${failed} failed`);

if (failed > 0) {
  process.exit(1);
}

console.log('✅ Builtin tools integration workflow complete\n');