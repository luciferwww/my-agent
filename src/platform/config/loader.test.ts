import { describe, expect, it } from 'vitest';

import { DEFAULT_AGENT_CONFIG } from './defaults.js';
import { DEFAULT_RUNNER_CONFIG } from '../../core/runner/config.js';
import { DEFAULT_RUNTIME_CONFIG } from '../../runtime/config.js';
import { deepMerge, getEnvOverrides, resolveAgentConfig } from './loader.js';
import type { AppConfig, AgentEntry } from './types.js';

function appConfig(list: AgentEntry[] = []): AppConfig {
  return {
    agentHome: '/tmp',
    llm: {},
    runtime: structuredClone(DEFAULT_RUNTIME_CONFIG),
    runner: structuredClone(DEFAULT_RUNNER_CONFIG),
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

  it('applies matching Agent, environment, then caller overrides to Agent-scoped fields', () => {
    const config = appConfig([{
      id: 'coding',
      memory: { enabled: false },
    }]);

    const resolved = resolveAgentConfig(config, {
      agentId: 'coding',
      envOverrides: {
        memory: { enabled: true },
      },
      cliOverrides: {
        memory: { enabled: false },
      },
    });

    expect(resolved.memory.enabled).toBe(false);
  });
});

describe('getEnvOverrides', () => {
  it('does not retain retired Agent-level LLM environment overrides', () => {
    expect(getEnvOverrides({
      ANTHROPIC_API_KEY: 'key',
      ANTHROPIC_BASE_URL: 'https://example.test',
      MY_AGENT_PROVIDER: 'provider',
      MY_AGENT_MODEL: 'model',
    })).toEqual({});
  });
});
