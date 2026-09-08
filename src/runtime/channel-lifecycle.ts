import type {
  ApprovalClosedResult,
  ChannelCompletion,
  ChannelInstance,
  ChannelLifecycleReport,
  ChannelRuntimeBinding,
  ChannelRuntimeHost,
  ChannelRuntimeInteraction,
  ChannelShutdownHandoff,
  ChannelCompletionObserver,
  TurnInteractionRequest,
} from '../core/channel/index.js';
import type { AgentEvent } from '../core/runner/index.js';
import type {
  ContributionSource,
  RegistrySnapshot,
  RegistryStartupDiagnostic,
} from '../core/registry/index.js';
import {
  finalizeRegistrySnapshot,
  type RegistryCandidate,
  type StagedRegistryUnit,
} from './registry-builder.js';
import { RuntimeLifecycleLedger } from './runtime-lifecycle.js';

interface ActiveChannelRecord {
  readonly id: string;
  readonly instanceId: string;
  readonly unitId: string;
  readonly source: ContributionSource;
  readonly instance: ChannelInstance;
  readonly completion: Promise<ChannelCompletion>;
  stopStarted: boolean;
}

interface ActivationResult {
  readonly unit: StagedRegistryUnit;
  readonly accepted: boolean;
  readonly bindings: readonly ChannelRuntimeBinding[];
  readonly records: readonly ActiveChannelRecord[];
  readonly diagnostics: readonly RegistryStartupDiagnostic[];
}

export interface ActivatedRegistry {
  readonly snapshot: RegistrySnapshot;
  readonly lifecycle: ChannelLifecycleSet;
}

export class ChannelLifecycleSet
implements ChannelCompletionObserver, ChannelShutdownHandoff {
  private shutdownPromise?: Promise<ChannelLifecycleReport>;

  constructor(
    private readonly completionById: ReadonlyMap<string, Promise<ChannelCompletion>>,
    private readonly activeRecords: readonly ActiveChannelRecord[],
    private readonly lifecycleLedger: RuntimeLifecycleLedger,
    private readonly generation: number,
  ) {}

  waitForChannelCompletion(id: string): Promise<ChannelCompletion> {
    const completion = this.completionById.get(id);
    if (!completion) {
      return Promise.reject(new Error(`CHANNEL_NOT_FOUND: ${id}`));
    }
    return completion;
  }

  runtimeConverged(): Promise<ChannelLifecycleReport> {
    this.shutdownPromise ??= this.stopActive();
    return this.shutdownPromise;
  }

  private async stopActive(): Promise<ChannelLifecycleReport> {
    const channelByInstanceId = new Map(
      this.activeRecords.map((record) => [record.instanceId, record.id]),
    );
    for (const record of this.activeRecords) {
      this.lifecycleLedger.removeGenerationMembership(record.instanceId, this.generation);
    }
    const report = await this.lifecycleLedger.stopEligible(
      this.activeRecords.map((record) => record.instanceId),
    );
    const completed = report.completed.map((instanceId) => channelByInstanceId.get(instanceId)!);
    const failed = report.failed.map((failure) => ({
      channelId: channelByInstanceId.get(failure.instanceId)!,
      message: failure.message,
    }));

    return Object.freeze({
      completed: Object.freeze(completed),
      failed: Object.freeze(failed.map((entry) => Object.freeze(entry))),
    });
  }
}

export async function activateRegistryChannels(params: {
  readonly candidate: RegistryCandidate;
  readonly host: ChannelRuntimeHost;
  readonly lifecycleLedger?: RuntimeLifecycleLedger;
}): Promise<ActivatedRegistry> {
  const lifecycleLedger = params.lifecycleLedger ?? new RuntimeLifecycleLedger();
  const completionById = new Map<string, Promise<ChannelCompletion>>();
  let results = await Promise.all(params.candidate.units.map(
    (unit) => activateUnit(unit, params.host, completionById),
  ));

  while (true) {
    const checks = results.flatMap((result) => result.accepted
      ? result.records.map((record) => ({ result, record }))
      : []);
    const completions = await Promise.all(
      checks.map(({ record }) => settledValue(record.completion)),
    );
    const failedResults = new Map<ActivationResult, {
      readonly record: ActiveChannelRecord;
      readonly completion: ChannelCompletion;
    }>();
    for (const [index, completion] of completions.entries()) {
      const check = checks[index];
      if (completion && check && !failedResults.has(check.result)) {
        failedResults.set(check.result, { record: check.record, completion });
      }
    }
    if (failedResults.size === 0) break;

    results = await Promise.all(results.map((result) => {
      const failure = failedResults.get(result);
      return failure
        ? rollbackCompletedBeforeHandoff(result, failure, completionById)
        : Promise.resolve(result);
    }));
  }

  const acceptedUnits = results.filter((result) => result.accepted).map((result) => result.unit);
  const bindings = results.flatMap((result) => result.accepted ? [...result.bindings] : []);
  const diagnostics = results.flatMap((result) => [...result.diagnostics]);
  const activeRecords = results.flatMap((result) => result.accepted ? [...result.records] : []);
  const ledgerOwnedInstanceIds: string[] = [];
  try {
    for (const record of activeRecords) {
      lifecycleLedger.create({
        instanceId: record.instanceId,
        unitId: record.unitId,
        source: record.source,
        owner: {
          async stop() {
            if (record.stopStarted) return;
            record.stopStarted = true;
            await record.instance.stop();
          },
        },
      });
      lifecycleLedger.markStarting(record.instanceId);
      lifecycleLedger.markReady(record.instanceId);
      lifecycleLedger.handoff(record.instanceId);
      ledgerOwnedInstanceIds.push(record.instanceId);
      lifecycleLedger.addGenerationMembership(record.instanceId, 1);
    }
    const lifecycle = new ChannelLifecycleSet(
      completionById,
      Object.freeze(activeRecords),
      lifecycleLedger,
      1,
    );
    const snapshot = finalizeRegistrySnapshot({
      candidate: params.candidate,
      acceptedUnits,
      channelBindings: bindings,
      generation: 1,
      diagnostics,
    });

    return Object.freeze({ snapshot, lifecycle });
  } catch (error) {
    for (const instanceId of ledgerOwnedInstanceIds) {
      lifecycleLedger.removeGenerationMembership(instanceId, 1);
    }
    await lifecycleLedger.stopEligible(ledgerOwnedInstanceIds);
    const ledgerOwned = new Set(ledgerOwnedInstanceIds);
    await Promise.all(activeRecords.map(async (record) => {
      if (ledgerOwned.has(record.instanceId) || record.stopStarted) return;
      record.stopStarted = true;
      try {
        await record.instance.stop();
      } catch {
        // Preserve the handoff/finalization failure as the startup cause.
      }
    }));
    throw error;
  }
}

async function activateUnit(
  unit: StagedRegistryUnit,
  host: ChannelRuntimeHost,
  completionById: Map<string, Promise<ChannelCompletion>>,
): Promise<ActivationResult> {
  if (unit.channels.length === 0) {
    return {
      unit,
      accepted: true,
      bindings: [],
      records: [],
      diagnostics: [],
    };
  }

  const records: ActiveChannelRecord[] = [];
  const bindings: ChannelRuntimeBinding[] = [];
  const diagnostics: RegistryStartupDiagnostic[] = [];
  let failedContributionId: string | undefined;
  let failedPhase: 'create' | 'start' = 'create';
  let startupError: unknown;

  for (const contribution of unit.channels) {
    failedContributionId = contribution.id;
    try {
      const instance = contribution.create();
      assertChannelInstance(instance, contribution.id);
      if (instance.id !== contribution.id) {
        throw new Error(
          `Channel factory identity "${instance.id}" does not match contribution "${contribution.id}".`,
        );
      }
      const record: ActiveChannelRecord = {
        id: contribution.id,
        instanceId: `channel:${contribution.id}`,
        unitId: unit.unit.id,
        source: unit.unit.source,
        instance,
        completion: instance.completion,
        stopStarted: false,
      };
      records.push(record);
      completionById.set(contribution.id, instance.completion);
      const binding = bindInstance(instance, host);
      bindings.push(binding);
    } catch (error) {
      startupError = error;
      break;
    }
  }

  if (!startupError) {
    failedPhase = 'start';
    const startFailure = await waitForReadinessOrFirstFailure(records);
    if (startFailure) {
      failedContributionId = startFailure.channelId;
      startupError = startFailure.error;
    }
  }

  if (!startupError) {
    return {
      unit,
      accepted: true,
      bindings: Object.freeze(bindings),
      records: Object.freeze(records),
      diagnostics: [],
    };
  }

  const failure = asError(startupError);
  for (const contribution of unit.channels) {
    completionById.set(
      contribution.id,
      Promise.resolve(Object.freeze({
        outcome: 'failed',
        phase: 'startup',
        error: failure,
      })),
    );
  }
  diagnostics.push(Object.freeze({
    unitId: unit.unit.id,
    source: unit.unit.source,
    contributionId: failedContributionId,
    phase: failedPhase,
    code: failedPhase === 'create' ? 'CHANNEL_CREATE_FAILED' : 'CHANNEL_START_FAILED',
    message: failure.message,
  }));

  await Promise.all(records.map(async (record) => {
    if (record.stopStarted) return;
    record.stopStarted = true;
    try {
      await record.instance.stop();
    } catch (error) {
      diagnostics.push(Object.freeze({
        unitId: unit.unit.id,
        source: unit.unit.source,
        contributionId: record.id,
        phase: 'rollback',
        code: 'CHANNEL_ROLLBACK_FAILED',
        message: messageOf(error),
      }));
    }
  }));

  return {
    unit,
    accepted: false,
    bindings: [],
    records: [],
    diagnostics: Object.freeze(diagnostics),
  };
}

async function rollbackCompletedBeforeHandoff(
  result: ActivationResult,
  failure: {
    readonly record: ActiveChannelRecord;
    readonly completion: ChannelCompletion;
  },
  completionById: Map<string, Promise<ChannelCompletion>>,
): Promise<ActivationResult> {
  const error = failure.completion.outcome === 'failed'
    ? failure.completion.error
    : new Error(`Channel "${failure.record.id}" completed before ownership handoff.`);
  const diagnostics: RegistryStartupDiagnostic[] = [Object.freeze({
    unitId: result.unit.unit.id,
    source: result.unit.unit.source,
    contributionId: failure.record.id,
    phase: 'start',
    code: 'CHANNEL_START_FAILED',
    message: error.message,
  })];

  for (const contribution of result.unit.channels) {
    completionById.set(
      contribution.id,
      Promise.resolve(Object.freeze({
        outcome: 'failed',
        phase: 'startup',
        error,
      })),
    );
  }

  await Promise.all(result.records.map(async (record) => {
    if (record.stopStarted) return;
    record.stopStarted = true;
    try {
      await record.instance.stop();
    } catch (rollbackError) {
      diagnostics.push(Object.freeze({
        unitId: result.unit.unit.id,
        source: result.unit.unit.source,
        contributionId: record.id,
        phase: 'rollback',
        code: 'CHANNEL_ROLLBACK_FAILED',
        message: messageOf(rollbackError),
      }));
    }
  }));

  return {
    unit: result.unit,
    accepted: false,
    bindings: [],
    records: [],
    diagnostics: Object.freeze(diagnostics),
  };
}

function waitForReadinessOrFirstFailure(
  records: readonly ActiveChannelRecord[],
): Promise<{ readonly channelId: string; readonly error: unknown } | undefined> {
  return new Promise((resolve) => {
    let pending = records.length;
    for (const record of records) {
      record.completion.then(
        (completion) => resolve({
          channelId: record.id,
          error: completion.outcome === 'failed'
            ? completion.error
            : new Error(`Channel "${record.id}" completed before ownership handoff.`),
        }),
        (error: unknown) => resolve({ channelId: record.id, error }),
      );
      Promise.resolve()
        .then(() => record.instance.start())
        .then(
          () => {
            pending -= 1;
            if (pending === 0) resolve(undefined);
          },
          (error: unknown) => resolve({ channelId: record.id, error }),
        );
    }
  });
}

function bindInstance(
  instance: ChannelInstance,
  host: ChannelRuntimeHost,
): ChannelRuntimeBinding {
  const interaction = normalizeInteraction(instance);
  const binding: ChannelRuntimeBinding = Object.freeze({
    id: instance.id,
    send: (event: AgentEvent) => instance.send(event),
    ...(interaction ? { interaction } : {}),
  });

  instance.onMessage((request) => host.onMessage(binding, request));
  if (instance.interaction) {
    instance.interaction.onInteractionResponse((response) => host.onInteractionResponse(response));
    instance.interaction.onInteractionUnavailable((id, reason) => {
      host.onInteractionUnavailable(id, reason);
    });
  }
  instance.bindAbortHooks?.(host.abortHooks);
  return binding;
}

function normalizeInteraction(
  instance: ChannelInstance,
): ChannelRuntimeInteraction | undefined {
  if (instance.interaction) {
    return Object.freeze({
      sendInteractionRequest: (request: TurnInteractionRequest) =>
        instance.interaction!.sendInteractionRequest(request),
      sendInteractionClosed: (
        request: TurnInteractionRequest,
        result: ApprovalClosedResult,
      ) => {
        instance.interaction!.sendInteractionClosed(request, result);
      },
    });
  }
  return undefined;
}

async function settledValue(
  promise: Promise<ChannelCompletion>,
): Promise<ChannelCompletion | undefined> {
  const sentinel = Symbol('pending');
  const result = await Promise.race([promise, Promise.resolve(sentinel)]);
  return result === sentinel ? undefined : result;
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function assertChannelInstance(
  instance: ChannelInstance,
  contributionId: string,
): void {
  if (!instance || typeof instance !== 'object') {
    throw new Error(`Channel factory "${contributionId}" did not return an instance.`);
  }
  if (
    typeof instance.send !== 'function'
    || typeof instance.onMessage !== 'function'
    || typeof instance.start !== 'function'
    || typeof instance.stop !== 'function'
    || !instance.completion
    || typeof instance.completion.then !== 'function'
  ) {
    throw new Error(`Channel factory "${contributionId}" returned an invalid instance.`);
  }
}

function messageOf(error: unknown): string {
  return asError(error).message;
}
