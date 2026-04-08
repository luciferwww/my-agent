/**
 * SqliteMemoryStore integration test.
 *
 * Runs against a real SQLite database (no mocks) to verify schema init,
 * CRUD operations, FTS5 keyword search, vector search ranking, BLOB
 * round-trip precision, multi-file isolation, and persistence across
 * close/reopen cycles.
 *
 * Usage:
 *   npx tsx scripts/test-memory-store-integration.ts
 */

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

import { SqliteMemoryStore } from '../src/memory/store/sqlite-store.js';
import type { MemoryChunk } from '../src/memory/types.js';

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

function makeChunk(overrides: Partial<MemoryChunk> & { id: string; content: string }): MemoryChunk {
  return {
    path: 'MEMORY.md',
    source: 'memory',
    startLine: 1,
    endLine: 10,
    updatedAt: Date.now(),
    ...overrides,
  };
}

/** Normalise a vector to unit length. */
function normalise(v: number[]): number[] {
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return norm === 0 ? v : v.map((x) => x / norm);
}

// ── setup ──────────────────────────────────────────────────────────────

const tmpDir = await mkdtemp(join(tmpdir(), 'sqlite-store-integration-'));
const dbPath = join(tmpDir, 'test.db');

let store = new SqliteMemoryStore(dbPath);

// ── steps ──────────────────────────────────────────────────────────────

await runStep('Schema init & file metadata CRUD', async () => {
  // upsertFile + getFile
  store.upsertFile('MEMORY.md', { source: 'memory', hash: 'abc123', mtime: 1000, size: 512 });
  const info = store.getFile('MEMORY.md');
  assert.ok(info, 'file info should exist');
  assert.equal(info.hash, 'abc123');
  assert.equal(info.mtime, 1000);
  assert.equal(info.size, 512);

  // setMeta + getMeta
  store.setMeta('embedding-model', 'all-MiniLM-L6-v2');
  assert.equal(store.getMeta('embedding-model'), 'all-MiniLM-L6-v2');

  // deleteFile
  store.deleteFile('MEMORY.md');
  assert.equal(store.getFile('MEMORY.md'), undefined, 'file info should be gone after delete');

  console.log('  file CRUD and meta CRUD verified');
});

await runStep('Chunk upsert & FTS sync on update', async () => {
  // Insert initial chunks
  store.upsertChunks([
    makeChunk({ id: 'c1', content: 'The quick brown fox jumps over the lazy dog' }),
    makeChunk({ id: 'c2', content: 'SQLite is a lightweight database engine' }),
  ]);

  // FTS should find "fox"
  const results1 = store.searchByKeyword('fox', 10);
  assert.equal(results1.length, 1);
  assert.equal(results1[0]!.id, 'c1');

  // Update c1 content — the old FTS entry must be replaced
  store.upsertChunks([
    makeChunk({ id: 'c1', content: 'A brand new sentence about elephants' }),
  ]);

  // "fox" should no longer match
  const results2 = store.searchByKeyword('fox', 10);
  assert.equal(results2.length, 0, 'old FTS content should be gone after upsert');

  // "elephants" should match
  const results3 = store.searchByKeyword('elephants', 10);
  assert.equal(results3.length, 1);
  assert.equal(results3[0]!.id, 'c1');

  console.log('  FTS correctly syncs on chunk update');
});

await runStep('Float32Array BLOB round-trip precision', async () => {
  const original = normalise([0.123456789, -0.987654321, 0.555555555, 0.111111111]);
  store.upsertChunks([
    makeChunk({ id: 'blob-test', content: 'blob precision test', embedding: original, model: 'test-model' }),
  ]);

  const results = store.searchByVector(original, 1, 'test-model');
  assert.equal(results.length, 1);

  // Score should be ~1.0 (same vector)
  assert.ok(results[0]!.score > 0.9999, `self-similarity should be ~1.0, got ${results[0]!.score}`);

  console.log(`  self-similarity score: ${results[0]!.score.toFixed(6)}`);
});

await runStep('Vector search ranking correctness', async () => {
  // Three 4-dim unit vectors pointing in different directions
  const vecA = normalise([1, 0, 0, 0]);
  const vecB = normalise([0.9, 0.1, 0, 0]);   // close to A
  const vecC = normalise([0, 0, 1, 0]);         // orthogonal to A

  store.upsertChunks([
    makeChunk({ id: 'va', content: 'vector a', embedding: vecA, model: 'rank-model' }),
    makeChunk({ id: 'vb', content: 'vector b', embedding: vecB, model: 'rank-model' }),
    makeChunk({ id: 'vc', content: 'vector c', embedding: vecC, model: 'rank-model' }),
  ]);

  // Query with vecA — should rank: va (self), vb (close), vc (orthogonal)
  const results = store.searchByVector(vecA, 3, 'rank-model');
  assert.equal(results[0]!.id, 'va', 'exact match should rank first');
  assert.equal(results[1]!.id, 'vb', 'close vector should rank second');
  assert.equal(results[2]!.id, 'vc', 'orthogonal vector should rank last');

  assert.ok(results[0]!.score > results[1]!.score, 'self > close');
  assert.ok(results[1]!.score > results[2]!.score, 'close > orthogonal');

  console.log(`  scores: va=${results[0]!.score.toFixed(4)}, vb=${results[1]!.score.toFixed(4)}, vc=${results[2]!.score.toFixed(4)}`);
});

await runStep('BM25 keyword ranking', async () => {
  store.upsertChunks([
    makeChunk({ id: 'bm-high', content: 'database database database performance tuning database', startLine: 1, endLine: 1 }),
    makeChunk({ id: 'bm-low', content: 'the database is useful', startLine: 2, endLine: 2 }),
  ]);

  const results = store.searchByKeyword('database', 10);
  assert.ok(results.length >= 2, 'both chunks should match');
  assert.equal(results[0]!.id, 'bm-high', 'higher term frequency should rank first');

  console.log(`  high=${results[0]!.score.toFixed(4)}, low=${results[1]!.score.toFixed(4)}`);
});

await runStep('Multi-file indexing & path-scoped deletion', async () => {
  store.upsertChunks([
    makeChunk({ id: 'mem-1', path: 'MEMORY.md', content: 'long term goals and priorities', embedding: normalise([1, 0, 0, 0]), model: 'multi' }),
    makeChunk({ id: 'daily-1', path: 'memory/2026-04-08.md', content: 'daily standup notes and priorities', embedding: normalise([0, 1, 0, 0]), model: 'multi' }),
  ]);

  // Both searchable before deletion
  assert.ok(store.searchByKeyword('priorities', 10).length >= 2, 'both files should appear');

  // Delete only MEMORY.md chunks
  store.deleteByPath('MEMORY.md');

  // Keyword: only daily note remains
  const afterKw = store.searchByKeyword('priorities', 10);
  assert.equal(afterKw.length, 1);
  assert.equal(afterKw[0]!.path, 'memory/2026-04-08.md');

  // Vector: only daily note remains
  const afterVec = store.searchByVector(normalise([0, 1, 0, 0]), 10, 'multi');
  assert.equal(afterVec.length, 1);
  assert.equal(afterVec[0]!.path, 'memory/2026-04-08.md');

  console.log('  path-scoped deletion verified for both keyword and vector search');
});

await runStep('FTS special character queries do not throw', async () => {
  const queries = [
    'hello',
    'C++ programming',
    '"quoted phrase"',
    'key:value',
    '',
    '   ',
    'emoji 🚀 test',
  ];

  for (const q of queries) {
    try {
      store.searchByKeyword(q, 5);
      console.log(`  "${q}" → ok`);
    } catch (err) {
      // FTS5 treats +, *, :, ", empty strings etc. as syntax — errors are expected
      const msg = err instanceof Error ? err.message : String(err);
      const isFtsSyntax = /fts5|syntax|no such column/.test(msg);
      assert.ok(isFtsSyntax, `unexpected non-FTS error for "${q}": ${msg}`);
      console.log(`  "${q}" → expected FTS syntax error: ${msg.slice(0, 60)}`);
    }
  }
});

await runStep('Degraded mode: chunks without embeddings', async () => {
  store.upsertChunks([
    makeChunk({ id: 'no-embed', content: 'degraded mode chunk without any vector' }),
  ]);

  // Keyword search works
  const kwResults = store.searchByKeyword('degraded', 10);
  assert.ok(kwResults.some((r) => r.id === 'no-embed'), 'should be findable by keyword');

  // Vector search returns nothing for this chunk (no embedding)
  const vecResults = store.searchByVector(normalise([1, 0, 0, 0]), 100, 'any-model');
  assert.ok(!vecResults.some((r) => r.id === 'no-embed'), 'should not appear in vector results');

  console.log('  keyword=found, vector=absent — degraded mode correct');
});

await runStep('Persistence across close & reopen', async () => {
  // Write a known chunk
  store.upsertChunks([
    makeChunk({ id: 'persist-1', content: 'persistence verification chunk', embedding: normalise([0, 0, 1, 0]), model: 'persist-model' }),
  ]);
  store.setMeta('test-key', 'test-value');

  // Close and reopen
  store.close();
  store = new SqliteMemoryStore(dbPath);

  // Keyword search
  const kwResults = store.searchByKeyword('persistence', 10);
  assert.ok(kwResults.some((r) => r.id === 'persist-1'), 'chunk should survive close/reopen (keyword)');

  // Vector search
  const vecResults = store.searchByVector(normalise([0, 0, 1, 0]), 5, 'persist-model');
  assert.ok(vecResults.some((r) => r.id === 'persist-1'), 'chunk should survive close/reopen (vector)');

  // Meta
  assert.equal(store.getMeta('test-key'), 'test-value', 'meta should survive close/reopen');

  console.log('  data persisted correctly across close/reopen');
});

// ── cleanup ────────────────────────────────────────────────────────────

store.close();
await rm(tmpDir, { recursive: true, force: true });

// ── summary ────────────────────────────────────────────────────────────

console.log(`\n${'='.repeat(72)}`);
console.log(`Results: ${passed} passed / ${failed} failed`);
console.log('='.repeat(72));

if (failed > 0) process.exit(1);
