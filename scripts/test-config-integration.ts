/**
 * Config module integration test.
 *
 * Verifies loadConfig + resolveAgentConfig end-to-end with real files,
 * environment variables, CLI overrides, and per-agent merging.
 *
 * Usage:
 *   npx tsx scripts/test-config-integration.ts
 */

import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

import { loadConfig, resolveAgentConfig, getEnvOverrides, DEFAULT_AGENT_CONFIG } from '../src/config/index.js';

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

// Save and restore env vars
const savedEnv: Record<string, string | undefined> = {};
function setEnv(key: string, value: string) {
  savedEnv[key] = process.env[key];
  process.env[key] = value;
}
function clearEnv(...keys: string[]) {
  for (const key of keys) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
}
function restoreEnv() {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

// ── setup ──────────────────────────────────────────────────────────────

const tmpDir = await mkdtemp(join(tmpdir(), 'config-integration-'));
clearEnv('ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL', 'MY_AGENT_MODEL');

// ── steps ──────────────────────────────────────────────────────────────

await runStep('No config file → all defaults', async () => {
  const config = loadConfig({ workspaceDir: tmpDir });
  const resolved = resolveAgentConfig(config);

  assert.equal(config.workspaceDir, tmpDir);
  assert.equal(resolved.llm.maxTokens, 4096);
  assert.equal(resolved.llm.apiKey, undefined);
  assert.equal(resolved.runner.maxToolRounds, 10);
  assert.equal(resolved.memory.enabled, true);
  assert.equal(resolved.memory.embedding.model, 'Xenova/all-MiniLM-L6-v2');
  assert.equal(resolved.prompt.mode, 'full');
  assert.equal(resolved.tools.execTimeout, 30);
  assert.equal(resolved.workspace.agentDir, '.agent');

  console.log('  all default values verified');
});

await runStep('Config file merges with defaults', async () => {
  await mkdir(join(tmpDir, '.agent'), { recursive: true });
  await writeFile(join(tmpDir, '.agent', 'config.json'), JSON.stringify({
    agents: {
      defaults: {
        llm: { apiKey: 'sk-file-key', model: 'claude-sonnet-4-20250514', maxTokens: 8192 },
        memory: { search: { maxResults: 10, minScore: 0.3 } },
        tools: { execTimeout: 60 },
      },
    },
  }));

  const config = loadConfig({ workspaceDir: tmpDir });
  const resolved = resolveAgentConfig(config);

  // Overridden
  assert.equal(resolved.llm.apiKey, 'sk-file-key');
  assert.equal(resolved.llm.model, 'claude-sonnet-4-20250514');
  assert.equal(resolved.llm.maxTokens, 8192);
  assert.equal(resolved.memory.search.maxResults, 10);
  assert.equal(resolved.tools.execTimeout, 60);

  // Non-overridden stay default
  assert.equal(resolved.runner.maxToolRounds, 10);
  assert.equal(resolved.memory.embedding.model, 'Xenova/all-MiniLM-L6-v2');
  assert.equal(resolved.memory.search.vectorWeight, 0.7);

  console.log('  file merge verified');
});

await runStep('Per-agent override via resolveAgentConfig', async () => {
  await writeFile(join(tmpDir, '.agent', 'config.json'), JSON.stringify({
    agents: {
      defaults: {
        llm: { maxTokens: 8192 },
      },
      list: [
        { id: 'main', default: true },
        { id: 'coding', llm: { model: 'claude-opus-4-20250514', maxTokens: 16384 }, memory: { enabled: false } },
        { id: 'quick', llm: { model: 'claude-haiku-4-20250514' } },
      ],
    },
  }));

  const config = loadConfig({ workspaceDir: tmpDir });

  // Default (no agentId)
  const defaultResolved = resolveAgentConfig(config);
  assert.equal(defaultResolved.llm.maxTokens, 8192);
  assert.equal(defaultResolved.memory.enabled, true);

  // Coding agent
  const coding = resolveAgentConfig(config, { agentId: 'coding' });
  assert.equal(coding.llm.model, 'claude-opus-4-20250514');
  assert.equal(coding.llm.maxTokens, 16384);
  assert.equal(coding.memory.enabled, false);
  assert.equal(coding.runner.maxToolRounds, 10); // inherited

  // Quick agent
  const quick = resolveAgentConfig(config, { agentId: 'quick' });
  assert.equal(quick.llm.model, 'claude-haiku-4-20250514');
  assert.equal(quick.llm.maxTokens, 8192); // from file defaults
  assert.equal(quick.memory.enabled, true); // from global defaults

  // Nonexistent agent → defaults
  const unknown = resolveAgentConfig(config, { agentId: 'nonexistent' });
  assert.equal(unknown.llm.maxTokens, 8192);

  console.log('  per-agent resolution verified for coding, quick, and unknown');
});

await runStep('Env vars override file and list values', async () => {
  setEnv('ANTHROPIC_API_KEY', 'sk-env-key');
  setEnv('MY_AGENT_MODEL', 'from-env-model');

  const config = loadConfig({ workspaceDir: tmpDir });
  const env = getEnvOverrides();

  // Coding agent has apiKey in list, but env should win
  const resolved = resolveAgentConfig(config, {
    agentId: 'coding',
    envOverrides: env,
  });

  assert.equal(resolved.llm.apiKey, 'sk-env-key');
  assert.equal(resolved.llm.model, 'from-env-model');

  clearEnv('ANTHROPIC_API_KEY', 'MY_AGENT_MODEL');
  console.log('  env overrides verified');
});

await runStep('CLI overrides take highest priority', async () => {
  setEnv('ANTHROPIC_API_KEY', 'sk-env-key');

  const config = loadConfig({ workspaceDir: tmpDir });
  const resolved = resolveAgentConfig(config, {
    agentId: 'coding',
    envOverrides: getEnvOverrides(),
    cliOverrides: { llm: { apiKey: 'sk-cli-key', maxTokens: 32768 } },
  });

  assert.equal(resolved.llm.apiKey, 'sk-cli-key');
  assert.equal(resolved.llm.maxTokens, 32768);

  clearEnv('ANTHROPIC_API_KEY');
  console.log('  CLI > env > list > file > defaults verified');
});

await runStep('Invalid JSON file degrades gracefully', async () => {
  await writeFile(join(tmpDir, '.agent', 'config.json'), '{ broken json !!!');

  const config = loadConfig({ workspaceDir: tmpDir });
  const resolved = resolveAgentConfig(config);

  assert.equal(resolved.llm.maxTokens, DEFAULT_AGENT_CONFIG.llm.maxTokens);
  assert.equal(resolved.memory.enabled, DEFAULT_AGENT_CONFIG.memory.enabled);

  console.log('  invalid JSON → graceful degradation');
});

// ── cleanup ────────────────────────────────────────────────────────────

restoreEnv();
await rm(tmpDir, { recursive: true, force: true });

// ── summary ────────────────────────────────────────────────────────────

console.log(`\n${'='.repeat(72)}`);
console.log(`Results: ${passed} passed / ${failed} failed`);
console.log('='.repeat(72));

if (failed > 0) process.exit(1);
