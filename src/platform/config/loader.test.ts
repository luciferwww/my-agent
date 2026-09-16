import { describe, expect, it } from 'vitest';

import { DEFAULT_AGENT_CONFIG } from './defaults.js';
import { deepMerge, getEnvOverrides, resolveAgentConfig } from './loader.js';
import type { AppConfig, AgentEntry } from './types.js';

function appConfig(list: AgentEntry[] = []): AppConfig {
  return {
    agentHome: '/tmp',
    agents: {
      defaults: structuredClone(DEFAULT_AGENT_CONFIG),
      list,
    },
    logger: {},
  };
}

describe('deepMerge', () => {
  it('returns an equivalent result when source is empty', () => {
    const target = { a: 1, b: { c: 2 } };
    expect(deepMerge(target, {})).toEqual(target);
  });

  it('overwrites scalars and recursively merges objects', () => {
    expect(deepMerge(
      { a: 1, nested: { x: 1, y: 2 } },
      { a: 10, nested: { x: 99 } },
    )).toEqual({ a: 10, nested: { x: 99, y: 2 } });
  });

  it('ignores undefined and does not mutate the target', () => {
    const target = { a: 'keep', nested: { x: 1 } };
    const result = deepMerge(target, { a: undefined, nested: { x: 2 } });

    expect(result).toEqual({ a: 'keep', nested: { x: 2 } });
    expect(target).toEqual({ a: 'keep', nested: { x: 1 } });
  });
});

describe('resolveAgentConfig', () => {
  it('returns defaults when no matching Agent is selected', () => {
    const config = appConfig();

    expect(resolveAgentConfig(config)).toEqual(config.agents.defaults);
    expect(resolveAgentConfig(config, { agentId: 'missing' })).toEqual(config.agents.defaults);
  });

  it('applies matching Agent, environment, then caller overrides', () => {
    const config = appConfig([{
      id: 'coding',
      model: { providerId: 'agent', modelId: 'agent-model' },
      llm: { apiKey: 'from-agent', maxTokens: 8192 },
      memory: { enabled: false },
    }]);

    const resolved = resolveAgentConfig(config, {
      agentId: 'coding',
      envOverrides: {
        model: { providerId: 'environment', modelId: 'environment-model' },
        llm: { apiKey: 'from-environment' },
      },
      cliOverrides: {
        model: { providerId: 'caller', modelId: '' },
        llm: { apiKey: 'from-caller' },
      },
    });

    expect(resolved.model).toEqual({ providerId: 'caller', modelId: '' });
    expect(resolved.llm.apiKey).toBe('from-caller');
    expect(resolved.llm.maxTokens).toBe(8192);
    expect(resolved.memory.enabled).toBe(false);
    expect(resolved.runner).toEqual(DEFAULT_AGENT_CONFIG.runner);
  });

  it('rejects legacy and incomplete Model References in overrides', () => {
    const config = appConfig();

    expect(() => resolveAgentConfig(config, {
      envOverrides: { llm: { model: 'legacy' } } as never,
    })).toThrow('uses legacy llm.model');
    expect(() => resolveAgentConfig(config, {
      cliOverrides: { model: { providerId: '', modelId: 'model' } },
    })).toThrow('requires a non-empty providerId');
  });
});

describe('getEnvOverrides', () => {
  it('maps connection values and the atomic default Model Reference', () => {
    const previous = {
      apiKey: process.env['ANTHROPIC_API_KEY'],
      baseURL: process.env['ANTHROPIC_BASE_URL'],
      provider: process.env['MY_AGENT_PROVIDER'],
      model: process.env['MY_AGENT_MODEL'],
    };
    try {
      process.env['ANTHROPIC_API_KEY'] = 'key';
      process.env['ANTHROPIC_BASE_URL'] = 'https://example.test';
      process.env['MY_AGENT_PROVIDER'] = 'provider';
      process.env['MY_AGENT_MODEL'] = 'model';

      expect(getEnvOverrides()).toEqual({
        llm: { apiKey: 'key', baseURL: 'https://example.test' },
        model: { providerId: 'provider', modelId: 'model' },
      });
    } finally {
      restoreEnvironment('ANTHROPIC_API_KEY', previous.apiKey);
      restoreEnvironment('ANTHROPIC_BASE_URL', previous.baseURL);
      restoreEnvironment('MY_AGENT_PROVIDER', previous.provider);
      restoreEnvironment('MY_AGENT_MODEL', previous.model);
    }
  });

  it('requires Provider and Model environment values as an atomic pair', () => {
    const previousProvider = process.env['MY_AGENT_PROVIDER'];
    const previousModel = process.env['MY_AGENT_MODEL'];
    try {
      process.env['MY_AGENT_PROVIDER'] = 'provider';
      delete process.env['MY_AGENT_MODEL'];
      expect(() => getEnvOverrides()).toThrow('must be provided together');
    } finally {
      restoreEnvironment('MY_AGENT_PROVIDER', previousProvider);
      restoreEnvironment('MY_AGENT_MODEL', previousModel);
    }
  });
});

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
