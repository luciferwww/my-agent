import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import {
  createBuiltinHostUnits,
  parseStandaloneHostArguments,
  runStandaloneHost,
  validateStandaloneHostComposition,
} from './standalone-host.js';
import type { AgentConfigSnapshot } from '../../platform/config/index.js';
import { ensureAgentConfigDocument, loadAgentConfig } from '../../platform/config/index.js';
import type { RuntimeAppOptions } from '../../runtime/index.js';

describe('standalone Host arguments', () => {
  it('accepts startup without arguments', () => {
    const parsed = parseStandaloneHostArguments([]);

    expect(parsed).toEqual({ builtinChannels: ['websocket'] });
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed.builtinChannels)).toBe(true);
  });

  it.each([
    [['-ah', 'C:/agent-home'], 'C:/agent-home'],
    [['--agent-home', 'C:/agent-home'], 'C:/agent-home'],
    [['--agent-home=C:/agent-home'], 'C:/agent-home'],
    [['--agent-home=profiles=one'], 'profiles=one'],
  ])('accepts one Agent Home override: %j', (argv, agentHomeArgument) => {
    expect(parseStandaloneHostArguments(argv)).toEqual({
      agentHomeArgument,
      builtinChannels: ['websocket'],
    });
  });

  it.each([
    [['-bc', 'websocket'], ['websocket']],
    [['--builtin-channels', 'cli'], ['cli']],
    [['--builtin-channels=websocket,cli'], ['websocket', 'cli']],
    [['-bc', 'cli,websocket'], ['websocket', 'cli']],
    [['--builtin-channels', 'none'], []],
    [['-bc', 'cli', '--agent-home=C:/agent-home'], ['cli']],
    [['--agent-home', 'C:/agent-home', '--builtin-channels=none'], []],
  ] as const)('accepts and canonicalizes Builtin Channels: %j', (argv, builtinChannels) => {
    const parsed = parseStandaloneHostArguments(argv);

    expect(parsed.builtinChannels).toEqual(builtinChannels);
    expect(Object.isFrozen(parsed.builtinChannels)).toBe(true);
  });

  it.each([
    ['--workspace', 'C:/workspace'],
    ['--workspace=C:/workspace'],
    ['--agent-home'],
    ['--agent-home='],
    ['--agent-home', '--unknown'],
    ['--agent-home', 'one', '--agent-home=two'],
    ['-ah', 'one', '--agent-home=two'],
    ['-ah'],
    ['-ah=one'],
    ['position'],
    ['--unknown'],
    ['-bc'],
    ['--builtin-channels'],
    ['--builtin-channels='],
    ['-bc', 'websocket,'],
    ['-bc', ',websocket'],
    ['-bc', 'websocket,,cli'],
    ['-bc', 'websocket,websocket'],
    ['-bc', 'none,cli'],
    ['-bc', 'WebSocket'],
    ['-bc', ' websocket'],
    ['-bc=cli'],
    ['-bc', 'cli', '--builtin-channels=websocket'],
  ])('rejects retired or unknown arguments: %s', (...argv) => {
    expect(() => parseStandaloneHostArguments(argv)).toThrow('HOST_ARGUMENT_INVALID');
  });
});

describe('standalone Host composition', () => {
  it.each([
    [['websocket'], ['builtin-websocket-channel']],
    [['cli'], ['builtin-cli-channel']],
    [['cli', 'websocket'], ['builtin-websocket-channel', 'builtin-cli-channel']],
    [[], []],
  ] as const)('creates the canonical Builtin Unit set for %j', (channels, ids) => {
    const units = createBuiltinHostUnits(channels);

    expect(units.map((unit) => unit.unitId)).toEqual(ids);
    expect(Object.isFrozen(units)).toBe(true);
  });

  it('rejects CLI with Console Logger and accepts CLI with File-only Logger', () => {
    const snapshot = (consoleEnabled: boolean): AgentConfigSnapshot => ({
      application: {
        agents: { defaults: {} as never, list: [] },
        logger: { console: { enabled: consoleEnabled }, file: { enabled: true } },
      },
      extensions: { enabled: true, entries: {} },
    });

    expect(() => validateStandaloneHostComposition(snapshot(true), ['cli']))
      .toThrow('HOST_OUTPUT_CONFLICT');
    expect(() => validateStandaloneHostComposition(snapshot(true), ['websocket', 'cli']))
      .toThrow('HOST_OUTPUT_CONFLICT');
    expect(() => validateStandaloneHostComposition(snapshot(false), ['cli'])).not.toThrow();
    expect(() => validateStandaloneHostComposition(snapshot(true), ['websocket'])).not.toThrow();
  });

  it('rejects a CLI output conflict before acquisition and Runtime creation', async () => {
    const prepareAcquisition = vi.fn();
    const createRuntime = vi.fn();

    await expect(runStandaloneHost({
      argv: ['-bc', 'cli'],
      env: {},
      resolvePathContext: async () => createPathContext(),
      ensureConfig: async () => undefined,
      loadConfig: async () => createSnapshot(true),
      prepareAcquisition,
      createRuntime,
    })).rejects.toThrow('HOST_OUTPUT_CONFLICT');

    expect(prepareAcquisition).not.toHaveBeenCalled();
    expect(createRuntime).not.toHaveBeenCalled();
  });

  it('rejects invalid arguments before path and configuration side effects', async () => {
    const resolvePathContext = vi.fn();
    const ensureConfig = vi.fn();

    await expect(runStandaloneHost({
      argv: ['-bc', 'websocket,websocket'],
      resolvePathContext,
      ensureConfig,
    })).rejects.toThrow('HOST_ARGUMENT_INVALID');

    expect(resolvePathContext).not.toHaveBeenCalled();
    expect(ensureConfig).not.toHaveBeenCalled();
  });

  it('hands one snapshot and one injected environment through acquisition and Runtime', async () => {
    const events: string[] = [];
    const snapshot = createSnapshot();
    const stderr = { write: vi.fn(() => true) };
    const environment = {
      MY_AGENT_PROVIDER: 'injected-provider',
      MY_AGENT_MODEL: 'injected-model',
      MY_AGENT_HOME: 'C:/retired-home',
      MY_AGENT_WORKSPACE: 'C:/retired-workspace',
    };
    const pathContext = Object.freeze({
      installDir: 'C:/installation',
      agentHome: 'C:/agent-home',
    });
    const resolvePathContext = vi.fn(async () => {
      events.push('paths');
      return pathContext;
    });
    const ensureConfig = vi.fn(async () => { events.push('bootstrap'); });
    const loadConfig = vi.fn(async () => {
      events.push('load');
      return snapshot;
    });
    const prepareAcquisition = vi.fn(async () => {
      events.push('acquisition');
      return { result: { loadedUnits: Object.freeze([]), diagnostics: Object.freeze([]) } };
    });
    const waitForChannelCompletion = vi.fn(async () => ({
      outcome: 'closed' as const,
      reason: 'transport_closed' as const,
    }));
    const runtime = {
      application: { waitForChannelCompletion },
      close: vi.fn(),
    };
    const createRuntime = vi.fn(async (runtimeOptions: RuntimeAppOptions) => {
      events.push('Runtime');
      runtimeOptions.onEvent?.({
        type: 'warning',
        info: {
          scope: 'startup',
          severity: 'warning',
          code: 'UNIT_INVALID',
          message: 'secret detail',
          unitId: 'relay',
        },
      });
      return runtime as never;
    });
    const shutdown = vi.fn(async () => ({ outcome: 'completed' } as never));
    const createHost = vi.fn(() => ({
      shutdown,
      completion: new Promise<never>(() => undefined),
      dispose: vi.fn(),
    }));

    await runStandaloneHost({
      argv: [],
      env: environment,
      stderr,
      resolvePathContext,
      ensureConfig,
      loadConfig,
      prepareAcquisition,
      createRuntime,
      createHost: createHost as never,
    });

    expect(resolvePathContext).toHaveBeenCalledOnce();
  expect(ensureConfig).toHaveBeenCalledWith({ agentHome: pathContext.agentHome });
    expect(loadConfig).toHaveBeenCalledWith({ agentHome: pathContext.agentHome });
  expect(events).toEqual(['paths', 'bootstrap', 'load', 'acquisition', 'Runtime']);
    expect(prepareAcquisition).toHaveBeenCalledWith(
      join(pathContext.installDir, 'extensions'),
      snapshot.extensions,
      environment,
    );
    expect(createRuntime).toHaveBeenCalledWith(expect.objectContaining({
      agentHome: pathContext.agentHome,
      applicationConfig: snapshot.application,
      envOverrides: {
        model: { providerId: 'injected-provider', modelId: 'injected-model' },
      },
    }));
    expect(waitForChannelCompletion).toHaveBeenCalledWith('websocket');
    expect(shutdown).toHaveBeenCalledWith('builtin websocket channel completed');
    expect(stderr.write).toHaveBeenCalledWith(
      'Runtime warning: code=UNIT_INVALID unitId="relay"\n',
    );
    expect(stderr.write).not.toHaveBeenCalledWith(expect.stringContaining('secret detail'));
  });

  it('reads Agent Home config once for acquisition and Runtime without reading project config', async () => {
    const temporaryRoot = await mkdtemp(join(tmpdir(), 'standalone-host-config-'));
    const agentHome = join(temporaryRoot, 'agent-home');
    const startupCwd = join(temporaryRoot, 'project');
    await mkdir(agentHome);
    await mkdir(startupCwd);
    await writeFile(join(agentHome, 'config.json'), JSON.stringify({
      agents: { defaults: { llm: { maxTokens: 8192 } } },
      extensions: { enabled: false },
    }), 'utf8');
    await writeFile(join(startupCwd, 'config.json'), JSON.stringify({
      agents: { defaults: { llm: { maxTokens: 1 } } },
      extensions: { enabled: true },
    }), 'utf8');
    const readTextFile = vi.fn((path: string) => readFile(path, 'utf8'));
    const prepareAcquisition = vi.fn(async () => ({
      result: { loadedUnits: Object.freeze([]), diagnostics: Object.freeze([]) },
    }));
    const createRuntime = vi.fn(async () => ({
      application: { waitForChannelCompletion: vi.fn() },
      close: vi.fn(),
    }) as never);

    try {
      await runStandaloneHost({
        argv: ['--builtin-channels', 'none'],
        env: {},
        resolvePathContext: async () => Object.freeze({
          installDir: join(temporaryRoot, 'installation'),
          agentHome,
        }),
        ensureConfig: (options) => ensureAgentConfigDocument(options),
        loadConfig: (options) => loadAgentConfig(options, { readTextFile }),
        prepareAcquisition,
        createRuntime,
        createHost: (() => ({
          shutdown: vi.fn(),
          completion: Promise.resolve({ outcome: 'completed' } as never),
          dispose: vi.fn(),
        })) as never,
      });

      expect(readTextFile).toHaveBeenCalledTimes(1);
      expect(readTextFile).toHaveBeenCalledWith(join(agentHome, 'config.json'));
      expect(prepareAcquisition).toHaveBeenCalledWith(
        join(temporaryRoot, 'installation', 'extensions'),
        expect.objectContaining({ enabled: false }),
        {},
      );
      expect(createRuntime).toHaveBeenCalledWith(expect.objectContaining({
        agentHome,
        applicationConfig: expect.objectContaining({
          agents: expect.objectContaining({
            defaults: expect.objectContaining({
              llm: expect.objectContaining({ maxTokens: 8192 }),
            }),
          }),
        }),
      }));
      await expect(readFile(join(startupCwd, 'config.json'), 'utf8'))
        .resolves.toContain('"maxTokens":1');
      await expect(readFile(join(agentHome, 'config.json'), 'utf8'))
        .resolves.toContain('"maxTokens":8192');
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  });

  it('stops before configuration loading, acquisition, and Runtime when bootstrap fails', async () => {
    const failure = new Error('bootstrap failed');
    const loadConfig = vi.fn();
    const prepareAcquisition = vi.fn();
    const createRuntime = vi.fn();

    await expect(runStandaloneHost({
      argv: [],
      env: {},
      resolvePathContext: async () => createPathContext(),
      ensureConfig: async () => { throw failure; },
      loadConfig,
      prepareAcquisition,
      createRuntime,
    })).rejects.toBe(failure);

    expect(loadConfig).not.toHaveBeenCalled();
    expect(prepareAcquisition).not.toHaveBeenCalled();
    expect(createRuntime).not.toHaveBeenCalled();
  });

  it('keeps generated config but creates no Runtime-owned state when acquisition fails', async () => {
    const temporaryRoot = await mkdtemp(join(tmpdir(), 'standalone-host-bootstrap-failure-'));
    const agentHome = join(temporaryRoot, 'agent-home');
    const failure = new Error('acquisition failed');
    const createRuntime = vi.fn();

    try {
      await expect(runStandaloneHost({
        argv: [],
        env: {},
        resolvePathContext: async () => Object.freeze({
          installDir: join(temporaryRoot, 'installation'),
          agentHome,
        }),
        prepareAcquisition: async () => { throw failure; },
        createRuntime,
      })).rejects.toBe(failure);

      await expect(readFile(join(agentHome, 'config.json'), 'utf8')).resolves.toBe('{}\n');
      await expect(readFile(join(agentHome, 'IDENTITY.md'), 'utf8')).rejects.toMatchObject({
        code: 'ENOENT',
      });
      await expect(readFile(join(agentHome, 'memory.sqlite'))).rejects.toMatchObject({
        code: 'ENOENT',
      });
      expect(createRuntime).not.toHaveBeenCalled();
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  });

  it('stops before acquisition and Runtime when strict loading fails', async () => {
    const failure = new Error('load failed');
    const prepareAcquisition = vi.fn();
    const createRuntime = vi.fn();

    await expect(runStandaloneHost({
      argv: [],
      env: {},
      resolvePathContext: async () => createPathContext(),
      ensureConfig: async () => undefined,
      loadConfig: async () => { throw failure; },
      prepareAcquisition,
      createRuntime,
    })).rejects.toBe(failure);

    expect(prepareAcquisition).not.toHaveBeenCalled();
    expect(createRuntime).not.toHaveBeenCalled();
  });

  it('keeps no-Builtin mode alive until shared Host completion', async () => {
    const snapshot = createSnapshot();
    const waitForChannelCompletion = vi.fn();
    const createRuntime = vi.fn(async () => ({
      application: { waitForChannelCompletion },
      close: vi.fn(),
    }) as never);
    const shutdown = vi.fn();
    const createHost = vi.fn(() => ({
      shutdown,
      completion: Promise.resolve({ outcome: 'completed' } as never),
      dispose: vi.fn(),
    }));

    await runStandaloneHost({
      argv: ['--builtin-channels=none'],
      env: {},
      resolvePathContext: async () => createPathContext(),
      ensureConfig: async () => undefined,
      loadConfig: async () => snapshot,
      prepareAcquisition: async () => ({
        result: { loadedUnits: Object.freeze([]), diagnostics: Object.freeze([]) },
      }),
      createRuntime,
      createHost: createHost as never,
    });

    expect(waitForChannelCompletion).not.toHaveBeenCalled();
    expect(shutdown).not.toHaveBeenCalled();
  });

  it('sets failure status and shuts down when the selected builtin Channel fails', async () => {
    const previousExitCode = process.exitCode;
    const shutdown = vi.fn(async () => ({ outcome: 'completed' } as never));
    try {
      process.exitCode = undefined;
      await runStandaloneHost({
        argv: [],
        env: {},
        stderr: { write: vi.fn(() => true) } as never,
        resolvePathContext: async () => createPathContext(),
        ensureConfig: async () => undefined,
        loadConfig: async () => createSnapshot(),
        prepareAcquisition: async () => ({
          result: { loadedUnits: Object.freeze([]), diagnostics: Object.freeze([]) },
        }),
        createRuntime: async () => ({
          application: {
            waitForChannelCompletion: async () => ({
              outcome: 'failed',
              phase: 'runtime',
              error: new Error('transport failed'),
            }),
          },
          close: vi.fn(),
        }) as never,
        createHost: (() => ({
          shutdown,
          completion: new Promise<never>(() => undefined),
          dispose: vi.fn(),
        })) as never,
      });

      expect(process.exitCode).toBe(1);
      expect(shutdown).toHaveBeenCalledWith('builtin websocket channel completed');
    } finally {
      process.exitCode = previousExitCode;
    }
  });

  it('shuts down when observing builtin Channel completion rejects', async () => {
    const shutdown = vi.fn(async () => ({ outcome: 'completed' } as never));
    const failure = new Error('completion observer failed');

    await expect(runStandaloneHost({
      argv: [],
      env: {},
      resolvePathContext: async () => createPathContext(),
      ensureConfig: async () => undefined,
      loadConfig: async () => createSnapshot(),
      prepareAcquisition: async () => ({
        result: { loadedUnits: Object.freeze([]), diagnostics: Object.freeze([]) },
      }),
      createRuntime: async () => ({
        application: { waitForChannelCompletion: async () => { throw failure; } },
        close: vi.fn(),
      }) as never,
      createHost: (() => ({
        shutdown,
        completion: new Promise<never>(() => undefined),
        dispose: vi.fn(),
      })) as never,
    })).rejects.toBe(failure);

    expect(shutdown).toHaveBeenCalledWith('builtin websocket channel completed');
  });

  it('lets CLI control lifetime when it is the only selected Builtin Channel', async () => {
    const waitForChannelCompletion = vi.fn(async () => ({
      outcome: 'closed' as const,
      reason: 'input_closed' as const,
    }));
    const shutdown = vi.fn(async () => ({ outcome: 'completed' } as never));

    await runStandaloneHost({
      argv: ['-bc', 'cli'],
      env: {},
      resolvePathContext: async () => createPathContext(),
      ensureConfig: async () => undefined,
      loadConfig: async () => createSnapshot(false),
      prepareAcquisition: async () => ({
        result: { loadedUnits: Object.freeze([]), diagnostics: Object.freeze([]) },
      }),
      createRuntime: async () => ({
        application: { waitForChannelCompletion },
        close: vi.fn(),
      }) as never,
      createHost: (() => ({
        shutdown,
        completion: new Promise<never>(() => undefined),
        dispose: vi.fn(),
      })) as never,
    });

    expect(waitForChannelCompletion).toHaveBeenCalledWith('cli');
    expect(shutdown).toHaveBeenCalledWith('builtin cli channel completed');
  });

  it('isolates normal secondary CLI completion while WebSocket remains active', async () => {
    const websocketCompletion = createDeferred<{
      outcome: 'closed';
      reason: 'transport_closed';
    }>();
    const waitForChannelCompletion = vi.fn((id: string) => id === 'cli'
      ? Promise.resolve({ outcome: 'closed' as const, reason: 'input_closed' as const })
      : websocketCompletion.promise);
    const shutdown = vi.fn(async () => ({ outcome: 'completed' } as never));
    const run = runStandaloneHost({
      argv: ['-bc', 'cli,websocket'],
      env: {},
      resolvePathContext: async () => createPathContext(),
      ensureConfig: async () => undefined,
      loadConfig: async () => createSnapshot(false),
      prepareAcquisition: async () => ({
        result: { loadedUnits: Object.freeze([]), diagnostics: Object.freeze([]) },
      }),
      createRuntime: async () => ({
        application: { waitForChannelCompletion },
        close: vi.fn(),
      }) as never,
      createHost: (() => ({
        shutdown,
        completion: new Promise<never>(() => undefined),
        dispose: vi.fn(),
      })) as never,
    });
    await vi.waitFor(() => expect(waitForChannelCompletion).toHaveBeenCalledTimes(2));

    expect(shutdown).not.toHaveBeenCalled();
    websocketCompletion.resolve({ outcome: 'closed', reason: 'transport_closed' });
    await run;
    expect(shutdown).toHaveBeenCalledWith('builtin websocket channel completed');
  });

  it('warns and consumes secondary CLI failure without stopping WebSocket', async () => {
    const websocketCompletion = createDeferred<{
      outcome: 'closed';
      reason: 'transport_closed';
    }>();
    const stderr = { write: vi.fn(() => true) };
    const shutdown = vi.fn(async () => ({ outcome: 'completed' } as never));
    const run = runStandaloneHost({
      argv: ['--builtin-channels=websocket,cli'],
      env: {},
      stderr,
      resolvePathContext: async () => createPathContext(),
      ensureConfig: async () => undefined,
      loadConfig: async () => createSnapshot(false),
      prepareAcquisition: async () => ({
        result: { loadedUnits: Object.freeze([]), diagnostics: Object.freeze([]) },
      }),
      createRuntime: async () => ({
        application: {
          waitForChannelCompletion: (id: string) => id === 'cli'
            ? Promise.resolve({
                outcome: 'failed' as const,
                phase: 'startup' as const,
                error: new Error('secret failure'),
              })
            : websocketCompletion.promise,
        },
        close: vi.fn(),
      }) as never,
      createHost: (() => ({
        shutdown,
        completion: new Promise<never>(() => undefined),
        dispose: vi.fn(),
      })) as never,
    });
    await vi.waitFor(() => expect(stderr.write).toHaveBeenCalledWith(
      'Secondary Channel cli failed; WebSocket remains active.\n',
    ));

    expect(shutdown).not.toHaveBeenCalled();
    expect(stderr.write).not.toHaveBeenCalledWith(expect.stringContaining('secret failure'));
    websocketCompletion.resolve({ outcome: 'closed', reason: 'transport_closed' });
    await run;
  });
});

function createSnapshot(consoleEnabled = true): AgentConfigSnapshot {
  return {
    application: {
      agents: { defaults: {} as never, list: [] },
      logger: { console: { enabled: consoleEnabled } },
    },
    extensions: { enabled: true, entries: {} },
  };
}

function createPathContext() {
  return Object.freeze({
    installDir: 'C:/installation',
    agentHome: 'C:/agent-home',
  });
}

function createDeferred<T>(): {
  readonly promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => { resolve = settle; });
  return { promise, resolve };
}