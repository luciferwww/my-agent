import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RegistrySnapshot } from '../core/registry/index.js';
import { bootstrapRuntime } from './bootstrap.js';
import {
  buildRuntimeHandle,
  type RuntimeApplicationKernel,
  type RuntimeApplicationKernelInput,
} from './runtime-builder.js';

vi.mock('./bootstrap.js', () => ({
  bootstrapRuntime: vi.fn(),
}));

function snapshot(generation = 1): RegistrySnapshot {
  return Object.freeze({
    generation,
    providers: Object.freeze([]),
    tools: Object.freeze({
      definitions: Object.freeze([]),
      resolve: () => undefined,
      visibleDefinitions: () => Object.freeze([]),
    }),
    hooks: Object.freeze({
      beforeToolCall: Object.freeze([]),
      afterToolCall: Object.freeze([]),
      beforeCompaction: Object.freeze([]),
      afterCompaction: Object.freeze([]),
    }),
    channels: Object.freeze({
      bindings: Object.freeze([]),
      resolve: () => undefined,
    }),
    diagnostics: Object.freeze([]),
  });
}

function createHarness(options: { memoryClose?: () => void | Promise<void> } = {}) {
  const runtimeConverged = vi.fn(async () => ({ completed: [], failed: [] }));
  vi.mocked(bootstrapRuntime).mockResolvedValue({
    resources: {
      registrySnapshot: snapshot(),
      memoryManager: options.memoryClose ? { close: options.memoryClose } : null,
    },
    channelCompletionObserver: {},
    channelShutdownHandoff: { runtimeConverged },
  } as never);

  const shutdownReport = {
    startedAt: 1,
    finishedAt: 2,
    completed: [],
    failed: [],
  };
  const close = vi.fn(async () => shutdownReport);
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
      close,
    } satisfies RuntimeApplicationKernel;
  });

  return {
    application,
    close,
    createApplication,
    getInput: () => input,
    runtimeConverged,
    shutdownReport,
  };
}

describe('Runtime Builder', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('delegates bootstrap and application creation once and publishes generation 1', async () => {
    const harness = createHarness();

    const handle = await buildRuntimeHandle({ workspaceDir: '/workspace' }, harness.createApplication);

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
      { workspaceDir: '/workspace' },
      () => { throw failure; },
    )).rejects.toBe(failure);

    expect(harness.runtimeConverged).toHaveBeenCalledTimes(1);
    expect(memoryClose).toHaveBeenCalledTimes(1);
  });

  it('shares one close operation across callers', async () => {
    const harness = createHarness();
    const handle = await buildRuntimeHandle({ workspaceDir: '/workspace' }, harness.createApplication);

    const first = handle.close('first');
    const second = handle.close('second');

    expect(first).toBe(second);
    await expect(first).resolves.toEqual(expect.objectContaining({
      startedAt: harness.shutdownReport.startedAt,
      completed: [],
      failed: [],
    }));
    expect(harness.close).toHaveBeenCalledTimes(1);
    expect(harness.close).toHaveBeenCalledWith('first');
    expect(harness.runtimeConverged).toHaveBeenCalledTimes(1);
  });

  it('returns structured reload rejections without publishing another generation', async () => {
    const harness = createHarness();
    const handle = await buildRuntimeHandle({ workspaceDir: '/workspace' }, harness.createApplication);

    const enabled = await handle.composition.enableUnit('optional-unit');
    const disabled = await handle.composition.disableUnit('optional-unit');

    expect(enabled).toEqual(expect.objectContaining({
      outcome: 'rejected',
      category: 'RELOAD_NOT_IMPLEMENTED',
      generation: 1,
      change: { operation: 'enable', unitId: 'optional-unit' },
    }));
    expect(disabled).toEqual(expect.objectContaining({
      outcome: 'rejected',
      category: 'RELOAD_NOT_IMPLEMENTED',
      generation: 1,
      change: { operation: 'disable', unitId: 'optional-unit' },
    }));
    expect(harness.getInput()?.snapshotAccess.currentSnapshot().generation).toBe(1);
  });
});
