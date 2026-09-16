# ADR-007: Builtin Capability Source Ownership and Layout

> Status: Accepted
> Decision status: Accepted
> Decision date: 2026-09-15
> Owner: Project owner
> Authority: Durable decision
> Related Plan: [Source Layout Refactoring Migration Plan](../changes/archive/source-layout-refactoring/plan.md)
> Decision input: temporary design comparison deleted after authority transfer
> Supersedes: None; refines builtin source ownership and naming without changing [ADR-005](adr-005-extension-registry-runtime-composition.md)
> Partially superseded by: [ADR-012](adr-012-agent-home-path-unification.md) for the Workspace-to-Environment Tool package, factory, contribution, and Unit identity rename; other source-ownership decisions remain accepted

## Context

[ADR-005](adr-005-extension-registry-runtime-composition.md) establishes one Runtime Unit staging, publication, lifecycle, Reload, retirement, and stop path for Builtin and External capabilities. At this decision's acceptance, the source tree followed that runtime mechanism, but its physical ownership was difficult to read:

- concrete Anthropic protocol and Provider code is separated from its required builtin Runtime Unit entry;
- concrete CLI/WebSocket Channels are separated from their Runtime Unit entries;
- concrete builtin Tools are owned partly by Core and registered through a mixed `runtime-modules` directory;
- Provider, Channel, and Tool factories share one horizontal barrel even though they are different capability families;
- `Module` names are used for objects whose actual contracts are `LoadedRuntimeUnit` or `RuntimeContributionUnit`.

The problem is source discoverability and ownership, not a missing runtime abstraction. Renaming `runtime-modules` to another horizontal bucket would leave each capability split across distant directories. Rebuilding the Runtime lifecycle or introducing a second composition mechanism would violate existing authority.

A durable decision is required because the target changes module ownership, dependency classification, canonical source paths, and naming rules. The physical migration remains governed by the related Plan.

This ADR authorized the target ownership and dependency rules without asserting convergence at acceptance time. The migration has since completed and validated; Current Architecture and current Fitness remain implementation-fact authority.

## Decision drivers

- Make each concrete builtin capability and its Host entry discoverable together.
- Keep provider-neutral contracts and application behavior independent of concrete SDKs and transports.
- Preserve Runtime as the sole generic Unit lifecycle and composition authority.
- Preserve the single shared lifecycle path for Builtin and External Units.
- Make filenames and primary symbols describe their actual protocol, capability, and return contract.
- Keep Provider, Channel, and Tool capability families distinct without another mixed horizontal bucket.
- Enforce the target through path-based Architecture Fitness rules.
- Complete migration without forwarding barrels, duplicate construction, or permanent Compatibility.
- Preserve all stable identities and observable behavior.

## Options considered

1. **Vertically grouped builtin capabilities:** place concrete builtin Providers, Channels, and Tools under `src/builtins/`, with each capability's implementation, Host entry, public surface, and tests colocated. This has the highest migration cost but provides the clearest ownership and navigation.
2. **Integration and Feature separation:** place protocols/transports under `src/integrations/` and application-native capabilities under `src/features/`. This makes one semantic distinction explicit but introduces a permanent Integration-versus-Feature classification rule and distributes builtin ownership across two roots.
3. **Strict horizontal layers with explicit Composition:** retain concrete code under Adapter/Core roots and replace `runtime-modules` with `composition/builtin-units`. This is the smallest move but preserves cross-directory navigation and recreates the mixed assembly bucket under a more accurate name.

## Decision

Choose option 1: vertically grouped builtin capabilities.

### Source ownership

The canonical target roots are:

```text
src/builtins/providers/
src/builtins/channels/
src/builtins/tools/
```

Each capability package owns its concrete implementation, package-local Host entry, explicit public surface, and colocated tests. The initial packages are:

```text
src/builtins/providers/anthropic/
src/builtins/channels/cli/
src/builtins/channels/websocket/
src/builtins/tools/workspace/
src/builtins/tools/memory/
src/builtins/tools/task/
```

Ownership remains separated as follows:

- Core owns provider-neutral/domain contracts, application behavior, and Ports.
- Runtime owns generic Unit contracts, Catalog, staging, generation, publication, lifecycle, Reload, retirement, and stop coordination.
- Builtin capability packages own concrete application-delivered Providers, Channels, and Tools.
- Extensions own externally acquired Units and do not depend on concrete Builtins.
- Composition code may assemble concrete Builtins, but generic Runtime and application logic do not gain concrete capability branches.

`src/builtins/` is a delivery/ownership root, not a new runtime framework, Extension mechanism, generic utility layer, or Service Locator.

### Dependency direction

The target must preserve these rules:

1. Domain/Application and Core contract surfaces must not import `src/builtins/`.
2. Concrete builtin implementations may depend on Core-owned contracts and Ports, but Core must not depend on those implementations.
3. A capability's `runtime-unit.ts` or `contribution.ts` may depend on its concrete implementation, Core Registry contracts, and the generic Runtime Unit contract needed for assembly.
4. Runtime Composition may import capability public entries; generic Runtime lifecycle, Runner, and Turn application logic must not import concrete capability implementations.
5. External Extensions and extension acquisition must not depend on `src/builtins/`.
6. The Anthropic SDK may be imported only by the Anthropic builtin Provider package.
7. The `ws` SDK may be imported only by the WebSocket builtin Channel package.
8. Shared Runtime mechanisms and unrelated utilities must not move into `src/builtins/` merely because Builtins consume them.
9. Package-internal implementation files must not import their own Composition-classified barrel to reach sibling implementation code.

### Host entries and lifecycle boundaries

Provider and Channel factories return `LoadedRuntimeUnit`; their package-local Host entry is named `runtime-unit.ts`, and their factory uses a `*Unit` name.

Tool factories return `RuntimeContributionUnit`; their package-local Host entry is named `contribution.ts`, and their factory uses a `*Contribution` name. Runtime Builder remains responsible for wrapping those contributions with `createLoadedRuntimeUnit()`.

The move must preserve the current Tool lifecycle policies:

| Contribution identity | Creation condition | Runtime wrapping policy |
|---|---|---|
| `builtin-workspace-tools` | Always | required and initially enabled |
| `builtin-memory-tools` | When `MemoryManager` exists | required and initially enabled |
| `builtin-subagent-tools` | When Subagents are not explicitly disabled | required and initially enabled |

Implementation subdirectories such as filesystem, search, web, process, memory, and task do not create new lifecycle boundaries. Splitting or merging existing Units requires a separate accepted architecture decision.

Builtin and External Units continue through the same Runtime create, staging, validation, publication, retirement, and stop path defined by ADR-005.

### Naming contract

Names must expose the actual responsibility and return contract.

The ownership roots, Host-entry vocabulary, and primary capability names below are durable parts of this decision because they resolve the ambiguity that triggered the Change. The mutable old-path-to-target-path inventory, test disposition, caller list, and migration order remain Plan controls rather than ADR policy.

For the Anthropic-compatible Provider package:

| Current name | Canonical target name |
|---|---|
| `AnthropicClient.ts` / `AnthropicClient` | `AnthropicMessagesClient.ts` / `AnthropicMessagesClient` |
| `AnthropicProvider.ts` / `AnthropicProvider` | `AnthropicCompatibleProvider.ts` / `AnthropicCompatibleProvider` |
| `anthropic-provider.ts` | `runtime-unit.ts` |
| `createAnthropicProviderModule()` | `createAnthropicProviderUnit()` |
| `ANTHROPIC_PROVIDER_MODULE_ID` | `ANTHROPIC_PROVIDER_UNIT_ID` |
| `AnthropicProviderModuleOptions` | `AnthropicProviderUnitOptions` |

Channel factories become `createCliChannelUnit()` and `createWebSocketChannelUnit()` in their respective `runtime-unit.ts` files.

Tool factories become `createWorkspaceToolsContribution()`, `createMemoryToolsContribution()`, and `createTaskToolContribution()` in package-local `contribution.ts` files. Concrete Tool filenames include `-tool` when the file's primary responsibility is implementing one Tool; helper filenames continue to describe their specific responsibility.

Primary class/type files use the same PascalCase name as their primary symbol. Package-local responsibility files use lowercase kebab-case. New ambiguous names such as `module.ts`, `manager.ts`, `handler.ts`, or `utils.ts` are prohibited unless the file has narrower capability context and that term precisely describes its responsibility.

Stable identity strings are not renamed. This includes `builtin-anthropic-provider`, `anthropic-compatible`, all existing Channel/Unit identities, and all existing Tool contribution identities.

### Package public surfaces and Fitness classification

A package `index.ts` contains explicit exports only. It performs no construction, registration, configuration loading, or other behavior, and it must not use broad exports that unintentionally widen the package surface.

Architecture Fitness classifies files by responsibility rather than treating all of `src/builtins/` as one logical layer:

| File responsibility | Logical boundary |
|---|---|
| Concrete Provider, Channel, or Tool implementation | Infrastructure |
| `runtime-unit.ts` or `contribution.ts` | Composition |
| Implementation-only barrel | Infrastructure |
| Barrel exporting a Runtime Unit or Runtime Contribution entry, including a mixed package public barrel | Composition |

The per-file migration map determines each barrel classification from its actual explicit exports. Core importing either Infrastructure or Composition remains forbidden. Package-local implementation imports use direct sibling implementation paths rather than a Composition-classified package barrel.

### Migration and Compatibility

Migration is performed capability by capability according to the related Plan. Each slice moves implementation and Host entry, updates real callers and tests, removes the old path, and runs focused validation in the same accepted change.

No old-path forwarding barrel, path alias, Feature Flag, duplicate factory, or second construction/registration path is introduced. Repository-internal callers move atomically with each capability. Completion deletes `src/runtime-modules/` and the replaced concrete Adapter/Core roots.

Rollback uses the Git capability-slice checkpoint. It does not retain a runtime dual path. If supported repository-external consumers are discovered before deletion, Delivery stops and requires an explicit Compatibility decision with owner, expiry, deletion conditions, and validation.

## Consequences

### Positive

- Concrete builtin implementation and Host assembly become discoverable as one capability package.
- `runtime-modules` is removed rather than renamed into another mixed bucket.
- Core and generic Runtime responsibilities remain independent of concrete SDKs and transports.
- Provider, Channel, and Tool entry names match their actual contracts.
- Architecture Fitness can distinguish concrete implementation from Composition within the builtin ownership root.
- New builtin capabilities have a consistent package shape without being misclassified as External Extensions.
- One authoritative Runtime Unit lifecycle path remains intact.

### Negative

- The migration touches many imports, tests, scripts, Fitness rules, and documentation evidence links.
- A vertical ownership root contains both Infrastructure and Composition files, so Fitness must classify file responsibility rather than only the top-level directory.
- Existing internal import names change without a forwarding facade.
- Package barrels require explicit review to prevent boundary widening or ambiguous classification.
- Source movement and semantic renaming must be coordinated to avoid temporary duplicate authority.

## Deliberately unchanged

This decision does not change:

- Runtime Unit contracts, staging, generation, publication, Reload, retirement, or stop behavior;
- Registry contribution contracts or Snapshot semantics;
- Provider Catalog, model facts, connection resolution, `resolveModel()`, or exact no-fallback behavior;
- Unit IDs, Contribution IDs, Provider IDs, required/optional policy, ordering, dependencies, or enablement semantics;
- Channel interaction, Tool schema, Tool execution, Memory, Subagent, error, cancellation, or resource ownership behavior;
- external Extension acquisition or ownership;
- public compatibility policy established by [ADR-006](adr-006-legacy-and-compatibility-exit.md).

If Delivery evidence requires any such change, implementation must stop and obtain a separate accepted decision or Specification update.

## Validation

Acceptance and Delivery evidence must establish that:

1. Core and generic Runtime application logic have no concrete Builtin dependency.
2. SDK imports occur only under their selected capability packages.
3. Runtime Builder assembles package entries without directly constructing concrete Provider, Channel, or Tool implementations.
4. Builtin and External Units still use the ADR-005 lifecycle path.
5. Existing Unit, Contribution, Provider, and Channel identities and lifecycle policies are unchanged.
6. Existing Provider, Channel, Tool, Runtime composition, and Architecture Fitness tests pass after relocation.
7. Root source, direct scripts, and Host entrypoints type-check under their respective TypeScript configurations.
8. Application and Host builds and Host artifact/WebSocket verification pass.
9. Residual scans find no replaced root, old symbol, forwarding export, duplicate construction, or stale source import.
10. Current Architecture and affected stable Specification evidence links are updated only after source convergence.
11. No README is modified without separate owner authorization.

The related Plan owns exact commands, slice sequencing, mutable inventories, and final validation batching.

## Follow-up

- The [Source Layout Refactoring Migration Plan](../changes/archive/source-layout-refactoring/plan.md) was Accepted together with this ADR before Delivery and now records completion provenance.
- S0 completed the per-file disposition and barrel classification before production moves.
- Architecture Fitness and current documentation transferred to the new canonical paths in the same accepted Change.
- Implemented source facts have transferred to Current Architecture, and the temporary Design Options input was deleted according to [ADR-006](adr-006-legacy-and-compatibility-exit.md).
- The Change was delivered and independently reviewed; Architecture Foundation closeout may resume as a separate task.

Process authority: [Development Workflow](../governance/development-workflow.md). Architecture constraints: [Architecture Principles](../governance/architecture-principles.md).
