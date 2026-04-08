import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadConfig, resolveAgentConfig, deepMerge } from './loader.js';
import { DEFAULT_AGENT_CONFIG } from './defaults.js';

// ── deepMerge ────────────────────────────────────────────

describe('deepMerge', () => {
  it('returns target when source is empty', () => {
    const target = { a: 1, b: { c: 2 } };
    const result = deepMerge(target, {});
    expect(result).toEqual(target);
  });

  it('overwrites scalar values', () => {
    const result = deepMerge({ a: 1, b: 2 }, { a: 10 });
    expect(result).toEqual({ a: 10, b: 2 });
  });

  it('deep-merges nested objects', () => {
    const target = { nested: { x: 1, y: 2 } };
    const result = deepMerge(target, { nested: { x: 99 } });
    expect(result).toEqual({ nested: { x: 99, y: 2 } });
  });

  it('does not overwrite with undefined', () => {
    const target = { a: 'keep', b: 'keep' };
    const result = deepMerge(target, { a: undefined, b: 'new' });
    expect(result).toEqual({ a: 'keep', b: 'new' });
  });

  it('does not mutate the original target', () => {
    const target = { nested: { x: 1 } };
    const copy = JSON.parse(JSON.stringify(target));
    deepMerge(target, { nested: { x: 99 } });
    expect(target).toEqual(copy);
  });
});

// ── loadConfig ───────────────────────────────────────────

describe('loadConfig', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'config-test-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('returns all defaults when no config file exists', () => {
    const config = loadConfig({ workspaceDir: tmpDir });

    expect(config.workspaceDir).toBe(tmpDir);
    expect(config.agents.defaults).toEqual(DEFAULT_AGENT_CONFIG);
    expect(config.agents.list).toEqual([]);
  });

  it('merges config file agents.defaults with hardcoded defaults', async () => {
    await mkdir(join(tmpDir, '.agent'), { recursive: true });
    await writeFile(join(tmpDir, '.agent', 'config.json'), JSON.stringify({
      agents: {
        defaults: {
          llm: { maxTokens: 8192, model: 'claude-opus-4-20250514' },
          memory: { search: { maxResults: 10 } },
        },
      },
    }));

    const config = loadConfig({ workspaceDir: tmpDir });

    // Overridden values
    expect(config.agents.defaults.llm.maxTokens).toBe(8192);
    expect(config.agents.defaults.llm.model).toBe('claude-opus-4-20250514');
    expect(config.agents.defaults.memory.search.maxResults).toBe(10);

    // Non-overridden values stay default
    expect(config.agents.defaults.runner.maxToolRounds).toBe(10);
    expect(config.agents.defaults.memory.search.minScore).toBe(0.25);
    expect(config.agents.defaults.memory.embedding.model).toBe('Xenova/all-MiniLM-L6-v2');
  });

  it('partial config does not affect other modules', async () => {
    await mkdir(join(tmpDir, '.agent'), { recursive: true });
    await writeFile(join(tmpDir, '.agent', 'config.json'), JSON.stringify({
      agents: { defaults: { llm: { maxTokens: 16384 } } },
    }));

    const config = loadConfig({ workspaceDir: tmpDir });

    expect(config.agents.defaults.llm.maxTokens).toBe(16384);
    expect(config.agents.defaults.runner).toEqual(DEFAULT_AGENT_CONFIG.runner);
    expect(config.agents.defaults.memory).toEqual(DEFAULT_AGENT_CONFIG.memory);
    expect(config.agents.defaults.prompt).toEqual(DEFAULT_AGENT_CONFIG.prompt);
    expect(config.agents.defaults.session).toEqual(DEFAULT_AGENT_CONFIG.session);
    expect(config.agents.defaults.tools).toEqual(DEFAULT_AGENT_CONFIG.tools);
    expect(config.agents.defaults.workspace).toEqual(DEFAULT_AGENT_CONFIG.workspace);
  });

  it('invalid JSON file degrades to defaults', async () => {
    await mkdir(join(tmpDir, '.agent'), { recursive: true });
    await writeFile(join(tmpDir, '.agent', 'config.json'), '{ invalid json!!!');

    const config = loadConfig({ workspaceDir: tmpDir });
    expect(config.agents.defaults).toEqual(DEFAULT_AGENT_CONFIG);
  });

  it('preserves agents.list from config file', async () => {
    await mkdir(join(tmpDir, '.agent'), { recursive: true });
    await writeFile(join(tmpDir, '.agent', 'config.json'), JSON.stringify({
      agents: {
        defaults: { llm: { maxTokens: 8192 } },
        list: [
          { id: 'coding', llm: { model: 'claude-opus-4-20250514' } },
          { id: 'quick', llm: { model: 'claude-haiku-4-20250514' } },
        ],
      },
    }));

    const config = loadConfig({ workspaceDir: tmpDir });

    expect(config.agents.list).toHaveLength(2);
    expect(config.agents.list[0]!.id).toBe('coding');
    expect(config.agents.list[1]!.id).toBe('quick');
  });
});

// ── resolveAgentConfig ───────────────────────────────────

describe('resolveAgentConfig', () => {
  it('returns defaults when no options provided', () => {
    const config = loadConfig({ workspaceDir: '/tmp' });
    const resolved = resolveAgentConfig(config);
    expect(resolved).toEqual(config.agents.defaults);
  });

  it('returns defaults when agentId not found in list', () => {
    const config = loadConfig({ workspaceDir: '/tmp' });
    const resolved = resolveAgentConfig(config, { agentId: 'nonexistent' });
    expect(resolved).toEqual(config.agents.defaults);
  });

  it('merges per-agent overrides from list', () => {
    const config: ReturnType<typeof loadConfig> = {
      workspaceDir: '/tmp',
      agents: {
        defaults: { ...DEFAULT_AGENT_CONFIG },
        list: [
          {
            id: 'coding',
            llm: { model: 'claude-opus-4-20250514', maxTokens: 16384 },
            memory: { enabled: false },
          },
        ],
      },
    };

    const resolved = resolveAgentConfig(config, { agentId: 'coding' });

    // Overridden by list entry
    expect(resolved.llm.model).toBe('claude-opus-4-20250514');
    expect(resolved.llm.maxTokens).toBe(16384);
    expect(resolved.memory.enabled).toBe(false);

    // Inherited from defaults
    expect(resolved.runner.maxToolRounds).toBe(10);
    expect(resolved.memory.embedding.model).toBe('Xenova/all-MiniLM-L6-v2');
    expect(resolved.prompt.mode).toBe('full');
  });

  it('envOverrides override list values', () => {
    const config: ReturnType<typeof loadConfig> = {
      workspaceDir: '/tmp',
      agents: {
        defaults: { ...DEFAULT_AGENT_CONFIG },
        list: [
          { id: 'main', llm: { apiKey: 'from-list' } },
        ],
      },
    };

    const resolved = resolveAgentConfig(config, {
      agentId: 'main',
      envOverrides: { llm: { apiKey: 'from-env' } },
    });

    expect(resolved.llm.apiKey).toBe('from-env');
  });

  it('cliOverrides override envOverrides', () => {
    const config = loadConfig({ workspaceDir: '/tmp' });

    const resolved = resolveAgentConfig(config, {
      envOverrides: { llm: { apiKey: 'from-env', maxTokens: 8192 } },
      cliOverrides: { llm: { apiKey: 'from-cli' } },
    });

    expect(resolved.llm.apiKey).toBe('from-cli');
    // env value not overridden by CLI stays
    expect(resolved.llm.maxTokens).toBe(8192);
  });

  it('full priority chain: defaults < file < list < env < CLI', async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), 'config-priority-'));
    await mkdir(join(tmpDir, '.agent'), { recursive: true });
    await writeFile(join(tmpDir, '.agent', 'config.json'), JSON.stringify({
      agents: {
        defaults: { llm: { apiKey: 'from-file', model: 'from-file' } },
        list: [
          { id: 'main', default: true, llm: { apiKey: 'from-list' } },
        ],
      },
    }));

    const config = loadConfig({ workspaceDir: tmpDir });
    const resolved = resolveAgentConfig(config, {
      agentId: 'main',
      envOverrides: { llm: { apiKey: 'from-env' } },
      cliOverrides: { llm: { apiKey: 'from-cli' } },
    });

    // CLI wins
    expect(resolved.llm.apiKey).toBe('from-cli');
    // model: file set it, list didn't override, env didn't override, CLI didn't override
    expect(resolved.llm.model).toBe('from-file');
    // maxTokens: nobody overrode → hardcoded default
    expect(resolved.llm.maxTokens).toBe(4096);

    await rm(tmpDir, { recursive: true, force: true });
  });
});
