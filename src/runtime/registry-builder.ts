import type { ChannelContribution, ChannelRuntimeBinding } from '../core/channel/index.js';
import type { ProviderProjectionEntry } from '../core/model-resolution/index.js';
import type {
  ExtensionRegistrationApi,
  HookBinding,
  HookContribution,
  HookProjection,
  RegistrySnapshot,
  RegistryStartupDiagnostic,
  RegistryUnitProvenance,
  ResolvedTool,
  RuntimeContributionUnit,
  ToolProjection,
} from '../core/registry/index.js';
import type { HookName } from '../core/runner/hooks/types.js';
import { compilePortableToolSchema } from '../core/tools/portable-schema.js';
import type { ApplicationToolPolicy, Tool, ToolDefinition } from '../core/tools/types.js';

const CONTRIBUTION_ID = /^[A-Za-z0-9_-]{1,64}$/;

export class RegistryBuildError extends Error {
  readonly kind = 'registry_build_error' as const;
}

export interface StagedRegistryUnit {
  readonly unit: RuntimeContributionUnit;
  readonly providers: readonly ProviderProjectionEntry[];
  readonly tools: readonly Tool[];
  readonly hooks: readonly HookContribution[];
  readonly channels: readonly ChannelContribution[];
}

export interface RegistryCandidate {
  readonly providers: readonly ProviderProjectionEntry[];
  readonly units: readonly StagedRegistryUnit[];
  readonly diagnostics: readonly RegistryStartupDiagnostic[];
}

export interface ResolveStagedRegistryCandidateParams {
  readonly providers: readonly ProviderProjectionEntry[];
  readonly units: readonly StagedRegistryUnit[];
  readonly diagnostics?: readonly RegistryStartupDiagnostic[];
}

export function resolveStagedRegistryCandidate(
  params: ResolveStagedRegistryCandidateParams,
): RegistryCandidate {
  const acceptedUnitIds = new Set<string>();
  const acceptedProviderIds = new Set<string>();
  const acceptedToolIds = new Set<string>();
  const acceptedHookIds = new Set<string>();
  const acceptedChannelIds = new Set<string>();
  const units: StagedRegistryUnit[] = [];
  const diagnostics: RegistryStartupDiagnostic[] = [...(params.diagnostics ?? [])];

  for (const staged of sortStagedUnits(params.units)) {
    const unit = staged.unit;
    try {
      assertNoAcceptedConflicts(
        staged,
        acceptedUnitIds,
        acceptedProviderIds,
        acceptedToolIds,
        acceptedHookIds,
        acceptedChannelIds,
      );
      acceptedUnitIds.add(unit.id);
      for (const provider of staged.providers) acceptedProviderIds.add(provider.id);
      for (const tool of staged.tools) acceptedToolIds.add(tool.name);
      for (const hook of staged.hooks) {
        acceptedHookIds.add(hookIdentity(hook.hookName, hook.id));
      }
      for (const channel of staged.channels) acceptedChannelIds.add(channel.id);
      units.push(staged);
    } catch (error) {
      if (unit.source === 'builtin') {
        throw new RegistryBuildError(
          `Builtin unit "${unit.id}" is invalid: ${messageOf(error)}`,
          { cause: error },
        );
      }
      diagnostics.push(Object.freeze({
        unitId: unit.id,
        source: unit.source,
        code: 'UNIT_CONFLICT',
        message: messageOf(error),
      }));
    }
  }

  return Object.freeze({
    providers: Object.freeze([...params.providers]),
    units: Object.freeze(units),
    diagnostics: Object.freeze(diagnostics),
  });
}

export function finalizeRegistrySnapshot(params: {
  readonly candidate: RegistryCandidate;
  readonly acceptedUnits: readonly StagedRegistryUnit[];
  readonly channelBindings: readonly ChannelRuntimeBinding[];
  readonly generation: number;
  readonly diagnostics?: readonly RegistryStartupDiagnostic[];
  readonly provenance?: readonly RegistryUnitProvenance[];
}): RegistrySnapshot {
  const resolvedTools: ResolvedTool[] = [];
  const hookBindings: HookBinding[] = [];
  const providers = [...params.candidate.providers];

  for (const staged of params.acceptedUnits) {
    providers.push(...staged.providers);
    for (const tool of staged.tools) {
      const validator = compilePortableToolSchema(tool.inputSchema);
      const definition: ToolDefinition = Object.freeze({
        name: tool.name,
        description: tool.description,
        inputSchema: validator.schema,
      });
      resolvedTools.push(Object.freeze({
        unitId: staged.unit.id,
        definition,
        validator,
        execute: tool.execute,
      }));
    }
    for (const contribution of staged.hooks) {
      hookBindings.push(Object.freeze({
        unitId: staged.unit.id,
        contributionId: contribution.id,
        hookName: contribution.hookName,
        priority: contribution.priority ?? 0,
        handler: contribution.handler,
      }) as HookBinding);
    }
  }

  if (!Number.isSafeInteger(params.generation) || params.generation < 1) {
    throw new RegistryBuildError(
      `Registry generation must be a positive safe integer. Received: ${params.generation}`,
    );
  }
  const provenance = params.provenance ?? params.acceptedUnits.map((staged) => ({
    unitId: staged.unit.id,
    instanceId: staged.unit.id,
    source: staged.unit.source,
    orderKey: staged.unit.orderKey ?? staged.unit.id,
    dependencies: Object.freeze([]),
  }));
  const acceptedUnitIds = params.acceptedUnits.map((staged) => staged.unit.id).sort(compareOrdinal);
  const provenanceUnitIds = provenance.map((entry) => entry.unitId).sort(compareOrdinal);
  if (acceptedUnitIds.length !== provenanceUnitIds.length
    || acceptedUnitIds.some((unitId, index) => unitId !== provenanceUnitIds[index])) {
    throw new RegistryBuildError('Registry provenance must match the accepted Unit set.');
  }

  return Object.freeze({
    generation: params.generation,
    units: Object.freeze(provenance.map((entry) => Object.freeze({
        ...entry,
        dependencies: Object.freeze([...entry.dependencies]),
      }))),
    providers: Object.freeze(providers),
    tools: createToolProjection(resolvedTools),
    hooks: createHookProjection(hookBindings),
    channels: createChannelProjection(params.channelBindings),
    diagnostics: Object.freeze([
      ...params.candidate.diagnostics,
      ...(params.diagnostics ?? []),
    ]),
  });
}

export function stageRegistryUnit(unit: RuntimeContributionUnit): StagedRegistryUnit {
  assertIdentity(unit.id, 'unit');
  const tools: Tool[] = [];
  const hooks: HookContribution[] = [];
  const channels: ChannelContribution[] = [];
  const providers: ProviderProjectionEntry[] = [];
  const localProviderIds = new Set<string>();
  const localToolIds = new Set<string>();
  const localHookIds = new Set<string>();
  const localChannelIds = new Set<string>();

  const api: ExtensionRegistrationApi = Object.freeze({
    registerProvider(provider: ProviderProjectionEntry): void {
      const normalized = normalizeProvider(provider);
      if (localProviderIds.has(normalized.id)) {
        throw new RegistryBuildError(
          `Duplicate Provider contribution "${normalized.id}" in unit "${unit.id}".`,
        );
      }
      localProviderIds.add(normalized.id);
      providers.push(normalized);
    },
    registerTool(tool: Tool): void {
      assertTool(tool);
      if (localToolIds.has(tool.name)) {
        throw new RegistryBuildError(`Duplicate Tool contribution "${tool.name}" in unit "${unit.id}".`);
      }
      localToolIds.add(tool.name);
      tools.push(tool);
    },
    registerHook<K extends HookName>(contribution: HookContribution<K>): void {
      assertHook(contribution);
      const identity = hookIdentity(contribution.hookName, contribution.id);
      if (localHookIds.has(identity)) {
        throw new RegistryBuildError(`Duplicate Hook contribution "${contribution.id}" in unit "${unit.id}".`);
      }
      localHookIds.add(identity);
      hooks.push(contribution as HookContribution);
    },
    registerChannel(contribution: ChannelContribution): void {
      assertChannel(contribution);
      if (localChannelIds.has(contribution.id)) {
        throw new RegistryBuildError(`Duplicate Channel contribution "${contribution.id}" in unit "${unit.id}".`);
      }
      localChannelIds.add(contribution.id);
      channels.push(Object.freeze(contribution));
    },
  });

  unit.register(api);
  return Object.freeze({
    unit,
    providers: Object.freeze(providers),
    tools: Object.freeze(tools),
    hooks: Object.freeze(hooks),
    channels: Object.freeze(channels),
  });
}

function normalizeProvider(provider: ProviderProjectionEntry): ProviderProjectionEntry {
  assertIdentity(provider.id, 'Provider');
  if (typeof provider.protocol !== 'string' || provider.protocol.trim() === '') {
    throw new RegistryBuildError(`Provider "${provider.id}" must have a non-empty protocol.`);
  }
  if (typeof provider.resolveConnection !== 'function') {
    throw new RegistryBuildError(`Provider "${provider.id}" must provide resolveConnection().`);
  }
  if (typeof provider.resolveModel !== 'function') {
    throw new RegistryBuildError(`Provider "${provider.id}" must provide resolveModel().`);
  }
  if (!Array.isArray(provider.models)) {
    throw new RegistryBuildError(`Provider "${provider.id}" must publish a model Catalog.`);
  }
  const modelIds = new Set<string>();
  const models = provider.models.map((model) => {
    if (!model || typeof model !== 'object') {
      throw new RegistryBuildError(`Provider "${provider.id}" published an invalid model entry.`);
    }
    assertIdentity(model.modelId, 'Model');
    if (modelIds.has(model.modelId)) {
      throw new RegistryBuildError(
        `Provider "${provider.id}" published duplicate model "${model.modelId}".`,
      );
    }
    modelIds.add(model.modelId);
    if (model.displayName !== undefined
      && (typeof model.displayName !== 'string' || model.displayName.trim() === '')) {
      throw new RegistryBuildError(
        `Provider "${provider.id}" model "${model.modelId}" has an invalid display name.`,
      );
    }
    return Object.freeze({
      modelId: model.modelId,
      ...(model.displayName !== undefined ? { displayName: model.displayName } : {}),
    });
  });
  if (provider.displayName !== undefined
    && (typeof provider.displayName !== 'string' || provider.displayName.trim() === '')) {
    throw new RegistryBuildError(`Provider "${provider.id}" has an invalid display name.`);
  }
  return Object.freeze({
    id: provider.id,
    ...(provider.displayName !== undefined ? { displayName: provider.displayName } : {}),
    models: Object.freeze(models),
    protocol: provider.protocol,
    invocationPort: provider.invocationPort,
    resolveConnection: provider.resolveConnection,
    resolveModel: provider.resolveModel,
  });
}

function assertTool(tool: Tool): void {
  assertIdentity(tool.name, 'Tool');
  if (typeof tool.description !== 'string' || tool.description.trim() === '') {
    throw new RegistryBuildError(`Tool "${tool.name}" must have a non-empty description.`);
  }
  if (typeof tool.execute !== 'function') {
    throw new RegistryBuildError(`Tool "${tool.name}" must provide execute().`);
  }
  compilePortableToolSchema(tool.inputSchema);
}

function assertHook(contribution: HookContribution): void {
  assertIdentity(contribution.id, 'Hook');
  if (!isHookName(contribution.hookName)) {
    throw new RegistryBuildError(`Hook "${contribution.id}" has an unknown kind.`);
  }
  if (typeof contribution.handler !== 'function') {
    throw new RegistryBuildError(`Hook "${contribution.id}" must provide a handler.`);
  }
  const priority = contribution.priority ?? 0;
  if (!Number.isSafeInteger(priority)) {
    throw new RegistryBuildError(`Hook "${contribution.id}" priority must be a safe integer.`);
  }
}

function assertChannel(contribution: ChannelContribution): void {
  assertIdentity(contribution.id, 'Channel');
  if (typeof contribution.create !== 'function') {
    throw new RegistryBuildError(`Channel "${contribution.id}" must provide create().`);
  }
}

function assertNoAcceptedConflicts(
  staged: StagedRegistryUnit,
  unitIds: ReadonlySet<string>,
  providerIds: ReadonlySet<string>,
  toolIds: ReadonlySet<string>,
  hookIds: ReadonlySet<string>,
  channelIds: ReadonlySet<string>,
): void {
  if (unitIds.has(staged.unit.id)) {
    throw conflict(`Duplicate unit identity "${staged.unit.id}".`);
  }
  for (const provider of staged.providers) {
    if (providerIds.has(provider.id)) {
      throw conflict(`Provider contribution "${provider.id}" conflicts with an accepted unit.`);
    }
  }
  for (const tool of staged.tools) {
    if (toolIds.has(tool.name)) {
      throw conflict(`Tool contribution "${tool.name}" conflicts with an accepted unit.`);
    }
  }
  for (const hook of staged.hooks) {
    const identity = hookIdentity(hook.hookName, hook.id);
    if (hookIds.has(identity)) {
      throw conflict(`Hook contribution "${identity}" conflicts with an accepted unit.`);
    }
  }
  for (const channel of staged.channels) {
    if (channelIds.has(channel.id)) {
      throw conflict(`Channel contribution "${channel.id}" conflicts with an accepted unit.`);
    }
  }
}

function createToolProjection(bindings: readonly ResolvedTool[]): ToolProjection {
  const byName = new Map(bindings.map((binding) => [binding.definition.name, binding]));
  const definitions = Object.freeze(bindings.map((binding) => binding.definition));
  return Object.freeze({
    definitions,
    resolve(name: string): ResolvedTool | undefined {
      return byName.get(name);
    },
    visibleDefinitions(policy: ApplicationToolPolicy): readonly ToolDefinition[] {
      return Object.freeze(definitions.filter((definition) => !policy.isDenied(definition.name)));
    },
  });
}

function createHookProjection(bindings: readonly HookBinding[]): HookProjection {
  const sorted = [...bindings].sort(compareHooks);
  return Object.freeze({
    beforeToolCall: byKind(sorted, 'before_tool_call'),
    afterToolCall: byKind(sorted, 'after_tool_call'),
    beforeCompaction: byKind(sorted, 'before_compaction'),
    afterCompaction: byKind(sorted, 'after_compaction'),
  });
}

function createChannelProjection(
  bindings: readonly ChannelRuntimeBinding[],
) {
  const frozen = Object.freeze([...bindings]);
  const byId = new Map(frozen.map((binding) => [binding.id, binding]));
  return Object.freeze({
    bindings: frozen,
    resolve(id: string): ChannelRuntimeBinding | undefined {
      return byId.get(id);
    },
  });
}

function byKind<K extends HookName>(
  bindings: readonly HookBinding[],
  hookName: K,
): readonly HookBinding<K>[] {
  return Object.freeze(bindings.filter(
    (binding): binding is HookBinding<K> => binding.hookName === hookName,
  ));
}

function compareHooks(left: HookBinding, right: HookBinding): number {
  return right.priority - left.priority
    || compareOrdinal(left.unitId, right.unitId)
    || compareOrdinal(left.contributionId, right.contributionId);
}

function sortStagedUnits(units: readonly StagedRegistryUnit[]): StagedRegistryUnit[] {
  return [...units].sort((left, right) => {
    if (left.unit.source !== right.unit.source) {
      return left.unit.source === 'builtin' ? -1 : 1;
    }
    return compareOrdinal(
      left.unit.orderKey ?? left.unit.id,
      right.unit.orderKey ?? right.unit.id,
    ) || compareOrdinal(left.unit.id, right.unit.id);
  });
}

function assertIdentity(identity: string, kind: string): void {
  if (!CONTRIBUTION_ID.test(identity)) {
    throw new RegistryBuildError(`${kind} identity "${identity}" must match ${CONTRIBUTION_ID.source}.`);
  }
}

function hookIdentity(hookName: HookName, hookId: string): string {
  return `${hookName}:${hookId}`;
}

function isHookName(value: unknown): value is HookName {
  return value === 'before_tool_call'
    || value === 'after_tool_call'
    || value === 'before_compaction'
    || value === 'after_compaction';
}

function compareOrdinal(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function conflict(message: string): RegistryBuildError {
  const error = new RegistryBuildError(message);
  Object.defineProperty(error, 'conflict', { value: true });
  return error;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
