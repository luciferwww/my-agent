import { mkdir, mkdtemp, readdir, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ModelInvocationError, type ChatMessage } from '../core/model-invocation/index.js';
import type {
  ApprovalClosedResult,
  ApprovalDecision,
  ApprovalRequest,
  Channel,
  ChannelCompletion,
  ChannelRunRequest,
  ChannelRuntimeCapabilities,
} from '../core/channel/index.js';
import type { AgentEvent, BeforeToolCallHook } from '../core/runner/index.js';
import type { RunParams, RunResult } from '../core/runner/types.js';
import type { Tool } from '../core/tools/types.js';
import type { RuntimeContributionUnit } from '../core/registry/index.js';
import { createLoadedRuntimeUnit, type LoadedRuntimeUnit } from './runtime-unit.js';
import type { ProviderProjectionEntry, ResolvedModel } from '../core/model-resolution/index.js';
import type { SubagentModelSelection } from '../platform/config/types.js';
import type { ApplicationConfigProjection } from '../platform/config/types.js';
import { DEFAULT_AGENT_CONFIG, DEFAULT_LOGGER_CONFIG } from '../platform/config/defaults.js';
import { loadAgentConfig } from '../platform/config/agent-config-loader.js';
import { RuntimeApp } from './RuntimeApp.js';
import type { RuntimeHandle } from './runtime-composition.js';
import type { RuntimeDependencies, RuntimeEvent } from './types.js';
import type { RuntimeDeadlineDriver, RuntimeDeadlineRaceResult } from './runtime-deadline.js';
import { Logger } from '../platform/logger/index.js';
import { DEFAULT_RUNNER_CONFIG } from '../core/runner/config.js';
import { DEFAULT_RUNTIME_CONFIG } from './config.js';

function testApplicationConfig(
  defaultModel: { readonly providerId: string; readonly modelId: string } | null = {
    providerId: 'test',
    modelId: 'test-model',
  },
): ApplicationConfigProjection {
  return {
    llm: {
      ...(defaultModel === null ? {} : { defaultModel }),
      builtin: {
        baseURL: 'https://example.test/v1',
        models: [{ modelId: 'test-model', protocol: 'openai-responses' }],
      },
    },
    runtime: structuredClone(DEFAULT_RUNTIME_CONFIG),
    runner: structuredClone(DEFAULT_RUNNER_CONFIG),
    agents: {
      defaults: structuredClone(DEFAULT_AGENT_CONFIG),
      list: [],
    },
    logger: structuredClone(DEFAULT_LOGGER_CONFIG),
  };
}

class ManualDeadlineDriver implements RuntimeDeadlineDriver {
  private nowMs = 0;
  private readonly deadlines = new Set<{
    deadline: number;
    resolve: (result: RuntimeDeadlineRaceResult<unknown>) => void;
  }>();

  now(): number {
    return this.nowMs;
  }

  get pendingCount(): number {
    return this.deadlines.size;
  }

  race<T>(operation: Promise<T>, absoluteDeadline: number): Promise<RuntimeDeadlineRaceResult<T>> {
    return new Promise((resolve) => {
      let settled = false;
      const waiter = {
        deadline: absoluteDeadline,
        resolve: (result: RuntimeDeadlineRaceResult<unknown>) => {
          if (settled) return;
          settled = true;
          this.deadlines.delete(waiter);
          resolve(result as RuntimeDeadlineRaceResult<T>);
        },
      };
      this.deadlines.add(waiter);
      void operation.then(
        (value) => waiter.resolve({ outcome: 'completed', value }),
        (error: unknown) => waiter.resolve({
          outcome: 'failed',
          message: error instanceof Error ? error.message : String(error),
        }),
      );
      if (absoluteDeadline <= this.nowMs) waiter.resolve({ outcome: 'deadline-exhausted' });
    });
  }

  advanceBy(milliseconds: number): void {
    this.nowMs += milliseconds;
    for (const waiter of [...this.deadlines]) {
      if (waiter.deadline <= this.nowMs) waiter.resolve({ outcome: 'deadline-exhausted' });
    }
  }
}

describe('RuntimeApp', () => {
  let agentHome: string;

  beforeEach(async () => {
    agentHome = await mkdtemp(join(tmpdir(), 'runtime-app-test-'));
  });

  afterEach(async () => {
    await rm(agentHome, { recursive: true, force: true });
  });

  it('routes Agent state, Environment Tools, and prompts to agentHome', async () => {
    const selectedAgentHome = join(agentHome, 'agent-home');
    const createSessionManager = vi.fn(() => ({
      initialize: vi.fn(async () => undefined),
      getSession: vi.fn(() => sessionEntry('main')),
    }) as never);
    const createMemoryManager = vi.fn(async () => null);
    const getBuiltinContributionUnits = vi.fn(() => []);
    const build = vi.fn(() => 'SYSTEM_PROMPT');

    const app = await RuntimeApp.create({
      agentHome: selectedAgentHome,
      applicationConfig: testApplicationConfig(),
      cliOverrides: {
        memory: { enabled: true },
        subagents: { enabled: false, maxDepth: 1 },
      },
      dependencies: createTestDependencies({
        createSessionManager,
        createMemoryManager,
        getBuiltinContributionUnits,
        createSystemPromptBuilder: () => ({ build }) as never,
      }),
    });

    await app.application.runTurn({
      sessionId: 'main',
      message: 'verify path ownership',
      promptMode: 'full',
    });

    expect(createSessionManager).toHaveBeenCalledWith(selectedAgentHome, expect.any(Object));
    expect(createMemoryManager).toHaveBeenCalledWith(expect.objectContaining({ agentHome: selectedAgentHome }));
    expect(getBuiltinContributionUnits).toHaveBeenCalledWith(
      expect.objectContaining({ agentHome: selectedAgentHome }),
      null,
    );
    expect(build).toHaveBeenCalledWith(expect.objectContaining({ agentHome: selectedAgentHome }));
    expect(await readdir(selectedAgentHome)).toEqual(expect.arrayContaining([
      'IDENTITY.md',
      'SOUL.md',
      'AGENTS.md',
      'TOOLS.md',
    ]));
    await app.close();
  });

  it('rejects archive, delete, and fork while a Session is active or queued', async () => {
    const releaseRun = createDeferred<void>();
    const archiveSession = vi.fn(async (sessionId: string) => ({
      ...sessionEntry(sessionId),
      archivedAt: 2,
    }));
    const deleteSession = vi.fn(async () => undefined);
    const forkSession = vi.fn(async () => sessionEntry('fork'));
    const runnerRun = vi.fn(async (): Promise<RunResult> => {
      await releaseRun.promise;
      return {
        text: 'done',
        content: [{ type: 'text', text: 'done' }],
        stopReason: 'end_turn',
        usage: { inputTokens: 1, outputTokens: 1 },
        toolRounds: 0,
      };
    });
    const app = await RuntimeApp.create({
      agentHome,
      applicationConfig: testApplicationConfig(),
      cliOverrides: {
        memory: { enabled: false },
      },
      dependencies: createTestDependencies({
        createSessionManager: () => ({
          initialize: vi.fn(async () => undefined),
          getSession: vi.fn((sessionId: string) => sessionEntry(sessionId)),
          archiveSession,
          deleteSession,
          forkSession,
        }) as never,
        createAgentRunner: () => ({ run: runnerRun }) as never,
        createMemoryManager: async () => null,
      }),
    });

    const assertBusy = async () => {
      await expect(app.application.archiveSession('main')).rejects.toMatchObject({
        code: 'SESSION_BUSY',
      });
      await expect(app.application.deleteSession('main')).rejects.toMatchObject({
        code: 'SESSION_BUSY',
      });
      await expect(app.application.forkSession('main')).rejects.toMatchObject({
        code: 'SESSION_BUSY',
      });
    };

    const activeTurn = app.application.runTurn({
      sessionId: 'main',
      message: 'active',
      promptMode: 'full',
    });
    await vi.waitFor(() => expect(runnerRun).toHaveBeenCalledTimes(1));
    await assertBusy();
    releaseRun.resolve();
    await activeTurn;

    const queueMap = (app.application as unknown as {
      messageQueueBySession: Map<string, unknown[]>;
    }).messageQueueBySession;
    queueMap.set('main', [{ queued: true }]);
    await assertBusy();
    queueMap.delete('main');

    expect(archiveSession).not.toHaveBeenCalled();
    expect(deleteSession).not.toHaveBeenCalled();
    expect(forkSession).not.toHaveBeenCalled();
    await app.close();
  });

  it('acquires Extensions during Runtime Bootstrap from generic Host startup facts', async () => {
    const installDir = join(agentHome, 'installation');
    const environment = Object.freeze({});
    await writeFile(join(agentHome, 'config.json'), '{}\n', 'utf8');
    const snapshot = await loadAgentConfig({ agentHome });
    const create = vi.fn(() => ({
      registration: { id: 'external-bootstrap', source: 'external' as const, register() {} },
      start() {},
      stop() {},
    }));
    const acquiredUnit: LoadedRuntimeUnit = Object.freeze({
      unitId: 'external-bootstrap',
      source: 'external',
      orderKey: 'external-bootstrap',
      required: false,
      initiallyEnabled: true,
      dependencies: Object.freeze([]),
      create,
    });
    const acquireExtensions = vi.fn(async () => Object.freeze({
      loadedUnits: Object.freeze([acquiredUnit]),
      diagnostics: Object.freeze([]),
    }));

    const app = await RuntimeApp.create({
      agentHome,
      applicationConfig: testApplicationConfig(),
      startupContext: {
        installDir,
        configuration: snapshot,
        environment,
      },
      cliOverrides: {
        memory: { enabled: false },
      },
      dependencies: createTestDependencies({ acquireExtensions }),
    });

    expect(acquireExtensions).toHaveBeenCalledWith({
      extensionsDir: join(installDir, 'extensions'),
      extensionsConfig: snapshot.extensions,
      environment,
    });
    expect(create).toHaveBeenCalledOnce();
    expect(acquireExtensions.mock.invocationCallOrder[0])
      .toBeLessThan(create.mock.invocationCallOrder[0]!);
    await app.close();
  });

  it('admits an existing canonical session and rejects an unknown identity', async () => {
    const sessionId = '00000000-0000-4000-8000-000000000001';
    const getSession = vi.fn((candidate: string) =>
      candidate === sessionId ? sessionEntry(sessionId) : undefined,
    );
    const build = vi.fn(() => 'SYSTEM_PROMPT');
    const runnerRun = vi.fn(async (_params: RunParams): Promise<RunResult> => ({
      text: 'hello',
      content: [{ type: 'text', text: 'hello' }],
      stopReason: 'end_turn',
      usage: { inputTokens: 1, outputTokens: 2 },
      toolRounds: 0,
    }));

    const deps = createTestDependencies({
      createSessionManager: () => ({
        initialize: vi.fn(async () => undefined),
        getSession,
      }) as never,
      createSystemPromptBuilder: () => ({ build } as never),
      createAgentRunner: () => ({ run: runnerRun } as never),
      createMemoryManager: async () => null,
    });

    const app = await RuntimeApp.create({
      agentHome: agentHome,
      applicationConfig: testApplicationConfig(),
      cliOverrides: {
        memory: { enabled: false },
      },
      dependencies: deps,
    });

    const result = await app.application.runTurn({
      sessionId: sessionId,
      message: 'Hello runtime',
      promptMode: 'full',
    });

    expect(getSession).toHaveBeenCalledWith(sessionId);
    expect(build).toHaveBeenCalled();
    expect(runnerRun).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId,
        message: 'Hello runtime',
        resolvedModel: expect.objectContaining({
          identity: { providerId: 'test', modelId: 'test-model' },
          referenceSource: 'config-default',
        }),
        systemPrompt: 'SYSTEM_PROMPT',
      }),
    );
    expect(result.sessionId).toBe(sessionId);
    expect(result.text).toBe('hello');
    expect(app.application.getState().phase).toBe('ready');

    runnerRun.mockClear();
    await expect(app.application.runTurn({
      sessionId: '00000000-0000-4000-8000-000000000002',
      message: 'unknown',
      promptMode: 'full',
    })).rejects.toThrow('was not found');
    expect(runnerRun).not.toHaveBeenCalled();
    await app.close();
  });

  it('uses the injected application projection without rereading Workspace configuration', async () => {
    await writeFile(join(agentHome, 'config.json'), JSON.stringify({
      agents: { defaults: { memory: { enabled: false } } },
      logger: { console: { enabled: false } },
    }), 'utf8');
    const snapshot = await loadAgentConfig({ agentHome: agentHome });
    await writeFile(join(agentHome, 'config.json'), JSON.stringify({
      agents: { defaults: { memory: { enabled: true } } },
    }), 'utf8');
    const createMemoryManager = vi.fn(async () => null);

    const app = await RuntimeApp.create({
      agentHome: agentHome,
      applicationConfig: {
        ...snapshot.application,
        llm: testApplicationConfig().llm,
      },
      dependencies: createTestDependencies({ createMemoryManager }),
    });

    expect(createMemoryManager).toHaveBeenCalledWith(expect.objectContaining({
      agentHome: agentHome,
      enabled: false,
    }));
    await app.close();
  });

  it('uses hardcoded defaults without reading config.json when no projection is supplied', async () => {
    await writeFile(join(agentHome, 'config.json'), '{ invalid json', 'utf8');
    const createMemoryManager = vi.fn(async () => null);

    const app = await RuntimeApp.create({
      agentHome: agentHome,
      applicationConfig: testApplicationConfig(),
      cliOverrides: {
        memory: { enabled: false },
      },
      dependencies: createTestDependencies({ createMemoryManager }),
    });

    expect(createMemoryManager).toHaveBeenCalledWith(expect.objectContaining({
      agentHome: agentHome,
      enabled: false,
    }));
    await app.close();
  });

  it('uses the global Runner limit unless the Turn supplies an override', async () => {
    const runnerRun = vi.fn(async (_params: RunParams): Promise<RunResult> => ({
      text: 'ok',
      content: [{ type: 'text', text: 'ok' }],
      stopReason: 'end_turn',
      usage: { inputTokens: 1, outputTokens: 1 },
      toolRounds: 0,
    }));
    const app = await RuntimeApp.create({
      agentHome,
      applicationConfig: {
        ...testApplicationConfig(),
        runner: { maxLlmCalls: 7 },
      },
      cliOverrides: { memory: { enabled: false } },
      dependencies: createTestDependencies({
        createAgentRunner: () => ({ run: runnerRun }) as never,
      }),
    });

    await app.application.runTurn({
      sessionId: 'global-limit',
      message: 'global',
      promptMode: 'full',
    });
    await app.application.runTurn({
      sessionId: 'turn-limit',
      message: 'turn',
      promptMode: 'full',
      maxLlmCalls: 2,
    });

    expect(runnerRun.mock.calls[0]?.[0]).toEqual(expect.objectContaining({ maxLlmCalls: 7 }));
    expect(runnerRun.mock.calls[1]?.[0]).toEqual(expect.objectContaining({ maxLlmCalls: 2 }));
    await app.close();
  });

  it('returns a deep-frozen transport-safe Catalog with an available default', async () => {
    const app = await RuntimeApp.create({
      agentHome: agentHome,
      applicationConfig: testApplicationConfig(),
      cliOverrides: {
        memory: { enabled: false },
      },
      dependencies: createTestDependencies({ createMemoryManager: async () => null }),
    });

    const catalog = app.application.getModelCatalog();
    expect(catalog).toEqual({
      generation: 1,
      defaultSelection: {
        state: 'available',
        reference: { providerId: 'test', modelId: 'test-model' },
      },
      providers: [{
        providerId: 'test',
        displayName: 'test',
        models: [
          { modelId: 'test-model', displayName: 'Test Model' },
          { modelId: 'parent-model', displayName: 'parent-model' },
        ],
      }],
    });
    expect(Object.isFrozen(catalog)).toBe(true);
    expect(Object.isFrozen(catalog.defaultSelection)).toBe(true);
    expect(Object.isFrozen(catalog.providers)).toBe(true);
    expect(Object.isFrozen(catalog.providers[0]?.models)).toBe(true);
    expect(Object.isFrozen(catalog.providers[0]?.models[0])).toBe(true);
    expect(JSON.parse(JSON.stringify(catalog))).toEqual(catalog);
    await app.close();
  });

  it('composes the real Built-in Unit with an empty Catalog without network I/O', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const app = await RuntimeApp.create({
      agentHome,
      applicationConfig: {
        llm: {
          defaultModel: { providerId: 'builtin', modelId: 'staged-model' },
          builtin: { baseURL: 'https://example.test/v1', models: [] },
        },
        runtime: structuredClone(DEFAULT_RUNTIME_CONFIG),
        runner: structuredClone(DEFAULT_RUNNER_CONFIG),
        agents: {
          defaults: structuredClone(DEFAULT_AGENT_CONFIG),
          list: [],
        },
        logger: structuredClone(DEFAULT_LOGGER_CONFIG),
      },
      cliOverrides: {
        memory: { enabled: false },
        subagents: { enabled: false, maxDepth: 1 },
      },
      dependencies: { createMemoryManager: async () => null },
    });

    expect(app.application.getModelCatalog()).toMatchObject({
      defaultSelection: {
        state: 'unavailable',
        reference: { providerId: 'builtin', modelId: 'staged-model' },
        reason: 'model_rejected',
      },
      providers: [{
        providerId: 'builtin',
        displayName: 'Built-in LLM',
        models: [],
      }],
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    await app.close();
    fetchSpy.mockRestore();
  });

  it.each([
    {
      label: 'unset',
      model: undefined,
      expected: { state: 'unset' },
      expectedCategory: 'reference_invalid',
    },
    {
      label: 'provider unavailable',
      model: { providerId: 'missing', modelId: 'preferred' },
      expected: {
        state: 'unavailable',
        reference: { providerId: 'missing', modelId: 'preferred' },
        reason: 'provider_unregistered',
      },
      expectedCategory: 'provider_unregistered',
    },
    {
      label: 'model unavailable',
      model: { providerId: 'test', modelId: 'missing' },
      expected: {
        state: 'unavailable',
        reference: { providerId: 'test', modelId: 'missing' },
        reason: 'model_rejected',
      },
      expectedCategory: 'model_rejected',
    },
  ])('reports a $label configured default without startup fallback', async ({
    model,
    expected,
    expectedCategory,
  }) => {
    const app = await RuntimeApp.create({
      agentHome: agentHome,
      applicationConfig: testApplicationConfig(model ?? null),
      cliOverrides: {
        memory: { enabled: false },
      },
      dependencies: createTestDependencies({ createMemoryManager: async () => null }),
    });

    expect(app.application.getModelCatalog().defaultSelection).toEqual(expected);
    await expect(app.application.runTurn({
      sessionId: `default-${expectedCategory}`,
      message: 'must not fall back',
      promptMode: 'full',
    })).rejects.toMatchObject({
      info: { resolutionCategory: expectedCategory },
    });
    await app.close();
  });

  it('keeps the last published Catalog readable while closing', async () => {
    const app = await RuntimeApp.create({
      agentHome: agentHome,
      applicationConfig: testApplicationConfig(),
      cliOverrides: {
        memory: { enabled: false },
      },
      dependencies: createTestDependencies({ createMemoryManager: async () => null }),
    });

    const closing = app.close();
    expect(app.application.getModelCatalog()).toMatchObject({
      generation: 1,
      defaultSelection: { state: 'available' },
      providers: [{ providerId: 'test' }],
    });
    await closing;
  });

  it.each([
    {
      label: 'inherited',
      selection: 'inherit' as const,
      expectedIdentity: { providerId: 'test', modelId: 'parent-model' },
    },
    {
      label: 'concrete',
      selection: { providerId: 'child', modelId: 'child-model' },
      expectedIdentity: { providerId: 'child', modelId: 'child-model' },
    },
  ])('delegates a real Parent task through fresh $label Child resolution', async ({
    selection,
    expectedIdentity,
  }: {
    selection: SubagentModelSelection;
    expectedIdentity: { providerId: string; modelId: string };
  }) => {
    let parentModel: ResolvedModel | undefined;
    let childModel: ResolvedModel | undefined;
    const deleteTransientSubagentTranscript = vi.fn(async () => {});
    const runnerRun = vi.fn(async (params: RunParams): Promise<RunResult> => {
      if (params.sessionId === 'main') {
        parentModel = params.resolvedModel;
        const taskTool = params.toolProjection.resolve('task');
        if (!taskTool || !params.signal) throw new Error('Parent task wiring is incomplete.');
        const taskResult = await taskTool.execute({
          subagent_type: 'reviewer',
          description: 'review',
          prompt: 'inspect the patch',
        }, {
          sessionId: params.sessionId,
          turnId: params.turnId,
          callId: 'task-use-1',
          subagentDepth: 0,
          signal: params.signal,
        });
        return {
          text: taskResult.content,
          content: [{ type: 'text', text: taskResult.content }],
          stopReason: 'end_turn',
          usage: { inputTokens: 5, outputTokens: 2 },
          toolRounds: 1,
        };
      }
      childModel = params.resolvedModel;
      return {
        text: 'child result',
        content: [{ type: 'text', text: 'child result' }],
        stopReason: 'end_turn',
        usage: { inputTokens: 3, outputTokens: 1 },
        toolRounds: 0,
      };
    });
    const makeProvider = (id: string) => ({
      id,
      protocol: 'test',
      models: [{ modelId: id === 'child' ? 'child-model' : 'parent-model' }],
      invocationPort: {} as never,
      resolveConnection: () => ({ ok: true as const, connection: { endpointId: `${id}-endpoint` } }),
      resolveModel: (modelId: string, connection: { endpointId: string }) => ({
        ok: true as const,
        descriptor: {
          identity: { providerId: id, modelId },
          protocol: 'test',
          connection,
          facts: {
            effectiveContextLimit: 200_000,
            maximumOutputTokens: 8192,
            toolUse: true,
          },
        },
      }),
    });
    const events: AgentEvent[] = [];
    const app = await RuntimeApp.create({
      agentHome: agentHome,
      applicationConfig: testApplicationConfig({
        providerId: 'test',
        modelId: 'parent-model',
      }),
      cliOverrides: {
        memory: { enabled: false },
        subagents: {
          enabled: true,
          maxDepth: 1,
          list: [{
            id: 'reviewer',
            description: 'reviews code',
            model: selection,
          }],
        },
      },
      dependencies: createTestDependencies({
        createBuiltinProviderUnit: () => createTestProviderUnit([
          makeProvider('test'),
          makeProvider('child'),
        ]),
        createSessionManager: () => ({
          initialize: vi.fn(async () => undefined),
          getSession: vi.fn((sessionId: string) => sessionEntry(sessionId)),
          createTransientSubagentTranscript: vi.fn(async () => {}),
          deleteTransientSubagentTranscript,
        }) as never,
        createAgentRunner: () => ({
          run: runnerRun,
        }) as never,
        createMemoryManager: async () => null,
      }),
      onAgentEvent: (event) => events.push(event),
    });

    const result = await app.application.runTurn({
      sessionId: 'main',
      message: 'delegate',
      promptMode: 'full',
    });

    expect(result.text).toBe('child result');
    expect(parentModel?.identity).toEqual({ providerId: 'test', modelId: 'parent-model' });
    expect(childModel?.identity).toEqual(expectedIdentity);
    expect(childModel).not.toBe(parentModel);
    expect(events.filter((event) => event.type === 'subagent_start')).toHaveLength(1);
    expect(events.filter((event) => event.type === 'subagent_end')).toHaveLength(1);
    expect(deleteTransientSubagentTranscript).toHaveBeenCalledTimes(1);

    await app.close();
  });

  it('keeps a Parent tree on N while Catalog/default recover on N+1', async () => {
    const parentEntered = createDeferred<void>();
    const continueParent = createDeferred<void>();
    let childRuns = 0;
    let taskOutcome: string | undefined;
    let newRootProviderId: string | undefined;
    let implicitRootProviderId: string | undefined;
    let childProviderId: string | undefined;
    let childHasGenerationOneTool = false;
    let childHasGenerationOneHook = false;
    const runnerRun = vi.fn(async (params: RunParams): Promise<RunResult> => {
      if (params.sessionId === 'parent') {
        parentEntered.resolve();
        await continueParent.promise;
        const task = params.toolProjection.resolve('task');
        if (!task || !params.signal) throw new Error('Parent task wiring is incomplete.');
        const result = await task.execute({
          subagent_type: 'next-generation',
          description: 'generation check',
          prompt: 'must stay pinned',
        }, {
          sessionId: params.sessionId,
          turnId: params.turnId,
          callId: 'generation-task',
          subagentDepth: 0,
          signal: params.signal,
        });
        taskOutcome = result.outcome;
      } else if (params.sessionId === 'new-root') {
        newRootProviderId = params.resolvedModel.identity.providerId;
      } else if (params.sessionId === 'implicit-root') {
        implicitRootProviderId = params.resolvedModel.identity.providerId;
      } else {
        childRuns += 1;
        childProviderId = params.resolvedModel.identity.providerId;
        childHasGenerationOneTool = params.toolProjection.resolve('generation-one-tool') !== undefined;
        childHasGenerationOneHook = params.hookProjection.beforeToolCall.some(
          (hook) => hook.contributionId === 'generation-one-hook',
        );
      }
      return {
        text: 'done',
        content: [{ type: 'text', text: 'done' }],
        stopReason: 'end_turn',
        usage: { inputTokens: 1, outputTokens: 1 },
        toolRounds: 0,
      };
    });
    const nextProvider = {
      id: 'next-provider',
      protocol: 'test',
      models: [{ modelId: 'root-model' }],
      invocationPort: {} as never,
      resolveConnection: () => ({ ok: true as const, connection: { endpointId: 'next' } }),
      resolveModel: (modelId: string, connection: { endpointId: string }) => ({
        ok: true as const,
        descriptor: {
          identity: { providerId: 'next-provider', modelId },
          protocol: 'test',
          connection,
          facts: {
            effectiveContextLimit: 200_000,
            maximumOutputTokens: 8192,
            toolUse: true,
          },
        },
      }),
    };
    const nextProviderUnit = createLoadedRuntimeUnit({
      registration: {
        id: 'next-provider-unit',
        source: 'external',
        register(api) { api.registerProvider(nextProvider); },
      },
      required: false,
      initiallyEnabled: false,
    });
    const generationOneUnit = createLoadedRuntimeUnit({
      registration: {
        id: 'generation-one-unit',
        source: 'external',
        register(api) {
          api.registerTool({
            name: 'generation-one-tool',
            description: 'marks generation one',
            inputSchema: { type: 'object', properties: {} },
            execute: async () => ({ outcome: 'success', content: 'generation one' }),
          });
          api.registerHook({
            id: 'generation-one-hook',
            hookName: 'before_tool_call',
            handler: () => ({ action: 'allow' as const }),
          });
        },
      },
      required: false,
      initiallyEnabled: true,
    });
    const app = await RuntimeApp.create({
      agentHome: agentHome,
      loadedUnits: [generationOneUnit, nextProviderUnit],
      applicationConfig: testApplicationConfig({
        providerId: 'next-provider',
        modelId: 'root-model',
      }),
      cliOverrides: {
        memory: { enabled: false },
        subagents: {
          enabled: true,
          maxDepth: 1,
          list: [{
            id: 'next-generation',
            description: 'inherits the Parent Provider',
            model: 'inherit',
          }],
        },
      },
      dependencies: createTestDependencies({
        createAgentRunner: () => ({ run: runnerRun }) as never,
        createSessionManager: () => ({
          initialize: vi.fn(async () => undefined),
          getSession: vi.fn((sessionId: string) => sessionEntry(sessionId)),
          createTransientSubagentTranscript: vi.fn(async () => {}),
          deleteTransientSubagentTranscript: vi.fn(async () => {}),
        }) as never,
        createMemoryManager: async () => null,
      }),
    });

    expect(app.application.getModelCatalog()).toMatchObject({
      generation: 1,
      defaultSelection: {
        state: 'unavailable',
        reason: 'provider_unregistered',
      },
      providers: [{ providerId: 'test' }],
    });

    const parent = app.application.runTurn({
      sessionId: 'parent',
      message: 'hold generation one',
      modelReference: { providerId: 'test', modelId: 'parent-model' },
      promptMode: 'full',
    });
    await parentEntered.promise;
    await expect(app.composition.enableUnit('next-provider-unit')).resolves.toEqual(
      expect.objectContaining({ outcome: 'published', generation: 2 }),
    );
    expect(app.application.getModelCatalog()).toMatchObject({
      generation: 2,
      defaultSelection: { state: 'available' },
      providers: [{ providerId: 'test' }, { providerId: 'next-provider' }],
    });
    continueParent.resolve();
    await parent;

    expect(taskOutcome).toBe('success');
    expect(childRuns).toBe(1);
    expect(childProviderId).toBe('test');
    expect(childHasGenerationOneTool).toBe(true);
    expect(childHasGenerationOneHook).toBe(true);
    await app.application.runTurn({
      sessionId: 'new-root',
      message: 'use generation two',
      modelReference: { providerId: 'next-provider', modelId: 'root-model' },
      promptMode: 'full',
    });
    expect(newRootProviderId).toBe('next-provider');
    await app.application.runTurn({
      sessionId: 'implicit-root',
      message: 'use the recovered default in generation two',
      promptMode: 'full',
    });
    expect(implicitRootProviderId).toBe('next-provider');

    await app.close();
  });

  it('seals a direct model-resolution failure with one failed turn_end', async () => {
    const events: RuntimeEvent[] = [];
    const app = await RuntimeApp.create({
      agentHome: agentHome,
      onEvent: (event) => events.push(event),
      applicationConfig: testApplicationConfig(),
      cliOverrides: {
        memory: { enabled: false },
      },
      dependencies: createTestDependencies({ createMemoryManager: async () => null }),
    });

    await expect(app.application.runTurn({
      requestId: 'request-resolution-failure',
      sessionId: 'main',
      message: 'fail resolution',
      modelReference: { providerId: 'missing-provider', modelId: 'missing-model' },
      promptMode: 'full',
    })).rejects.toThrow();

    const terminal = events.filter((event) =>
      event.type === 'turn_end' && event.requestId === 'request-resolution-failure');
    expect(terminal).toHaveLength(1);
    expect(terminal[0]).toMatchObject({ outcome: 'failed', turnId: expect.any(String) });
    await app.close();
  });

  it('seals a direct Runner failure with one caller rejection and one failed turn_end', async () => {
    const events: RuntimeEvent[] = [];
    const providerError = new ModelInvocationError('invalid_request', {
      providerId: 'test-provider',
      httpStatus: 400,
      providerErrorType: 'invalid_request_error',
      providerMessage: 'At most one image is supported.',
      requestId: 'req-provider-1',
      request: {
        model: 'test-model',
        maxTokens: 1024,
        hasSystem: true,
        messageCount: 4,
        userMessageCount: 2,
        assistantMessageCount: 2,
        stringContentMessageCount: 1,
        textBlockCount: 2,
        imageBlockCount: 4,
        toolUseBlockCount: 1,
        toolResultBlockCount: 1,
        toolDefinitionCount: 3,
      },
    });
    const runnerError = new Error(providerError.message, { cause: providerError });
    const errorLog = vi.spyOn(Logger.get('RuntimeApp'), 'error');
    const app = await RuntimeApp.create({
      agentHome: agentHome,
      onEvent: (event) => events.push(event),
      applicationConfig: testApplicationConfig(),
      cliOverrides: {
        memory: { enabled: false },
      },
      dependencies: createTestDependencies({
        createAgentRunner: () => ({ run: async () => { throw runnerError; } }) as never,
        createMemoryManager: async () => null,
      }),
    });

    const caller = app.application.runTurn({
      requestId: 'request-runner-failure',
      sessionId: 'main',
      message: 'fail execution',
      promptMode: 'full',
    });
    await expect(caller).rejects.toMatchObject({
      info: {
        code: 'RUN_FAILED',
        message: 'Model invocation failed: invalid_request.',
      },
    });
    expect(events.filter((event) =>
      event.type === 'turn_end' && event.requestId === 'request-runner-failure')).toEqual([
      expect.objectContaining({
        outcome: 'failed',
        failure: {
          code: 'RUN_FAILED',
          message: 'Model invocation failed: invalid_request.',
        },
      }),
    ]);
    expect(errorLog).toHaveBeenCalledWith('turn failed', expect.objectContaining({
      requestId: 'request-runner-failure',
      code: 'RUN_FAILED',
      modelInvocation: {
        category: 'invalid_request',
        diagnostics: {
          ...providerError.diagnostics,
          request: {
            ...providerError.diagnostics?.request,
            model: '"test-model"',
          },
        },
      },
    }));
    await app.close();
    errorLog.mockRestore();
  });

  it('canonicalizes a foreign structural invocation error and logs only a bounded projection', async () => {
    const opaqueModelId = `model\r\n\t${'x'.repeat(210)}hidden-suffix`;
    const foreign = Object.assign(new Error('foreign secret message'), {
      protocol: 'my-agent.model-invocation-error',
      version: 1,
      category: 'rate_limit',
      diagnostics: {
        providerId: 'external-provider',
        httpStatus: 429,
        providerErrorCode: 'quota_exhausted',
        unknown: 'hidden diagnostic',
        request: {
          model: opaqueModelId,
          maxTokens: 512,
          hasSystem: false,
          messageCount: 1,
          userMessageCount: 1,
          assistantMessageCount: 0,
          stringContentMessageCount: 1,
          textBlockCount: 0,
          imageBlockCount: 0,
          toolUseBlockCount: 0,
          toolResultBlockCount: 0,
          toolDefinitionCount: 0,
          prompt: 'hidden prompt',
        },
      },
      privatePayload: 'hidden payload',
    });
    foreign.stack = 'hidden foreign stack';
    const runnerError = new Error('outer secret wrapper', { cause: foreign });
    const errorLog = vi.spyOn(Logger.get('RuntimeApp'), 'error');
    const app = await RuntimeApp.create({
      agentHome: agentHome,
      applicationConfig: testApplicationConfig(),
      cliOverrides: {
        memory: { enabled: false },
      },
      dependencies: createTestDependencies({
        createAgentRunner: () => ({ run: async () => { throw runnerError; } }) as never,
        createMemoryManager: async () => null,
      }),
    });

    try {
      await expect(app.application.runTurn({
        requestId: 'foreign-structural-error',
        sessionId: 'foreign',
        message: 'fail structurally',
        promptMode: 'full',
      })).rejects.toMatchObject({
        info: {
          message: 'Model invocation failed: rate_limit.',
          cause: {
            name: 'ModelInvocationError',
            category: 'rate_limit',
            diagnostics: {
              providerId: 'external-provider',
              request: { model: opaqueModelId },
            },
          },
        },
      });

      const logEntry = errorLog.mock.calls.find(([, fields]) => (
        fields as { requestId?: string }
      ).requestId === 'foreign-structural-error')?.[1];
      expect(logEntry).toMatchObject({
        message: 'Model invocation failed: rate_limit.',
        modelInvocation: {
          category: 'rate_limit',
          diagnostics: {
            providerId: 'external-provider',
            providerErrorCode: 'quota_exhausted',
            request: {
              model: JSON.stringify(`${opaqueModelId.slice(0, 200)}…`),
            },
          },
        },
      });
      const serializedLog = JSON.stringify(logEntry);
      expect(serializedLog).not.toContain('foreign secret message');
      expect(serializedLog).not.toContain('outer secret wrapper');
      expect(serializedLog).not.toContain('hidden foreign stack');
      expect(serializedLog).not.toContain('hidden diagnostic');
      expect(serializedLog).not.toContain('hidden prompt');
      expect(serializedLog).not.toContain('hidden payload');
      expect(serializedLog).not.toContain('hidden-suffix');
    } finally {
      await app.close();
      errorLog.mockRestore();
    }
  });

  it('bounds cause traversal, detects cycles, and does not execute cause accessors', async () => {
    const structural = Object.assign(new Error('foreign'), {
      protocol: 'my-agent.model-invocation-error',
      version: 1,
      category: 'transport',
    });
    let lastAccepted: Error = structural;
    for (let index = 0; index < 7; index += 1) {
      lastAccepted = new Error(`accepted-wrapper-${index}`, { cause: lastAccepted });
    }
    let tooDeep: Error = structural;
    for (let index = 0; index < 8; index += 1) {
      tooDeep = new Error(`wrapper-${index}`, { cause: tooDeep });
    }

    const cycleA = new Error('cycle-a');
    const cycleB = new Error('cycle-b', { cause: cycleA });
    Object.defineProperty(cycleA, 'cause', { value: cycleB });

    const causeGetter = vi.fn(() => structural);
    const accessorCause = new Error('accessor-cause');
    Object.defineProperty(accessorCause, 'cause', { get: causeGetter });

    const failures = new Map<string, Error>([
      ['last-accepted', lastAccepted],
      ['too-deep', tooDeep],
      ['cycle', cycleA],
      ['accessor', accessorCause],
    ]);
    const errorLog = vi.spyOn(Logger.get('RuntimeApp'), 'error');
    const app = await RuntimeApp.create({
      agentHome: agentHome,
      applicationConfig: testApplicationConfig(),
      cliOverrides: {
        memory: { enabled: false },
      },
      dependencies: createTestDependencies({
        createAgentRunner: () => ({
          run: async ({ sessionId: sessionKey }: RunParams) => { throw failures.get(sessionKey); },
        }) as never,
        createMemoryManager: async () => null,
      }),
    });

    try {
      for (const sessionKey of failures.keys()) {
        await expect(app.application.runTurn({
          requestId: `cause-${sessionKey}`,
          sessionId: sessionKey,
          message: 'fail',
          promptMode: 'full',
        })).rejects.toThrow();
      }

      expect(causeGetter).not.toHaveBeenCalled();
      const logEntry = (sessionKey: string) => errorLog.mock.calls.find(([, fields]) => (
        fields as { requestId?: string }
      ).requestId === `cause-${sessionKey}`)?.[1];
      expect(logEntry('last-accepted')).toMatchObject({
        modelInvocation: { category: 'transport' },
      });
      expect(logEntry('too-deep')).not.toHaveProperty('modelInvocation');
      expect(logEntry('cycle')).not.toHaveProperty('modelInvocation');
      expect(logEntry('accessor')).not.toHaveProperty('modelInvocation');
    } finally {
      await app.close();
      errorLog.mockRestore();
    }
  });

  it('CH-05 isolates channel.send failures without changing Turn execution', async () => {
    const runnerRun = vi.fn(async (): Promise<RunResult> => ({
      text: 'done',
      content: [{ type: 'text', text: 'done' }],
      stopReason: 'end_turn',
      usage: { inputTokens: 1, outputTokens: 1 },
      toolRounds: 0,
    }));
    const observedEvents = vi.fn();
    const deps = createTestDependencies({
      createAgentRunner: () => ({ run: runnerRun } as never),
      createMemoryManager: async () => null,
    });
    const failingChannel = createTestChannel('failing-channel');
    failingChannel.channel.send = vi.fn(() => {
      throw new Error('channel failed');
    });
    const receivingChannel = createTestChannel('receiving-channel');
    const receivedEvents = vi.fn();
    receivingChannel.channel.send = receivedEvents;
    const app = await RuntimeApp.create({
      agentHome: agentHome,
      loadedUnits: [failingChannel.unit, receivingChannel.unit],
      applicationConfig: testApplicationConfig(),
      cliOverrides: {
        memory: { enabled: false },
      },
      dependencies: deps,
      onAgentEvent: observedEvents,
    });

    await failingChannel.dispatch({
      sessionId: 'main',
      message: 'fan out',
      clientId: 'client-1',
    });

    expect(receivedEvents).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'user_message',
        sessionId: 'main',
        content: 'fan out',
      }),
    );
    expect(observedEvents).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'user_message', sessionId: 'main' }),
    );
    expect(runnerRun).toHaveBeenCalledTimes(1);
  });

  it('CH-05 isolates an onAgentEvent observer failure from Runner execution', async () => {
    const runnerRun = vi.fn(async (): Promise<RunResult> => ({
      text: 'unreachable',
      content: [{ type: 'text', text: 'unreachable' }],
      stopReason: 'end_turn',
      usage: { inputTokens: 1, outputTokens: 1 },
      toolRounds: 0,
    }));
    const observerError = new Error('observer failed');
    const deps = createTestDependencies({
      createAgentRunner: () => ({ run: runnerRun } as never),
      createMemoryManager: async () => null,
    });
    const testChannel = createTestChannel('observer-failure-channel');
    const app = await RuntimeApp.create({
      agentHome: agentHome,
      loadedUnits: [testChannel.unit],
      applicationConfig: testApplicationConfig(),
      cliOverrides: {
        memory: { enabled: false },
      },
      dependencies: deps,
      onAgentEvent: (event) => {
        if (event.type === 'user_message') throw observerError;
      },
    });
    await expect(testChannel.dispatch({
      sessionId: 'main',
      message: 'observe',
      clientId: 'client-1',
    })).resolves.toBeUndefined();

    expect(runnerRun).toHaveBeenCalledTimes(1);
  });

  it('degrades to warning when memory initialization fails', async () => {
    const events: RuntimeEvent[] = [];
    const deps = createTestDependencies({
      createMemoryManager: async () => {
        throw new Error('memory init failed');
      },
    });

    const app = await RuntimeApp.create({
      agentHome: agentHome,
      applicationConfig: testApplicationConfig(),
      cliOverrides: {
      },
      dependencies: deps,
      onEvent: (event) => events.push(event),
    });

    expect(app.application.getToolNames()).not.toContain('memory_search');
    expect(events.some((event) => event.type === 'warning')).toBe(true);
    expect(events.some((event) => event.type === 'app_ready')).toBe(true);
  });

  it.each([
    { subagentsEnabled: true, taskExpected: true },
    { subagentsEnabled: false, taskExpected: false },
  ])('publishes one final Snapshot before app_ready when subagents enabled=$subagentsEnabled', async ({
    subagentsEnabled,
    taskExpected,
  }) => {
    const events: RuntimeEvent[] = [];
    const app = await RuntimeApp.create({
      agentHome: agentHome,
      applicationConfig: testApplicationConfig(),
      cliOverrides: {
        memory: { enabled: false },
        subagents: { enabled: subagentsEnabled, maxDepth: 1 },
      },
      dependencies: createTestDependencies(),
      onEvent: (event) => events.push(event),
    });

    const readyEvents = events.filter((event) => event.type === 'app_ready');
    expect(readyEvents).toHaveLength(1);
    expect(readyEvents[0]?.toolNames).toEqual(app.application.getToolNames());
    expect(readyEvents[0]?.toolNames.includes('task')).toBe(taskExpected);

    await app.close();
  });

  it('emits app_ready only after Channel readiness with final channelIds', async () => {
    const events: RuntimeEvent[] = [];
    const ready = createDeferred<void>();
    const testChannel = createTestChannel('deferred-ready-channel');
    testChannel.channel.start = vi.fn(async () => ready.promise);

    const creation = RuntimeApp.create({
      agentHome: agentHome,
      loadedUnits: [testChannel.unit],
      applicationConfig: testApplicationConfig(),
      cliOverrides: {
        memory: { enabled: false },
      },
      dependencies: createTestDependencies(),
      onEvent: (event) => events.push(event),
    });

    await vi.waitFor(() => expect(testChannel.channel.start).toHaveBeenCalledTimes(1));
    expect(events.map((event) => event.type)).not.toContain('app_ready');

    ready.resolve();
    const app = await creation;
    expect(events.filter((event) => event.type === 'app_ready')).toEqual([
      expect.objectContaining({ channelIds: ['deferred-ready-channel'] }),
    ]);
    await app.close();
  });

  it('stops activated Channels when app_ready delivery rejects RuntimeApp creation', async () => {
    const observerError = new Error('app_ready observer failed');
    const testChannel = createTestChannel('ready-observer-failure');
    const stop = vi.spyOn(testChannel.channel, 'stop');

    await expect(RuntimeApp.create({
      agentHome: agentHome,
      loadedUnits: [testChannel.unit],
      applicationConfig: testApplicationConfig(),
      cliOverrides: {
        memory: { enabled: false },
      },
      dependencies: createTestDependencies(),
      onEvent: (event) => {
        if (event.type === 'app_ready') throw observerError;
      },
    })).rejects.toBe(observerError);

    expect(stop).toHaveBeenCalledTimes(1);
    await expect(testChannel.channel.completion).resolves.toEqual({
      outcome: 'closed',
      reason: 'stopped',
    });
  });

  it('cleans Memory exactly once after Builder-side Unit assembly failure', async () => {
    const events: RuntimeEvent[] = [];
    const memoryClose = vi.fn();
    const startupError = new Error('tool assembly failed');

    await expect(RuntimeApp.create({
      agentHome: agentHome,
      applicationConfig: testApplicationConfig(),
      cliOverrides: {
        memory: { enabled: true },
      },
      dependencies: createTestDependencies({
        createMemoryManager: async () => ({ close: memoryClose }) as never,
        getBuiltinContributionUnits: () => {
          throw startupError;
        },
      }),
      onEvent: (event) => events.push(event),
    })).rejects.toBe(startupError);

    expect(events.map((event) => event.type)).toContain('app_start');
    expect(events.map((event) => event.type)).toContain('error');
    expect(events.map((event) => event.type)).not.toContain('app_ready');
    expect(memoryClose).toHaveBeenCalledTimes(1);
  });

  it('bounds nonresponsive Memory cleanup after a bootstrap failure', async () => {
    const deadlineDriver = new ManualDeadlineDriver();
    const memoryClose = vi.fn(() => new Promise<void>(() => undefined));
    const startupError = new Error('runner creation failed');
    const creation = RuntimeApp.create({
      agentHome: agentHome,
      deadlineDriver,
      deadlinePolicy: { candidateCleanupMs: 5_000 },
      applicationConfig: testApplicationConfig(),
      cliOverrides: {
        memory: { enabled: true },
      },
      dependencies: createTestDependencies({
        createMemoryManager: async () => ({ close: memoryClose }) as never,
        createAgentRunner: () => { throw startupError; },
      }),
    });

    await vi.waitFor(() => expect(memoryClose).toHaveBeenCalledTimes(1));
    deadlineDriver.advanceBy(5_000);

    await expect(creation).rejects.toBe(startupError);
  });

  it('fails a missing model before Runner and resolves an explicit Catalog model', async () => {
    const agentEvents: AgentEvent[] = [];
    const runnerRun = vi.fn(async (): Promise<RunResult> => ({
      text: 'provider accepted model',
      content: [{ type: 'text', text: 'provider accepted model' }],
      stopReason: 'end_turn',
      usage: { inputTokens: 2, outputTokens: 1 },
      toolRounds: 0,
    }));
    const app = await RuntimeApp.create({
      agentHome: agentHome,
      applicationConfig: testApplicationConfig(null),
      cliOverrides: {
        memory: { enabled: false },
      },
      dependencies: createTestDependencies({
        createAgentRunner: () => ({ run: runnerRun }) as never,
        createMemoryManager: async () => null,
      }),
      onAgentEvent: (event) => agentEvents.push(event),
    });

    await expect(app.application.runTurn({
      sessionId: 'main',
      message: 'missing model',
      promptMode: 'full',
    })).rejects.toMatchObject({
      info: {
        code: 'MODEL_MISSING',
        resolutionCategory: 'reference_invalid',
        cause: { category: 'reference_invalid' },
      },
    });
    expect(runnerRun).not.toHaveBeenCalled();
    expect(agentEvents.filter((event) => event.type === 'error')).toEqual([]);

    await expect(app.application.runTurn({
      sessionId: 'main',
      message: 'queued missing model',
      promptMode: 'full',
      turnId: 'queued-resolution-turn',
      originMessageId: 'queued-message',
    })).rejects.toMatchObject({ info: { code: 'MODEL_MISSING' } });
    expect(agentEvents.filter((event) => event.type === 'error')).toEqual([
      expect.objectContaining({
        type: 'error',
        sessionId: 'main',
        turnId: 'queued-resolution-turn',
        category: 'reference_invalid',
        originMessageId: 'queued-message',
      }),
    ]);
    expect(runnerRun).not.toHaveBeenCalled();

    await expect(app.application.runTurn({
      sessionId: 'main',
      message: 'explicit model',
      promptMode: 'full',
      modelReference: { providerId: 'test', modelId: 'test-model' },
    })).resolves.toEqual(expect.objectContaining({ text: 'provider accepted model' }));
    expect(runnerRun).toHaveBeenCalledTimes(1);
    expect(runnerRun).toHaveBeenCalledWith(
      expect.objectContaining({
        resolvedModel: expect.objectContaining({
          identity: { providerId: 'test', modelId: 'test-model' },
          referenceSource: 'turn-explicit',
        }),
      }),
    );

    await app.close();
  });

  it('reloads context files, closes idempotently, and rejects future runs after close', async () => {
    await writeFile(join(agentHome, 'IDENTITY.md'), '# Identity', 'utf-8').catch(() => undefined);

    const memoryClose = vi.fn();
    const deps = createTestDependencies({
      createMemoryManager: async () => ({ close: memoryClose } as never),
    });

    const app = await RuntimeApp.create({
      agentHome: agentHome,
      applicationConfig: testApplicationConfig(),
      cliOverrides: {
        memory: { enabled: true },
      },
      dependencies: deps,
    });

    const previousVersion = app.application.getState().contextVersion;
    await app.application.reloadContextFiles();
    expect(app.application.getState().contextVersion).toBe(previousVersion + 1);

    await app.close('test shutdown');
    await app.close('test shutdown');

    expect(memoryClose).toHaveBeenCalledTimes(1);
    await expect(app.application.runTurn({ sessionId: 'main', message: 'after close', promptMode: 'full' })).rejects.toThrow(
      'Cannot run when runtime phase is closed.',
    );
  });

  it('CH-07 rolls back a failed Channel while preserving an independent successful Channel', async () => {
    const startError = new Error('channel start failed');
    const events: RuntimeEvent[] = [];
    const successfulChannel = createTestChannel('successful-channel');
    const failingChannel = createTestChannel('failing-channel');
    successfulChannel.channel.start = vi.fn(async () => {});
    successfulChannel.channel.stop = vi.fn(async () => {});
    failingChannel.channel.start = vi.fn(async () => {
      throw startError;
    });
    failingChannel.channel.stop = vi.fn(async () => {});

    const app = await RuntimeApp.create({
      agentHome: agentHome,
      loadedUnits: [successfulChannel.unit, failingChannel.unit],
      applicationConfig: testApplicationConfig(),
      cliOverrides: {
        memory: { enabled: false },
      },
      dependencies: createTestDependencies({
        createAgentRunner: () => ({
          on: () => {},
          run: vi.fn(),
        }) as never,
        createMemoryManager: async () => null,
      }),
      onEvent: (event) => events.push(event),
    });
    expect(successfulChannel.channel.start).toHaveBeenCalledTimes(1);
    expect(failingChannel.channel.start).toHaveBeenCalledTimes(1);
    expect(successfulChannel.channel.stop).not.toHaveBeenCalled();
    expect(failingChannel.channel.stop).toHaveBeenCalledTimes(1);
    await expect(app.application.waitForChannelCompletion('failing-channel')).resolves.toEqual(
      expect.objectContaining({ outcome: 'failed', phase: 'startup', error: startError }),
    );
    expect(events).toContainEqual({
      type: 'warning',
      info: expect.objectContaining({
        code: 'CHANNEL_START_FAILED',
        unitId: 'builtin-test-channel-failing-channel',
        contributionId: 'failing-channel',
        phase: 'start',
      }),
    });

    await app.close();
    expect(successfulChannel.channel.stop).toHaveBeenCalledTimes(1);
    expect(failingChannel.channel.stop).toHaveBeenCalledTimes(1);
  });

  it('CH-08 isolates and reports a Channel stop failure', async () => {
    const failingChannel = createTestChannel('failing-stop-channel');
    const successfulChannel = createTestChannel('successful-stop-channel');
    failingChannel.channel.stop = vi.fn(async () => {
      throw new Error('channel stop failed');
    });
    successfulChannel.channel.stop = vi.fn(async () => {});

    const app = await RuntimeApp.create({
      agentHome: agentHome,
      loadedUnits: [failingChannel.unit, successfulChannel.unit],
      applicationConfig: testApplicationConfig(),
      cliOverrides: {
        memory: { enabled: false },
      },
      dependencies: createTestDependencies({
        createAgentRunner: () => ({
          on: () => {},
          run: vi.fn(),
        }) as never,
        createMemoryManager: async () => null,
      }),
    });
    const report = await app.close();

    expect(failingChannel.channel.stop).toHaveBeenCalledTimes(1);
    expect(successfulChannel.channel.stop).toHaveBeenCalledTimes(1);
    expect(report.completed.some((resource) =>
      resource.endsWith(':channel:successful-stop-channel'))).toBe(true);
    expect(report.failed).toEqual([
      {
        resource: expect.stringMatching(/:channel:failing-stop-channel$/),
        message: 'channel stop failed',
      },
    ]);
    expect(app.application.getState().phase).toBe('closed');
  });

  it('CH-01 serializes a busy session while another session runs concurrently', async () => {
    const firstRun = createDeferred<RunResult>();
    const secondRun = createDeferred<RunResult>();
    const otherRun = createDeferred<RunResult>();
    const runnerRun = vi.fn(async (params: { sessionId: string; message: string }): Promise<RunResult> => {
      if (params.sessionId === 'main' && params.message === 'first') {
        return firstRun.promise;
      }
      if (params.sessionId === 'other') {
        return otherRun.promise;
      }
      return secondRun.promise;
    });
    const result = (text: string): RunResult => ({
        text,
        content: [{ type: 'text', text }],
        stopReason: 'end_turn',
        usage: { inputTokens: 1, outputTokens: 1 },
        toolRounds: 0,
      });

    const deps = createTestDependencies({
      createAgentRunner: () => ({ run: runnerRun } as never),
      createMemoryManager: async () => null,
    });

    const testChannel = createTestChannel('queue-test');
    const app = await RuntimeApp.create({
      agentHome: agentHome,
      loadedUnits: [testChannel.unit],
      applicationConfig: testApplicationConfig(),
      cliOverrides: {
        memory: { enabled: false },
      },
      dependencies: deps,
    });

    const firstDispatch = testChannel.dispatch({
      sessionId: 'main',
      message: 'first',
      clientId: 'client-1',
    });

    await vi.waitFor(() => {
      expect(runnerRun).toHaveBeenCalledTimes(1);
    });

    const secondDispatch = testChannel.dispatch({
      sessionId: 'main',
      message: 'second',
      clientId: 'client-1',
      maxLlmCalls: 9,
    });

    await secondDispatch;
    expect(runnerRun).toHaveBeenCalledTimes(1);

    const otherDispatch = testChannel.dispatch({
      sessionId: 'other',
      message: 'parallel',
      clientId: 'client-2',
    });

    await vi.waitFor(() => {
      expect(runnerRun).toHaveBeenCalledTimes(2);
    });
    expect(runnerRun.mock.calls.map(([params]) => [params.sessionId, params.message])).toEqual([
      ['main', 'first'],
      ['other', 'parallel'],
    ]);

    firstRun.resolve(result('first'));

    await firstDispatch;
    await vi.waitFor(() => {
      expect(runnerRun).toHaveBeenCalledTimes(3);
    });
    expect(runnerRun.mock.calls[2]?.[0]).toEqual(
      expect.objectContaining({
        sessionId: 'main',
        message: 'second',
        maxLlmCalls: 9,
      }),
    );

    secondRun.resolve(result('second'));
    otherRun.resolve(result('parallel'));
    await otherDispatch;
    await vi.waitFor(() => {
      expect(app.application.getState().activeRunCount).toBe(0);
    });
  });

  it('routes busy-session channel input to steering when steer mode is enabled', async () => {
    const releaseRun = createDeferred<void>();
    let drainedSteering: ChatMessage[] = [];
    const runnerRun = vi.fn(async (params: {
      getSteeringMessages?: () => Promise<ChatMessage[]>;
    }): Promise<RunResult> => {
      await releaseRun.promise;
      drainedSteering = await params.getSteeringMessages?.() ?? [];
      return {
        text: 'done',
        content: [{ type: 'text', text: 'done' }],
        stopReason: 'end_turn',
        usage: { inputTokens: 1, outputTokens: 1 },
        toolRounds: 0,
      };
    });

    const deps = createTestDependencies({
      createAgentRunner: () => ({ run: runnerRun } as never),
      createMemoryManager: async () => null,
    });

    const testChannel = createTestChannel('steer-test');
    const app = await RuntimeApp.create({
      agentHome: agentHome,
      loadedUnits: [testChannel.unit],
      applicationConfig: {
        ...testApplicationConfig(),
        runtime: { steeringEnabled: true },
      },
      cliOverrides: {
        memory: { enabled: false },
      },
      dependencies: deps,
    });

    const firstDispatch = testChannel.dispatch({
      sessionId: 'main',
      message: 'first',
      clientId: 'client-1',
    });

    await vi.waitFor(() => {
      expect(runnerRun).toHaveBeenCalledTimes(1);
    });

    const steeringDispatch = testChannel.dispatch({
      sessionId: 'main',
      message: 'steer now',
      clientId: 'client-2',
    });

    await steeringDispatch;
    expect(runnerRun).toHaveBeenCalledTimes(1);

    releaseRun.resolve();
    await firstDispatch;

    expect(drainedSteering).toEqual([
      {
        role: 'user',
        content: 'steer now',
      },
    ]);
  });

  it('CH-06 keeps queued turn approval pending past 120 seconds and closes it on Turn abort', async () => {
    vi.useFakeTimers();

    try {
      const firstRun = createDeferred<RunResult>();
      const approvalRequests: ApprovalRequest[] = [];
      const approvalClosures: Array<{
        request: ApprovalRequest;
        result: ApprovalClosedResult;
      }> = [];
      let approvalDecision: unknown;

      const runnerRun = vi.fn()
        .mockImplementationOnce(async (): Promise<RunResult> => firstRun.promise)
        .mockImplementationOnce(async (params: RunParams): Promise<RunResult> => {
          if (!params.approvalCapability || !params.signal) {
            throw new Error('Approval capability is missing.');
          }
          const approval = await params.approvalCapability.request({
              callId: 'demo-call',
              toolName: 'demo_tool',
              input: { approval: true },
              turnId: params.turnId,
              sessionId: params.sessionId,
            }, params.signal);
          approvalDecision = approval.outcome;
          if (approval.outcome === 'aborted') {
            return {
              text: '',
              content: [],
              stopReason: 'aborted',
              usage: { inputTokens: 0, outputTokens: 0 },
              toolRounds: 0,
            };
          }

          return {
            text: 'approved',
            content: [{ type: 'text', text: 'approved' }],
            stopReason: 'end_turn',
            usage: { inputTokens: 1, outputTokens: 1 },
            toolRounds: 0,
          };
        });

      const agentRunner = {
        run: runnerRun,
      };

      const deps = createTestDependencies({
        createAgentRunner: () => agentRunner as never,
        createMemoryManager: async () => null,
      });

      const testChannel = createApprovalTestChannel('approval-expiry-queue-test', {
        approvalRequests,
        approvalClosures,
        autoDecision: null,
      });
      const app = await RuntimeApp.create({
        agentHome: agentHome,
        loadedUnits: [testChannel.unit],
        applicationConfig: testApplicationConfig(),
        cliOverrides: {
          memory: { enabled: false },
        },
        dependencies: deps,
      });

      const firstDispatch = testChannel.dispatch({
        sessionId: 'main',
        message: 'first',
        clientId: 'client-1',
      });

      await vi.waitFor(() => {
        expect(runnerRun).toHaveBeenCalledTimes(1);
      });

      const secondDispatch = testChannel.dispatch({
        sessionId: 'main',
        message: 'second',
        clientId: 'client-2',
      });

      await secondDispatch;
      expect(runnerRun).toHaveBeenCalledTimes(1);

      firstRun.resolve({
        text: 'first',
        content: [{ type: 'text', text: 'first' }],
        stopReason: 'end_turn',
        usage: { inputTokens: 1, outputTokens: 1 },
        toolRounds: 0,
      });

      await firstDispatch;
      await vi.waitFor(() => {
        expect(approvalRequests).toHaveLength(1);
      });

      await vi.advanceTimersByTimeAsync(120_000);
      expect(approvalClosures).toHaveLength(0);
      expect(approvalDecision).toBeUndefined();

      expect(app.application.abortTurn('main')).toEqual({ aborted: true, dropped: 0 });
      await vi.waitFor(() => {
        expect(approvalClosures).toHaveLength(1);
      });

      const queuedRunPromise = runnerRun.mock.results[1]?.value;
      expect(queuedRunPromise).toBeDefined();
      await queuedRunPromise;
      expect(approvalDecision).toBe('aborted');

      expect(approvalRequests[0]).toEqual(
        expect.objectContaining({
          sessionId: 'main',
          toolName: 'demo_tool',
          originClientId: 'client-2',
        }),
      );
      expect(approvalClosures[0]).toEqual({
        request: expect.objectContaining({
          sessionId: 'main',
          toolName: 'demo_tool',
          originClientId: 'client-2',
        }),
        result: { outcome: 'aborted', reason: 'turn' },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('fails closed without an origin approval capability independently of Channel startup history', async () => {
    const decisions: unknown[] = [];
    const runnerRun = vi.fn(async (params: RunParams): Promise<RunResult> => {
      decisions.push({
        decision: params.toolPolicy.decide(
          'unmatched_tool',
          {},
          params.approvalCapability !== undefined,
        ),
        hasApprovalCapability: params.approvalCapability !== undefined,
      });
      return {
        text: 'done',
        content: [{ type: 'text', text: 'done' }],
        stopReason: 'end_turn',
        usage: { inputTokens: 1, outputTokens: 1 },
        toolRounds: 0,
      };
    });
    const agentRunner = {
      run: runnerRun,
    };
    const deps = createTestDependencies({
      createAgentRunner: () => agentRunner as never,
      createMemoryManager: async () => null,
    });
    const testChannel = createTestChannel('no-approval-channel');
    const app = await RuntimeApp.create({
      agentHome: agentHome,
      loadedUnits: [testChannel.unit],
      applicationConfig: testApplicationConfig(),
      cliOverrides: {
        memory: { enabled: false },
        tools: { allow: [], deny: [] },
      },
      dependencies: deps,
    });
    await testChannel.dispatch({ sessionId: 'main', message: 'first request' });
    expect(decisions).toEqual([{ decision: 'deny', hasApprovalCapability: false }]);

    await testChannel.dispatch({ sessionId: 'main', message: 'second request' });

    expect(decisions).toEqual([
      { decision: 'deny', hasApprovalCapability: false },
      { decision: 'deny', hasApprovalCapability: false },
    ]);
  });

  it('CH-06 shutdown closes a pending approval before waiting for Turn convergence', async () => {
    const approvalRequests: ApprovalRequest[] = [];
    const approvalClosures: Array<{
      request: ApprovalRequest;
      result: ApprovalClosedResult;
    }> = [];

    const agentRunner = {
      run: vi.fn(async (params: RunParams): Promise<RunResult> => {
        if (!params.approvalCapability || !params.signal) {
          throw new Error('Approval capability is missing.');
        }
        const approval = await params.approvalCapability.request({
            callId: 'demo-call',
            toolName: 'demo_tool',
            input: {},
            turnId: params.turnId,
            sessionId: params.sessionId,
          }, params.signal);
        if (approval.outcome !== 'aborted') {
          throw new Error('approval unexpectedly settled without shutdown');
        }
        return {
          text: '',
          content: [],
          stopReason: 'aborted',
          usage: { inputTokens: 0, outputTokens: 0 },
          toolRounds: 0,
        };
      }),
    };
    const testChannel = createApprovalTestChannel('approval-shutdown-test', {
      approvalRequests,
      approvalClosures,
      autoDecision: null,
    });
    const app = await RuntimeApp.create({
      agentHome: agentHome,
      loadedUnits: [testChannel.unit],
      applicationConfig: testApplicationConfig(),
      cliOverrides: {
        memory: { enabled: false },
      },
      dependencies: createTestDependencies({
        createAgentRunner: () => agentRunner as never,
        createMemoryManager: async () => null,
      }),
    });
    const dispatch = testChannel.dispatch({
      sessionId: 'main',
      message: 'wait for approval',
      clientId: 'client-1',
    });
    await vi.waitFor(() => {
      expect(approvalRequests).toHaveLength(1);
    });

    await expect(app.close('approval shutdown test')).resolves.toEqual(
      expect.objectContaining({ failed: [] }),
    );
    await dispatch;
    expect(approvalClosures).toEqual([
      {
        request: expect.objectContaining({
          toolName: 'demo_tool',
          originClientId: 'client-1',
        }),
        result: { outcome: 'aborted', reason: 'shutdown' },
      },
    ]);
  });

  // ── Abort（core-abort-spec.md §8） ──────────────────

  describe('abort', () => {
    // Run one Turn with an abortable hook; callers can customize runnerRun.
    async function makeAppWithRunner(runnerRun: (params: unknown) => Promise<RunResult>): Promise<RuntimeHandle> {
      const deps = createTestDependencies({
        createAgentRunner: () => ({ run: runnerRun }) as never,
        createMemoryManager: async () => null,
      });
      return RuntimeApp.create({
        agentHome: agentHome,
        applicationConfig: testApplicationConfig(),
        cliOverrides: {
          memory: { enabled: false },
        },
        dependencies: deps,
      });
    }

    // With no active Turn or queue, abortTurn reports no work and emits nothing.
    it('abortTurn: 无 active + 无 queue → returns { false, 0 }, no emit', async () => {
      const events: RuntimeEvent[] = [];
      const app = await makeAppWithRunner(async () => ({
        text: 'ok',
        content: [{ type: 'text', text: 'ok' }],
        stopReason: 'end_turn',
        usage: { inputTokens: 1, outputTokens: 1 },
        toolRounds: 0,
      }));
      // Recreate the app to install the event collector through onEvent.
      const app2 = await RuntimeApp.create({
        agentHome: agentHome,
        applicationConfig: testApplicationConfig(),
        cliOverrides: { memory: { enabled: false } },
        dependencies: createTestDependencies({ createMemoryManager: async () => null }),
        onEvent: (e) => events.push(e),
      });

      const result = app2.application.abortTurn('no-such-session');
      expect(result).toEqual({ aborted: false, dropped: 0 });
      expect(events.find((e) => e.type === 'messages_dropped')).toBeUndefined();
      await app.close();
      await app2.close();
    });

    // An active Turn with an empty queue reports aborted without a drop event.
    it('abortTurn: 有 active turn + queue 空 → aborts turn, no emit', async () => {
      const events: RuntimeEvent[] = [];
      const releaseRun = createDeferred<void>();
      let capturedSignal: AbortSignal | undefined;

      const runnerRun = vi.fn(async (params: { signal?: AbortSignal }): Promise<RunResult> => {
        capturedSignal = params.signal;
        await releaseRun.promise;
        return {
          text: 'aborted',
          content: [],
          stopReason: 'aborted',
          usage: { inputTokens: 0, outputTokens: 0 },
          toolRounds: 0,
        };
      });

      const app = await RuntimeApp.create({
        agentHome: agentHome,
        applicationConfig: testApplicationConfig(),
        cliOverrides: { memory: { enabled: false } },
        dependencies: createTestDependencies({
          createAgentRunner: () => ({ run: runnerRun }) as never,
          createMemoryManager: async () => null,
        }),
        onEvent: (e) => events.push(e),
      });

      const turnPromise = app.application.runTurn({ sessionId: 'main', message: 'go', promptMode: 'full' });

      // Wait until Runner receives the signal.
      await vi.waitFor(() => expect(capturedSignal).toBeDefined());

      const abortResult = app.application.abortTurn('main');
      expect(abortResult).toEqual({ aborted: true, dropped: 0 });
      expect(capturedSignal!.aborted).toBe(true);
      expect(events.find((e) => e.type === 'messages_dropped')).toBeUndefined();

      // Release Runner and wait for Turn cleanup.
      releaseRun.resolve();
      await turnPromise;
      await app.close();
    });

    // With no active Turn, abortTurn clears the queue and emits messages_dropped.
    it('abortTurn: 无 active turn + queue 有 N → clears queue, emits messages_dropped', async () => {
      const events: RuntimeEvent[] = [];
      const app = await RuntimeApp.create({
        agentHome: agentHome,
        applicationConfig: testApplicationConfig(),
        cliOverrides: { memory: { enabled: false } },
        dependencies: createTestDependencies({ createMemoryManager: async () => null }),
        onEvent: (e) => events.push(e),
      });

      // Seed three queued messages directly.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const queueMap = (app.application as any).messageQueueBySession as Map<string, unknown[]>;
      queueMap.set('main', [{ dummy: 1 }, { dummy: 2 }, { dummy: 3 }]);

      const result = app.application.abortTurn('main');
      expect(result).toEqual({ aborted: false, dropped: 3 });

      // The queue is empty.
      expect(queueMap.has('main')).toBe(false);

      // A messages_dropped event was emitted.
      const dropEvent = events.find((e) => e.type === 'messages_dropped');
      expect(dropEvent).toBeDefined();
      expect(dropEvent).toMatchObject({
        type: 'messages_dropped',
        sessionId: 'main',
        reason: 'abort',
        dropped: 3,
      });

      await app.close();
    });

    // Public Channel path aborts the active Turn and drops queued messages once.
    it('CH-09 aborts an active public Channel turn and drops its queued message exactly once', async () => {
      const events: RuntimeEvent[] = [];
      const releaseRun = createDeferred<void>();
      let capturedSignal: AbortSignal | undefined;

      const runnerRun = vi.fn(async (params: { signal?: AbortSignal }): Promise<RunResult> => {
        capturedSignal = params.signal;
        await releaseRun.promise;
        return {
          text: 'aborted',
          content: [],
          stopReason: 'aborted',
          usage: { inputTokens: 0, outputTokens: 0 },
          toolRounds: 0,
        };
      });

      const testChannel = createTestChannel('public-abort-test');
      const app = await RuntimeApp.create({
        agentHome: agentHome,
        loadedUnits: [testChannel.unit],
        applicationConfig: testApplicationConfig(),
        cliOverrides: { memory: { enabled: false } },
        dependencies: createTestDependencies({
          createAgentRunner: () => ({ run: runnerRun }) as never,
          createMemoryManager: async () => null,
        }),
        onEvent: (e) => events.push(e),
      });
      const firstDispatch = testChannel.dispatch({
        sessionId: 'main',
        message: 'active',
        clientId: 'client-1',
      });
      await vi.waitFor(() => expect(capturedSignal).toBeDefined());

      await testChannel.dispatch({
        sessionId: 'main',
        message: 'queued',
        clientId: 'client-2',
      });
      expect(runnerRun).toHaveBeenCalledTimes(1);

      const result = app.application.abortTurn('main');
      expect(result).toEqual({ aborted: true, dropped: 1 });
      expect(capturedSignal!.aborted).toBe(true);
      expect(events.filter((e) => e.type === 'messages_dropped')).toEqual([
        expect.objectContaining({ sessionId: 'main', reason: 'abort', dropped: 1 }),
      ]);

      releaseRun.resolve();
      await firstDispatch;
      expect(runnerRun).toHaveBeenCalledTimes(1);
      expect(events.filter((e) => e.type === 'turn_start')).toHaveLength(1);
      expect(events.filter((e) => e.type === 'turn_end')).toHaveLength(1);
      await app.close();
    });

    it('CH-09 clears unread steering on abort without settling or carrying it into the next turn', async () => {
      const events: RuntimeEvent[] = [];
      const agentEvents: Array<{ type: string; content?: string; deliveryMode?: string }> = [];
      const releaseRun = createDeferred<void>();
      let capturedSignal: AbortSignal | undefined;
      let nextTurnSteering: ChatMessage[] | undefined;

      const runnerRun = vi.fn(async (params: {
        message: string;
        signal?: AbortSignal;
        getSteeringMessages?: () => Promise<ChatMessage[]>;
      }): Promise<RunResult> => {
        if (params.message === 'active') {
          capturedSignal = params.signal;
          await releaseRun.promise;
          return {
            text: 'aborted',
            content: [],
            stopReason: 'aborted',
            usage: { inputTokens: 0, outputTokens: 0 },
            toolRounds: 0,
          };
        }

        nextTurnSteering = await params.getSteeringMessages?.() ?? [];
        return {
          text: 'next',
          content: [{ type: 'text', text: 'next' }],
          stopReason: 'end_turn',
          usage: { inputTokens: 1, outputTokens: 1 },
          toolRounds: 0,
        };
      });

      const testChannel = createTestChannel('steering-abort-test');
      const app = await RuntimeApp.create({
        agentHome: agentHome,
        loadedUnits: [testChannel.unit],
        applicationConfig: {
          ...testApplicationConfig(),
          runtime: { steeringEnabled: true },
        },
        cliOverrides: {
          memory: { enabled: false },
        },
        dependencies: createTestDependencies({
          createAgentRunner: () => ({ run: runnerRun }) as never,
          createMemoryManager: async () => null,
        }),
        onEvent: (event) => events.push(event),
        onAgentEvent: (event) => agentEvents.push(event),
      });
      const firstDispatch = testChannel.dispatch({
        sessionId: 'main',
        message: 'active',
        clientId: 'client-1',
      });
      await vi.waitFor(() => expect(capturedSignal).toBeDefined());

      await testChannel.dispatch({
        sessionId: 'main',
        message: 'unread steering',
        clientId: 'client-2',
      });
      expect(agentEvents).toContainEqual(
        expect.objectContaining({
          type: 'user_message',
          content: 'unread steering',
          deliveryMode: 'steering',
        }),
      );

      expect(app.application.abortTurn('main')).toEqual({ aborted: true, dropped: 0 });
      expect(events.filter((event) => event.type === 'messages_dropped')).toEqual([]);

      releaseRun.resolve();
      await firstDispatch;
      await testChannel.dispatch({
        sessionId: 'main',
        message: 'next root',
        clientId: 'client-3',
      });

      expect(runnerRun).toHaveBeenCalledTimes(2);
      expect(nextTurnSteering).toEqual([]);
      await app.close();
    });

    // Cross-Session isolation leaves another Session's queue untouched.
    it('abortTurn: cross-session isolation — sk1 abort does not touch sk2 queue', async () => {
      const app = await RuntimeApp.create({
        agentHome: agentHome,
        applicationConfig: testApplicationConfig(),
        cliOverrides: { memory: { enabled: false } },
        dependencies: createTestDependencies({ createMemoryManager: async () => null }),
      });

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const queueMap = (app.application as any).messageQueueBySession as Map<string, unknown[]>;
      queueMap.set('sk1', [{ x: 1 }]);
      queueMap.set('sk2', [{ y: 1 }, { y: 2 }]);

      const result = app.application.abortTurn('sk1');
      expect(result).toEqual({ aborted: false, dropped: 1 });
      expect(queueMap.has('sk1')).toBe(false);
      expect(queueMap.get('sk2')?.length).toBe(2);

      await app.close();
    });

    // A new Turn defensively clears a manually seeded stale controller.
    it('stale controller defense: pre-existing entry is cleared on new turn', async () => {
      const runnerRun = vi.fn(async (): Promise<RunResult> => ({
        text: 'ok',
        content: [{ type: 'text', text: 'ok' }],
        stopReason: 'end_turn',
        usage: { inputTokens: 1, outputTokens: 1 },
        toolRounds: 0,
      }));

      const app = await RuntimeApp.create({
        agentHome: agentHome,
        applicationConfig: testApplicationConfig(),
        cliOverrides: { memory: { enabled: false } },
        dependencies: createTestDependencies({
          createAgentRunner: () => ({ run: runnerRun }) as never,
          createMemoryManager: async () => null,
        }),
      });

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const activeAborts = (app.application as any).activeAborts as Map<string, AbortController>;
      const staleController = new AbortController();
      activeAborts.set('main', staleController);

      await app.application.runTurn({ sessionId: 'main', message: 'hi', promptMode: 'full' });

      // Both the stale and newly registered controllers are gone after the Turn.
      expect(activeAborts.has('main')).toBe(false);

      await app.close();
    });

    // safeEmit prevents subscriber failures from escaping the API.
    it('safeEmit: throwing subscriber does not break abortTurn contract', async () => {
      // Allow startup events and throw only for messages_dropped to model a
      // runtime subscriber defect.
      let armed = false;
      const app = await RuntimeApp.create({
        agentHome: agentHome,
        applicationConfig: testApplicationConfig(),
        cliOverrides: { memory: { enabled: false } },
        dependencies: createTestDependencies({ createMemoryManager: async () => null }),
        onEvent: (e) => {
          if (armed && e.type === 'messages_dropped') {
            throw new Error('subscriber boom');
          }
        },
      });
      armed = true;

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const queueMap = (app.application as any).messageQueueBySession as Map<string, unknown[]>;
      queueMap.set('main', [{ dummy: 1 }]);

      // The API does not throw and returns the actual state.
      const result = app.application.abortTurn('main');
      expect(result).toEqual({ aborted: false, dropped: 1 });
      expect(queueMap.has('main')).toBe(false);

      await app.close();
    });

    // CH-08 aborts the active Turn before convergence; queued work never starts.
    it('CH-08 shutdown aborts the active turn, waits for it, and does not start queued work', async () => {
      const releaseRun = createDeferred<void>();
      const deadlineDriver = new ManualDeadlineDriver();
      let capturedSignal: AbortSignal | undefined;

      const runnerRun = vi.fn(async (params: { signal?: AbortSignal }): Promise<RunResult> => {
        capturedSignal = params.signal;
        // Return after signal.aborted to model a responsive Turn.
        await new Promise<void>((resolve) => {
          const check = () => {
            if (params.signal?.aborted) resolve();
          };
          params.signal?.addEventListener('abort', check);
          check();
        });
        await releaseRun.promise;
        return {
          text: 'aborted',
          content: [],
          stopReason: 'aborted',
          usage: { inputTokens: 0, outputTokens: 0 },
          toolRounds: 0,
        };
      });

      const testChannel = createTestChannel('shutdown-queue-test');
      const app = await RuntimeApp.create({
        agentHome: agentHome,
        deadlineDriver,
        loadedUnits: [testChannel.unit],
        applicationConfig: testApplicationConfig(),
        cliOverrides: { memory: { enabled: false } },
        dependencies: createTestDependencies({
          createAgentRunner: () => ({ run: runnerRun }) as never,
          createMemoryManager: async () => null,
        }),
      });
      const firstDispatch = testChannel.dispatch({
        sessionId: 'main',
        message: 'active',
        clientId: 'client-1',
      });
      await vi.waitFor(() => expect(capturedSignal).toBeDefined());
      await testChannel.dispatch({
        sessionId: 'main',
        message: 'queued',
        clientId: 'client-2',
      });
      expect(runnerRun).toHaveBeenCalledTimes(1);

      const closePromise = app.close();
      let closeSettled = false;
      void closePromise.then(() => {
        closeSettled = true;
      });

      // Graceful shutdown does not abort early; convergence starts after its deadline.
      await Promise.resolve();
      expect(capturedSignal!.aborted).toBe(false);
      deadlineDriver.advanceBy(30_000);
      await vi.waitFor(() => expect(capturedSignal!.aborted).toBe(true));
      await Promise.resolve();
      expect(closeSettled).toBe(false);

      releaseRun.resolve();
      await Promise.all([firstDispatch, closePromise]);
      expect(runnerRun).toHaveBeenCalledTimes(1);
    });

    // Shutdown timing uses the monotonic manual deadline without wall-clock sleeps.
    it('shutdown deadline: responsive signal path aborts after graceful drain and converges', async () => {
      let capturedSignal: AbortSignal | undefined;
      const deadlineDriver = new ManualDeadlineDriver();
      const runnerRun = vi.fn(async (params: { signal?: AbortSignal }): Promise<RunResult> => {
        capturedSignal = params.signal;
        await new Promise<void>((resolve) => {
          if (params.signal?.aborted) return resolve();
          params.signal?.addEventListener('abort', () => resolve());
        });
        return {
          text: 'aborted',
          content: [],
          stopReason: 'aborted',
          usage: { inputTokens: 0, outputTokens: 0 },
          toolRounds: 0,
        };
      });

      const app = await RuntimeApp.create({
        agentHome: agentHome,
        deadlineDriver,
        applicationConfig: testApplicationConfig(),
        cliOverrides: { memory: { enabled: false } },
        dependencies: createTestDependencies({
          createAgentRunner: () => ({ run: runnerRun }) as never,
          createMemoryManager: async () => null,
        }),
      });

      const turnPromise = app.application.runTurn({ sessionId: 'main', message: 'go', promptMode: 'full' });
      await vi.waitFor(() => expect(capturedSignal).toBeDefined());

      const closePromise = app.close();
      await Promise.resolve();
      expect(capturedSignal!.aborted).toBe(false);
      deadlineDriver.advanceBy(30_000);
      await vi.waitFor(() => expect(capturedSignal!.aborted).toBe(true));
      const [, report] = await Promise.all([turnPromise, closePromise]);
      expect(report.outcome).toBe('completed');
    });

    it('queued abort seals one request_end without a turnId', async () => {
      const releaseRun = createDeferred<void>();
      const agentEvents: AgentEvent[] = [];
      const runtimeEvents: RuntimeEvent[] = [];
      const testChannel = createTestChannel('queued-abort-terminal');
      testChannel.channel.send = (event) => { agentEvents.push(event); };
      const runnerRun = vi.fn(async (): Promise<RunResult> => {
        await releaseRun.promise;
        return {
          text: 'done',
          content: [],
          stopReason: 'aborted',
          usage: { inputTokens: 0, outputTokens: 0 },
          toolRounds: 0,
        };
      });
      const app = await RuntimeApp.create({
        agentHome: agentHome,
        loadedUnits: [testChannel.unit],
        onEvent: (event) => runtimeEvents.push(event),
        applicationConfig: testApplicationConfig(),
        cliOverrides: { memory: { enabled: false } },
        dependencies: createTestDependencies({
          createAgentRunner: () => ({ run: runnerRun }) as never,
          createMemoryManager: async () => null,
        }),
      });

      const active = testChannel.dispatch({ sessionId: 'main', message: 'active' });
      await vi.waitFor(() => expect(runnerRun).toHaveBeenCalledTimes(1));
      await testChannel.dispatch({ sessionId: 'main', message: 'queued' });

      expect(app.application.abortTurn('main')).toEqual({ aborted: true, dropped: 1 });
      await vi.waitFor(() => expect(agentEvents.filter((event) => event.type === 'request_end')).toHaveLength(1));
      const agentTerminal = agentEvents.find((event) => event.type === 'request_end');
      expect(agentTerminal).toMatchObject({
        outcome: 'cancelled',
        reason: 'abort_queue_drop',
      });
      expect('turnId' in agentTerminal!).toBe(false);
      expect(runtimeEvents.filter((event) => event.type === 'request_end')).toHaveLength(1);

      releaseRun.resolve();
      await active;
      await app.close();
    });

    it('nonresponsive Root seals once, preserves its pin, and ignores late success', async () => {
      const deadlineDriver = new ManualDeadlineDriver();
      const releaseRun = createDeferred<void>();
      const runtimeEvents: RuntimeEvent[] = [];
      const testChannel = createTestChannel('nonconverged-root');
      const stop = vi.spyOn(testChannel.channel, 'stop');
      const runnerRun = vi.fn(async (): Promise<RunResult> => {
        await releaseRun.promise;
        return {
          text: 'late',
          content: [],
          stopReason: 'end_turn',
          usage: { inputTokens: 0, outputTokens: 0 },
          toolRounds: 0,
        };
      });
      const app = await RuntimeApp.create({
        agentHome: agentHome,
        loadedUnits: [testChannel.unit],
        deadlineDriver,
        onEvent: (event) => runtimeEvents.push(event),
        applicationConfig: testApplicationConfig(),
        cliOverrides: { memory: { enabled: false } },
        dependencies: createTestDependencies({
          createAgentRunner: () => ({ run: runnerRun }) as never,
          createMemoryManager: async () => null,
        }),
      });
      const caller = app.application.runTurn({
        requestId: 'request-nonconverged',
        turnId: 'turn-nonconverged',
        sessionId: 'main',
        message: 'hang',
        promptMode: 'full',
      });
      const callerSettlement = caller.then(
        () => 'resolved',
        (error: unknown) => error instanceof Error ? error.message : String(error),
      );
      await vi.waitFor(() => expect(runnerRun).toHaveBeenCalledTimes(1));

      const close = app.close('test shutdown');
      await vi.waitFor(() => expect(deadlineDriver.pendingCount).toBeGreaterThan(0));
      deadlineDriver.advanceBy(30_000);
      await vi.waitFor(() => expect(deadlineDriver.pendingCount).toBeGreaterThan(0));
      deadlineDriver.advanceBy(10_000);
      const report = await close;

      expect(await callerSettlement).toContain('did not converge during shutdown');
      expect(report.outcome).toBe('deadline-exhausted');
      expect(report.turns.nonconvergedRequestIds).toEqual(['request-nonconverged']);
      expect(report.turns.protectedGenerations).toEqual([1]);
      expect(report.instanceStops.skippedProtectedInstanceIds.length).toBeGreaterThan(0);
      expect(stop).not.toHaveBeenCalled();
      expect(Object.isFrozen(report)).toBe(true);
      expect(Object.isFrozen(report.residuals)).toBe(true);
      const sealedResidualCount = report.residuals.length;

      releaseRun.resolve();
      await vi.waitFor(() => expect(app.application.getState().activeRunCount).toBe(0));
      expect(runtimeEvents.filter((event) =>
        event.type === 'turn_end' && event.requestId === 'request-nonconverged')).toHaveLength(1);
      expect(report.residuals).toHaveLength(sealedResidualCount);
      expect(stop).not.toHaveBeenCalled();
    });

    it('nonresponsive terminal Fanout exhausts the shared budget and returns a frozen report', async () => {
      const deadlineDriver = new ManualDeadlineDriver();
      const never = new Promise<void>(() => undefined);
      const testChannel = createTestChannel('nonresponsive-fanout');
      testChannel.channel.send = (event) => event.type === 'run_end' ? never : undefined;
      const runResult: RunResult = {
        text: 'done',
        content: [],
        stopReason: 'end_turn',
        usage: { inputTokens: 0, outputTokens: 0 },
        toolRounds: 0,
      };
      const app = await RuntimeApp.create({
        agentHome: agentHome,
        loadedUnits: [testChannel.unit],
        deadlineDriver,
        applicationConfig: testApplicationConfig(),
        cliOverrides: { memory: { enabled: false } },
        dependencies: createTestDependencies({
          createAgentRunner: (config) => ({
            run: async (params: RunParams) => {
              config.onEvent?.({
                type: 'run_end',
                requestId: params.requestId ?? params.turnId,
                sessionId: params.sessionId,
                turnId: params.turnId,
                result: runResult,
              });
              return runResult;
            },
          }) as never,
          createMemoryManager: async () => null,
        }),
      });
      await app.application.runTurn({
        requestId: 'request-fanout',
        sessionId: 'main',
        message: 'done',
        promptMode: 'full',
      });

      const close = app.close();
      await vi.waitFor(() => expect(deadlineDriver.pendingCount).toBeGreaterThan(0));
      deadlineDriver.advanceBy(60_000);
      const report = await close;

      expect(report.outcome).toBe('deadline-exhausted');
      expect(report.residuals.some((entry) => entry.owner === 'fanout')).toBe(true);
      expect(Object.isFrozen(report)).toBe(true);
      expect(Object.isFrozen(report.instanceStops.pendingInstanceIds)).toBe(true);
    });

    // Channel activation receives unified Catalog, Abort, and Session capabilities.
    it('bindRuntimeCapabilities injects current Catalog, abort, and Session commands', async () => {
      let capturedCapabilities: ChannelRuntimeCapabilities | undefined;
      const testChannel = createTestChannel('runtime-capabilities-test');
      (testChannel.channel as Channel).bindRuntimeCapabilities = (capabilities) => {
        capturedCapabilities = capabilities;
      };

      const app = await RuntimeApp.create({
        agentHome: agentHome,
        loadedUnits: [testChannel.unit],
        applicationConfig: testApplicationConfig(),
        cliOverrides: { memory: { enabled: false } },
        dependencies: createTestDependencies({ createMemoryManager: async () => null }),
      });

      expect(capturedCapabilities).toBeDefined();
      expect(capturedCapabilities!.modelCatalog.getSnapshot()).toMatchObject({
        generation: 1,
        defaultSelection: {
          state: 'available',
          reference: { providerId: 'test', modelId: 'test-model' },
        },
      });
      expect(Object.isFrozen(capturedCapabilities)).toBe(true);
      expect(Object.isFrozen(capturedCapabilities!.modelCatalog)).toBe(true);
      expect(Object.isFrozen(capturedCapabilities!.abort)).toBe(true);
      expect(Object.isFrozen(capturedCapabilities!.sessions)).toBe(true);

      const created = await capturedCapabilities!.sessions.createSession();
      expect(created.sessionId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
      );
      expect(created.permission).toMatchObject({
        sessionId: created.sessionId,
        mode: 'manual',
      });
      expect(capturedCapabilities!.sessions.getPermissionMode(created.sessionId))
        .toEqual(created.permission);

      const permissionChanges: unknown[] = [];
      const unsubscribe = capturedCapabilities!.sessions.onPermissionModeChanged((state) => {
        permissionChanges.push(state);
      });
      const elevated = capturedCapabilities!.sessions.setPermissionMode({
        sessionId: created.sessionId,
        mode: 'allow_all',
        originClientId: 'test-client',
      });
      expect(elevated).toMatchObject({
        sessionId: created.sessionId,
        mode: 'allow_all',
        changedByClientId: 'test-client',
      });
      expect(permissionChanges).toEqual([elevated]);
      unsubscribe();
      capturedCapabilities!.sessions.setPermissionMode({
        sessionId: created.sessionId,
        mode: 'manual',
      });
      expect(permissionChanges).toEqual([elevated]);

      const elevatedAtCreation = await capturedCapabilities!.sessions.createSession({
        permissionMode: 'allow_all',
        originClientId: 'test-client',
      });
      expect(elevatedAtCreation.permission).toMatchObject({
        sessionId: elevatedAtCreation.sessionId,
        mode: 'allow_all',
        changedByClientId: 'test-client',
      });
      const deletionChanges: unknown[] = [];
      const unsubscribeDeletion = capturedCapabilities!.sessions.onPermissionModeChanged((state) => {
        deletionChanges.push(state);
      });
      await capturedCapabilities!.sessions.deleteSession(elevatedAtCreation.sessionId);
      expect(deletionChanges).toEqual([
        expect.objectContaining({
          sessionId: elevatedAtCreation.sessionId,
          mode: 'manual',
        }),
      ]);
      unsubscribeDeletion();

      // Seed a queued message for one Session.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const queueMap = (app.application as any).messageQueueBySession as Map<string, unknown[]>;
      queueMap.set('sk-with-queue', [{ x: 1 }, { x: 2 }]);

      // querySessionsNeedingAbort includes the queued Session.
      const sessions = capturedCapabilities!.abort.querySessionsNeedingAbort();
      expect(sessions).toContain('sk-with-queue');

      // Triggering abort through the hook clears the queue and returns the count.
      const result = capturedCapabilities!.abort.abortTurn('sk-with-queue');
      expect(result).toEqual({ aborted: false, dropped: 2 });
      expect(queueMap.has('sk-with-queue')).toBe(false);

      capturedCapabilities!.sessions.setPermissionMode({
        sessionId: created.sessionId,
        mode: 'allow_all',
      });
      await app.close();
      expect(capturedCapabilities!.sessions.getPermissionMode(created.sessionId)).toMatchObject({
        sessionId: created.sessionId,
        mode: 'manual',
      });
    });
  });
});

function createDeferred<T>(): {
  promise: Promise<T>;
  resolve(value: T | PromiseLike<T>): void;
  reject(reason?: unknown): void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function createTestChannel(id: string): {
  channel: Channel;
  unit: LoadedRuntimeUnit;
  dispatch(req: ChannelRunRequest): Promise<void>;
} {
  let handler: ((req: ChannelRunRequest) => Promise<void>) | undefined;
  const completion = createDeferred<ChannelCompletion>();
  const channel: Channel = {
    id,
    completion: completion.promise,
    send() {
      // no-op for tests
    },
    onMessage(nextHandler) {
      handler = nextHandler;
    },
    async start() {
      // no-op for tests
    },
    async stop() {
      completion.resolve({ outcome: 'closed', reason: 'stopped' });
    },
  };

  return {
    channel,
    unit: channelUnit(channel),
    async dispatch(req: ChannelRunRequest) {
      if (!handler) {
        throw new Error('message handler was not registered');
      }
      await handler(req);
    },
  };
}

function createApprovalTestChannel(
  id: string,
  options: {
    approvalRequests: ApprovalRequest[];
    approvalClosures?: Array<{
      request: ApprovalRequest;
      result: ApprovalClosedResult;
    }>;
    autoDecision?: ApprovalDecision | null;
  },
): {
  channel: Channel;
  unit: LoadedRuntimeUnit;
  dispatch(req: ChannelRunRequest): Promise<void>;
} {
  let handler: ((req: ChannelRunRequest) => Promise<void>) | undefined;
  let interactionResponseHandler: Parameters<NonNullable<Channel['interaction']>['onInteractionResponse']>[0] | undefined;
  const autoDecision = options.autoDecision === undefined ? 'allow' : options.autoDecision;
  const completion = createDeferred<ChannelCompletion>();
  const channel: Channel = {
    id,
    completion: completion.promise,
    send() {
      // no-op for tests
    },
    onMessage(nextHandler) {
      handler = nextHandler;
    },
    async start() {
      // no-op for tests
    },
    async stop() {
      completion.resolve({ outcome: 'closed', reason: 'stopped' });
    },
    interaction: {
      sendInteractionRequest(request) {
        if (request.kind !== 'approval') {
          return { status: 'unavailable', reason: 'delivery_failed' };
        }
        options.approvalRequests.push(request);
        if (autoDecision) {
          interactionResponseHandler?.({
            id: request.id,
            kind: 'approval',
            outcome: 'submitted',
            decision: autoDecision,
          });
        }
        return { status: 'accepted' };
      },
      sendInteractionClosed(request, result) {
        if (request.kind !== 'approval') return;
        options.approvalClosures?.push({ request, result });
      },
      onInteractionResponse(nextHandler) {
        interactionResponseHandler = nextHandler;
      },
      onInteractionUnavailable() {
        // This test channel remains available for its full lifetime.
      },
    },
  };

  return {
    channel,
    unit: channelUnit(channel),
    async dispatch(req: ChannelRunRequest) {
      if (!handler) {
        throw new Error('message handler was not registered');
      }
      await handler(req);
    },
  };
}

function channelUnit(channel: Channel): LoadedRuntimeUnit {
  return createLoadedRuntimeUnit({
    registration: {
    id: `builtin-test-channel-${channel.id}`,
    source: 'builtin',
    register(api) {
      api.registerChannel({ id: channel.id, create: () => channel });
    },
    },
    required: false,
  });
}

function createTestDependencies(
  overrides: Partial<RuntimeDependencies> = {},
): Partial<RuntimeDependencies> {
  const builtinTool: Tool = {
    name: 'demo_tool',
    description: 'Demo tool',
    inputSchema: { type: 'object', properties: {} },
    async execute() {
      return { outcome: 'success', content: 'ok' };
    },
  };

  return {
    createBuiltinProviderUnit: () => createTestProviderUnit([{
      id: 'test',
      protocol: 'test',
      models: [
        { modelId: 'test-model', displayName: 'Test Model' },
        { modelId: 'parent-model' },
      ],
      invocationPort: {} as never,
      resolveConnection: () => ({ ok: true, connection: { endpointId: 'test' } }),
      resolveModel: (modelId, connection) => ({
        ok: true,
        descriptor: {
          identity: { providerId: 'test', modelId },
          protocol: 'test',
          connection,
          facts: {
            effectiveContextLimit: 200_000,
            maximumOutputTokens: 8192,
            toolUse: true,
            mediaKinds: ['image'],
          },
        },
      }),
    }]),
    createSessionManager: () => ({
      initialize: vi.fn(async () => undefined),
      getSession: vi.fn((sessionId: string) => sessionEntry(sessionId)),
      createTransientSubagentTranscript: vi.fn(async () => {}),
      deleteTransientSubagentTranscript: vi.fn(async () => {}),
    }) as never,
    createMemoryManager: async () => null,
    createSystemPromptBuilder: () => ({ build: () => 'SYSTEM_PROMPT' }) as never,
    createAgentRunner: () => ({
      run: async () => ({
        text: 'ok',
        content: [{ type: 'text', text: 'ok' }],
        stopReason: 'end_turn',
        usage: { inputTokens: 1, outputTokens: 1 },
        toolRounds: 0,
      }),
    }) as never,
    getBuiltinContributionUnits: () => [builtinUnit(builtinTool)],
    ...overrides,
  };
}

function createTestProviderUnit(
  providers: readonly ProviderProjectionEntry[],
): LoadedRuntimeUnit {
  return createLoadedRuntimeUnit({
    registration: {
      id: 'builtin-test-provider',
      source: 'builtin',
      register(api) {
        for (const provider of providers) api.registerProvider(provider);
      },
    },
    required: true,
  });
}

function builtinUnit(tool: Tool): RuntimeContributionUnit {
  return {
    id: `builtin-test-${tool.name}`,
    source: 'builtin',
    register(api) {
      api.registerTool(tool);
    },
  };
}

function sessionEntry(sessionId: string) {
  return { sessionId, createdAt: 1, updatedAt: 1 };
}