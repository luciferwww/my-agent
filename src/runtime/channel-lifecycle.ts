import type {
  ApprovalClosedResult,
  ChannelCompletion,
  ChannelInstance,
  ChannelRuntimeBinding,
  ChannelRuntimeHost,
  ChannelRuntimeInteraction,
  TurnInteractionRequest,
} from '../core/channel/index.js';
import type { AgentEvent } from '../core/runner/index.js';
import type {
  ContributionSource,
  RegistryStartupDiagnostic,
} from '../core/registry/index.js';
import {
  type StagedRegistryUnit,
} from './registry-builder.js';

export interface PreparedChannelRecord {
  readonly id: string;
  readonly instanceId: string;
  readonly unitId: string;
  readonly source: ContributionSource;
  readonly instance: ChannelInstance;
  readonly completion: Promise<ChannelCompletion>;
  stopStarted: boolean;
}

export interface PreparedUnitChannels {
  readonly unit: StagedRegistryUnit;
  readonly accepted: boolean;
  readonly bindings: readonly ChannelRuntimeBinding[];
  readonly records: readonly PreparedChannelRecord[];
  readonly diagnostics: readonly RegistryStartupDiagnostic[];
  readonly completions: ReadonlyMap<string, Promise<ChannelCompletion>>;
  activateIngress(): void;
  deactivateIngress(): void;
}

type ActivationResult = PreparedUnitChannels;

export async function prepareStagedUnitChannels(params: {
  readonly unit: StagedRegistryUnit;
  readonly host: ChannelRuntimeHost;
  readonly instanceIdPrefix?: string;
}): Promise<PreparedUnitChannels> {
  return activateUnit(params.unit, params.host, new Map(), params.instanceIdPrefix);
}

export async function recheckPreparedUnitChannels(
  prepared: PreparedUnitChannels,
): Promise<PreparedUnitChannels> {
  if (!prepared.accepted) return prepared;
  for (const record of prepared.records) {
    const completion = await settledValue(record.completion);
    if (!completion) continue;
    return rollbackCompletedBeforeHandoff(
      prepared,
      { record, completion },
      new Map(prepared.completions),
    );
  }
  return prepared;
}

async function activateUnit(
  unit: StagedRegistryUnit,
  host: ChannelRuntimeHost,
  completionById: Map<string, Promise<ChannelCompletion>>,
  instanceIdPrefix?: string,
): Promise<ActivationResult> {
  const ingressGate = { active: false };
  const activateIngress = (): void => { ingressGate.active = true; };
  const deactivateIngress = (): void => { ingressGate.active = false; };
  if (unit.channels.length === 0) {
    return {
      unit,
      accepted: true,
      bindings: [],
      records: [],
      diagnostics: [],
      completions: completionById,
      activateIngress,
      deactivateIngress,
    };
  }

  const records: PreparedChannelRecord[] = [];
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
      const record: PreparedChannelRecord = {
        id: contribution.id,
        instanceId: instanceIdPrefix
          ? `${instanceIdPrefix}:channel:${contribution.id}`
          : `channel:${contribution.id}`,
        unitId: unit.unit.id,
        source: unit.unit.source,
        instance,
        completion: instance.completion,
        stopStarted: false,
      };
      records.push(record);
      completionById.set(contribution.id, instance.completion);
      const binding = bindInstance(instance, host, ingressGate);
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
      completions: completionById,
      activateIngress,
      deactivateIngress,
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
    completions: completionById,
    activateIngress,
    deactivateIngress,
  };
}

async function rollbackCompletedBeforeHandoff(
  result: ActivationResult,
  failure: {
    readonly record: PreparedChannelRecord;
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
    completions: completionById,
    activateIngress: result.activateIngress,
    deactivateIngress: result.deactivateIngress,
  };
}

function waitForReadinessOrFirstFailure(
  records: readonly PreparedChannelRecord[],
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
  ingressGate: { readonly active: boolean },
): ChannelRuntimeBinding {
  const interaction = normalizeInteraction(instance);
  const binding: ChannelRuntimeBinding = Object.freeze({
    id: instance.id,
    send: (event: AgentEvent) => instance.send(event),
    ...(interaction ? { interaction } : {}),
  });

  instance.onMessage((request) => ingressGate.active
    ? host.onMessage(binding, request)
    : Promise.reject(new Error(`Channel "${instance.id}" ingress is not published.`)));
  if (instance.interaction) {
    instance.interaction.onInteractionResponse((response) => {
      if (ingressGate.active) host.onInteractionResponse(response);
    });
    instance.interaction.onInteractionUnavailable((id, reason) => {
      if (ingressGate.active) host.onInteractionUnavailable(id, reason);
    });
  }
  instance.bindRuntimeCapabilities?.(host.capabilities);
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
