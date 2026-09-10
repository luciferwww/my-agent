import { beforeEach, describe, expect, it, vi } from 'vitest';
import { bootstrapRuntime } from './bootstrap.js';
import { createLoadedRuntimeUnit, type LoadedRuntimeUnit } from './runtime-unit.js';
import { Logger } from '../platform/logger/index.js';
import type { ProviderProjectionEntry } from '../core/model-resolution/index.js';
import type { RuntimeDeadlineDriver, RuntimeDeadlineRaceResult } from './runtime-deadline.js';
import type { RuntimeAppOptions } from './types.js';
import {
  buildRuntimeHandle,
  type RuntimeApplicationKernel,
  type RuntimeApplicationKernelInput,
} from './runtime-builder.js';

vi.mock('./bootstrap.js', () => ({
  bootstrapRuntime: vi.fn(),
}));

class ManualDeadlineDriver implements RuntimeDeadlineDriver {
  private time = 0;
  private readonly waits = new Set<{
    deadline: number;
    resolve: (result: RuntimeDeadlineRaceResult<unknown>) => void;
  }>();

  now(): number { return this.time; }

  race<T>(operation: Promise<T>, deadline: number): Promise<RuntimeDeadlineRaceResult<T>> {
    return new Promise((resolve) => {
      let done = false;
      const wait = {
        deadline,
        resolve: (result: RuntimeDeadlineRaceResult<unknown>) => {
          if (done) return;
          done = true;
          this.waits.delete(wait);
          resolve(result as RuntimeDeadlineRaceResult<T>);
        },
      };
      this.waits.add(wait);
      void operation.then(
        (value) => wait.resolve({ outcome: 'completed', value }),
        (error: unknown) => wait.resolve({
          outcome: 'failed',
          message: error instanceof Error ? error.message : String(error),
        }),
      );
    });
  }

  get pendingCount(): number { return this.waits.size; }

  advanceBy(milliseconds: number): void {
    this.time += milliseconds;
    for (const wait of [...this.waits]) {
      if (wait.deadline <= this.time) wait.resolve({ outcome: 'deadline-exhausted' });
    }
  }
}

function createProviderUnit(
  providers: readonly ProviderProjectionEntry[] = [testProvider('test-provider')],
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

function testProvider(id: string): ProviderProjectionEntry {
  return {
    id,
    protocol: 'test',
    invocationPort: {} as never,
    resolveConnection: () => ({ ok: false, category: 'connection_missing', message: 'unused' }),
    resolveModel: () => ({ ok: false, category: 'model_rejected', message: 'unused' }),
  };
}

function createHarness(options: {
  memoryClose?: () => void | Promise<void>;
  providerUnit?: LoadedRuntimeUnit;
  providerFactory?: () => LoadedRuntimeUnit;
  baseStop?: () => void | Promise<void>;
  additionalLoadedUnits?: readonly LoadedRuntimeUnit[];
} = {}) {
  const baseStop = vi.fn(options.baseStop ?? (() => {}));
  const optionalStop = vi.fn();
  const events: NonNullable<RuntimeAppOptions['onEvent']> extends (event: infer T) => void ? T[] : never[] = [];
  const loadedUnits = [
    createLoadedRuntimeUnit({
      registration: { id: 'base', source: 'builtin', register() {} },
      required: true,
      stop: baseStop,
    }),
    createLoadedRuntimeUnit({
      registration: { id: 'optional-unit', source: 'external', register() {} },
      required: false,
      initiallyEnabled: false,
      stop: optionalStop,
    }),
    ...(options.additionalLoadedUnits ?? []),
  ];
  const runtimeOptions: RuntimeAppOptions = {
    workspaceDir: '/workspace',
    loadedUnits,
    onEvent: (event) => events.push(event),
  };
  vi.mocked(bootstrapRuntime).mockResolvedValue({
    resources: {
      memoryManager: options.memoryClose ? { close: options.memoryClose } : null,
      resolvedConfig: {
        llm: { contextWindowTokens: 1, maxTokens: 1 },
        tools: {},
        workspace: { maxFileChars: 1, maxTotalChars: 1 },
        subagents: { enabled: false, list: [] },
      },
    },
    state: { phase: 'ready', startedAt: 1, activeRunCount: 0, contextVersion: 1 },
    dependencies: {
      createBundledProviderUnit: () => options.providerFactory?.()
        ?? options.providerUnit
        ?? createProviderUnit(),
      getBuiltinContributionUnits: () => [],
    },
  } as never);

  const shutdownReport = {
    outcome: 'completed' as const,
    startedAt: 1,
    finishedAt: 2,
    completed: [],
    failed: [],
    turns: {
      completedRequestIds: [],
      abortedRequestIds: [],
      nonconvergedRequestIds: [],
      queuedCancelledRequestIds: [],
      protectedGenerations: [],
    },
    instanceStops: {
      completedInstanceIds: [],
      failedInstanceIds: [],
      pendingInstanceIds: [],
      skippedProtectedInstanceIds: [],
    },
    residuals: [],
  };
  const close = vi.fn(async () => shutdownReport);
  const channelBindingsForTurn = vi.fn<RuntimeApplicationKernel['channelBindingsForTurn']>(
    () => undefined,
  );
  let input: RuntimeApplicationKernelInput | undefined;
  const application = Object.freeze({
    runTurn: vi.fn(),
    abortTurn: vi.fn(() => ({ aborted: false, dropped: 0 })),
    reloadContextFiles: vi.fn(),
    getState: vi.fn(),
    getToolNames: vi.fn(),
    getContextFiles: vi.fn(),
    getAvailableSubagents: vi.fn(),
    waitForChannelCompletion: vi.fn(),
  });
  const createApplication = vi.fn((nextInput: RuntimeApplicationKernelInput) => {
    input = nextInput;
    return {
      application,
      onChannelMessage: vi.fn(),
      onInteractionResponse: vi.fn(),
      onInteractionUnavailable: vi.fn(),
      querySessionsNeedingAbort: vi.fn(() => []),
      abortTurn: vi.fn(() => ({ aborted: false, dropped: 0 })),
      blockingTurnIds: vi.fn(() => []),
      abortGeneration: vi.fn(() => []),
      channelBindingsForTurn,
      shouldDeliverAgentEvent: vi.fn(() => true),
      close,
    } satisfies RuntimeApplicationKernel;
  });

  return {
    application,
    close,
    channelBindingsForTurn,
    createApplication,
    getInput: () => input,
    runtimeOptions,
    events,
    baseStop,
    optionalStop,
    shutdownReport,
  };
}

describe('Runtime Builder', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('delegates bootstrap and application creation once and publishes generation 1', async () => {
    const harness = createHarness();

    const handle = await buildRuntimeHandle(harness.runtimeOptions, harness.createApplication);

    expect(bootstrapRuntime).toHaveBeenCalledTimes(1);
    expect(harness.createApplication).toHaveBeenCalledTimes(1);
    expect(handle.application).toBe(harness.application);
    expect(harness.getInput()?.resources.defaultProviderId).toBe('test-provider');
    const access = harness.getInput()?.snapshotAccess;
    expect(access?.currentSnapshot().generation).toBe(1);
    const pin = access?.captureRootGeneration();
    expect(pin?.generation).toBe(1);
    pin?.release();
  });

  it('runs the bundled Provider through factory, create, staging, start, and publication', async () => {
    const trace: string[] = [];
    const providerUnit: LoadedRuntimeUnit = {
      unitId: 'builtin-traced-provider',
      source: 'builtin',
      orderKey: 'builtin-traced-provider',
      required: true,
      initiallyEnabled: true,
      dependencies: [],
      create() {
        trace.push('create');
        return {
          registration: {
            id: 'builtin-traced-provider',
            source: 'builtin',
            register(api) {
              trace.push('registration');
              api.registerProvider(testProvider('traced-provider'));
            },
          },
          start() { trace.push('start'); },
          stop() {},
        };
      },
    };
    const harness = createHarness({
      providerFactory: () => {
        trace.push('factory');
        return providerUnit;
      },
    });
    harness.runtimeOptions.onEvent = (event) => {
      harness.events.push(event);
      if (event.type === 'app_ready') trace.push('ready');
    };
    const createApplication = (input: RuntimeApplicationKernelInput) => {
      trace.push('kernel');
      return harness.createApplication(input);
    };

    const handle = await buildRuntimeHandle(harness.runtimeOptions, createApplication);

    expect(trace).toEqual(['factory', 'create', 'registration', 'start', 'kernel', 'ready']);
    expect(harness.getInput()?.resources.defaultProviderId).toBe('traced-provider');
    await handle.close();
  });

  it('keeps a builtin Provider first when an external Provider starts in the same Snapshot', async () => {
    const externalProviderUnit = createLoadedRuntimeUnit({
      registration: {
        id: 'external-test-provider',
        source: 'external',
        register(api) { api.registerProvider(testProvider('external-provider')); },
      },
      required: false,
    });
    const harness = createHarness({ additionalLoadedUnits: [externalProviderUnit] });

    const handle = await buildRuntimeHandle(harness.runtimeOptions, harness.createApplication);

    expect(harness.getInput()?.resources.defaultProviderId).toBe('test-provider');
    expect(harness.getInput()?.snapshotAccess.currentSnapshot().providers.map(({ id }) => id))
      .toEqual(['test-provider', 'external-provider']);
    await handle.close();
  });

  it('rejects an empty published Provider Snapshot before kernel creation or app_ready', async () => {
    const harness = createHarness({ providerUnit: createProviderUnit([]) });

    await expect(buildRuntimeHandle(harness.runtimeOptions, harness.createApplication))
      .rejects.toThrow('Published Registry Snapshot must contain at least one Provider entry.');

    expect(harness.createApplication).not.toHaveBeenCalled();
    expect(harness.events.some((event) => event.type === 'app_ready')).toBe(false);
    expect(harness.baseStop).toHaveBeenCalledTimes(1);
  });

  it('attributes required Provider Unit create failure and cleans earlier candidates', async () => {
    const providerFailure = new Error('provider construction failed');
    const failingProviderUnit: LoadedRuntimeUnit = {
      unitId: 'builtin-anthropic-provider',
      source: 'builtin',
      orderKey: 'builtin-anthropic-provider',
      required: true,
      initiallyEnabled: true,
      dependencies: [],
      create() { throw providerFailure; },
    };
    const harness = createHarness({ providerUnit: failingProviderUnit });

    await expect(buildRuntimeHandle(harness.runtimeOptions, harness.createApplication))
      .rejects.toBe(providerFailure);

    expect(harness.createApplication).not.toHaveBeenCalled();
    expect(harness.events).toContainEqual(expect.objectContaining({
      type: 'error',
      info: expect.objectContaining({
        unitId: 'builtin-anthropic-provider',
        phase: 'create',
      }),
    }));
    expect(harness.events.some((event) => event.type === 'app_ready')).toBe(false);
    expect(harness.baseStop).toHaveBeenCalledTimes(1);
  });

  it('fails closed when earlier candidate cleanup fails after Provider create failure', async () => {
    const failingProviderUnit: LoadedRuntimeUnit = {
      unitId: 'builtin-anthropic-provider',
      source: 'builtin',
      orderKey: 'builtin-anthropic-provider',
      required: true,
      initiallyEnabled: true,
      dependencies: [],
      create() { throw new Error('provider construction failed'); },
    };
    const harness = createHarness({
      providerUnit: failingProviderUnit,
      baseStop: () => { throw new Error('candidate cleanup failed'); },
    });

    await expect(buildRuntimeHandle(harness.runtimeOptions, harness.createApplication))
      .rejects.toMatchObject({
        blocker: expect.objectContaining({
          phase: 'candidate-cleanup',
          unitId: 'base',
          message: 'candidate cleanup failed',
        }),
      });

    expect(harness.createApplication).not.toHaveBeenCalled();
    expect(harness.events.some((event) => event.type === 'app_ready')).toBe(false);
    expect(harness.baseStop).toHaveBeenCalledTimes(1);
  });

  it('cleans up startup resources when application creation fails', async () => {
    const memoryClose = vi.fn();
    const harness = createHarness({ memoryClose });
    const failure = new Error('application creation failed');

    await expect(buildRuntimeHandle(
      harness.runtimeOptions,
      () => { throw failure; },
    )).rejects.toBe(failure);

    expect(harness.baseStop).toHaveBeenCalledTimes(1);
    expect(memoryClose).toHaveBeenCalledTimes(1);
  });

  it('shares one close operation across callers', async () => {
    const harness = createHarness();
    const handle = await buildRuntimeHandle(harness.runtimeOptions, harness.createApplication);

    const first = handle.close('first');
    const second = handle.close('second');

    expect(first).toBe(second);
    await expect(first).resolves.toEqual(expect.objectContaining({
      startedAt: harness.shutdownReport.startedAt,
      completed: expect.arrayContaining([expect.stringMatching(/^unit:base:/), 'logger']),
      failed: [],
    }));
    expect(harness.close).toHaveBeenCalledTimes(1);
    expect(harness.close).toHaveBeenCalledWith('first', expect.anything());
    expect(harness.baseStop).toHaveBeenCalledTimes(1);
  });

  it('returns a frozen residual report when Memory close never settles', async () => {
    const deadlineDriver = new ManualDeadlineDriver();
    const memoryClose = vi.fn(() => new Promise<void>(() => undefined));
    const harness = createHarness({ memoryClose });
    const handle = await buildRuntimeHandle(
      { ...harness.runtimeOptions, deadlineDriver },
      harness.createApplication,
    );

    const close = handle.close('memory deadline');
    await vi.waitFor(() => expect(memoryClose).toHaveBeenCalledTimes(1));
    deadlineDriver.advanceBy(60_000);
    const report = await close;

    expect(report.outcome).toBe('deadline-exhausted');
    expect(report.residuals).toEqual(expect.arrayContaining([
      expect.objectContaining({ owner: 'resource', phase: 'memory-close' }),
      expect.objectContaining({ owner: 'resource', phase: 'logger-close' }),
    ]));
    expect(Object.isFrozen(report)).toBe(true);
    expect(Object.isFrozen(report.residuals)).toBe(true);
  });

  it('returns a frozen residual report when Logger close never settles', async () => {
    const deadlineDriver = new ManualDeadlineDriver();
    const loggerClose = vi.spyOn(Logger, 'close').mockReturnValue(
      new Promise<void>(() => undefined),
    );
    const harness = createHarness();
    const handle = await buildRuntimeHandle(
      { ...harness.runtimeOptions, deadlineDriver },
      harness.createApplication,
    );

    const close = handle.close('logger deadline');
    await vi.waitFor(() => expect(loggerClose).toHaveBeenCalledTimes(1));
    expect(deadlineDriver.pendingCount).toBeGreaterThan(0);
    deadlineDriver.advanceBy(60_000);
    const report = await close;

    expect(report.outcome).toBe('deadline-exhausted');
    expect(report.residuals).toEqual([
      expect.objectContaining({ owner: 'resource', phase: 'logger-close' }),
    ]);
    expect(Object.isFrozen(report)).toBe(true);
    loggerClose.mockRestore();
  });

  it('fans out turn events through the pinned Channel projection', async () => {
    const harness = createHarness();
    const send = vi.fn();
    harness.channelBindingsForTurn.mockReturnValue(Object.freeze([{
      id: 'old-generation-channel',
      send,
    }]));
    await buildRuntimeHandle(harness.runtimeOptions, harness.createApplication);

    harness.getInput()!.fanoutAgentEvent({
      type: 'text_delta',
      sessionKey: 'session',
      turnId: 'turn-old',
      text: 'done',
    });

    expect(harness.channelBindingsForTurn).toHaveBeenCalledWith('turn-old');
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('publishes loaded Unit enable and disable changes through composition control', async () => {
    const harness = createHarness();
    const handle = await buildRuntimeHandle(harness.runtimeOptions, harness.createApplication);

    const enabled = await handle.composition.enableUnit('optional-unit');
    const disabled = await handle.composition.disableUnit('optional-unit');

    expect(enabled).toEqual(expect.objectContaining({
      outcome: 'published',
      previousGeneration: 1,
      generation: 2,
      change: { operation: 'enable', unitId: 'optional-unit' },
    }));
    expect(disabled).toEqual(expect.objectContaining({
      outcome: 'published',
      previousGeneration: 2,
      generation: 3,
      change: { operation: 'disable', unitId: 'optional-unit' },
    }));
    expect(harness.getInput()?.snapshotAccess.currentSnapshot().generation).toBe(3);
    await vi.waitFor(() => expect(harness.optionalStop).toHaveBeenCalledTimes(1));
  });
});
