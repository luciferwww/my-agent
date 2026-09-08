import type { ProviderProjectionEntry } from '../core/model-resolution/index.js';
import type {
  ExtensionRegistrationApi,
  HookBinding,
  HookContribution,
  HookProjection,
  RegistrySnapshot,
  RegistryStartupDiagnostic,
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

export interface BuildRegistrySnapshotParams {
  readonly providers: readonly ProviderProjectionEntry[];
  readonly units: readonly RuntimeContributionUnit[];
}

interface StagedUnit {
  readonly unit: RuntimeContributionUnit;
  readonly tools: Tool[];
  readonly hooks: HookContribution[];
}

export function buildRegistrySnapshot(
  params: BuildRegistrySnapshotParams,
): RegistrySnapshot {
  const acceptedUnitIds = new Set<string>();
  const acceptedToolIds = new Set<string>();
  const acceptedHookIds = new Set<string>();
  const resolvedTools: ResolvedTool[] = [];
  const hookBindings: HookBinding[] = [];
  const diagnostics: RegistryStartupDiagnostic[] = [];

  for (const unit of sortUnits(params.units)) {
    try {
      const staged = stageUnit(unit);
      assertNoAcceptedConflicts(staged, acceptedUnitIds, acceptedToolIds, acceptedHookIds);

      acceptedUnitIds.add(unit.id);
      for (const tool of staged.tools) {
        const validator = compilePortableToolSchema(tool.inputSchema);
        const definition: ToolDefinition = Object.freeze({
          name: tool.name,
          description: tool.description,
          inputSchema: validator.schema,
        });
        resolvedTools.push(Object.freeze({
          unitId: unit.id,
          definition,
          validator,
          execute: tool.execute,
        }));
        acceptedToolIds.add(tool.name);
      }
      for (const contribution of staged.hooks) {
        hookBindings.push(Object.freeze({
          unitId: unit.id,
          contributionId: contribution.id,
          hookName: contribution.hookName,
          priority: contribution.priority ?? 0,
          handler: contribution.handler,
        }) as HookBinding);
        acceptedHookIds.add(hookIdentity(contribution.hookName, contribution.id));
      }
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
        code: isConflictError(error) ? 'UNIT_CONFLICT' : 'UNIT_INVALID',
        message: messageOf(error),
      }));
    }
  }

  const tools = createToolProjection(resolvedTools);
  const hooks = createHookProjection(hookBindings);
  return Object.freeze({
    id: 'startup:1',
    providers: Object.freeze([...params.providers]),
    tools,
    hooks,
    diagnostics: Object.freeze(diagnostics),
  });
}

function stageUnit(unit: RuntimeContributionUnit): StagedUnit {
  assertIdentity(unit.id, 'unit');
  const tools: Tool[] = [];
  const hooks: HookContribution[] = [];
  const localToolIds = new Set<string>();
  const localHookIds = new Set<string>();

  const api: ExtensionRegistrationApi = Object.freeze({
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
  });

  unit.register(api);
  return { unit, tools, hooks };
}

function assertTool(tool: Tool): void {
  assertIdentity(tool.name, 'Tool');
  if (typeof tool.description !== 'string' || tool.description.trim() === '') {
    throw new RegistryBuildError(`Tool "${tool.name}" must have a non-empty description.`);
  }
  if (typeof tool.execute !== 'function') {
    throw new RegistryBuildError(`Tool "${tool.name}" must provide execute().`);
  }
  // Compile during staging so a unit cannot partially publish valid Tools.
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

function assertNoAcceptedConflicts(
  staged: StagedUnit,
  unitIds: ReadonlySet<string>,
  toolIds: ReadonlySet<string>,
  hookIds: ReadonlySet<string>,
): void {
  if (unitIds.has(staged.unit.id)) {
    throw conflict(`Duplicate unit identity "${staged.unit.id}".`);
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

function sortUnits(units: readonly RuntimeContributionUnit[]): RuntimeContributionUnit[] {
  return [...units].sort((left, right) => {
    if (left.source !== right.source) return left.source === 'builtin' ? -1 : 1;
    return compareOrdinal(left.orderKey ?? left.id, right.orderKey ?? right.id)
      || compareOrdinal(left.id, right.id);
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

function isConflictError(error: unknown): boolean {
  return error instanceof RegistryBuildError && 'conflict' in error;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
