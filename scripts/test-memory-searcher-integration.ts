/**
 * MemorySearcher integration test.
 *
 * Uses real SQLite + real embedding model to verify hybrid search (vector +
 * keyword), degraded keyword-only mode, score normalization, minScore
 * filtering, maxResults truncation, and FTS syntax error handling.
 *
 * Usage:
 *   npx tsx scripts/test-memory-searcher-integration.ts
 */

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

import { SqliteMemoryStore } from '../src/memory/store/sqlite-store.js';
import { MemorySearcher } from '../src/memory/MemorySearcher.js';
import { MemoryIndexer } from '../src/memory/MemoryIndexer.js';
import { LocalEmbeddingProvider } from '../src/memory/embedding/LocalEmbeddingProvider.js';
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
    path: 'test.md',
    source: 'memory',
    startLine: 1,
    endLine: 10,
    updatedAt: Date.now(),
    ...overrides,
  };
}

// ── setup ──────────────────────────────────────────────────────────────

const tmpDir = await mkdtemp(join(tmpdir(), 'searcher-integration-'));
const provider = new LocalEmbeddingProvider();

// Warm up pipeline once for all tests
console.log('Loading embedding model (first run may download ~90 MB)...');
await provider.embed(['warmup']);
console.log('Model ready.\n');

// ── steps ──────────────────────────────────────────────────────────────

await runStep('Keyword-only search (degraded mode, no embedding provider)', async () => {
  const store = new SqliteMemoryStore(join(tmpDir, 'kw-only.db'));
  const searcher = new MemorySearcher(store, null); // no provider

  store.upsertChunks([
    makeChunk({ id: 'kw1', content: 'Kubernetes cluster management and orchestration' }),
    makeChunk({ id: 'kw2', content: 'Simple web server with Node.js' }),
  ]);

  const results = await searcher.search('Kubernetes');
  assert.ok(results.length >= 1, 'should find keyword match');
  assert.equal(results[0]!.matchType, 'keyword');
  assert.ok(results[0]!.content.includes('Kubernetes'));

  console.log(`  ${results.length} result(s), matchType=${results[0]!.matchType}, score=${results[0]!.score.toFixed(4)}`);
  store.close();
});

await runStep('Vector search returns semantically relevant results', async () => {
  const store = new SqliteMemoryStore(join(tmpDir, 'vec.db'));
  const indexer = new MemoryIndexer(store, provider);
  const searcher = new MemorySearcher(store, provider);

  // Index semantically diverse chunks
  await indexer.indexFile('animals.md', 'Cats are adorable furry pets that love to nap.');
  await indexer.indexFile('finance.md', 'Stock market indices rose sharply in Q4 2025.');
  await indexer.indexFile('pets.md', 'Dogs are loyal companions and enjoy playing fetch.');

  const results = await searcher.search('cute domestic animals', { minScore: 0 });

  assert.ok(results.length >= 2, `should find at least 2 results, got ${results.length}`);

  // Animals/pets should score higher than finance
  const animalPaths = ['animals.md', 'pets.md'];
  const topPaths = results.slice(0, 2).map((r) => r.path);
  const hasAnimalInTop2 = topPaths.some((p) => animalPaths.includes(p));
  assert.ok(hasAnimalInTop2, `top 2 should include animal-related content, got: ${topPaths.join(', ')}`);

  for (const r of results) {
    console.log(`  ${r.path}: score=${r.score.toFixed(4)}, type=${r.matchType}`);
  }

  store.close();
});

await runStep('Hybrid search: chunk matching both keyword and vector gets hybrid type', async () => {
  const store = new SqliteMemoryStore(join(tmpDir, 'hybrid.db'));
  const indexer = new MemoryIndexer(store, provider);
  const searcher = new MemorySearcher(store, provider);

  await indexer.indexFile('target.md', 'Machine learning algorithms for natural language processing.');
  await indexer.indexFile('other.md', 'Cooking recipes for Italian pasta dishes.');

  // Query contains both the keyword "learning" AND is semantically close
  const results = await searcher.search('machine learning', { minScore: 0 });

  assert.ok(results.length >= 1);
  const targetResult = results.find((r) => r.path === 'target.md');
  assert.ok(targetResult, 'target.md should be in results');
  assert.equal(targetResult!.matchType, 'hybrid', 'should be hybrid (matched keyword + vector)');

  // Hybrid score should be higher than keyword-only or vector-only
  const otherResult = results.find((r) => r.path === 'other.md');
  if (otherResult) {
    assert.ok(
      targetResult!.score > otherResult.score,
      `hybrid score (${targetResult!.score.toFixed(4)}) should beat non-hybrid (${otherResult.score.toFixed(4)})`,
    );
  }

  console.log(`  target: score=${targetResult!.score.toFixed(4)}, type=${targetResult!.matchType}`);
  if (otherResult) {
    console.log(`  other:  score=${otherResult.score.toFixed(4)}, type=${otherResult.matchType}`);
  }

  store.close();
});

await runStep('minScore filters low-scoring results', async () => {
  const store = new SqliteMemoryStore(join(tmpDir, 'minscore.db'));
  const indexer = new MemoryIndexer(store, provider);
  const searcher = new MemorySearcher(store, provider);

  await indexer.indexFile('relevant.md', 'TypeScript generics and type inference patterns.');
  await indexer.indexFile('irrelevant.md', 'Cooking spaghetti with tomato sauce and basil.');

  // High minScore should filter out irrelevant content
  const strict = await searcher.search('TypeScript type system', { minScore: 0.5 });
  const loose = await searcher.search('TypeScript type system', { minScore: 0 });

  assert.ok(loose.length >= strict.length, 'loose threshold should return >= strict results');

  // With high threshold, irrelevant content should be filtered out
  if (strict.length > 0) {
    assert.ok(
      strict.every((r) => r.score >= 0.5),
      'all results should meet minScore threshold',
    );
  }

  console.log(`  minScore=0.5: ${strict.length} result(s), minScore=0: ${loose.length} result(s)`);
  store.close();
});

await runStep('maxResults truncates output', async () => {
  const store = new SqliteMemoryStore(join(tmpDir, 'maxresults.db'));
  const indexer = new MemoryIndexer(store, provider);
  const searcher = new MemorySearcher(store, provider);

  // Index many chunks about similar topics
  for (let i = 0; i < 10; i++) {
    await indexer.indexFile(`note-${i}.md`, `Programming language feature number ${i}: generics, closures, and pattern matching.`);
  }

  const results = await searcher.search('programming language features', { maxResults: 3, minScore: 0 });
  assert.ok(results.length <= 3, `should return at most 3 results, got ${results.length}`);

  // Should be sorted by score descending
  for (let i = 1; i < results.length; i++) {
    assert.ok(
      results[i - 1]!.score >= results[i]!.score,
      `results should be sorted: ${results[i - 1]!.score} >= ${results[i]!.score}`,
    );
  }

  console.log(`  returned ${results.length} result(s) (max 3), sorted by score`);
  store.close();
});

await runStep('FTS syntax errors handled gracefully (C++, key:value)', async () => {
  const store = new SqliteMemoryStore(join(tmpDir, 'fts-safe.db'));
  const indexer = new MemoryIndexer(store, provider);
  const searcher = new MemorySearcher(store, provider);

  await indexer.indexFile('cpp.md', 'C++ template metaprogramming and compile-time evaluation.');

  // These queries contain FTS5 syntax characters — should not crash
  const problematicQueries = ['C++ templates', 'key:value pairs', '"unbalanced quote'];

  for (const q of problematicQueries) {
    const results = await searcher.search(q, { minScore: 0 });
    // Should return results (via vector fallback) or empty array — never throw
    console.log(`  "${q}" → ${results.length} result(s)`);
  }

  store.close();
});

// ── cleanup ────────────────────────────────────────────────────────────

await rm(tmpDir, { recursive: true, force: true });

// ── summary ────────────────────────────────────────────────────────────

console.log(`\n${'='.repeat(72)}`);
console.log(`Results: ${passed} passed / ${failed} failed`);
console.log('='.repeat(72));

if (failed > 0) process.exit(1);
