import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_AGENT_CONFIG, DEFAULT_LOGGER_CONFIG } from './defaults.js';
import { AgentConfigError } from './agent-config-errors.js';
import { loadAgentConfig } from './agent-config-loader.js';

describe('loadAgentConfig', () => {
  let agentHome: string;

  beforeEach(async () => {
    agentHome = await mkdtemp(join(tmpdir(), 'agent-config-test-'));
  });

  afterEach(async () => {
    await rm(agentHome, { recursive: true, force: true });
  });

  async function writeConfig(value: unknown): Promise<void> {
    await writeFile(join(agentHome, 'config.json'), JSON.stringify(value), 'utf8');
  }

  it('rejects an absent document instead of synthesizing in-memory defaults', async () => {
    await expect(loadAgentConfig({ agentHome })).rejects.toMatchObject({
      code: 'FILE_MISSING',
      message: 'Agent configuration file is missing.',
    });
  });

  it('reads only the Agent Home document once and ignores project-local config', async () => {
    const startupCwd = join(agentHome, 'project');
    await mkdir(startupCwd);
    await writeConfig({ agents: { defaults: { runner: { maxLlmCalls: 8 } } } });
    await writeFile(join(startupCwd, 'config.json'), JSON.stringify({
      agents: { defaults: { runner: { maxLlmCalls: 1 } } },
    }), 'utf8');
    const readTextFile = vi.fn((path: string) => readFile(path, 'utf8'));

    const snapshot = await loadAgentConfig({ agentHome }, { readTextFile });

    expect(readTextFile).toHaveBeenCalledTimes(1);
    expect(readTextFile).toHaveBeenCalledWith(join(agentHome, 'config.json'));
    expect(snapshot.application.agents.defaults.runner.maxLlmCalls).toBe(8);
    await expect(readFile(join(startupCwd, 'config.json'), 'utf8'))
      .resolves.toContain('"maxLlmCalls":1');
  });

  it('projects Agent Context budgets from agents.defaults.context', async () => {
    await writeConfig({
      agents: { defaults: { context: { maxFileChars: 1234, maxTotalChars: 5678 } } },
    });

    const snapshot = await loadAgentConfig({ agentHome });

    expect(snapshot.application.agents.defaults.context).toEqual({
      maxFileChars: 1234,
      maxTotalChars: 5678,
    });
  });

  it.each([
    [{ agents: { defaults: { workspace: { maxFileChars: 1 } } } }, 'agents.defaults.workspace'],
    [{ agents: { list: [{ id: 'legacy', workspace: { maxFileChars: 1 } }] } }, 'agents.list[0].workspace'],
  ])('rejects the retired Workspace Context key %#', async (document, fieldPath) => {
    await writeConfig(document);

    await expect(loadAgentConfig({ agentHome })).rejects.toMatchObject({
      code: 'NAMESPACE_INVALID',
      fieldPath,
    });
  });

  it('rejects the retired Host namespace directly', async () => {
    await writeConfig({ host: { mode: 'websocket' } });

    await expect(loadAgentConfig({ agentHome })).rejects.toMatchObject({
      code: 'UNKNOWN_NAMESPACE',
      fieldPath: 'host',
    });
  });

  it('rejects a missing Agent Home as a missing config document', async () => {
    const missingAgentHome = join(agentHome, 'not-created');

    await expect(loadAgentConfig({ agentHome: missingAgentHome })).rejects.toMatchObject({
      code: 'FILE_MISSING',
    });
  });

  it('projects all known namespaces from one root document', async () => {
    await writeConfig({
      agents: {
        defaults: {},
        list: [{ id: 'reviewer', default: true, runner: { maxLlmCalls: 3 } }],
      },
      llm: {
        defaultModel: { providerId: 'builtin', modelId: 'model-a' },
        builtin: {
          baseURL: 'https://example.test/v1///',
          apiKey: '${BUILTIN_API_KEY}',
          models: [{ modelId: 'model-a', protocol: 'openai-responses' }],
        },
      },
      logger: {
        minLevel: 'warn',
        console: { enabled: false },
        file: { enabled: true, minLevel: 'info' },
      },
      extensions: {
        enabled: false,
        entries: {
          relay: { enabled: true, config: { token: { $env: 'RELAY_TOKEN' } } },
        },
      },
    });

    const snapshot = await loadAgentConfig({
      agentHome,
      environment: { BUILTIN_API_KEY: 'secret' },
    });

    expect(Object.keys(snapshot)).toEqual(['application', 'extensions']);
    expect(snapshot.application.llm).toEqual({
      defaultModel: { providerId: 'builtin', modelId: 'model-a' },
      builtin: {
        baseURL: 'https://example.test/v1',
        apiKey: 'secret',
        models: [{ modelId: 'model-a', protocol: 'openai-responses' }],
      },
    });
    expect(snapshot.application.agents.defaults.runner).toEqual(DEFAULT_AGENT_CONFIG.runner);
    expect(snapshot.application.agents.list).toEqual([
      { id: 'reviewer', default: true, runner: { maxLlmCalls: 3 } },
    ]);
    expect(snapshot.application.logger).toEqual({
      minLevel: 'warn',
      console: { enabled: false },
      file: { enabled: true, minLevel: 'info' },
    });
    expect(snapshot.extensions).toEqual({
      enabled: false,
      entries: {
        relay: { enabled: true, config: { token: { $env: 'RELAY_TOKEN' } } },
      },
    });
  });

  it('ignores the retired nested Agent configuration path', async () => {
    await mkdir(join(agentHome, '.agent'), { recursive: true });
    await writeFile(join(agentHome, '.agent', 'config.json'), JSON.stringify({
      agents: { defaults: { llm: { maxTokens: 1 } } },
    }));
    await writeConfig({});

    const snapshot = await loadAgentConfig({ agentHome });

    expect(snapshot.application.agents.defaults).toEqual(DEFAULT_AGENT_CONFIG);
    expect(snapshot.application.llm).toEqual({});
  });

  it.each([
    [{ agents: { defaults: { model: { providerId: 'a', modelId: 'b' } } } }, 'agents.defaults.model'],
    [{ agents: { defaults: { llm: {} } } }, 'agents.defaults.llm'],
    [{ agents: { list: [{ id: 'a', model: { providerId: 'a', modelId: 'b' } }] } }, 'agents.list[0].model'],
    [{ agents: { list: [{ id: 'a', llm: {} }] } }, 'agents.list[0].llm'],
  ])('rejects legacy Agent-level LLM configuration %#', async (document, fieldPath) => {
    await writeConfig(document);

    await expect(loadAgentConfig({ agentHome })).rejects.toMatchObject({
      code: 'NAMESPACE_INVALID',
      fieldPath,
    });
  });

  it('reports unavailable API-key references without exposing secret values', async () => {
    await writeConfig({
      llm: {
        builtin: {
          baseURL: 'https://example.test',
          apiKey: '${BUILTIN_API_KEY}',
          models: [],
        },
      },
    });

    const error = await captureConfigError({ BUILTIN_API_KEY: '   ' });

    expect(error).toMatchObject({
      code: 'SECRET_UNAVAILABLE',
      fieldPath: 'llm.builtin.apiKey',
    });
    expect(error.message).toContain('BUILTIN_API_KEY');
    expect(error.message).not.toContain('   ');
  });

  it('deep-freezes every value reachable from both projections without freezing defaults', async () => {
    await writeConfig({
      agents: { defaults: { tools: { allow: ['read_file'] } } },
      extensions: { entries: { sample: { config: { nested: ['value'] } } } },
    });

    const snapshot = await loadAgentConfig({ agentHome });

    expectAllFrozen(snapshot);
    expect(Object.isFrozen(DEFAULT_AGENT_CONFIG)).toBe(false);
    expect(Object.isFrozen(DEFAULT_AGENT_CONFIG.tools)).toBe(false);
    expect(() => {
      (snapshot.application.agents.defaults.tools.allow as string[]).push('exec');
    }).toThrow();
    expect(snapshot.application.agents.defaults.tools.allow).toEqual(['read_file']);
  });

  it('retains Descriptor-keyed Extension values for later candidate isolation', async () => {
    await writeConfig({
      extensions: {
        entries: {
          malformedLater: 'not-an-entry-object',
          validLater: { enabled: true, config: { arbitrary: [1, null, 'value'] } },
        },
      },
    });

    const snapshot = await loadAgentConfig({ agentHome });

    expect(snapshot.extensions.entries).toEqual({
      malformedLater: 'not-an-entry-object',
      validLater: { enabled: true, config: { arbitrary: [1, null, 'value'] } },
    });
  });

  it('classifies unreadable, invalid JSON, and invalid-root documents without content leakage', async () => {
    await mkdir(join(agentHome, 'config.json'));
    await expectConfigError('FILE_UNREADABLE');

    await rm(join(agentHome, 'config.json'), { recursive: true, force: true });
    await writeFile(join(agentHome, 'config.json'), '{"secret":"do-not-report"', 'utf8');
    const invalidJson = await captureConfigError();
    expect(invalidJson).toMatchObject({ code: 'INVALID_JSON' });
    expect(invalidJson.message).not.toContain('do-not-report');

    await writeConfig([]);
    await expectConfigError('ROOT_INVALID');
  });

  it('rejects and bounds an unknown top-level namespace', async () => {
    const longNamespace = `unknown-${'x'.repeat(300)}`;
    await writeConfig({ [longNamespace]: { secret: 'do-not-report' } });

    const error = await captureConfigError();

    expect(error.code).toBe('UNKNOWN_NAMESPACE');
    expect(error.fieldPath).toHaveLength(200);
    expect(error.message).not.toContain('do-not-report');
  });

  it.each([
    [{ agents: [] }, 'agents'],
    [{ agents: { defaults: [] } }, 'agents.defaults'],
    [{ agents: { list: {} } }, 'agents.list'],
    [{ agents: { list: [null] } }, 'agents.list[0]'],
    [{ agents: { list: [{ id: '  ' }] } }, 'agents.list[0].id'],
    [{ agents: { list: [{ id: 'a', default: 'yes' }] } }, 'agents.list[0].default'],
    [{ llm: [] }, 'llm'],
    [{ llm: { defaultModel: 'unstructured' } }, 'llm.defaultModel'],
    [{ llm: { builtin: {} } }, 'llm.builtin.baseURL'],
    [{ llm: { builtin: { baseURL: 'https://example.test', models: {} } } }, 'llm.builtin.models'],
    [{ agents: { defaults: { tools: { fs: {} } } } }, 'agents.defaults.tools.fs'],
    [{ agents: { list: [{ id: 'a', tools: { fs: {} } }] } }, 'agents.list[0].tools.fs'],
    [{ logger: [] }, 'logger'],
    [{ logger: { minLevel: 'verbose' } }, 'logger.minLevel'],
    [{ logger: { console: true } }, 'logger.console'],
    [{ logger: { console: { enabled: 'yes' } } }, 'logger.console.enabled'],
    [{ logger: { file: { minLevel: 1 } } }, 'logger.file.minLevel'],
    [{ extensions: [] }, 'extensions'],
    [{ extensions: { enabled: 'yes' } }, 'extensions.enabled'],
    [{ extensions: { entries: [] } }, 'extensions.entries'],
  ])('rejects an invalid known namespace at %s', async (document, fieldPath) => {
    await writeConfig(document);

    const error = await captureConfigError();

    expect(error).toMatchObject({ code: 'NAMESPACE_INVALID', fieldPath });
  });

  async function expectConfigError(code: AgentConfigError['code']): Promise<void> {
    const error = await captureConfigError();
    expect(error.code).toBe(code);
  }

  async function captureConfigError(
    environment?: Readonly<Record<string, string | undefined>>,
  ): Promise<AgentConfigError> {
    try {
      await loadAgentConfig({ agentHome, environment });
    } catch (error) {
      expect(error).toBeInstanceOf(AgentConfigError);
      return error as AgentConfigError;
    }
    throw new Error('Expected loadAgentConfig() to reject.');
  }
});

function expectAllFrozen(value: unknown): void {
  if (typeof value !== 'object' || value === null) return;
  expect(Object.isFrozen(value)).toBe(true);
  for (const child of Object.values(value)) expectAllFrozen(child);
}