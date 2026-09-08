import { beforeEach, describe, expect, it, vi } from 'vitest';
import { bootstrapRuntime } from './bootstrap.js';
import { createLoadedRuntimeUnit } from './runtime-unit.js';
import { Logger } from '../platform/logger/index.js';
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

function createHarness(options: { memoryClose?: () => void | Promise<void> } = {}) {
  const baseStop = vi.fn();
  const optionalStop = vi.fn();
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
  ];
  const runtimeOptions: RuntimeAppOptions = {
    workspaceDir: '/workspace',
    loadedUnits,
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
      createProviderProjection: () => [{
        id: 'test-provider',
        protocol: 'test',
        invocationPort: {},
        resolveConnection: () => ({ ok: false, category: 'connection_missing', message: 'unused' }),
        resolveModel: () => ({ ok: false, category: 'model_rejected', message: 'unused' }),
      }],
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
    const access = harness.getInput()?.snapshotAccess;
    expect(access?.currentSnapshot().generation).toBe(1);
    const pin = access?.captureRootGeneration();
    expect(pin?.generation).toBe(1);
    pin?.release();
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
