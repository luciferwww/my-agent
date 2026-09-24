import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import {
  createStandaloneHostUnits,
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

    expect(parsed).toEqual({ cli: false });
    expect(Object.isFrozen(parsed)).toBe(true);
  });

  it.each([
    [['-ah', 'C:/agent-home'], 'C:/agent-home'],
    [['--agent-home', 'C:/agent-home'], 'C:/agent-home'],
    [['--agent-home=C:/agent-home'], 'C:/agent-home'],
    [['--agent-home=profiles=one'], 'profiles=one'],
  ])('accepts one Agent Home override: %j', (argv, agentHomeArgument) => {
    expect(parseStandaloneHostArguments(argv)).toEqual({
      agentHomeArgument,
      cli: false,
    });
  });

  it.each([
    [['--cli'], undefined],
    [['--cli', '--agent-home=C:/agent-home'], 'C:/agent-home'],
    [['--agent-home', 'C:/agent-home', '--cli'], 'C:/agent-home'],
  ] as const)('accepts the optional CLI flag: %j', (argv, agentHomeArgument) => {
    expect(parseStandaloneHostArguments(argv)).toEqual({
      ...(agentHomeArgument === undefined ? {} : { agentHomeArgument }),
      cli: true,
    });
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
    ['--cli', '--cli'],
    ['--cli=true'],
    ['-c'],
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
    [true, ['builtin-cli-channel']],
    [false, []],
  ] as const)('creates the Host-local Unit set when CLI is %j', (cliEnabled, ids) => {
    const units = createStandaloneHostUnits(cliEnabled);

    expect(units.map((unit) => unit.unitId)).toEqual(ids);
    expect(Object.isFrozen(units)).toBe(true);
  });

  it('rejects CLI with Console Logger and accepts CLI with File-only Logger', () => {
    const snapshot = (consoleEnabled: boolean): AgentConfigSnapshot => ({
      application: {
        llm: {},
        runtime: { steeringEnabled: false },
        runner: {},
        agents: { defaults: {} as never, list: [] },
        logger: { console: { enabled: consoleEnabled }, file: { enabled: true } },
      },
      extensions: { enabled: true, entries: {} },
    });

    expect(() => validateStandaloneHostComposition(snapshot(true), true))
      .toThrow('HOST_OUTPUT_CONFLICT');
    expect(() => validateStandaloneHostComposition(snapshot(false), true)).not.toThrow();
    expect(() => validateStandaloneHostComposition(snapshot(true), false)).not.toThrow();
  });

  it('rejects a CLI output conflict before Runtime creation', async () => {
    const createRuntime = vi.fn();

    await expect(runStandaloneHost({
      argv: ['--cli'],
      env: {},
      resolvePathContext: async () => createPathContext(),
      ensureConfig: async () => undefined,
      loadConfig: async () => createSnapshot(true),
      createRuntime,
    })).rejects.toThrow('HOST_OUTPUT_CONFLICT');

    expect(createRuntime).not.toHaveBeenCalled();
  });

  it('rejects invalid arguments before path and configuration side effects', async () => {
    const resolvePathContext = vi.fn();
    const ensureConfig = vi.fn();

    await expect(runStandaloneHost({
      argv: ['--builtin-channels=websocket'],
      resolvePathContext,
      ensureConfig,
    })).rejects.toThrow('HOST_ARGUMENT_INVALID');

    expect(resolvePathContext).not.toHaveBeenCalled();
    expect(ensureConfig).not.toHaveBeenCalled();
  });

  it('hands one snapshot and one injected environment through acquisition and Runtime', async () => {
    const events: string[] = [];
    const snapshot = createSnapshot();
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
      return runtime as never;
    });
    const shutdown = vi.fn(async () => ({ outcome: 'completed' } as never));
    const createHost = vi.fn(() => ({
      shutdown,
      completion: Promise.resolve({ outcome: 'completed' } as never),
      dispose: vi.fn(),
    }));

    await runStandaloneHost({
      argv: [],
      env: environment,
      resolvePathContext,
      ensureConfig,
      loadConfig,
      createRuntime,
      createHost: createHost as never,
    });

    expect(resolvePathContext).toHaveBeenCalledOnce();
    expect(ensureConfig).toHaveBeenCalledWith({ agentHome: pathContext.agentHome });
    expect(loadConfig).toHaveBeenCalledWith({
      agentHome: pathContext.agentHome,
      environment,
    });
    expect(events).toEqual(['paths', 'bootstrap', 'load', 'Runtime']);
    expect(createRuntime).toHaveBeenCalledWith(expect.objectContaining({
      agentHome: pathContext.agentHome,
      startupContext: {
        installDir: pathContext.installDir,
        configuration: snapshot,
        environment,
      },
      loadedUnits: [],
    }));
    expect(waitForChannelCompletion).not.toHaveBeenCalled();
    expect(shutdown).not.toHaveBeenCalled();
  });

  it('reads Agent Home config once for acquisition and Runtime without reading project config', async () => {
    const temporaryRoot = await mkdtemp(join(tmpdir(), 'standalone-host-config-'));
    const agentHome = join(temporaryRoot, 'agent-home');
    const startupCwd = join(temporaryRoot, 'project');
    await mkdir(agentHome);
    await mkdir(startupCwd);
    await writeFile(join(agentHome, 'config.json'), JSON.stringify({
      runner: { maxLlmCalls: 8 },
      extensions: { enabled: false },
    }), 'utf8');
    await writeFile(join(startupCwd, 'config.json'), JSON.stringify({
      runner: { maxLlmCalls: 1 },
      extensions: { enabled: true },
    }), 'utf8');
    const readTextFile = vi.fn((path: string) => readFile(path, 'utf8'));
    const createRuntime = vi.fn(async () => ({
      application: { waitForChannelCompletion: vi.fn() },
      close: vi.fn(),
    }) as never);

    try {
      await runStandaloneHost({
        argv: [],
        env: {},
        resolvePathContext: async () => Object.freeze({
          installDir: join(temporaryRoot, 'installation'),
          agentHome,
        }),
        ensureConfig: (options) => ensureAgentConfigDocument(options),
        loadConfig: (options) => loadAgentConfig(options, { readTextFile }),
        createRuntime,
        createHost: (() => ({
          shutdown: vi.fn(),
          completion: Promise.resolve({ outcome: 'completed' } as never),
          dispose: vi.fn(),
        })) as never,
      });

      expect(readTextFile).toHaveBeenCalledTimes(1);
      expect(readTextFile).toHaveBeenCalledWith(join(agentHome, 'config.json'));
      expect(createRuntime).toHaveBeenCalledWith(expect.objectContaining({
        agentHome,
        startupContext: expect.objectContaining({
          installDir: join(temporaryRoot, 'installation'),
          configuration: expect.objectContaining({
            application: expect.objectContaining({
              runner: expect.objectContaining({ maxLlmCalls: 8 }),
            }),
          }),
        }),
      }));
      await expect(readFile(join(startupCwd, 'config.json'), 'utf8'))
        .resolves.toContain('"maxLlmCalls":1');
      await expect(readFile(join(agentHome, 'config.json'), 'utf8'))
        .resolves.toContain('"maxLlmCalls":8');
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  });

  it('stops before configuration loading and Runtime when bootstrap fails', async () => {
    const failure = new Error('bootstrap failed');
    const loadConfig = vi.fn();
    const createRuntime = vi.fn();

    await expect(runStandaloneHost({
      argv: [],
      env: {},
      resolvePathContext: async () => createPathContext(),
      ensureConfig: async () => { throw failure; },
      loadConfig,
      createRuntime,
    })).rejects.toBe(failure);

    expect(loadConfig).not.toHaveBeenCalled();
    expect(createRuntime).not.toHaveBeenCalled();
  });

  it('keeps generated config but creates no Runtime-owned state when Runtime creation fails', async () => {
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
        createRuntime: async () => {
          createRuntime();
          throw failure;
        },
      })).rejects.toBe(failure);

      await expect(readFile(join(agentHome, 'config.json'), 'utf8')).resolves.toBe('{}\n');
      await expect(readFile(join(agentHome, 'IDENTITY.md'), 'utf8')).rejects.toMatchObject({
        code: 'ENOENT',
      });
      await expect(readFile(join(agentHome, 'memory.sqlite'))).rejects.toMatchObject({
        code: 'ENOENT',
      });
      expect(createRuntime).toHaveBeenCalledOnce();
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  });

  it('stops before Runtime when strict loading fails', async () => {
    const failure = new Error('load failed');
    const createRuntime = vi.fn();

    await expect(runStandaloneHost({
      argv: [],
      env: {},
      resolvePathContext: async () => createPathContext(),
      ensureConfig: async () => undefined,
      loadConfig: async () => { throw failure; },
      createRuntime,
    })).rejects.toBe(failure);

    expect(createRuntime).not.toHaveBeenCalled();
  });

  it('keeps zero-Channel mode alive until shared Host completion', async () => {
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
      argv: [],
      env: {},
      resolvePathContext: async () => createPathContext(),
      ensureConfig: async () => undefined,
      loadConfig: async () => snapshot,
      createRuntime,
      createHost: createHost as never,
    });

    expect(waitForChannelCompletion).not.toHaveBeenCalled();
    expect(shutdown).not.toHaveBeenCalled();
  });

  it('sets failure status and shuts down when the Host-local CLI fails', async () => {
    const previousExitCode = process.exitCode;
    const shutdown = vi.fn(async () => ({ outcome: 'completed' } as never));
    try {
      process.exitCode = undefined;
      await runStandaloneHost({
        argv: ['--cli'],
        env: {},
        resolvePathContext: async () => createPathContext(),
        ensureConfig: async () => undefined,
        loadConfig: async () => createSnapshot(false),
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
      expect(shutdown).toHaveBeenCalledWith('cli channel completed');
    } finally {
      process.exitCode = previousExitCode;
    }
  });

  it('shuts down when observing Host-local CLI completion rejects', async () => {
    const shutdown = vi.fn(async () => ({ outcome: 'completed' } as never));
    const failure = new Error('completion observer failed');

    await expect(runStandaloneHost({
      argv: ['--cli'],
      env: {},
      resolvePathContext: async () => createPathContext(),
      ensureConfig: async () => undefined,
      loadConfig: async () => createSnapshot(false),
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

    expect(shutdown).toHaveBeenCalledWith('cli channel completed');
  });

  it('lets CLI control lifetime when explicitly enabled', async () => {
    const waitForChannelCompletion = vi.fn(async () => ({
      outcome: 'closed' as const,
      reason: 'input_closed' as const,
    }));
    const shutdown = vi.fn(async () => ({ outcome: 'completed' } as never));

    await runStandaloneHost({
      argv: ['--cli'],
      env: {},
      resolvePathContext: async () => createPathContext(),
      ensureConfig: async () => undefined,
      loadConfig: async () => createSnapshot(false),
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
    expect(shutdown).toHaveBeenCalledWith('cli channel completed');
  });

});

function createSnapshot(consoleEnabled = true): AgentConfigSnapshot {
  return {
    application: {
      llm: {},
      runtime: { steeringEnabled: false },
      runner: {},
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
