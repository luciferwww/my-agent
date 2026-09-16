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

  it('returns independent application and Extension defaults when the file is absent', async () => {
    const snapshot = await loadAgentConfig({ agentHome });

    expect(snapshot.application.agents.defaults).toEqual(DEFAULT_AGENT_CONFIG);
    expect(snapshot.application.agents.list).toEqual([]);
    expect(snapshot.application.logger).toEqual(DEFAULT_LOGGER_CONFIG);
    expect(snapshot.extensions).toEqual({ enabled: true, entries: {} });
    expect(snapshot.host).toEqual({
      mode: 'websocket',
      websocket: { host: '127.0.0.1', port: 8787, path: '/ws', approval: true },
      cli: { sessionKey: 'main', prompt: '> ', approval: true },
    });
  });

  it('reads only the Agent Home document once and ignores project-local config', async () => {
    const workingDir = join(agentHome, 'project');
    await mkdir(workingDir);
    await writeConfig({ agents: { defaults: { llm: { maxTokens: 8192 } } } });
    await writeFile(join(workingDir, 'config.json'), JSON.stringify({
      agents: { defaults: { llm: { maxTokens: 1 } } },
    }), 'utf8');
    const readTextFile = vi.fn((path: string) => readFile(path, 'utf8'));

    const snapshot = await loadAgentConfig({ agentHome }, { readTextFile });

    expect(readTextFile).toHaveBeenCalledTimes(1);
    expect(readTextFile).toHaveBeenCalledWith(join(agentHome, 'config.json'));
    expect(snapshot.application.agents.defaults.llm.maxTokens).toBe(8192);
    await expect(readFile(join(workingDir, 'config.json'), 'utf8'))
      .resolves.toContain('"maxTokens":1');
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

  it('projects validated standalone Host settings from the same document', async () => {
    await writeConfig({
      host: {
        mode: 'cli',
        websocket: { host: '0.0.0.0', port: 9876, path: '/agent', approval: false },
        cli: { sessionKey: 'operator', prompt: 'agent> ', approval: false },
      },
    });

    const snapshot = await loadAgentConfig({ agentHome });

    expect(snapshot.host).toEqual({
      mode: 'cli',
      websocket: { host: '0.0.0.0', port: 9876, path: '/agent', approval: false },
      cli: { sessionKey: 'operator', prompt: 'agent> ', approval: false },
    });
    expect(Object.isFrozen(snapshot.host)).toBe(true);
    expect(Object.isFrozen(snapshot.host.websocket)).toBe(true);
    expect(Object.isFrozen(snapshot.host.cli)).toBe(true);
  });

  it.each([
    [{ mode: 'both' }, 'host.mode'],
    [{ websocket: { port: 0 } }, 'host.websocket.port'],
    [{ websocket: { path: 'ws' } }, 'host.websocket.path'],
    [{ cli: { sessionKey: ' ' } }, 'host.cli.sessionKey'],
    [{ extra: true }, 'host.extra'],
  ])('rejects an invalid Host projection %#', async (host, expectedField) => {
    await writeConfig({ host });

    await expect(loadAgentConfig({ agentHome })).rejects.toMatchObject({
      code: 'NAMESPACE_INVALID',
      fieldPath: expectedField,
    });
  });

  it('treats a missing Agent Home as an absent config document', async () => {
    const missingAgentHome = join(agentHome, 'not-created');

    const snapshot = await loadAgentConfig({ agentHome: missingAgentHome });

    expect(snapshot.application.agents.defaults).toEqual(DEFAULT_AGENT_CONFIG);
    expect(snapshot.extensions).toEqual({ enabled: true, entries: {} });
  });

  it('projects all known namespaces from one root document', async () => {
    await writeConfig({
      agents: {
        defaults: {
          llm: { maxTokens: 8192 },
          model: { providerId: 'provider-a', modelId: 'model-a' },
        },
        list: [{ id: 'reviewer', default: true, runner: { maxLlmCalls: 3 } }],
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

    const snapshot = await loadAgentConfig({ agentHome });

    expect(snapshot.application.agents.defaults.llm.maxTokens).toBe(8192);
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

    const snapshot = await loadAgentConfig({ agentHome });

    expect(snapshot.application.agents.defaults).toEqual(DEFAULT_AGENT_CONFIG);
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
    [{ agents: { defaults: { llm: { model: 'legacy' } } } }, 'agents.defaults'],
    [{ agents: { defaults: { model: 'unstructured' } } }, 'agents.defaults'],
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

  async function captureConfigError(): Promise<AgentConfigError> {
    try {
      await loadAgentConfig({ agentHome });
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