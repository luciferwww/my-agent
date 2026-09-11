import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadConfig, resolveAgentConfig, deepMerge, getEnvOverrides } from './loader.js';
import { DEFAULT_AGENT_CONFIG, DEFAULT_LOGGER_CONFIG } from './defaults.js';

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
    expect(config.logger).toEqual(DEFAULT_LOGGER_CONFIG);
  });

  it('merges config file agents.defaults with hardcoded defaults', async () => {
    await mkdir(join(tmpDir, '.agent'), { recursive: true });
    await writeFile(join(tmpDir, '.agent', 'config.json'), JSON.stringify({
      agents: {
        defaults: {
          llm: { maxTokens: 8192 },
          model: { providerId: 'anthropic', modelId: 'claude-opus-4-20250514' },
          memory: { search: { maxResults: 10 } },
        },
      },
    }));

    const config = loadConfig({ workspaceDir: tmpDir });

    // Overridden values
    expect(config.agents.defaults.llm.maxTokens).toBe(8192);
    expect(config.agents.defaults.model).toEqual({
      providerId: 'anthropic',
      modelId: 'claude-opus-4-20250514',
    });
    expect(config.agents.defaults.memory.search.maxResults).toBe(10);

    // Non-overridden values stay default
    expect(config.agents.defaults.runner.maxLlmCalls).toBe(12);
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
    expect(config.agents.defaults.tools).toEqual(DEFAULT_AGENT_CONFIG.tools);
    expect(config.agents.defaults.workspace).toEqual(DEFAULT_AGENT_CONFIG.workspace);
    expect(config.agents.defaults.subagents).toEqual(DEFAULT_AGENT_CONFIG.subagents);
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
          { id: 'coding', model: { providerId: 'anthropic', modelId: 'claude-opus-4-20250514' } },
          { id: 'quick', model: { providerId: 'anthropic', modelId: 'claude-haiku-4-20250514' } },
        ],
      },
    }));

    const config = loadConfig({ workspaceDir: tmpDir });

    expect(config.agents.list).toHaveLength(2);
    expect(config.agents.list[0]!.id).toBe('coding');
    expect(config.agents.list[1]!.id).toBe('quick');
  });

  it('merges logger config from file with defaults', async () => {
    await mkdir(join(tmpDir, '.agent'), { recursive: true });
    await writeFile(join(tmpDir, '.agent', 'config.json'), JSON.stringify({
      logger: {
        minLevel: 'debug',
        file: { enabled: true, minLevel: 'warn' },
      },
    }));

    const config = loadConfig({ workspaceDir: tmpDir });

    // Overridden values
    expect(config.logger.minLevel).toBe('debug');
    expect(config.logger.file?.enabled).toBe(true);
    expect(config.logger.file?.minLevel).toBe('warn');

    // Inherited defaults
    expect(config.logger.console?.enabled).toBe(true);
    // file.dir / prefix / maxQueueSize 字段已删（spec §8.3）——FileAdapter 内部默认接手
  });

  it('tools.allow and deny default to empty arrays', () => {
    const config = loadConfig({ workspaceDir: '/tmp' });
    expect(config.agents.defaults.tools.allow).toEqual([]);
    expect(config.agents.defaults.tools.deny).toEqual([]);
  });

  it('tools.fs.workspaceOnly defaults to true', () => {
    const config = loadConfig({ workspaceDir: '/tmp' });
    expect(config.agents.defaults.tools.fs?.workspaceOnly).toBe(true);
  });

  it('rejects legacy llm.model in configuration files', async () => {
    await mkdir(join(tmpDir, '.agent'), { recursive: true });
    await writeFile(join(tmpDir, '.agent', 'config.json'), JSON.stringify({
      agents: { defaults: { llm: { model: 'legacy-model' } } },
    }));

    expect(() => loadConfig({ workspaceDir: tmpDir })).toThrow('uses legacy llm.model');
  });

  it('rejects incomplete structured model references in per-agent entries', async () => {
    await mkdir(join(tmpDir, '.agent'), { recursive: true });
    await writeFile(join(tmpDir, '.agent', 'config.json'), JSON.stringify({
      agents: {
        list: [{ id: 'partial', model: { modelId: 'model-only' } }],
      },
    }));

    expect(() => loadConfig({ workspaceDir: tmpDir }))
      .toThrow('requires a non-empty providerId and string modelId');
  });

  it('preserves an arbitrary Provider-owned Model ID string', async () => {
    const modelId = ' model/vendor:v1?x=1\n\u0000 ';
    await mkdir(join(tmpDir, '.agent'), { recursive: true });
    await writeFile(join(tmpDir, '.agent', 'config.json'), JSON.stringify({
      agents: { defaults: { model: { providerId: 'anthropic-compatible', modelId } } },
    }));

    expect(loadConfig({ workspaceDir: tmpDir }).agents.defaults.model).toEqual({
      providerId: 'anthropic-compatible',
      modelId,
    });
  });

  it('preserves an empty string Model ID instead of treating it as missing', async () => {
    await mkdir(join(tmpDir, '.agent'), { recursive: true });
    await writeFile(join(tmpDir, '.agent', 'config.json'), JSON.stringify({
      agents: {
        defaults: { model: { providerId: 'anthropic-compatible', modelId: '' } },
      },
    }));

    expect(loadConfig({ workspaceDir: tmpDir }).agents.defaults.model).toEqual({
      providerId: 'anthropic-compatible',
      modelId: '',
    });
  });

  it('merges tools.allow / deny arrays from config file', async () => {
    await mkdir(join(tmpDir, '.agent'), { recursive: true });
    await writeFile(join(tmpDir, '.agent', 'config.json'), JSON.stringify({
      agents: {
        defaults: {
          tools: {
            allow: ['read_file', 'exec'],
            deny: ['web_fetch'],
          },
        },
      },
    }));

    const config = loadConfig({ workspaceDir: tmpDir });

    expect(config.agents.defaults.tools.allow).toEqual(['read_file', 'exec']);
    expect(config.agents.defaults.tools.deny).toEqual(['web_fetch']);
    // Other tools fields remain default
    expect(config.agents.defaults.tools.fs?.workspaceOnly).toBe(true);
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
            model: { providerId: 'anthropic', modelId: 'claude-opus-4-20250514' },
            llm: { maxTokens: 16384 },
            memory: { enabled: false },
          },
        ],
      },
      logger: {},
    };

    const resolved = resolveAgentConfig(config, { agentId: 'coding' });

    // Overridden by list entry
    expect(resolved.model).toEqual({
      providerId: 'anthropic',
      modelId: 'claude-opus-4-20250514',
    });
    expect(resolved.llm.maxTokens).toBe(16384);
    expect(resolved.memory.enabled).toBe(false);

    // Inherited from defaults
    expect(resolved.runner.maxLlmCalls).toBe(12);
    expect(resolved.memory.embedding.model).toBe('Xenova/all-MiniLM-L6-v2');
    expect(resolved.prompt.safetyLevel).toBe('normal');
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
      logger: {},
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
        defaults: {
          llm: { apiKey: 'from-file' },
          model: { providerId: 'file-provider', modelId: 'from-file' },
        },
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
    expect(resolved.model).toEqual({ providerId: 'file-provider', modelId: 'from-file' });
    // maxTokens: nobody overrode → hardcoded default
    expect(resolved.llm.maxTokens).toBe(4096);

    await rm(tmpDir, { recursive: true, force: true });
  });

  it('applies structured model precedence as whole valid references', async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), 'config-model-priority-'));
    await mkdir(join(tmpDir, '.agent'), { recursive: true });
    await writeFile(join(tmpDir, '.agent', 'config.json'), JSON.stringify({
      agents: {
        defaults: { model: { providerId: 'file', modelId: 'file-model' } },
        list: [{
          id: 'main',
          model: { providerId: 'agent', modelId: 'agent-model' },
        }],
      },
    }));

    const config = loadConfig({ workspaceDir: tmpDir });
    expect(resolveAgentConfig(config, { agentId: 'main' }).model).toEqual({
      providerId: 'agent',
      modelId: 'agent-model',
    });
    expect(resolveAgentConfig(config, {
      agentId: 'main',
      envOverrides: { model: { providerId: 'env', modelId: 'env-model' } },
    }).model).toEqual({ providerId: 'env', modelId: 'env-model' });
    expect(resolveAgentConfig(config, {
      agentId: 'main',
      envOverrides: { model: { providerId: 'env', modelId: 'env-model' } },
      cliOverrides: { model: { providerId: 'cli', modelId: 'cli-model' } },
    }).model).toEqual({ providerId: 'cli', modelId: 'cli-model' });

    await rm(tmpDir, { recursive: true, force: true });
  });

  it('requires MY_AGENT_PROVIDER and MY_AGENT_MODEL as an atomic pair', () => {
    const previousProvider = process.env['MY_AGENT_PROVIDER'];
    const previousModel = process.env['MY_AGENT_MODEL'];
    try {
      process.env['MY_AGENT_PROVIDER'] = 'anthropic';
      delete process.env['MY_AGENT_MODEL'];
      expect(() => getEnvOverrides()).toThrow('must be provided together');

      process.env['MY_AGENT_MODEL'] = 'claude-test';
      expect(getEnvOverrides().model).toEqual({
        providerId: 'anthropic',
        modelId: 'claude-test',
      });
    } finally {
      if (previousProvider === undefined) delete process.env['MY_AGENT_PROVIDER'];
      else process.env['MY_AGENT_PROVIDER'] = previousProvider;
      if (previousModel === undefined) delete process.env['MY_AGENT_MODEL'];
      else process.env['MY_AGENT_MODEL'] = previousModel;
    }
  });
});
