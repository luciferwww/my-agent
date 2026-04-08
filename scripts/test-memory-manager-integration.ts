/**
 * MemoryManager end-to-end integration test.
 *
 * Uses real filesystem + real SQLite, no embedding provider (degraded mode)
 * to keep the test fast. Verifies the full create → write → search → read →
 * reindex → recall-tracking pipeline.
 *
 * Usage:
 *   npx tsx scripts/test-memory-manager-integration.ts
 */

import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

import { MemoryManager } from '../src/memory/MemoryManager.js';

// ── helpers ────────────────────────────────────────────────────────────

type AsyncStep = () => Promise<void>;

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

/** Wait for async fire-and-forget operations to flush. */
function settle(ms = 200): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ── setup ──────────────────────────────────────────────────────────────

const workspace = await mkdtemp(join(tmpdir(), 'manager-integration-'));
await mkdir(join(workspace, 'memory'), { recursive: true });

// Seed initial files
await writeFile(
  join(workspace, 'MEMORY.md'),
  '# Project Memory\n\n- Goal: build an AI agent framework\n- Language: TypeScript\n- Runtime: Node.js 22\n',
);
await writeFile(
  join(workspace, 'memory', '2026-04-07.md'),
  '## 2026-04-07\n\n- Implemented SQLite store\n- Added FTS5 keyword search\n',
);

// Create manager with disabled embedding (degraded mode — fast)
const manager = await MemoryManager.create({
  workspaceDir: workspace,
  embedding: { provider: 'openai' }, // unsupported → returns null → degraded mode
});

// ── steps ──────────────────────────────────────────────────────────────

await runStep('create() initialises and indexes existing files', async () => {
  // Should have indexed the seed files on creation
  const results = await manager.search('TypeScript');

  assert.ok(results.length >= 1, 'should find seed content');
  assert.ok(
    results.some((r) => r.path === 'MEMORY.md'),
    'MEMORY.md should be indexed',
  );
  assert.equal(results[0]!.matchType, 'keyword', 'degraded mode should use keyword search');

  console.log(`  found ${results.length} result(s), matchType=${results[0]!.matchType}`);
});

await runStep('search() finds content from daily notes', async () => {
  const results = await manager.search('SQLite');

  assert.ok(results.length >= 1, 'should find daily note content');
  assert.ok(
    results.some((r) => r.path === 'memory/2026-04-07.md'),
    'daily note should be indexed',
  );

  console.log(`  path=${results[0]!.path}, score=${results[0]!.score.toFixed(4)}`);
});

await runStep('writeFile (overwrite) + immediate search', async () => {
  await manager.writeFile('memory/2026-04-08.md', '## 2026-04-08\n\n- Added embedding integration tests\n- Verified cosine similarity\n', 'overwrite');

  const results = await manager.search('cosine similarity');
  assert.ok(results.length >= 1, 'newly written content should be searchable immediately');
  assert.ok(
    results.some((r) => r.path === 'memory/2026-04-08.md'),
    'new file should appear in results',
  );

  console.log(`  write + search roundtrip verified`);
});

await runStep('writeFile (append) preserves old content', async () => {
  await manager.writeFile('memory/2026-04-08.md', '- Also fixed FTS special character handling\n', 'append');

  // Old content still searchable
  const oldResults = await manager.search('cosine');
  assert.ok(
    oldResults.some((r) => r.path === 'memory/2026-04-08.md'),
    'old content should still be searchable after append',
  );

  // New content also searchable
  const newResults = await manager.search('FTS special character');
  assert.ok(
    newResults.some((r) => r.path === 'memory/2026-04-08.md'),
    'appended content should be searchable',
  );

  console.log('  append preserved old content and indexed new content');
});

await runStep('readFile: full file', async () => {
  const content = await manager.readFile('MEMORY.md');

  assert.ok(content.includes('Project Memory'), 'should read full file content');
  assert.ok(content.includes('TypeScript'), 'should include all lines');

  console.log(`  read ${content.length} chars`);
});

await runStep('readFile: line range', async () => {
  const fullContent = await manager.readFile('MEMORY.md');
  const lines = fullContent.split('\n');

  // Read lines 3-4 (1-based)
  const partial = await manager.readFile('MEMORY.md', 3, 2);
  const partialLines = partial.split('\n');

  assert.equal(partialLines.length, 2, 'should return exactly 2 lines');
  assert.equal(partialLines[0], lines[2], 'line 3 should match');
  assert.equal(partialLines[1], lines[3], 'line 4 should match');

  console.log(`  lines 3-4: "${partial.slice(0, 60)}..."`);
});

await runStep('reindex() picks up external file changes', async () => {
  // Modify a file externally (simulating user edit outside the agent)
  await writeFile(
    join(workspace, 'MEMORY.md'),
    '# Project Memory\n\n- Goal: build an AI agent framework\n- Language: TypeScript\n- Runtime: Node.js 22\n- Database: PostgreSQL for production\n',
  );

  // Before reindex, old content is still what's indexed
  await manager.reindex();

  // After reindex, new content should be searchable
  const results = await manager.search('PostgreSQL');
  assert.ok(results.length >= 1, 'externally modified content should be found after reindex');
  assert.ok(results.some((r) => r.path === 'MEMORY.md'));

  console.log('  external file change detected and re-indexed');
});

await runStep('RecallTracker creates JSONL log after search', async () => {
  // Trigger a search to generate recall entries
  await manager.search('testing');
  // Wait for fire-and-forget async write
  await settle(300);

  const recallDir = join(workspace, '.agent', 'memory', '.recalls');
  let files: string[] = [];
  try {
    files = await readdir(recallDir);
  } catch {
    // directory may not exist if recall failed
  }

  assert.ok(files.length > 0, 'recall directory should contain log files');

  const logPath = join(recallDir, files[0]!);
  const logContent = await readFile(logPath, 'utf-8');
  const logLines = logContent.trim().split('\n').filter(Boolean);

  assert.ok(logLines.length >= 1, 'recall log should have entries');

  // Each line should be valid JSON
  for (const line of logLines) {
    const entry = JSON.parse(line);
    assert.ok(entry.query, 'entry should have query field');
    assert.ok(entry.timestamp, 'entry should have timestamp field');
    assert.ok(Array.isArray(entry.results), 'entry should have results array');
  }

  console.log(`  ${logLines.length} recall entries in ${files[0]}`);
});

await runStep('Degraded mode: no embedding provider → keyword-only', async () => {
  // All searches so far should have been keyword-only
  const results = await manager.search('TypeScript framework');

  for (const r of results) {
    assert.equal(r.matchType, 'keyword', `matchType should be keyword in degraded mode, got ${r.matchType}`);
  }

  console.log(`  all ${results.length} result(s) are keyword-only as expected`);
});

// ── cleanup ────────────────────────────────────────────────────────────

manager.close();
await rm(workspace, { recursive: true, force: true });

// ── summary ────────────────────────────────────────────────────────────

console.log(`\n${'='.repeat(72)}`);
console.log(`Results: ${passed} passed / ${failed} failed`);
console.log('='.repeat(72));

if (failed > 0) process.exit(1);
