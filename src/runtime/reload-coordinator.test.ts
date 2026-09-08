import { describe, expect, it, vi } from 'vitest';
import type { RuntimeReloadChange } from './runtime-composition.js';
import { CompositionCoordinator } from './composition-coordinator.js';
import {
  RuntimeReloadStateMachine,
  RuntimeReloadBlockedError,
  type PreparedRuntimeReload,
  type RuntimeReloadDeadlineDriver,
  type RuntimeReloadExecutionHooks,
  type RuntimeReloadRequest,
  type RuntimeRetirementResult,
} from './reload-coordinator.js';

interface Prepared extends PreparedRuntimeReload {
  readonly marker: string;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

function change(operation: 'enable' | 'disable', unitId: string): RuntimeReloadChange {
  return Object.freeze({ operation, unitId });
}

function createHarness() {
  let generation = 1;
  const activeUnits = new Set(['builtin']);
  const preparations: Array<{
    request: RuntimeReloadRequest;
    signal: AbortSignal;
    deferred: ReturnType<typeof deferred<Prepared>>;
  }> = [];
  const retirements: Array<{
    prepared: Prepared;
    deferred: ReturnType<typeof deferred<RuntimeRetirementResult>>;
  }> = [];
  let cleanupResidual: Awaited<ReturnType<RuntimeReloadExecutionHooks<Prepared>['cleanup']>>;

  const hooks: RuntimeReloadExecutionHooks<Prepared> = {
    currentGeneration: () => generation,
    preflight: (nextChange) => {
      if (nextChange.unitId === 'missing') {
        return { outcome: 'rejected', category: 'UNIT_UNKNOWN', message: 'unknown unit' };
      }
      const active = activeUnits.has(nextChange.unitId);
      if ((nextChange.operation === 'enable' && active)
        || (nextChange.operation === 'disable' && !active)) {
        return {
          outcome: 'no-op',
          warnings: [{ code: 'ALREADY_SATISFIED', message: 'desired state already active' }],
        };
      }
      return { outcome: 'proceed' };
    },
    prepare: vi.fn((request, signal) => {
      const next = deferred<Prepared>();
      preparations.push({ request, signal, deferred: next });
      return next.promise;
    }),
    cleanup: vi.fn(async () => cleanupResidual),
    publish: vi.fn((prepared) => {
      const previousGeneration = generation;
      generation += 1;
      if (prepared.request.change.operation === 'enable') {
        activeUnits.add(prepared.request.change.unitId);
      } else {
        activeUnits.delete(prepared.request.change.unitId);
      }
      return {
        previousGeneration,
        generation,
        retiredUnitIds: prepared.request.change.operation === 'disable'
          ? [prepared.request.change.unitId]
          : [],
      };
    }),
    retire: vi.fn((prepared) => {
      const next = deferred<RuntimeRetirementResult>();
      retirements.push({ prepared, deferred: next });
      return next.promise;
    }),
  };

  let id = 0;
  const coordinator = new RuntimeReloadStateMachine(new CompositionCoordinator(), hooks, {
    createRequestId: () => `reload-${++id}`,
  });
  const resolvePreparation = (index: number) => {
    const item = preparations[index]!;
    item.deferred.resolve({ request: item.request, marker: item.request.requestId });
  };

  return {
    activeUnits,
    coordinator,
    hooks,
    preparations,
    retirements,
    resolvePreparation,
    setCleanupResidual: (residual: typeof cleanupResidual) => { cleanupResidual = residual; },
  };
}

describe('RuntimeReloadStateMachine', () => {
  it('returns rejected and no-op results before creating a candidate', async () => {
    const harness = createHarness();

    await expect(harness.coordinator.submit(change('enable', 'builtin'))).resolves.toEqual(
      expect.objectContaining({ outcome: 'no-op', generation: 1 }),
    );
    await expect(harness.coordinator.submit(change('disable', 'absent'))).resolves.toEqual(
      expect.objectContaining({ outcome: 'no-op', generation: 1 }),
    );
    await expect(harness.coordinator.submit(change('enable', 'missing'))).resolves.toEqual(
      expect.objectContaining({ outcome: 'rejected', category: 'UNIT_UNKNOWN', generation: 1 }),
    );
    expect(harness.hooks.prepare).not.toHaveBeenCalled();
    expect(harness.hooks.publish).not.toHaveBeenCalled();
  });

  it('publishes one generation then runs the sole pending request after retirement', async () => {
    const harness = createHarness();
    const first = harness.coordinator.submit(change('enable', 'external-a'));
    await vi.waitFor(() => expect(harness.preparations).toHaveLength(1));
    harness.resolvePreparation(0);

    await expect(first).resolves.toEqual(expect.objectContaining({
      requestId: 'reload-1',
      outcome: 'published',
      previousGeneration: 1,
      generation: 2,
    }));
    await vi.waitFor(() => expect(harness.retirements).toHaveLength(1));

    const pending = harness.coordinator.submit(change('disable', 'external-a'));
    expect(harness.coordinator.pendingRequestId).toBe('reload-2');
    expect(harness.preparations).toHaveLength(1);

    harness.retirements[0]!.deferred.resolve({ outcome: 'retired' });
    await vi.waitFor(() => expect(harness.preparations).toHaveLength(2));
    harness.resolvePreparation(1);
    await expect(pending).resolves.toEqual(expect.objectContaining({
      requestId: 'reload-2',
      outcome: 'published',
      previousGeneration: 2,
      generation: 3,
      retiredUnitIds: ['external-a'],
    }));
  });

  it('settles D/E/F latest-wins while D is retiring and starts only F', async () => {
    const harness = createHarness();
    const d = harness.coordinator.submit(change('enable', 'd'));
    await vi.waitFor(() => expect(harness.preparations).toHaveLength(1));
    harness.resolvePreparation(0);
    await expect(d).resolves.toEqual(expect.objectContaining({
      requestId: 'reload-1',
      outcome: 'published',
      generation: 2,
    }));
    await vi.waitFor(() => expect(harness.retirements).toHaveLength(1));

    const e = harness.coordinator.submit(change('enable', 'e'));
    const f = harness.coordinator.submit(change('enable', 'f'));
    await expect(e).resolves.toEqual(expect.objectContaining({
      requestId: 'reload-2',
      outcome: 'superseded',
      supersededByRequestId: 'reload-3',
    }));
    expect(harness.preparations).toHaveLength(1);

    harness.retirements[0]!.deferred.resolve({ outcome: 'retired' });
    await vi.waitFor(() => expect(harness.preparations).toHaveLength(2));
    expect(harness.preparations[1]?.request.change.unitId).toBe('f');
    harness.resolvePreparation(1);
    await expect(f).resolves.toEqual(expect.objectContaining({
      requestId: 'reload-3',
      outcome: 'published',
      generation: 3,
    }));
    expect(harness.hooks.publish).toHaveBeenCalledTimes(2);
  });

  it('settles A/B/C latest-wins and starts only C after A cleanup', async () => {
    const harness = createHarness();
    const a = harness.coordinator.submit(change('enable', 'a'));
    await vi.waitFor(() => expect(harness.preparations).toHaveLength(1));
    const b = harness.coordinator.submit(change('enable', 'b'));
    const c = harness.coordinator.submit(change('enable', 'c'));

    await expect(a).resolves.toEqual(expect.objectContaining({
      requestId: 'reload-1',
      outcome: 'superseded',
      supersededByRequestId: 'reload-2',
    }));
    await expect(b).resolves.toEqual(expect.objectContaining({
      requestId: 'reload-2',
      outcome: 'superseded',
      supersededByRequestId: 'reload-3',
    }));
    expect(harness.preparations[0]?.signal.aborted).toBe(true);

    harness.resolvePreparation(0);
    await vi.waitFor(() => expect(harness.preparations).toHaveLength(2));
    expect(harness.preparations[1]?.request.change.unitId).toBe('c');
    harness.resolvePreparation(1);
    await expect(c).resolves.toEqual(expect.objectContaining({
      requestId: 'reload-3',
      outcome: 'published',
      generation: 2,
    }));
    expect(harness.hooks.publish).toHaveBeenCalledTimes(1);
  });

  it('blocks pending and future requests after attributable candidate cleanup failure', async () => {
    const harness = createHarness();
    harness.setCleanupResidual(Object.freeze({
      phase: 'candidate-cleanup',
      unitId: 'a',
      message: 'stop failed',
    }));
    const a = harness.coordinator.submit(change('enable', 'a'));
    await vi.waitFor(() => expect(harness.preparations).toHaveLength(1));
    const b = harness.coordinator.submit(change('enable', 'b'));
    await expect(a).resolves.toEqual(expect.objectContaining({ outcome: 'superseded' }));

    harness.resolvePreparation(0);
    await expect(b).resolves.toEqual(expect.objectContaining({
      outcome: 'blocked',
      blocker: expect.objectContaining({ message: 'stop failed' }),
    }));
    await expect(harness.coordinator.submit(change('enable', 'c'))).resolves.toEqual(
      expect.objectContaining({ outcome: 'blocked' }),
    );
    expect(harness.hooks.publish).not.toHaveBeenCalled();
  });

  it('blocks when preparation reports creator-owned cleanup nonconvergence', async () => {
    const harness = createHarness();
    vi.mocked(harness.hooks.prepare).mockRejectedValueOnce(new RuntimeReloadBlockedError({
      phase: 'candidate-cleanup',
      unitId: 'a',
      message: 'creator cleanup failed',
    }));

    await expect(harness.coordinator.submit(change('enable', 'a'))).resolves.toEqual(
      expect.objectContaining({
        outcome: 'blocked',
        blocker: expect.objectContaining({
          requestId: 'reload-1',
          message: 'creator cleanup failed',
        }),
      }),
    );
    await expect(harness.coordinator.submit(change('enable', 'b'))).resolves.toEqual(
      expect.objectContaining({ outcome: 'blocked' }),
    );
  });

  it('cleans a prepared candidate before rejecting a synchronous publication failure', async () => {
    const harness = createHarness();
    vi.mocked(harness.hooks.publish).mockImplementation(() => {
      throw new Error('publish rejected');
    });
    const result = harness.coordinator.submit(change('enable', 'a'));
    await vi.waitFor(() => expect(harness.preparations).toHaveLength(1));
    harness.resolvePreparation(0);

    await expect(result).resolves.toEqual(expect.objectContaining({
      outcome: 'rejected',
      category: 'CANDIDATE_FAILED',
      message: 'publish rejected',
    }));
    expect(harness.hooks.cleanup).toHaveBeenCalledTimes(1);
  });

  it('blocks when cleanup after publication rejection leaves a residual', async () => {
    const harness = createHarness();
    vi.mocked(harness.hooks.publish).mockImplementation(() => {
      throw new Error('publish rejected');
    });
    harness.setCleanupResidual(Object.freeze({
      phase: 'candidate-cleanup',
      unitId: 'a',
      message: 'cleanup failed',
    }));
    const result = harness.coordinator.submit(change('enable', 'a'));
    await vi.waitFor(() => expect(harness.preparations).toHaveLength(1));
    harness.resolvePreparation(0);

    await expect(result).resolves.toEqual(expect.objectContaining({
      outcome: 'blocked',
      blocker: expect.objectContaining({ message: 'cleanup failed' }),
    }));
    await expect(harness.coordinator.submit(change('enable', 'b'))).resolves.toEqual(
      expect.objectContaining({ outcome: 'blocked' }),
    );
  });

  it('blocks pending and future requests after retirement failure without rewriting publish', async () => {
    const harness = createHarness();
    const published = harness.coordinator.submit(change('enable', 'a'));
    await vi.waitFor(() => expect(harness.preparations).toHaveLength(1));
    harness.resolvePreparation(0);
    await expect(published).resolves.toEqual(expect.objectContaining({ outcome: 'published' }));
    await vi.waitFor(() => expect(harness.retirements).toHaveLength(1));

    const pending = harness.coordinator.submit(change('enable', 'b'));
    harness.retirements[0]!.deferred.resolve({
      outcome: 'failed-residual',
      blocker: Object.freeze({
        phase: 'retirement-stop',
        generation: 1,
        unitId: 'a',
        message: 'stop failed',
      }),
    });

    await expect(pending).resolves.toEqual(expect.objectContaining({
      outcome: 'blocked',
      blocker: expect.objectContaining({ phase: 'retirement-stop' }),
    }));
    await expect(harness.coordinator.submit(change('disable', 'a'))).resolves.toEqual(
      expect.objectContaining({ outcome: 'blocked' }),
    );
  });

  it('settles active and pending requests as shutdown/cancelled', async () => {
    const harness = createHarness();
    const active = harness.coordinator.submit(change('enable', 'a'));
    const pending = harness.coordinator.submit(change('enable', 'b'));

    harness.coordinator.beginShutdown();

    await expect(active).resolves.toEqual(expect.objectContaining({
      requestId: 'reload-1',
      outcome: 'superseded',
    }));
    await expect(pending).resolves.toEqual(expect.objectContaining({
      requestId: 'reload-2',
      outcome: 'shutdown/cancelled',
    }));
    await expect(harness.coordinator.submit(change('enable', 'c'))).resolves.toEqual(
      expect.objectContaining({ outcome: 'shutdown/cancelled' }),
    );
  });

  it('turns a nonconvergent cleanup deadline into a permanent blocker', async () => {
    const harness = createHarness();
    const deadline = deferred<
      | { readonly outcome: 'completed'; readonly value: undefined }
      | { readonly outcome: 'timed-out' }
    >();
    const deadlineDriver: RuntimeReloadDeadlineDriver = {
      wait: vi.fn(async () => deadline.promise) as RuntimeReloadDeadlineDriver['wait'],
    };
    let id = 0;
    const coordinator = new RuntimeReloadStateMachine(
      new CompositionCoordinator(),
      harness.hooks,
      {
        createRequestId: () => `deadline-${++id}`,
        candidateCleanupTimeoutMs: 25,
        deadlineDriver,
      },
    );

    const active = coordinator.submit(change('enable', 'a'));
    await vi.waitFor(() => expect(harness.preparations).toHaveLength(1));
    const pending = coordinator.submit(change('enable', 'b'));
    await expect(active).resolves.toEqual(expect.objectContaining({ outcome: 'superseded' }));
    harness.resolvePreparation(0);
    deadline.resolve({ outcome: 'timed-out' });

    await expect(pending).resolves.toEqual(expect.objectContaining({
      outcome: 'blocked',
      blocker: expect.objectContaining({
        phase: 'candidate-cleanup',
        message: 'Candidate cleanup exceeded 25ms.',
      }),
    }));
  });

  it('bounds an aborted prepare that never observes its abort signal', async () => {
    const harness = createHarness();
    const deadline = deferred<
      | { readonly outcome: 'completed'; readonly value: undefined }
      | { readonly outcome: 'timed-out' }
    >();
    const deadlineDriver: RuntimeReloadDeadlineDriver = {
      wait: vi.fn(async () => deadline.promise) as RuntimeReloadDeadlineDriver['wait'],
    };
    let id = 0;
    const coordinator = new RuntimeReloadStateMachine(
      new CompositionCoordinator(),
      harness.hooks,
      {
        createRequestId: () => `stuck-${++id}`,
        candidateCleanupTimeoutMs: 25,
        deadlineDriver,
      },
    );

    const active = coordinator.submit(change('enable', 'a'));
    await vi.waitFor(() => expect(harness.preparations).toHaveLength(1));
    const pending = coordinator.submit(change('enable', 'b'));
    await expect(active).resolves.toEqual(expect.objectContaining({ outcome: 'superseded' }));
    expect(harness.preparations[0]?.signal.aborted).toBe(true);

    deadline.resolve({ outcome: 'timed-out' });
    await expect(pending).resolves.toEqual(expect.objectContaining({
      outcome: 'blocked',
      blocker: expect.objectContaining({
        phase: 'candidate-cleanup',
        message: 'Candidate cleanup exceeded 25ms.',
      }),
    }));
    expect(harness.preparations).toHaveLength(1);
  });
});
