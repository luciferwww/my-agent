import type { ProviderProjectionEntry } from '../model-resolution/index.js';
import type {
  ApplicationToolPolicy,
  Tool,
  ToolDefinition,
} from '../tools/types.js';
import type { CompiledToolInputValidator } from '../tools/portable-schema.js';
import type {
  HookHandlerMap,
  HookName,
} from '../runner/hooks/types.js';

export type ContributionSource = 'builtin' | 'external';

export interface HookContribution<K extends HookName = HookName> {
  readonly id: string;
  readonly hookName: K;
  readonly priority?: number;
  readonly handler: HookHandlerMap[K];
}

export interface ExtensionRegistrationApi {
  registerTool(tool: Tool): void;
  registerHook<K extends HookName>(contribution: HookContribution<K>): void;
}

export interface RuntimeContributionUnit {
  readonly id: string;
  readonly source: ContributionSource;
  /** Deterministic external acquisition key. Builtins use their stable id. */
  readonly orderKey?: string;
  register(api: ExtensionRegistrationApi): void;
}

export interface ResolvedTool {
  readonly unitId: string;
  readonly definition: ToolDefinition;
  readonly validator: CompiledToolInputValidator;
  readonly execute: Tool['execute'];
}

export interface ToolProjection {
  readonly definitions: readonly ToolDefinition[];
  resolve(name: string): ResolvedTool | undefined;
  visibleDefinitions(policy: ApplicationToolPolicy): readonly ToolDefinition[];
}

export interface HookBinding<K extends HookName = HookName> {
  readonly unitId: string;
  readonly contributionId: string;
  readonly hookName: K;
  readonly priority: number;
  readonly handler: HookHandlerMap[K];
}

export interface HookProjection {
  readonly beforeToolCall: readonly HookBinding<'before_tool_call'>[];
  readonly afterToolCall: readonly HookBinding<'after_tool_call'>[];
  readonly beforeCompaction: readonly HookBinding<'before_compaction'>[];
  readonly afterCompaction: readonly HookBinding<'after_compaction'>[];
}

export interface RegistryStartupDiagnostic {
  readonly unitId: string;
  readonly source: ContributionSource;
  readonly code: 'UNIT_INVALID' | 'UNIT_CONFLICT';
  readonly message: string;
}

export interface RegistrySnapshot {
  readonly id: string;
  readonly providers: readonly ProviderProjectionEntry[];
  readonly tools: ToolProjection;
  readonly hooks: HookProjection;
  readonly diagnostics: readonly RegistryStartupDiagnostic[];
}
