import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  runAgentHomeInitialization,
  type AgentHomeInitializationOptions,
} from './workflow.js';
import {
  InitializationCancelledError,
  type InitializationPrompter,
} from './prompts.js';

const roots: string[] = [];

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(roots.splice(0).map((root) =>
    rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })));
});

describe('Agent Home initialization', () => {
  it('rejects a non-interactive terminal before mutation', async () => {
    const fixture = await createFixture();

    await expect(runAgentHomeInitialization({
      ...fixture.options,
      interactive: false,
    })).rejects.toThrow('Initialization requires an interactive terminal.');

    await expect(readFile(join(fixture.agentHome, 'config.json'), 'utf8'))
      .rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('cancels before Provider execution without creating Agent Home files', async () => {
    const fixture = await createFixture();
    const prompter = fakePrompter({ select: [new InitializationCancelledError()] });

    await runAgentHomeInitialization({
      ...fixture.options,
      interactive: true,
      prompter,
    });

    await expect(readFile(join(fixture.agentHome, 'config.json'), 'utf8'))
      .rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(join(fixture.agentHome, 'IDENTITY.md'), 'utf8'))
      .rejects.toMatchObject({ code: 'ENOENT' });
    expect(prompter.outro).toHaveBeenCalledWith(
      'Initialization cancelled. Agent Home was not changed.',
    );
  });

  it('disables initialization until the required draft conditions are satisfied', async () => {
    const fixture = await createFixture();
    const prompter = fakePrompter({ select: ['cancel'] });

    await runAgentHomeInitialization({
      ...fixture.options,
      interactive: true,
      prompter,
    });

    expect(prompter.select).toHaveBeenCalledWith(
      'What would you like to configure?',
      expect.arrayContaining([
        expect.objectContaining({
          value: 'save',
          disabled: true,
          hint: 'Verify at least one Model first',
        }),
      ]),
      'providers',
    );
  });

  it('verifies one Built-in Model and publishes config last', async () => {
    const fixture = await createFixture();
    const fetchImpl = vi.fn(async () => new Response([
      `data: ${JSON.stringify({ type: 'response.created' })}`,
      '',
      `data: ${JSON.stringify({ type: 'response.output_text.delta', delta: 'OK' })}`,
      '',
      `data: ${JSON.stringify({
        type: 'response.completed',
        response: { usage: { input_tokens: 1, output_tokens: 1 } },
      })}`,
      '',
      'data: [DONE]',
      '',
    ].join('\n'), {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    }));
    vi.stubGlobal('fetch', fetchImpl);
    const prompter = fakePrompter({
      select: [
        'providers',
        'builtin',
        'none',
        'openai-responses',
        'save',
        'initialize',
      ],
      text: ['https://example.test/v1/', 'model-a'],
      confirm: [false, true],
    });

    await runAgentHomeInitialization({
      ...fixture.options,
      interactive: true,
      prompter,
    });

    const config = JSON.parse(await readFile(join(fixture.agentHome, 'config.json'), 'utf8'));
    expect(config).toMatchObject({
      llm: {
        defaultModel: { providerId: 'builtin', modelId: 'model-a' },
        builtin: {
          baseURL: 'https://example.test/v1',
          models: [{ modelId: 'model-a', protocol: 'openai-responses' }],
        },
      },
      agents: {
        steeringEnabled: false,
        maxSubagentDepth: 1,
        defaults: {
          tools: {
            allow: [
              'list_dir',
              'read_file',
              'file_search',
              'grep_search',
              'write_file',
              'edit_file',
              'apply_patch',
              'web_fetch',
            ],
            deny: [],
          },
        },
        list: [
          { id: 'reviewer' },
          { id: 'explorer' },
          { id: 'researcher' },
        ],
      },
    });
    for (const agent of config.agents.list) {
      expect(config.agents.defaults.tools.allow)
        .toEqual(expect.arrayContaining(agent.tools.allow));
    }
    expect(config.llm.builtin).not.toHaveProperty('apiKey');
    expect(config).not.toHaveProperty('extensions');
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://example.test/v1/responses',
      expect.any(Object),
    );
    await expect(readFile(join(fixture.agentHome, 'IDENTITY.md'), 'utf8'))
      .resolves.toContain('# Identity');
    await expect(readFile(
      join(fixture.agentHome, 'agents', 'reviewer', 'IDENTITY.md'),
      'utf8',
    )).resolves.toContain('reviewer agent');
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(prompter.outro).toHaveBeenCalledWith(
      expect.stringContaining('Agent Home initialized successfully.'),
    );
  });

  it('returns from final review to edit Runtime settings before publication', async () => {
    const fixture = await createFixture();
    vi.stubGlobal('fetch', vi.fn(async () => successfulResponsesCall()));
    const prompter = fakePrompter({
      select: [
        'providers',
        'builtin',
        'none',
        'openai-responses',
        'save',
        'back',
        'runtime',
        'save',
        'initialize',
      ],
      text: ['https://example.test/v1', 'model-a', '7'],
      confirm: [false, true],
    });

    await runAgentHomeInitialization({
      ...fixture.options,
      interactive: true,
      prompter,
    });

    const config = JSON.parse(await readFile(join(fixture.agentHome, 'config.json'), 'utf8'));
    expect(config.agents.maxLlmCallsPerTurn).toBe(7);
    expect(prompter.note).toHaveBeenCalledWith(
      expect.stringContaining('Maximum LLM calls per Turn: unlimited'),
      'Initialization summary',
    );
    expect(prompter.note).toHaveBeenCalledWith(
      expect.stringContaining('Maximum LLM calls per Turn: 7'),
      'Initialization summary',
    );
  });

  it('preserves an existing config when editing is declined', async () => {
    const fixture = await createFixture();
    await writeFile(join(fixture.agentHome, 'config.json'), '{}\n', 'utf8');
    const prompter = fakePrompter({ confirm: [false] });

    await runAgentHomeInitialization({
      ...fixture.options,
      interactive: true,
      prompter,
    });

    await expect(readFile(join(fixture.agentHome, 'config.json'), 'utf8'))
      .resolves.toBe('{}\n');
    expect(prompter.outro).toHaveBeenCalledWith('Agent Home was not changed.');
  });

  it('updates Runtime settings while preserving untouched existing sections', async () => {
    const fixture = await createFixture();
    const existing = {
      llm: {
        defaultModel: { providerId: 'builtin', modelId: 'existing-model' },
        builtin: {
          baseURL: 'https://existing.test/v1',
          models: [{ modelId: 'existing-model', protocol: 'openai-responses', endpoint: 'responses' }],
        },
      },
      agents: {
        steeringEnabled: true,
        maxLlmCallsPerTurn: 3,
        maxSubagentDepth: 2,
        list: [{ id: 'custom', description: 'Custom Agent' }],
      },
      logger: { minLevel: 'info' },
      extensions: {
        entries: {
          'websocket-channel': { config: { port: 9000 } },
        },
      },
    };
    await writeFile(
      join(fixture.agentHome, 'config.json'),
      `${JSON.stringify(existing, null, 2)}\n`,
      'utf8',
    );
    const prompter = fakePrompter({
      select: ['runtime', 'save', 'initialize'],
      text: ['9'],
      confirm: [true],
    });

    await runAgentHomeInitialization({
      ...fixture.options,
      interactive: true,
      prompter,
    });

    const saved = JSON.parse(await readFile(join(fixture.agentHome, 'config.json'), 'utf8'));
    expect(saved).toEqual({
      ...existing,
      agents: {
        ...existing.agents,
        maxLlmCallsPerTurn: 9,
      },
    });
  });

  it('restores recommended Root Tool defaults without changing other Agent defaults', async () => {
    const fixture = await createFixture();
    const existing = {
      llm: {
        defaultModel: { providerId: 'builtin', modelId: 'existing-model' },
        builtin: {
          baseURL: 'https://existing.test/v1',
          models: [{ modelId: 'existing-model', protocol: 'openai-responses' }],
        },
      },
      agents: {
        steeringEnabled: true,
        maxLlmCallsPerTurn: 3,
        maxSubagentDepth: 2,
        defaults: {
          memory: { enabled: false },
          tools: { allow: ['custom_tool'], deny: ['write_file'] },
        },
        list: [{ id: 'custom', description: 'Custom Agent' }],
      },
    };
    await writeFile(
      join(fixture.agentHome, 'config.json'),
      `${JSON.stringify(existing, null, 2)}\n`,
      'utf8',
    );
    const prompter = fakePrompter({
      select: ['restore-root-tools', 'save', 'initialize'],
      confirm: [true],
    });

    await runAgentHomeInitialization({
      ...fixture.options,
      interactive: true,
      prompter,
    });

    const saved = JSON.parse(await readFile(join(fixture.agentHome, 'config.json'), 'utf8'));
    expect(saved.agents).toEqual({
      ...existing.agents,
      defaults: {
        memory: { enabled: false },
        tools: {
          allow: [
            'list_dir',
            'read_file',
            'file_search',
            'grep_search',
            'write_file',
            'edit_file',
            'apply_patch',
            'web_fetch',
          ],
          deny: [],
        },
      },
    });
    expect(prompter.note).toHaveBeenCalledWith(
      'Root Agent Tool permissions will be restored to the recommended defaults.',
      'Agent defaults',
    );
  });

  it('replaces the LLM section while preserving untouched Provider Extension entries', async () => {
    const fixture = await createFixture();
    await installProviderExtension(fixture.options.pathContext.installDir, 'fixture-provider');
    const existing = {
      llm: {
        defaultModel: { providerId: 'builtin', modelId: 'old-model' },
        builtin: {
          baseURL: 'https://old.test/v1',
          models: [{ modelId: 'old-model', protocol: 'openai-responses' }],
        },
      },
      agents: {
        steeringEnabled: true,
        maxSubagentDepth: 2,
        list: [{ id: 'custom', description: 'Custom Agent' }],
      },
      logger: { minLevel: 'info' },
      extensions: {
        enabled: true,
        entries: {
          'fixture-provider': { config: { old: true } },
          'websocket-channel': { config: { port: 9000 } },
        },
      },
    };
    await writeFile(
      join(fixture.agentHome, 'config.json'),
      `${JSON.stringify(existing, null, 2)}\n`,
      'utf8',
    );
    vi.stubGlobal('fetch', vi.fn(async () => successfulResponsesCall()));
    const prompter = fakePrompter({
      select: [
        'providers',
        'builtin',
        'none',
        'openai-responses',
        'save',
        'initialize',
      ],
      text: ['https://new.test/v1', 'new-model'],
      confirm: [true, true, false, true],
    });

    await runAgentHomeInitialization({
      ...fixture.options,
      interactive: true,
      prompter,
    });

    const saved = JSON.parse(await readFile(join(fixture.agentHome, 'config.json'), 'utf8'));
    expect(saved.llm).toEqual({
      defaultModel: { providerId: 'builtin', modelId: 'new-model' },
      builtin: {
        baseURL: 'https://new.test/v1',
        models: [{ modelId: 'new-model', protocol: 'openai-responses' }],
      },
    });
    expect(saved.agents).toEqual(existing.agents);
    expect(saved.logger).toEqual(existing.logger);
    expect(saved.extensions).toEqual(existing.extensions);
  });

  it.each(['providers', 'extensions'])(
    'confirms global enablement before verifying an Extension through %s',
    async (action) => {
      const fixture = await createFixture();
      await installProviderExtension(fixture.options.pathContext.installDir, 'fixture-provider');
      await writeFile(join(fixture.agentHome, 'config.json'), JSON.stringify({
        extensions: { enabled: false },
      }));
      const lifecycle = { factory: 0, create: 0, start: 0, chat: 0, stop: 0 };
      (globalThis as Record<string, unknown>)['__ahiFixtureLifecycle'] = lifecycle;
      const prompter = fakePrompter({
        select: [action, 'extension:fixture-provider', 'save', 'initialize'],
        text: ['model-a'],
        confirm: [true, true, true, false, true],
      });
      try {
        await runAgentHomeInitialization({
          ...fixture.options, interactive: true, prompter,
        });
      } finally {
        delete (globalThis as Record<string, unknown>)['__ahiFixtureLifecycle'];
      }
      const saved = JSON.parse(await readFile(join(fixture.agentHome, 'config.json'), 'utf8'));
      expect(saved.extensions.enabled).toBe(true);
      expect(saved.llm.defaultModel).toEqual({ providerId: 'fixture', modelId: 'model-a' });
      expect(lifecycle.chat).toBe(1);
      expect(prompter.confirm).toHaveBeenCalledWith(
        'Extensions are globally disabled. Enable Extensions when saving this Provider?',
        false,
      );
    },
  );

  it('leaves globally disabled Extensions unchanged when enablement is declined', async () => {
    const fixture = await createFixture();
    await installProviderExtension(fixture.options.pathContext.installDir, 'fixture-provider');
    const original = JSON.stringify({ extensions: { enabled: false } });
    await writeFile(join(fixture.agentHome, 'config.json'), original);
    const prompter = fakePrompter({
      select: ['providers', 'extension:fixture-provider', 'cancel'],
      confirm: [true, true, false],
    });
    await runAgentHomeInitialization({ ...fixture.options, interactive: true, prompter });
    expect(await readFile(join(fixture.agentHome, 'config.json'), 'utf8')).toBe(original);
    expect(prompter.text).not.toHaveBeenCalled();
  });

  it('does not publish global enablement after discarding verified Extension changes', async () => {
    const fixture = await createFixture();
    await installProviderExtension(fixture.options.pathContext.installDir, 'fixture-provider');
    await writeFile(join(fixture.agentHome, 'config.json'), JSON.stringify({
      extensions: { enabled: false },
    }));
    const lifecycle = { factory: 0, create: 0, start: 0, chat: 0, stop: 0 };
    (globalThis as Record<string, unknown>)['__ahiFixtureLifecycle'] = lifecycle;
    const prompter = fakePrompter({
      select: [
        'providers', 'extension:fixture-provider', 'discard-llm',
        'runtime', 'save', 'initialize',
      ],
      text: ['model-a', '5'],
      confirm: [true, true, true, false, true],
    });
    try {
      await runAgentHomeInitialization({ ...fixture.options, interactive: true, prompter });
    } finally {
      delete (globalThis as Record<string, unknown>)['__ahiFixtureLifecycle'];
    }
    const saved = JSON.parse(await readFile(join(fixture.agentHome, 'config.json'), 'utf8'));
    expect(saved.extensions).toEqual({ enabled: false });
    expect(saved).not.toHaveProperty('llm');
  });

  it.each([
    ['provider', 'literal'], ['provider', 'environment'], ['provider', 'none'],
    ['channel', 'literal'], ['channel', 'environment'], ['channel', 'none'],
  ])('summarizes %s Extension credentials from %s without exposing values', async (kind, source) => {
    const fixture = await createFixture();
    const id = `fixture-${kind}`;
    const properties = { token: { type: 'string', writeOnly: true } };
    if (kind === 'provider') {
      await installProviderExtension(fixture.options.pathContext.installDir, id, properties);
    } else {
      await installUnsupportedExtension(fixture.options.pathContext.installDir, id, properties);
    }
    await writeFile(join(fixture.agentHome, 'config.json'), '{}');
    const secret = 'private-extension-credential';
    const lifecycle = { factory: 0, create: 0, start: 0, chat: 0, stop: 0 };
    (globalThis as Record<string, unknown>)['__ahiFixtureLifecycle'] = lifecycle;
    const prompter = fakePrompter({
      select: ['extensions', `extension:${id}`, source, 'save', 'initialize'],
      text: [
        ...(source === 'none' ? [] : [source === 'literal' ? secret : 'EXT_TOKEN']),
        ...(kind === 'provider' ? ['model-a'] : []),
      ],
      confirm: kind === 'provider' ? [true, true, false, true] : [true],
    });
    try {
      await runAgentHomeInitialization({
        ...fixture.options, environment: { EXT_TOKEN: secret }, interactive: true, prompter,
      });
    } finally {
      delete (globalThis as Record<string, unknown>)['__ahiFixtureLifecycle'];
    }
    const summary = prompter.note.mock.calls.find((call) =>
      call[1] === 'Initialization summary')?.[0];
    expect(summary).toContain(`${id} / token: ${source === 'literal'
      ? 'entered directly'
      : source === 'environment' ? 'environment variable EXT_TOKEN' : 'not configured'}`);
    expect(summary).not.toContain(secret);
    expect(summary.includes('stored as plaintext in config.json')).toBe(source === 'literal');
  });

  it.each(['literal', 'environment', 'none'])(
    'summarizes Built-in credential source %s without exposing its value',
    async (source) => {
      const fixture = await createFixture();
      vi.stubGlobal('fetch', vi.fn(async () => successfulResponsesCall()));
      const secret = 'private-fixture-credential';
      const prompter = fakePrompter({
        select: ['providers', 'builtin', source, 'openai-responses', 'save', 'initialize'],
        text: [
          'https://example.test/v1',
          ...(source === 'none' ? [] : [source === 'literal' ? secret : 'API_TOKEN']),
          'model-a',
        ],
        confirm: [false, true],
      });
      await runAgentHomeInitialization({
        ...fixture.options, environment: { API_TOKEN: secret }, interactive: true, prompter,
      });
      const summary = prompter.note.mock.calls.find((call) =>
        call[1] === 'Initialization summary')?.[0];
      expect(summary).toContain(source === 'literal'
        ? 'Built-in API key: entered directly'
        : source === 'environment'
          ? 'Built-in API key: environment variable API_TOKEN'
          : 'Built-in API key: not configured');
      expect(summary).not.toContain(secret);
      if (source === 'literal') {
        expect(summary).toContain('stored as plaintext in config.json');
      } else {
        expect(summary).not.toContain('stored as plaintext');
      }
    },
  );

  it('starts only the selected Provider Extension and stops it after verification', async () => {
    const fixture = await createFixture();
    await installProviderExtension(fixture.options.pathContext.installDir, 'fixture-provider');
    const lifecycle = { factory: 0, create: 0, start: 0, chat: 0, stop: 0 };
    (globalThis as Record<string, unknown>)['__ahiFixtureLifecycle'] = lifecycle;
    const prompter = fakePrompter({
      select: ['extensions', 'extension:fixture-provider', 'save', 'initialize'],
      text: ['model-a'],
      confirm: [false, true],
    });

    try {
      await runAgentHomeInitialization({
        ...fixture.options,
        interactive: true,
        prompter,
      });
    } finally {
      delete (globalThis as Record<string, unknown>)['__ahiFixtureLifecycle'];
    }

    expect(lifecycle).toEqual({ factory: 1, create: 1, start: 1, chat: 1, stop: 1 });
    const config = JSON.parse(await readFile(join(fixture.agentHome, 'config.json'), 'utf8'));
    expect(config.llm.defaultModel).toEqual({
      providerId: 'fixture',
      modelId: 'model-a',
    });
    expect(config).not.toHaveProperty('llm.builtin');
    expect(config.extensions).toEqual({
      entries: {
        'fixture-provider': { config: {} },
      },
    });
  });

  it('allows Schema configuration for Extensions without a live verification policy', async () => {
    const fixture = await createFixture();
    await installUnsupportedExtension(
      fixture.options.pathContext.installDir,
      'websocket-channel',
    );
    const prompter = fakePrompter({
      select: ['extensions', 'extension:websocket-channel', 'cancel'],
    });

    await runAgentHomeInitialization({
      ...fixture.options,
      interactive: true,
      prompter,
    });

    expect(prompter.select).toHaveBeenCalledWith(
      'Select an Extension to configure',
      expect.arrayContaining([
        expect.objectContaining({
          value: 'extension:websocket-channel',
          label: 'WebSocket Channel',
          hint: 'Schema configuration — no declared live verification',
        }),
      ]),
      'back',
    );
  });

  it('persists a Schema-configured Extension without bypassing required LLM verification', async () => {
    const fixture = await createFixture();
    await installUnsupportedExtension(
      fixture.options.pathContext.installDir,
      'websocket-channel',
    );
    vi.stubGlobal('fetch', vi.fn(async () => successfulResponsesCall()));
    const prompter = fakePrompter({
      select: [
        'extensions',
        'extension:websocket-channel',
        'providers',
        'builtin',
        'none',
        'openai-responses',
        'save',
        'initialize',
      ],
      text: ['https://example.test/v1', 'model-a'],
      confirm: [false, true],
    });

    await runAgentHomeInitialization({
      ...fixture.options,
      interactive: true,
      prompter,
    });

    const config = JSON.parse(await readFile(join(fixture.agentHome, 'config.json'), 'utf8'));
    expect(config.extensions.entries).toEqual({
      'websocket-channel': { config: {} },
    });
  });

  it('retains Built-in and Extension Providers and selects a verified default', async () => {
    const fixture = await createFixture();
    await installProviderExtension(fixture.options.pathContext.installDir, 'fixture-provider');
    const lifecycle = { factory: 0, create: 0, start: 0, chat: 0, stop: 0 };
    (globalThis as Record<string, unknown>)['__ahiFixtureLifecycle'] = lifecycle;
    vi.stubGlobal('fetch', vi.fn(async () => successfulResponsesCall()));
    const prompter = fakePrompter({
      select: [
        'providers',
        'builtin',
        'none',
        'openai-responses',
        'providers',
        'extension:fixture-provider',
        'default-model',
        'model:1',
        'save',
        'initialize',
      ],
      text: ['https://example.test/v1', 'builtin-model', 'model-a'],
      confirm: [
        false,
        true,
        false,
        true,
      ],
    });

    try {
      await runAgentHomeInitialization({
        ...fixture.options,
        interactive: true,
        prompter,
      });
    } finally {
      delete (globalThis as Record<string, unknown>)['__ahiFixtureLifecycle'];
    }

    const config = JSON.parse(await readFile(join(fixture.agentHome, 'config.json'), 'utf8'));
    expect(config.llm.defaultModel).toEqual({
      providerId: 'fixture',
      modelId: 'model-a',
    });
    expect(config.llm.builtin.models).toEqual([
      { modelId: 'builtin-model', protocol: 'openai-responses' },
    ]);
    expect(config.extensions.entries).toEqual({
      'fixture-provider': { config: {} },
    });
    expect(lifecycle).toEqual({ factory: 1, create: 1, start: 1, chat: 1, stop: 1 });
  });

  it('distinguishes an Extension named builtin from the built-in Provider', async () => {
    const fixture = await createFixture();
    await installProviderExtension(fixture.options.pathContext.installDir, 'builtin');
    const lifecycle = { factory: 0, create: 0, start: 0, chat: 0, stop: 0 };
    (globalThis as Record<string, unknown>)['__ahiFixtureLifecycle'] = lifecycle;
    const prompter = fakePrompter({
      select: ['providers', 'extension:builtin', 'save', 'initialize'],
      text: ['model-a'],
      confirm: [false, true],
    });

    try {
      await runAgentHomeInitialization({
        ...fixture.options,
        interactive: true,
        prompter,
      });
    } finally {
      delete (globalThis as Record<string, unknown>)['__ahiFixtureLifecycle'];
    }

    const config = JSON.parse(await readFile(join(fixture.agentHome, 'config.json'), 'utf8'));
    expect(config).not.toHaveProperty('llm.builtin');
    expect(config.extensions.entries).toEqual({
      builtin: { config: {} },
    });
    expect(lifecycle).toEqual({ factory: 1, create: 1, start: 1, chat: 1, stop: 1 });
  });

  it('persists only Models whose individual live call succeeds', async () => {
    const fixture = await createFixture();
    let request = 0;
    vi.stubGlobal('fetch', vi.fn(async () => {
      request += 1;
      return request === 1
        ? successfulResponsesCall()
        : new Response('unavailable', { status: 503 });
    }));
    const prompter = fakePrompter({
      select: [
        'providers',
        'builtin',
        'none',
        'openai-responses',
        'openai-responses',
        'save',
        'initialize',
      ],
      text: ['https://example.test/v1', 'working-model', 'failed-model'],
      confirm: [true, false, true],
    });

    await runAgentHomeInitialization({
      ...fixture.options,
      interactive: true,
      prompter,
    });

    const config = JSON.parse(await readFile(join(fixture.agentHome, 'config.json'), 'utf8'));
    expect(config.llm.defaultModel).toEqual({
      providerId: 'builtin',
      modelId: 'working-model',
    });
    expect(config.llm.builtin.models).toEqual([
      { modelId: 'working-model', protocol: 'openai-responses' },
    ]);
  });
});

async function createFixture(): Promise<Readonly<{
  agentHome: string;
  options: AgentHomeInitializationOptions;
}>> {
  const root = await mkdtemp(join(tmpdir(), 'my-agent-initializer-'));
  roots.push(root);
  const installDir = join(root, 'installation');
  const agentHome = join(root, 'agent-home');
  await Promise.all([
    mkdir(installDir, { recursive: true }),
    mkdir(agentHome, { recursive: true }),
  ]);
  return Object.freeze({
    agentHome,
    options: {
      pathContext: Object.freeze({ installDir, agentHome }),
      environment: {},
    },
  });
}

async function installProviderExtension(
  installDir: string,
  extensionId: string,
  properties: Record<string, unknown> = {},
): Promise<void> {
  const directory = join(installDir, 'extensions', extensionId);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'extension.json'), JSON.stringify({
    manifestVersion: 1,
    id: extensionId,
    name: 'Fixture Provider',
    version: '1.0.0',
    entry: 'entry.js',
    contributes: ['provider'],
    configSchema: {
      $schema: 'http://json-schema.org/draft-07/schema#',
      type: 'object',
      additionalProperties: false,
      properties,
    },
  }), 'utf8');
  await writeFile(join(directory, 'entry.js'), `
export function createExtension() {
  const lifecycle = globalThis.__ahiFixtureLifecycle;
  lifecycle.factory += 1;
  return {
    unitId: ${JSON.stringify(extensionId)},
    source: 'external',
    orderKey: ${JSON.stringify(extensionId)},
    required: false,
    initiallyEnabled: true,
    dependencies: [],
    create() {
      lifecycle.create += 1;
      const invocationPort = {
        async chat() {
          lifecycle.chat += 1;
          return {
            content: [{ type: 'text', text: 'OK' }],
            toolCalls: [],
            stopReason: 'end_turn',
            usage: { inputTokens: 1, outputTokens: 1 },
          };
        },
        async *chatStream() {},
      };
      return {
        registration: {
          id: ${JSON.stringify(extensionId)},
          source: 'external',
          register(api) {
            api.registerProvider({
              id: 'fixture',
              displayName: 'Fixture',
              protocol: 'fixture',
              models: [{ modelId: 'model-a' }],
              invocationPort,
              resolveConnection() {
                return { ok: true, connection: { endpointId: 'fixture' } };
              },
              resolveModel(modelId, connection) {
                return modelId === 'model-a'
                  ? {
                      ok: true,
                      descriptor: {
                        identity: { providerId: 'fixture', modelId },
                        protocol: 'fixture',
                        connection,
                        facts: { effectiveContextLimit: 8192 },
                      },
                    }
                  : { ok: false, category: 'model_rejected', message: 'unknown' };
              },
            });
          },
        },
        start() { lifecycle.start += 1; },
        stop() { lifecycle.stop += 1; },
      };
    },
  };
}
`, 'utf8');
}

async function installUnsupportedExtension(
  installDir: string,
  extensionId: string,
  properties: Record<string, unknown> = {},
): Promise<void> {
  const directory = join(installDir, 'extensions', extensionId);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'extension.json'), JSON.stringify({
    manifestVersion: 1,
    id: extensionId,
    name: 'WebSocket Channel',
    version: '1.0.0',
    entry: 'entry.js',
    configSchema: {
      $schema: 'http://json-schema.org/draft-07/schema#',
      type: 'object',
      additionalProperties: false,
      properties,
    },
  }), 'utf8');
  await writeFile(join(directory, 'entry.js'), 'export function createExtension() {}\n', 'utf8');
}

function successfulResponsesCall(): Response {
  return new Response([
    `data: ${JSON.stringify({ type: 'response.created' })}`,
    '',
    `data: ${JSON.stringify({ type: 'response.output_text.delta', delta: 'OK' })}`,
    '',
    `data: ${JSON.stringify({
      type: 'response.completed',
      response: { usage: { input_tokens: 1, output_tokens: 1 } },
    })}`,
    '',
    'data: [DONE]',
    '',
  ].join('\n'), {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

function fakePrompter(values: {
  readonly select?: readonly (string | Error)[];
  readonly text?: readonly (string | Error)[];
  readonly confirm?: readonly (boolean | Error)[];
}): InitializationPrompter & {
  readonly intro: ReturnType<typeof vi.fn>;
  readonly outro: ReturnType<typeof vi.fn>;
  readonly note: ReturnType<typeof vi.fn>;
} {
  const selectValues = [...(values.select ?? [])];
  const textValues = [...(values.text ?? [])];
  const confirmValues = [...(values.confirm ?? [])];
  const next = <T>(queue: (T | Error)[]): T => {
    const value = queue.shift();
    if (value instanceof Error) throw value;
    if (value === undefined) throw new Error('Fake prompt queue is empty.');
    return value;
  };
  return {
    intro: vi.fn(),
    outro: vi.fn(),
    note: vi.fn(),
    select: vi.fn(async () => next(selectValues)),
    confirm: vi.fn(async () => next(confirmValues)),
    text: vi.fn(async () => next(textValues)),
    progress: vi.fn(async (_message, operation) => operation()),
  };
}
