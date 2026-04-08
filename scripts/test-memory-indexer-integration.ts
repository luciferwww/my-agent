/**
 * MemoryIndexer integration test.
 *
 * Uses real filesystem + real SQLite (no mocks) to verify chunking logic,
 * hash-based deduplication, incremental re-indexing, and indexAll() directory
 * traversal. Embedding provider is omitted to focus on chunking behavior.
 *
 * Usage:
 *   npx tsx scripts/test-memory-indexer-integration.ts
 */

import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

import { SqliteMemoryStore } from '../src/memory/store/sqlite-store.js';
import { MemoryIndexer } from '../src/memory/MemoryIndexer.js';

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

/**
 * Generate multi-line text of approximately `charCount` characters.
 * Each line is ~80 characters for realistic Markdown-like content.
 */
function generateText(charCount: number): string {
  const line = 'Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod.\n';
  const count = Math.ceil(charCount / line.length);
  return Array(count).fill(line).join('');
}

// ── setup ──────────────────────────────────────────────────────────────

const tmpDir = await mkdtemp(join(tmpdir(), 'indexer-integration-'));
const dbPath = join(tmpDir, 'test.db');
const store = new SqliteMemoryStore(dbPath);
const indexer = new MemoryIndexer(store, null); // no embedding provider

// ── steps ──────────────────────────────────────────────────────────────

await runStep('Small file → single chunk', async () => {
  const content = 'Short memory note.\nJust two lines.';
  await indexer.indexFile('small.md', content);

  const results = store.searchByKeyword('memory', 10);
  assert.equal(results.length, 1, 'should produce exactly 1 chunk');
  assert.equal(results[0]!.path, 'small.md');
  assert.equal(results[0]!.startLine, 1);
  assert.ok(results[0]!.content.includes('Short memory note'));

  console.log(`  1 chunk, lines ${results[0]!.startLine}-${results[0]!.endLine}`);
});

await runStep('Large file → multiple chunks with overlap', async () => {
  // ~5000 chars → should produce multiple chunks (chunkChars=1600, overlap=320)
  const content = generateText(5000);
  await indexer.indexFile('large.md', content);

  // Search for a word that appears in every line
  const results = store.searchByKeyword('Lorem', 50);
  const largeChunks = results.filter((r) => r.path === 'large.md');

  assert.ok(largeChunks.length >= 3, `expected >= 3 chunks for ~5000 chars, got ${largeChunks.length}`);

  // Verify overlap: second chunk's startLine should be less than first chunk's endLine
  const sorted = [...largeChunks].sort((a, b) => a.startLine - b.startLine);
  if (sorted.length >= 2) {
    assert.ok(
      sorted[1]!.startLine <= sorted[0]!.endLine,
      `chunks should overlap: chunk2.start (${sorted[1]!.startLine}) should be <= chunk1.end (${sorted[0]!.endLine})`,
    );
  }

  console.log(`  ${largeChunks.length} chunks, overlap verified`);
  for (const c of sorted) {
    console.log(`    lines ${c.startLine}-${c.endLine} (${c.content.length} chars)`);
  }
});

await runStep('Line boundaries preserved (no mid-line breaks)', async () => {
  // Create a file with distinct lines of varying length
  const lines = [
    '# Title',
    '',
    'First paragraph with some content here.',
    'Second line of the first paragraph.',
    '',
    'Another paragraph starts here.',
  ];
  const content = lines.join('\n');
  await indexer.indexFile('lines.md', content);

  const results = store.searchByKeyword('paragraph', 10);
  const lineChunks = results.filter((r) => r.path === 'lines.md');
  assert.ok(lineChunks.length >= 1);

  // Every chunk's content should consist of complete lines
  for (const chunk of lineChunks) {
    const chunkLines = chunk.content.split('\n');
    for (const line of chunkLines) {
      // Each line in the chunk should be a complete line from the original
      assert.ok(
        lines.includes(line) || line.trim() === '',
        `chunk contains partial line: "${line}"`,
      );
    }
  }

  console.log('  all chunk boundaries aligned to line boundaries');
});

await runStep('Hash deduplication: unchanged file skips re-index', async () => {
  const content = 'Unique dedup content for testing.';
  await indexer.indexFile('dedup.md', content);

  // Record file info
  const info1 = store.getFile('dedup.md');
  assert.ok(info1);
  const mtime1 = info1.mtime;

  // Wait a bit and re-index with same content
  await new Promise((r) => setTimeout(r, 10));
  await indexer.indexFile('dedup.md', content);

  // mtime should NOT have changed (file was skipped)
  const info2 = store.getFile('dedup.md');
  assert.ok(info2);
  assert.equal(info2.mtime, mtime1, 'mtime should not change for unchanged file');

  console.log('  unchanged file correctly skipped');
});

await runStep('Content change triggers re-index', async () => {
  const content1 = 'Original content about apples.';
  await indexer.indexFile('changing.md', content1);

  let results = store.searchByKeyword('apples', 10);
  assert.ok(results.some((r) => r.path === 'changing.md'), 'should find original content');

  // Update content
  const content2 = 'Updated content about bananas.';
  await indexer.indexFile('changing.md', content2);

  // Old keyword gone
  results = store.searchByKeyword('apples', 10);
  assert.ok(!results.some((r) => r.path === 'changing.md'), 'old content should be gone');

  // New keyword found
  results = store.searchByKeyword('bananas', 10);
  assert.ok(results.some((r) => r.path === 'changing.md'), 'new content should be found');

  console.log('  content change detected and re-indexed');
});

await runStep('indexAll() discovers MEMORY.md + memory/*.md', async () => {
  // Create a workspace structure
  const workspace = join(tmpDir, 'workspace');
  await mkdir(join(workspace, 'memory'), { recursive: true });
  await writeFile(join(workspace, 'MEMORY.md'), 'Long-term goals and priorities.');
  await writeFile(join(workspace, 'memory', '2026-04-07.md'), 'Daily note about debugging.');
  await writeFile(join(workspace, 'memory', '2026-04-08.md'), 'Daily note about integration tests.');
  // This file should be ignored (not .md)
  await writeFile(join(workspace, 'memory', 'notes.txt'), 'This should be ignored.');
  // This file should be ignored (not in memory/)
  await writeFile(join(workspace, 'README.md'), 'Project readme.');

  // Fresh store for clean indexAll test
  const store2 = new SqliteMemoryStore(join(tmpDir, 'indexall.db'));
  const indexer2 = new MemoryIndexer(store2, null);

  await indexer2.indexAll(workspace);

  // Verify MEMORY.md indexed
  const memFile = store2.getFile('MEMORY.md');
  assert.ok(memFile, 'MEMORY.md should be indexed');

  // Verify daily notes indexed
  const daily1 = store2.getFile('memory/2026-04-07.md');
  const daily2 = store2.getFile('memory/2026-04-08.md');
  assert.ok(daily1, 'memory/2026-04-07.md should be indexed');
  assert.ok(daily2, 'memory/2026-04-08.md should be indexed');

  // Verify searchable
  const results = store2.searchByKeyword('debugging', 10);
  assert.ok(results.some((r) => r.path === 'memory/2026-04-07.md'));

  const results2 = store2.searchByKeyword('priorities', 10);
  assert.ok(results2.some((r) => r.path === 'MEMORY.md'));

  // Verify non-.md and non-memory files NOT indexed
  assert.equal(store2.getFile('memory/notes.txt'), undefined, 'non-.md files should be ignored');
  assert.equal(store2.getFile('README.md'), undefined, 'files outside memory scope should be ignored');

  store2.close();
  console.log('  MEMORY.md + 2 daily notes indexed, non-memory files ignored');
});

await runStep('Path isolation: deleteByPath affects only target', async () => {
  // Setup two files
  await indexer.indexFile('fileA.md', 'Alpha content about rockets.');
  await indexer.indexFile('fileB.md', 'Beta content about rockets.');

  // Both searchable
  let results = store.searchByKeyword('rockets', 10);
  assert.ok(results.some((r) => r.path === 'fileA.md'));
  assert.ok(results.some((r) => r.path === 'fileB.md'));

  // Remove only fileA
  indexer.removeFile('fileA.md');

  // fileA gone, fileB remains
  results = store.searchByKeyword('rockets', 10);
  assert.ok(!results.some((r) => r.path === 'fileA.md'), 'fileA should be removed');
  assert.ok(results.some((r) => r.path === 'fileB.md'), 'fileB should remain');
  assert.equal(store.getFile('fileA.md'), undefined, 'fileA metadata should be removed');
  assert.ok(store.getFile('fileB.md'), 'fileB metadata should remain');

  console.log('  path isolation verified');
});

// ── cleanup ────────────────────────────────────────────────────────────

store.close();
await rm(tmpDir, { recursive: true, force: true });

// ── summary ────────────────────────────────────────────────────────────

console.log(`\n${'='.repeat(72)}`);
console.log(`Results: ${passed} passed / ${failed} failed`);
console.log('='.repeat(72));

if (failed > 0) process.exit(1);
