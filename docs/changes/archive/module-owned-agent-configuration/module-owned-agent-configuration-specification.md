# Module-owned Agent Configuration Specification

> Status: Implemented, Validated, and Accepted
> Date: 2026-09-23
> Owner: Project owner
> Related Plan: [Module-owned Agent Configuration and Defaults Plan](plan.md)
> Authorization: Delivery authorized by project owner on 2026-09-23.

## 1. Purpose

Define one configuration ownership boundary for all modules while preserving
the current external Agent configuration contract.

## 2. Ownership rule

For a configuration leaf `L`, its owning module must own:

1. the public TypeScript contract for `L`;
2. the complete behavioral default for `L`;
3. semantic validation that depends on `L`'s meaning;
4. normalization specific to `L`;
5. runtime interpretation of `L`;
6. focused contract and behavior tests.

Platform Configuration owns:

1. physical `config.json` bootstrap and strict read;
2. top-level namespace recognition;
3. document and Application composition types;
4. `agents.defaults` and `agents.list[]` merge precedence;
5. generic deep merge;
6. environment extraction;
7. credential materialization;
8. immutable projection assembly;
9. translation of owner validation failures into bounded configuration
   diagnostics without changing owner semantics.

An owner must not import Platform Configuration. Dependency direction is:

```text
Platform Configuration -> leaf module contract
Runtime composition     -> resolved leaf projections
leaf module             -X-> Platform Configuration
```

## 3. Preserved external document

The accepted top-level namespaces remain:

```text
llm
runtime
runner
agents
logger
extensions
```

The Agent section remains:

```ts
interface AgentsConfigDocument {
  readonly defaults?: DeepPartial<AgentDefaults>;
  readonly list?: readonly AgentEntry[];
}

interface AgentEntry extends DeepPartial<AgentDefaults> {
  readonly id: string;
  readonly default?: boolean;
}
```

`AgentDefaults` remains a Platform-owned composition contract, but its fields
must reference owner-exported leaf contracts:

```ts
interface AgentDefaults {
  readonly memory: MemoryConfig;
  readonly prompt: PromptConfig;
  readonly tools: ToolPolicyConfig;
  readonly context: AgentContextConfig;
  readonly compaction: CompactionConfig;
  readonly subagents: SubagentConfig;
}
```

This Change does not rename JSON fields or move Runtime/Runner policy under an
Agent.

## 4. Module contracts

Each owner exports a contract and immutable default:

```ts
export interface MemoryConfig { /* existing fields */ }
export const DEFAULT_MEMORY_CONFIG: Readonly<MemoryConfig>;

export interface PromptConfig { /* existing fields */ }
export const DEFAULT_PROMPT_CONFIG: Readonly<PromptConfig>;

export interface ToolPolicyConfig { /* existing fields */ }
export const DEFAULT_TOOL_POLICY_CONFIG: Readonly<ToolPolicyConfig>;

export interface AgentContextConfig { /* existing fields */ }
export const DEFAULT_AGENT_CONTEXT_CONFIG: Readonly<AgentContextConfig>;

export interface CompactionConfig { /* existing fields */ }
export const DEFAULT_COMPACTION_CONFIG: Readonly<CompactionConfig>;

export interface SubagentConfig { /* existing fields */ }
export const DEFAULT_SUBAGENT_CONFIG: Readonly<SubagentConfig>;

export interface LoggerConfig { /* existing fields */ }
export const DEFAULT_LOGGER_CONFIG: Readonly<LoggerConfig>;
```

Exact filenames may follow existing package conventions, but each public
contract/default must be exported from its owner package index. Platform may
re-export a type; it may not redefine it.

Defaults must be deeply immutable at the owner boundary. Consumers that merge
configuration must clone before mutation and deeply freeze the final
projection.

## 5. Default composition

`src/platform/config/defaults.ts` must be removed. Platform Configuration
replaces it with a composition function, not a second default authority:

```ts
function createDefaultAgentConfig(): AgentDefaults {
  return {
    memory: structuredClone(DEFAULT_MEMORY_CONFIG),
    prompt: structuredClone(DEFAULT_PROMPT_CONFIG),
    tools: structuredClone(DEFAULT_TOOL_POLICY_CONFIG),
    context: structuredClone(DEFAULT_AGENT_CONTEXT_CONFIG),
    compaction: structuredClone(DEFAULT_COMPACTION_CONFIG),
    subagents: structuredClone(DEFAULT_SUBAGENT_CONFIG),
  };
}
```

The function may be internal to the loader or live in a composition-named
Platform file. It must not contain leaf default literals.

Platform imports `DEFAULT_LOGGER_CONFIG` directly from Platform Logger.
Runtime Bootstrap's direct-library fallback uses the same Platform composition
function; it must not import or rebuild leaf defaults separately.

`DEFAULT_AGENT_CONFIG` is retired as a mutable exported object. Tests and
callers use the composition function or owner constants according to the
boundary they exercise.

## 6. Validation

### Platform validation

Platform validates only composition concerns:

- root is an object;
- top-level namespaces are known;
- document sections have the required broad JSON shape;
- Agent identity/default metadata is valid;
- merge inputs are structurally composable;
- exact environment credential references can be materialized.

### Owner validation

Owners validate leaf semantics, including:

- supported enum values;
- integer/range constraints;
- cross-field invariants;
- duplicate identities within a leaf list;
- empty-string and normalization rules;
- values that cannot be executed by the owner.

Owner validators return or throw owner-defined structured failures. Platform
maps them to the existing `AgentConfigError` category and exact document field
path. User-visible error classification must remain backward compatible unless
the current behavior accepts a value that cannot work.

## 7. Memory chunking

The existing public fields remain:

```ts
interface ChunkingConfig {
  readonly chunkChars: number;
  readonly overlapChars: number;
}
```

Required invariants:

- both values are positive safe integers;
- `overlapChars < chunkChars`;
- invalid values fail during configuration loading;
- Runtime passes the resolved chunking projection to Memory;
- `MemoryIndexer` uses the resolved values;
- direct Memory construction without an override uses
  `DEFAULT_MEMORY_CONFIG.chunking`;
- there is no private duplicate `DEFAULT_CHUNK_CHARS` or
  `DEFAULT_OVERLAP_CHARS`.

A behavioral test must prove that changing these fields changes produced chunk
boundaries. Merely asserting the projected object is insufficient.

## 8. Duplicate fallback policy

A fallback is allowed only when the module API is independently supported
without a resolved Application projection.

When allowed:

- it must reference the owner constant;
- it must not copy literal values;
- its tests must prove equality with owner defaults.

When callers always receive a complete resolved projection, local `??` or
literal fallback behavior must be removed. This applies to current duplicates
such as Prompt safety, Agent Context budgets, Compaction, Subagent enablement
and depth, and Logger level where the call boundary guarantees completeness.

## 9. Tool policy

The Tool policy owner defines:

```ts
interface ToolPolicyConfig {
  readonly allow?: readonly string[];
  readonly deny?: readonly string[];
}
```

Its default is empty allow and deny lists. It owns glob-pattern semantics and
validation. Runtime continues to combine this static policy with the live
Session permission mode. This Change does not alter final-deny precedence,
Manual mandatory Approval, or Allow All behavior.

## 10. Compaction

Runner Compaction owns the existing `CompactionConfig` and all of its default
values. Session persistence may consume trimming fields, but that consumption
does not transfer configuration ownership to Session.

Direct `AgentRunner.run()` calls that omit Compaction configuration use the
Runner-owned immutable default. Runtime-provided values and direct-call
fallback must therefore share one constant.

## 11. Logger

Platform Logger owns:

- `LoggerConfig` and nested adapter configuration contracts;
- default global level;
- default Console/File enablement;
- semantic validation of Logger levels and adapter fields.

Platform Configuration composes the `logger` namespace and maps validation
failures. Standalone Host continues to enforce the cross-module rule that CLI
and enabled Console Logger cannot both own terminal presentation.

## 12. Compatibility

The following are invariant:

- an empty `{}` document produces the same effective values;
- current valid explicit configurations remain valid;
- current invalid configurations remain invalid with equivalent bounded field
  attribution;
- top-level and per-Agent precedence is unchanged;
- resolved projections remain deeply frozen;
- Agent lists replace arrays under existing merge rules;
- Runtime and Runner remain global;
- Session permission state remains outside configuration.

The only intended behavior correction is that accepted configuration fields
must affect execution. `memory.chunking` becomes effective under its existing
public meaning.

## 13. Fitness constraints

Fitness tests must fail if:

- `src/platform/config/defaults.ts` exists;
- Platform Configuration defines one of the leaf interfaces;
- Platform Configuration contains reviewed leaf default literals;
- a leaf module imports `src/platform/config`;
- a duplicate private default appears for a migrated field;
- Runtime Bootstrap drops an accepted resolved leaf field;
- Memory chunking configuration lacks a behavioral test.

The test should prefer structural import/AST checks and bounded reviewed
literal checks rather than broad name matching that blocks unrelated code.

## 14. Acceptance scenarios

Validation must cover:

1. empty document default equivalence;
2. full explicit document equivalence;
3. per-Agent override precedence;
4. immutable owner defaults and immutable final projections;
5. owner validation with exact Platform field attribution;
6. Memory chunking behavioral effect;
7. direct Runner Compaction fallback;
8. Prompt and Agent Context default equivalence;
9. Subagent default enablement/depth;
10. Tool policy and Session permission behavior unchanged;
11. Logger defaults and CLI conflict unchanged;
12. direct Runtime construction without a Host snapshot;
13. absence of central leaf contracts/default literals;
14. dependency-direction Fitness checks.

## 15. Delivery gate

This Specification is accepted and Delivery is authorized. Closeout still
requires the validation and acceptance gates defined by the Plan.
