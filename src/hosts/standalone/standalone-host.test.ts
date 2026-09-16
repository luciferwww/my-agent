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
import type {
  StandaloneHostConfigProjection,
  AgentConfigSnapshot,
} from '../../platform/config/index.js';
import { loadAgentConfig } from '../../platform/config/index.js';
import type { RuntimeAppOptions } from '../../runtime/index.js';

const hostDefaults: StandaloneHostConfigProjection = Object.freeze({
  mode: 'websocket',
  websocket: Object.freeze({ host: '127.0.0.1', port: 8787, path: '/ws', approval: true }),
  cli: Object.freeze({ sessionKey: 'main', prompt: '> ', approval: true }),
});

describe('standalone Host arguments', () => {
  it('accepts startup without arguments', () => {
    expect(parseStandaloneHostArguments([])).toBeUndefined();
  });

  it.each([
    ['--workspace', 'C:/workspace'],
    ['--workspace=C:/workspace'],
    ['--agent-home', 'C:/agent-home'],
    ['--agent-home=C:/agent-home'],
    ['--unknown'],
  ])('rejects retired or unknown arguments: %s', (...argv) => {
    expect(() => parseStandaloneHostArguments(argv)).toThrow('HOST_ARGUMENT_INVALID');
  });
});

describe('standalone Host composition', () => {
  it.each([
    ['websocket', ['builtin-websocket-channel']],
    ['cli', ['builtin-cli-channel']],
    ['headless', []],
  ] as const)('creates only the selected builtin mode for %s', (mode, ids) => {
    expect(createBuiltinHostUnits({ ...hostDefaults, mode }).map((unit) => unit.unitId))
      .toEqual(ids);
  });

  it('rejects CLI with Console Logger and accepts CLI with File-only Logger', () => {
    const snapshot = (consoleEnabled: boolean): AgentConfigSnapshot => ({
      application: {
        agents: { defaults: {} as never, list: [] },
        logger: { console: { enabled: consoleEnabled }, file: { enabled: true } },
      },
      extensions: { enabled: true, entries: {} },
      host: { ...hostDefaults, mode: 'cli' },
    });

    expect(() => validateStandaloneHostComposition(snapshot(true))).toThrow('HOST_OUTPUT_CONFLICT');
    expect(() => validateStandaloneHostComposition(snapshot(false))).not.toThrow();
  });

  it('hands one snapshot and one injected environment through acquisition and Runtime', async () => {
    const snapshot = createSnapshot('websocket');
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
      workingDir: 'C:/working',
    });
    const resolvePathContext = vi.fn(async () => pathContext);
    const loadConfig = vi.fn(async () => snapshot);
    const prepareAcquisition = vi.fn(async () => ({
      result: { loadedUnits: Object.freeze([]), diagnostics: Object.freeze([]) },
    }));
    const waitForChannelCompletion = vi.fn(async () => ({
      outcome: 'closed' as const,
      reason: 'transport_closed' as const,
    }));
    const runtime = {
      application: { waitForChannelCompletion },
      close: vi.fn(),
    };
    const createRuntime = vi.fn(async (runtimeOptions: RuntimeAppOptions) => {
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
      loadConfig,
      prepareAcquisition,
      createRuntime,
      createHost: createHost as never,
    });

    expect(resolvePathContext).toHaveBeenCalledOnce();
    expect(loadConfig).toHaveBeenCalledWith({ agentHome: pathContext.agentHome });
    expect(prepareAcquisition).toHaveBeenCalledWith(
      join(pathContext.installDir, 'extensions'),
      snapshot.extensions,
      environment,
    );
    expect(createRuntime).toHaveBeenCalledWith(expect.objectContaining({
      agentHome: pathContext.agentHome,
      workingDir: pathContext.workingDir,
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
    const workingDir = join(temporaryRoot, 'project');
    await mkdir(agentHome);
    await mkdir(workingDir);
    await writeFile(join(agentHome, 'config.json'), JSON.stringify({
      agents: { defaults: { llm: { maxTokens: 8192 } } },
      extensions: { enabled: false },
      host: { mode: 'headless' },
    }), 'utf8');
    await writeFile(join(workingDir, 'config.json'), JSON.stringify({
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
        argv: [],
        env: {},
        resolvePathContext: async () => Object.freeze({
          installDir: join(temporaryRoot, 'installation'),
          agentHome,
          workingDir,
        }),
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
        workingDir,
        applicationConfig: expect.objectContaining({
          agents: expect.objectContaining({
            defaults: expect.objectContaining({
              llm: expect.objectContaining({ maxTokens: 8192 }),
            }),
          }),
        }),
      }));
      await expect(readFile(join(workingDir, 'config.json'), 'utf8'))
        .resolves.toContain('"maxTokens":1');
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  });

  it('keeps headless mode alive until shared Host completion', async () => {
    const snapshot = createSnapshot('headless');
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
        loadConfig: async () => createSnapshot('websocket'),
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
      loadConfig: async () => createSnapshot('websocket'),
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
});

function createSnapshot(mode: StandaloneHostConfigProjection['mode']): AgentConfigSnapshot {
  return {
    application: {
      agents: { defaults: {} as never, list: [] },
      logger: { console: { enabled: mode !== 'cli' } },
    },
    extensions: { enabled: true, entries: {} },
    host: { ...hostDefaults, mode },
  };
}

function createPathContext() {
  return Object.freeze({
    installDir: 'C:/installation',
    agentHome: 'C:/agent-home',
    workingDir: 'C:/working',
  });
}