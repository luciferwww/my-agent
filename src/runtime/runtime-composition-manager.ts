import { randomUUID } from 'node:crypto';
import type {
  ChannelCompletion,
  ChannelCompletionObserver,
  ChannelRuntimeBinding,
  ChannelRuntimeHost,
} from '../core/channel/index.js';
import type {
  RegistrySnapshot,
  RegistryStartupDiagnostic,
} from '../core/registry/index.js';
import {
  prepareStagedUnitChannels,
  recheckPreparedUnitChannels,
  type PreparedUnitChannels,
} from './channel-lifecycle.js';
import { CompositionCoordinator } from './composition-coordinator.js';
import {
  finalizeRegistrySnapshot,
  resolveStagedRegistryCandidate,
  stageRegistryUnit,
  type StagedRegistryUnit,
} from './registry-builder.js';
import {
  RuntimeReloadStateMachine,
  RuntimeReloadBlockedError,
  type PreparedRuntimeReload,
  type RuntimeReloadExecutionHooks,
  type RuntimeReloadDeadlineDriver,
  type RuntimeReloadPreflight,
  type RuntimeReloadRequest,
  type RuntimeRetirementResult,
} from './reload-coordinator.js';
import type {
  RuntimeCompositionControl,
  RuntimeCompositionResidual,
  RuntimeReloadChange,
} from './runtime-composition.js';
import {
  RuntimeLifecycleLedger,
  type RuntimeLifecycleStopReport,
} from './runtime-lifecycle.js';
import {
  RuntimeUnitCatalog,
  type LoadedRuntimeUnit,
  type RuntimeUnitInstance,
} from './runtime-unit.js';
import type { RuntimeDeadlineBudget } from './runtime-deadline.js';
import type { RuntimeShutdownResidual } from './types.js';
import { attributeRuntimeUnitCreationError } from './errors.js';

interface ActiveRuntimeUnit {
  readonly loaded: LoadedRuntimeUnit;
  readonly instance: RuntimeUnitInstance;
  readonly unitInstanceId: string;
  readonly staged: StagedRegistryUnit;
  readonly channels: PreparedUnitChannels;
  readonly instanceIds: readonly string[];
}

interface PublishedRuntimeComposition {
  readonly snapshot: RegistrySnapshot;
  readonly units: ReadonlyMap<string, ActiveRuntimeUnit>;
  readonly instanceIds: readonly string[];
}

interface PreparedCompositionReload extends PreparedRuntimeReload {
  readonly composition: PublishedRuntimeComposition;
  readonly createdUnits: readonly ActiveRuntimeUnit[];
  readonly removedUnits: readonly ActiveRuntimeUnit[];
  readonly retiredUnitIds: readonly string[];
}

export interface RuntimeCompositionManagerOptions {
  readonly createInstanceId?: (unitId: string) => string;
  readonly candidateCleanupTimeoutMs?: number;
  readonly retirementDrainTimeoutMs?: number;
  readonly retirementAbortTimeoutMs?: number;
  readonly deadlineDriver?: RuntimeReloadDeadlineDriver;
}

export interface RuntimeCompositionShutdownReport extends RuntimeLifecycleStopReport {
  readonly residuals: readonly RuntimeShutdownResidual[];
}

export interface RuntimeGenerationConvergence {
  blockingTurnIds(generation: number): readonly string[];
  abortGeneration(generation: number): readonly string[];
}

export class RuntimeCompositionManager implements ChannelCompletionObserver {
  private readonly reload: RuntimeReloadStateMachine<PreparedCompositionReload>;
  private readonly createInstanceId: (unitId: string) => string;
  private readonly retirementDrainTimeoutMs: number;
  private readonly retirementAbortTimeoutMs: number;
  private readonly deadlineDriver: RuntimeReloadDeadlineDriver;
  private generationConvergence?: RuntimeGenerationConvergence;
  private currentComposition?: PublishedRuntimeComposition;
  private readonly failedChannelCompletions = new Map<string, Promise<ChannelCompletion>>();
  private readonly knownInstanceIds = new Set<string>();
  private activeRetirement?: Promise<RuntimeRetirementResult>;
  private shutdownBudget?: RuntimeDeadlineBudget;
  private readonly shutdownAdmission: Promise<RuntimeDeadlineBudget>;
  private admitShutdown!: (budget: RuntimeDeadlineBudget) => void;

  constructor(
    private readonly catalog: RuntimeUnitCatalog,
    private readonly coordinator: CompositionCoordinator,
    private readonly lifecycleLedger: RuntimeLifecycleLedger,
    private readonly channelHost: ChannelRuntimeHost,
    options: RuntimeCompositionManagerOptions = {},
  ) {
    this.shutdownAdmission = new Promise((resolve) => {
      this.admitShutdown = resolve;
    });
    const createInstanceId = options.createInstanceId
      ?? ((unitId: string) => `unit:${unitId}:${randomUUID()}`);
    this.createInstanceId = createInstanceId;
    this.retirementDrainTimeoutMs = options.retirementDrainTimeoutMs ?? 30_000;
    this.retirementAbortTimeoutMs = options.retirementAbortTimeoutMs ?? 10_000;
    assertPositiveTimeout(this.retirementDrainTimeoutMs, 'retirementDrainTimeoutMs');
    assertPositiveTimeout(this.retirementAbortTimeoutMs, 'retirementAbortTimeoutMs');
    this.deadlineDriver = options.deadlineDriver ?? createSystemDeadlineDriver();
    const hooks: RuntimeReloadExecutionHooks<PreparedCompositionReload> = {
      currentGeneration: () => this.currentSnapshot().generation,
      preflight: (change) => this.preflight(change),
      prepare: (request, signal) => this.prepareReload(request, signal, createInstanceId),
      cleanup: (prepared) => this.cleanupPrepared(prepared),
      publish: (prepared) => this.publishPrepared(prepared),
      retire: (prepared) => {
        const retirement = this.retirePublished(prepared);
        this.activeRetirement = retirement;
        void retirement.finally(() => {
          if (this.activeRetirement === retirement) this.activeRetirement = undefined;
        });
        return retirement;
      },
    };
    this.reload = new RuntimeReloadStateMachine(this.coordinator, hooks, {
      candidateCleanupTimeoutMs: options.candidateCleanupTimeoutMs,
      deadlineDriver: options.deadlineDriver,
    });
  }

  async start(): Promise<RegistrySnapshot> {
    if (this.currentComposition) throw new Error('Runtime composition is already started.');
    const startupRequest: RuntimeReloadRequest = Object.freeze({
      requestId: 'startup',
      change: Object.freeze({ operation: 'enable', unitId: 'startup' }),
    });
    const prepared = await this.prepareDesired(
      startupRequest,
      this.catalog.initialUnitIds(),
      new AbortController().signal,
      this.createInstanceId,
      true,
    );
    try {
      this.publish(prepared);
    } catch (error) {
      await this.cleanupPrepared(prepared);
      throw error;
    }
    return prepared.composition.snapshot;
  }

  currentSnapshot(): RegistrySnapshot {
    const current = this.currentComposition;
    if (!current) throw new Error('Runtime composition has not started.');
    return current.snapshot;
  }

  currentChannelBindings(): readonly ChannelRuntimeBinding[] {
    return this.currentSnapshot().channels.bindings;
  }

  waitForChannelCompletion(id: string): Promise<ChannelCompletion> {
    for (const unit of this.currentComposition?.units.values() ?? []) {
      const record = unit.channels.records.find((candidate) => candidate.id === id);
      if (record) return record.completion;
    }
    const failedCompletion = this.failedChannelCompletions.get(id);
    if (failedCompletion) return failedCompletion;
    return Promise.reject(new Error(`CHANNEL_NOT_FOUND: ${id}`));
  }

  compositionControl(): RuntimeCompositionControl {
    return Object.freeze({
      enableUnit: (unitId: string) =>
        this.reload.submit(Object.freeze({ operation: 'enable', unitId })),
      disableUnit: (unitId: string) =>
        this.reload.submit(Object.freeze({ operation: 'disable', unitId })),
    });
  }

  setGenerationConvergence(convergence: RuntimeGenerationConvergence): void {
    if (this.generationConvergence) {
      throw new Error('Runtime generation convergence is already configured.');
    }
    this.generationConvergence = convergence;
  }

  beginShutdown(budget?: RuntimeDeadlineBudget): void {
    if (budget && !this.shutdownBudget) {
      this.shutdownBudget = budget;
      this.admitShutdown(budget);
    }
    this.reload.beginShutdown();
  }

  async shutdown(budget?: RuntimeDeadlineBudget): Promise<RuntimeCompositionShutdownReport> {
    this.beginShutdown(budget);
    const residuals: RuntimeShutdownResidual[] = [];
    if (budget) {
      const candidate = await budget.race(
        this.reload.shutdownConvergence(),
        budget.policy.candidateCleanupMs,
      );
      if (candidate.outcome === 'deadline-exhausted') {
        residuals.push({
          owner: 'reload',
          phase: 'candidate-cleanup',
          message: 'Active reload candidate cleanup did not converge before its deadline.',
        });
      } else if (candidate.outcome === 'failed') {
        residuals.push({ owner: 'reload', phase: 'candidate-cleanup', message: candidate.message });
      } else if (candidate.value) {
        residuals.push({
          owner: 'reload',
          phase: candidate.value.phase,
          message: candidate.value.message,
          ...(candidate.value.requestId ? { requestId: candidate.value.requestId } : {}),
          ...(candidate.value.unitId ? { unitId: candidate.value.unitId } : {}),
          ...(candidate.value.instanceId ? { instanceId: candidate.value.instanceId } : {}),
        });
      }

      const retirement = this.activeRetirement;
      if (retirement) {
        const settled = await budget.raceRemaining(retirement);
        if (settled.outcome !== 'completed') {
          residuals.push({
            owner: 'retirement',
            phase: 'retirement-convergence',
            message: settled.outcome === 'failed'
              ? settled.message
              : 'Active generation retirement did not converge before shutdown deadline.',
          });
        } else if (settled.value.outcome === 'failed-residual') {
          const blocker = settled.value.blocker;
          residuals.push({
            owner: 'retirement',
            phase: blocker.phase,
            message: blocker.message,
            ...(blocker.generation ? { generation: blocker.generation } : {}),
            ...(blocker.requestId ? { requestId: blocker.requestId } : {}),
            ...(blocker.instanceId ? { instanceId: blocker.instanceId } : {}),
            ...(blocker.blockingTurnIds
              ? { blockingTurnIds: blocker.blockingTurnIds }
              : {}),
          });
        }
      }
    }
    const current = this.currentComposition;
    if (!current) return Object.freeze({
      completed: Object.freeze([]),
      failed: Object.freeze([]),
      pending: Object.freeze([]),
      skippedProtected: Object.freeze([]),
      residuals: Object.freeze(residuals.map((entry) => Object.freeze(entry))),
    });
    for (const unit of current.units.values()) unit.channels.deactivateIngress();
    for (const generation of this.coordinator.generationViews()) {
      if (generation.pinCount === 0) {
        this.lifecycleLedger.removeGenerationMemberships(
          generation.instanceIds,
          generation.generation,
        );
      } else {
        residuals.push({
          owner: 'retirement',
          phase: 'shutdown-protected-generation',
          generation: generation.generation,
          blockingTurnIds: this.generationConvergence?.blockingTurnIds(generation.generation),
          message: `Registry generation ${generation.generation} remains protected by ${generation.pinCount} pin(s).`,
        });
      }
    }
    const stopped = await this.lifecycleLedger.stopEligible(
      [...this.knownInstanceIds],
      { retryFailed: true, ...(budget ? { budget } : {}) },
    );
    for (const instanceId of stopped.pending) {
      residuals.push({
        owner: 'instance',
        phase: 'shutdown-stop',
        instanceId,
        message: `Runtime instance "${instanceId}" stop did not converge before shutdown deadline.`,
      });
    }
    return Object.freeze({
      ...stopped,
      residuals: Object.freeze(residuals.map((entry) => Object.freeze(entry))),
    });
  }

  private preflight(change: RuntimeReloadChange): RuntimeReloadPreflight {
    const plan = this.catalog.planChange(change, this.activeUnitIds());
    if (plan.outcome === 'no-op') {
      return {
        outcome: 'no-op',
        warnings: [Object.freeze({ code: plan.code, message: plan.message, unitId: change.unitId })],
      };
    }
    if (plan.outcome === 'rejected') {
      return { outcome: 'rejected', category: plan.category, message: plan.message };
    }
    return { outcome: 'proceed' };
  }

  private async prepareReload(
    request: RuntimeReloadRequest,
    signal: AbortSignal,
    createInstanceId: (unitId: string) => string,
  ): Promise<PreparedCompositionReload> {
    const plan = this.catalog.planChange(request.change, this.activeUnitIds());
    if (plan.outcome !== 'proceed') {
      throw new Error(`Reload preflight changed after admission for "${request.change.unitId}".`);
    }
    return this.prepareDesired(request, plan.desiredUnitIds, signal, createInstanceId, false);
  }

  private async prepareDesired(
    request: RuntimeReloadRequest,
    desiredUnitIds: readonly string[],
    signal: AbortSignal,
    createInstanceId: (unitId: string) => string,
    startup: boolean,
  ): Promise<PreparedCompositionReload> {
    const currentUnits = this.currentComposition?.units ?? new Map<string, ActiveRuntimeUnit>();
    const desired = new Map<string, ActiveRuntimeUnit>();
    const created: ActiveRuntimeUnit[] = [];
    const handedOff = new Set<ActiveRuntimeUnit>();
    const directlyCleaned = new Set<ActiveRuntimeUnit>();
    const startupDiagnostics: RegistryStartupDiagnostic[] = [];

    try {
      for (const loaded of this.catalog.orderedUnits(desiredUnitIds)) {
        const existing = currentUnits.get(loaded.unitId);
        if (existing) {
          desired.set(loaded.unitId, existing);
          continue;
        }
        throwIfAborted(signal);
        try {
          const next = await this.createUnit(loaded, signal, createInstanceId(loaded.unitId));
          created.push(next);
          desired.set(loaded.unitId, next);
        } catch (error) {
          if (error instanceof RuntimeReloadBlockedError) throw error;
          if (!startup || loaded.required) throw error;
          startupDiagnostics.push(...diagnosticsForStartupFailure(loaded, error));
        }
      }

      for (const unit of created) {
        const checked = await recheckPreparedUnitChannels(unit.channels);
        if (checked.accepted) continue;
        for (const [channelId, completion] of checked.completions) {
          this.failedChannelCompletions.set(channelId, completion);
        }
        const rollbackFailure = checked.diagnostics.find(
          (diagnostic) => diagnostic.code === 'CHANNEL_ROLLBACK_FAILED',
        );
        if (rollbackFailure) {
          throw new RuntimeReloadBlockedError(Object.freeze({
            phase: 'candidate-cleanup',
            unitId: unit.loaded.unitId,
            message: rollbackFailure.message,
          }));
        }
        if (!startup || unit.loaded.required) {
          throw new RuntimeChannelPreparationError(checked.diagnostics);
        }
        startupDiagnostics.push(...checked.diagnostics);
        await this.cleanupCreatedUnit(unit);
        directlyCleaned.add(unit);
        desired.delete(unit.loaded.unitId);
      }

      const resolved = resolveStagedRegistryCandidate({
        providers: [],
        units: [...desired.values()].map((unit) => unit.staged),
        diagnostics: startupDiagnostics,
      });
      const acceptedIds = new Set(resolved.units.map((unit) => unit.unit.id));
      const requestedAccepted = request.requestId === 'startup'
        || request.change.operation === 'disable'
        || acceptedIds.has(request.change.unitId);
      if (!requestedAccepted) {
        throw new Error(`Runtime Unit "${request.change.unitId}" lost deterministic conflict resolution.`);
      }
      for (const unitId of acceptedIds) {
        const unit = desired.get(unitId)!;
        const missing = unit.loaded.dependencies.find((dependency) => !acceptedIds.has(dependency));
        if (missing) {
          throw new Error(`Runtime Unit "${unitId}" requires unavailable Unit "${missing}".`);
        }
      }

      const dropped = [...desired.values()].filter((unit) => !acceptedIds.has(unit.loaded.unitId));
      if (!startup && dropped.some((unit) => currentUnits.has(unit.loaded.unitId))) {
        // Deterministic conflict displacement is intentional and represented in retiredUnitIds.
      }
      for (const unit of dropped.filter((candidate) => created.includes(candidate))) {
        await this.cleanupCreatedUnit(unit);
        directlyCleaned.add(unit);
      }
      const acceptedUnits = new Map<string, ActiveRuntimeUnit>();
      for (const staged of resolved.units) {
        acceptedUnits.set(staged.unit.id, desired.get(staged.unit.id)!);
      }
      const createdAccepted = created.filter((unit) => acceptedIds.has(unit.loaded.unitId));
      for (const unit of createdAccepted) {
        this.handoffCreatedUnit(unit);
        handedOff.add(unit);
      }

      const generation = (this.currentComposition?.snapshot.generation ?? 0) + 1;
      const bindings = [...acceptedUnits.values()].flatMap((unit) => [...unit.channels.bindings]);
      const snapshot = finalizeRegistrySnapshot({
        candidate: resolved,
        acceptedUnits: resolved.units,
        channelBindings: bindings,
        generation,
        provenance: [...acceptedUnits.values()].map((unit) => Object.freeze({
          unitId: unit.loaded.unitId,
          instanceId: unit.unitInstanceId,
          source: unit.loaded.source,
          orderKey: unit.loaded.orderKey,
          dependencies: unit.loaded.dependencies,
        })),
      });
      const instanceIds = Object.freeze(
        [...acceptedUnits.values()].flatMap((unit) => [...unit.instanceIds]),
      );
      const removedUnits = [...currentUnits.values()]
        .filter((unit) => !acceptedUnits.has(unit.loaded.unitId));
      return Object.freeze({
        request,
        composition: Object.freeze({ snapshot, units: acceptedUnits, instanceIds }),
        createdUnits: Object.freeze(createdAccepted),
        removedUnits: Object.freeze(removedUnits),
        retiredUnitIds: Object.freeze(removedUnits.map((unit) => unit.loaded.unitId)),
        warnings: Object.freeze(resolved.diagnostics.map((diagnostic) => Object.freeze({
          code: diagnostic.code,
          message: diagnostic.message,
          unitId: diagnostic.unitId,
        }))),
      });
    } catch (error) {
      const handedOffIds = [...handedOff].flatMap((unit) => [...unit.instanceIds]);
      const ledgerCleanup = await this.lifecycleLedger.stopEligible(handedOffIds);
      if (ledgerCleanup.failed.length > 0) {
        const failure = ledgerCleanup.failed[0]!;
        throw new RuntimeReloadBlockedError(Object.freeze({
          phase: 'candidate-cleanup',
          instanceId: failure.instanceId,
          message: failure.message,
        }));
      }
      await Promise.all(created
        .filter((unit) => !handedOff.has(unit) && !directlyCleaned.has(unit))
        .map((unit) => this.cleanupCreatedUnit(unit)));
      throw error;
    }
  }

  private async createUnit(
    loaded: LoadedRuntimeUnit,
    signal: AbortSignal,
    unitInstanceId: string,
  ): Promise<ActiveRuntimeUnit> {
    let instance: RuntimeUnitInstance;
    try {
      instance = await loaded.create(signal);
    } catch (error) {
      throw attributeRuntimeUnitCreationError(error, loaded.unitId);
    }
    try {
      assertRegistrationIdentity(loaded, instance);
      const staged = stageRegistryUnit(instance.registration);
      throwIfAborted(signal);
      await instance.start(signal);
      throwIfAborted(signal);
      const channels = await prepareStagedUnitChannels({
        unit: staged,
        host: this.channelHost,
        instanceIdPrefix: unitInstanceId,
      });
      if (!channels.accepted) {
        for (const [channelId, completion] of channels.completions) {
          this.failedChannelCompletions.set(channelId, completion);
        }
        const rollbackFailure = channels.diagnostics.find(
          (diagnostic) => diagnostic.code === 'CHANNEL_ROLLBACK_FAILED',
        );
        if (rollbackFailure) {
          throw new RuntimeReloadBlockedError(Object.freeze({
            phase: 'candidate-cleanup',
            unitId: loaded.unitId,
            message: rollbackFailure.message,
          }));
        }
        throw new RuntimeChannelPreparationError(channels.diagnostics);
      }
      return Object.freeze({
        loaded,
        instance,
        unitInstanceId,
        staged,
        channels,
        instanceIds: Object.freeze([
          unitInstanceId,
          ...channels.records.map((record) => record.instanceId),
        ]),
      });
    } catch (error) {
      try {
        await instance.stop();
      } catch (cleanupError) {
        throw new RuntimeReloadBlockedError(Object.freeze({
          phase: 'candidate-cleanup',
          unitId: loaded.unitId,
          message: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
        }));
      }
      throw error;
    }
  }

  private handoffCreatedUnit(unit: ActiveRuntimeUnit): void {
    this.lifecycleLedger.create({
      instanceId: unit.unitInstanceId,
      unitId: unit.loaded.unitId,
      source: unit.loaded.source,
      dependencies: unit.loaded.dependencies,
      owner: { stop: () => unit.instance.stop() },
    });
    this.lifecycleLedger.markStarting(unit.unitInstanceId);
    this.lifecycleLedger.markReady(unit.unitInstanceId);
    this.lifecycleLedger.handoff(unit.unitInstanceId);
    for (const record of unit.channels.records) {
      this.lifecycleLedger.create({
        instanceId: record.instanceId,
        unitId: unit.loaded.unitId,
        source: unit.loaded.source,
        dependencies: unit.loaded.dependencies,
        owner: {
          async stop() {
            if (record.stopStarted) return;
            record.stopStarted = true;
            await record.instance.stop();
          },
        },
      });
      this.lifecycleLedger.markStarting(record.instanceId);
      this.lifecycleLedger.markReady(record.instanceId);
      this.lifecycleLedger.handoff(record.instanceId);
    }
    for (const instanceId of unit.instanceIds) this.knownInstanceIds.add(instanceId);
  }

  private publishPrepared(prepared: PreparedCompositionReload) {
    const previousGeneration = this.currentSnapshot().generation;
    this.publish(prepared);
    return Object.freeze({
      previousGeneration,
      generation: prepared.composition.snapshot.generation,
      retiredUnitIds: prepared.retiredUnitIds,
    });
  }

  private publish(prepared: PreparedCompositionReload): void {
    this.coordinator.commitPublish(
      prepared.composition.snapshot,
      prepared.composition.instanceIds,
    );
    for (const unit of prepared.removedUnits) unit.channels.deactivateIngress();
    for (const unit of prepared.createdUnits) unit.channels.activateIngress();
    this.currentComposition = prepared.composition;
  }

  private async cleanupPrepared(
    prepared: PreparedCompositionReload,
  ): Promise<RuntimeCompositionResidual | undefined> {
    const report = await this.lifecycleLedger.stopEligible(
      prepared.createdUnits.flatMap((unit) => [...unit.instanceIds]),
    );
    if (report.failed.length === 0) return undefined;
    const failure = report.failed[0]!;
    return Object.freeze({
      phase: 'candidate-cleanup',
      requestId: prepared.request.requestId,
      instanceId: failure.instanceId,
      message: failure.message,
    });
  }

  private async retirePublished(
    prepared: PreparedCompositionReload,
  ): Promise<RuntimeRetirementResult> {
    const generation = prepared.composition.snapshot.generation - 1;
    const graceful = await this.waitForPins(
      this.coordinator.waitForZeroPins(generation),
      this.retirementDrainTimeoutMs,
    );
    if (graceful.outcome === 'timed-out') {
      this.generationConvergence?.abortGeneration(generation);
      const aborted = await this.waitForPins(
        this.coordinator.waitForZeroPins(generation),
        this.retirementAbortTimeoutMs,
      );
      if (aborted.outcome === 'timed-out') {
        const blockingTurnIds = Object.freeze([
          ...(this.generationConvergence?.blockingTurnIds(generation) ?? []),
        ]);
        const blocker = Object.freeze({
          phase: 'retirement-abort-convergence',
          requestId: prepared.request.requestId,
          generation,
          blockingTurnIds,
          message: `Registry generation ${generation} pins did not converge after abort.`,
        });
        this.coordinator.failRetirement(generation, blocker.message);
        return { outcome: 'failed-residual', blocker };
      }
    }
    const retiringIds = this.coordinator.generationInstanceIds(generation);
    if (this.shutdownBudget && this.shutdownBudget.remaining() <= 0) {
      const blocker = Object.freeze({
        phase: 'retirement-stop',
        requestId: prepared.request.requestId,
        generation,
        message: `Registry generation ${generation} retirement exhausted the shutdown deadline.`,
      });
      this.coordinator.failRetirement(generation, blocker.message);
      return { outcome: 'failed-residual', blocker };
    }
    this.lifecycleLedger.removeGenerationMemberships(retiringIds, generation);
    const report = await this.lifecycleLedger.stopEligible(retiringIds, {
      ...(this.shutdownBudget ? { budget: this.shutdownBudget } : {}),
    });
    if (report.pending.length > 0) {
      const instanceId = report.pending[0]!;
      const blocker = Object.freeze({
        phase: 'retirement-stop',
        requestId: prepared.request.requestId,
        generation,
        instanceId,
        message: `Runtime instance "${instanceId}" stop did not converge before shutdown deadline.`,
      });
      this.coordinator.failRetirement(generation, blocker.message);
      return { outcome: 'failed-residual', blocker };
    }
    if (report.failed.length > 0) {
      const failure = report.failed[0]!;
      const blocker = Object.freeze({
        phase: 'retirement-stop',
        requestId: prepared.request.requestId,
        generation,
        instanceId: failure.instanceId,
        message: failure.message,
      });
      this.coordinator.failRetirement(generation, failure.message);
      return { outcome: 'failed-residual', blocker };
    }
    this.coordinator.completeRetirement(generation);
    return { outcome: 'retired' };
  }

  private async waitForPins(
    operation: Promise<void>,
    standaloneTimeoutMs: number,
  ): Promise<{ readonly outcome: 'completed' | 'timed-out' }> {
    if (this.shutdownBudget) {
      const settled = await this.shutdownBudget.race(operation, standaloneTimeoutMs);
      return { outcome: settled.outcome === 'completed' ? 'completed' : 'timed-out' };
    }
    const standalone = this.deadlineDriver.wait(operation, standaloneTimeoutMs);
    const first = await Promise.race([
      standalone.then((result) => ({ source: 'standalone' as const, result })),
      this.shutdownAdmission.then((budget) => ({ source: 'shutdown' as const, budget })),
    ]);
    if (first.source === 'standalone') return first.result;
    const settled = await first.budget.race(operation, standaloneTimeoutMs);
    return { outcome: settled.outcome === 'completed' ? 'completed' : 'timed-out' };
  }

  private async cleanupCreatedUnit(unit: ActiveRuntimeUnit): Promise<void> {
    unit.channels.deactivateIngress();
    for (const record of unit.channels.records) {
      if (record.stopStarted) continue;
      record.stopStarted = true;
      try {
        await record.instance.stop();
      } catch (error) {
        throw new RuntimeReloadBlockedError(Object.freeze({
          phase: 'candidate-cleanup',
          unitId: unit.loaded.unitId,
          instanceId: record.instanceId,
          message: error instanceof Error ? error.message : String(error),
        }));
      }
    }
    try {
      await unit.instance.stop();
    } catch (error) {
      throw new RuntimeReloadBlockedError(Object.freeze({
        phase: 'candidate-cleanup',
        unitId: unit.loaded.unitId,
        instanceId: unit.unitInstanceId,
        message: error instanceof Error ? error.message : String(error),
      }));
    }
  }

  private activeUnitIds(): ReadonlySet<string> {
    return new Set(this.currentComposition?.units.keys() ?? []);
  }
}

class RuntimeChannelPreparationError extends Error {
  constructor(readonly diagnostics: readonly RegistryStartupDiagnostic[]) {
    super(diagnostics.map((diagnostic) => diagnostic.message).join('; '));
  }
}

function diagnosticsForStartupFailure(
  loaded: LoadedRuntimeUnit,
  error: unknown,
): readonly RegistryStartupDiagnostic[] {
  if (error instanceof RuntimeChannelPreparationError) return error.diagnostics;
  return [Object.freeze({
    unitId: loaded.unitId,
    source: loaded.source,
    code: 'UNIT_INVALID',
    message: error instanceof Error ? error.message : String(error),
  })];
}

function assertRegistrationIdentity(
  loaded: LoadedRuntimeUnit,
  instance: RuntimeUnitInstance,
): void {
  if (!instance || typeof instance !== 'object') {
    throw new Error(`Runtime Unit factory "${loaded.unitId}" did not return an instance.`);
  }
  const registration = instance.registration;
  if (registration.id !== loaded.unitId) {
    throw new Error(
      `Runtime Unit factory "${loaded.unitId}" returned registration "${registration.id}".`,
    );
  }
  if (registration.source !== loaded.source) {
    throw new Error(`Runtime Unit "${loaded.unitId}" changed its source during creation.`);
  }
  if (typeof instance.start !== 'function' || typeof instance.stop !== 'function') {
    throw new Error(`Runtime Unit factory "${loaded.unitId}" returned an invalid lifecycle owner.`);
  }
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new Error(`Runtime Unit candidate aborted: ${String(signal.reason)}`);
}

function assertPositiveTimeout(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive safe integer.`);
  }
}

function createSystemDeadlineDriver(): RuntimeReloadDeadlineDriver {
  return Object.freeze({
    wait<T>(operation: Promise<T>, timeoutMs: number) {
      return new Promise<
        | { readonly outcome: 'completed'; readonly value: T }
        | { readonly outcome: 'timed-out' }
      >((resolve, reject) => {
        const timer = setTimeout(() => resolve({ outcome: 'timed-out' }), timeoutMs);
        timer.unref?.();
        void operation.then(
          (value) => {
            clearTimeout(timer);
            resolve({ outcome: 'completed', value });
          },
          (error) => {
            clearTimeout(timer);
            reject(error);
          },
        );
      });
    },
  });
}
