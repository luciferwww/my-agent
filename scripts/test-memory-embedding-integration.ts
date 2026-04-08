/**
 * LocalEmbeddingProvider integration test.
 *
 * Runs the real Xenova/all-MiniLM-L6-v2 model (no mocks) to verify embedding
 * quality, dimensional correctness, and pipeline caching behaviour.
 *
 * First run downloads the model (~90 MB) to ~/.cache/huggingface/.
 *
 * Usage:
 *   npx tsx scripts/test-local-embedding-integration.ts
 */

import assert from 'node:assert/strict';
import process from 'node:process';

import { LocalEmbeddingProvider } from '../src/memory/embedding/LocalEmbeddingProvider.js';

// ── helpers ────────────────────────────────────────────────────────────

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    normA += a[i]! * a[i]!;
    normB += b[i]! * b[i]!;
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

function l2norm(v: number[]): number {
  return Math.sqrt(v.reduce((sum, x) => sum + x * x, 0));
}

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

// ── shared provider (pipeline loaded once, reused across steps) ────────

const provider = new LocalEmbeddingProvider();

// ── steps ──────────────────────────────────────────────────────────────

await runStep('Model loading & basic embedding', async () => {
  const result = await provider.embed(['Hello world']);

  assert.equal(result.length, 1, 'should return exactly 1 vector');
  assert.equal(result[0]!.length, 384, 'vector dimension should be 384');

  const norm = l2norm(result[0]!);
  assert.ok(
    Math.abs(norm - 1.0) < 0.01,
    `vector should be L2-normalised (norm=${norm.toFixed(4)})`,
  );

  console.log(`  vector dimension: ${result[0]!.length}`);
  console.log(`  L2 norm: ${norm.toFixed(6)}`);
});

await runStep('Semantic similarity ordering', async () => {
  const textA = 'The cat sat on the mat';
  const textB = 'A kitten rested on the rug';
  const textC = 'Stock markets rose sharply today';

  const [vecA, vecB, vecC] = await provider.embed([textA, textB, textC]);

  const simAB = cosine(vecA!, vecB!);
  const simAC = cosine(vecA!, vecC!);

  console.log(`  sim(A, B) = ${simAB.toFixed(4)}  (cat ↔ kitten)`);
  console.log(`  sim(A, C) = ${simAC.toFixed(4)}  (cat ↔ stock market)`);

  assert.ok(
    simAB > simAC,
    `semantically similar texts should score higher: sim(A,B)=${simAB.toFixed(4)} vs sim(A,C)=${simAC.toFixed(4)}`,
  );
});

await runStep('Batch embedding consistency', async () => {
  const target = 'Transformers are great for NLP tasks';

  const [solo] = await provider.embed([target]);
  const batch = await provider.embed(['irrelevant prefix', target, 'irrelevant suffix']);
  const fromBatch = batch[1]!;

  assert.equal(solo!.length, fromBatch.length, 'dimensions should match');

  // 逐元素比较
  for (let i = 0; i < solo!.length; i++) {
    assert.ok(
      Math.abs(solo![i]! - fromBatch[i]!) < 1e-6,
      `mismatch at index ${i}: ${solo![i]} vs ${fromBatch[i]}`,
    );
  }

  console.log('  solo vs batch vectors: identical');
});

await runStep('Empty input returns empty array', async () => {
  const result = await provider.embed([]);
  assert.deepEqual(result, []);
  console.log('  embed([]) → []');
});

await runStep('Long text does not throw', async () => {
  const longText = 'A'.repeat(3000);
  const result = await provider.embed([longText]);

  assert.equal(result.length, 1, 'should return 1 vector');
  assert.equal(result[0]!.length, 384, 'dimension should still be 384');

  const norm = l2norm(result[0]!);
  assert.ok(
    Math.abs(norm - 1.0) < 0.01,
    `long-text vector should be normalised (norm=${norm.toFixed(4)})`,
  );

  console.log(`  3000-char input → 384-dim vector, norm=${norm.toFixed(6)}`);
});

await runStep('Pipeline caching (second call should be faster)', async () => {
  // Pipeline already loaded by earlier steps.
  // First timed call
  const t1Start = performance.now();
  await provider.embed(['benchmark run one']);
  const t1 = performance.now() - t1Start;

  // Second timed call
  const t2Start = performance.now();
  await provider.embed(['benchmark run two']);
  const t2 = performance.now() - t2Start;

  console.log(`  call 1: ${t1.toFixed(1)} ms`);
  console.log(`  call 2: ${t2.toFixed(1)} ms`);

  // 仅验证第二次调用不异常且速度合理（pipeline 已缓存，不应比首次慢很多）
  assert.ok(t2 < t1 * 5, 'second call should not be dramatically slower than first');
});

// ── summary ────────────────────────────────────────────────────────────

console.log(`\n${'='.repeat(72)}`);
console.log(`Results: ${passed} passed / ${failed} failed`);
console.log('='.repeat(72));

if (failed > 0) process.exit(1);
