# Target Architecture

> Status: Archived target design record — retained as historical provenance, not current or contract authority
> Date: 2026-09-15
> Owner: Project owner
> Supersession: Completed through accepted Decisions, stable Specifications, Current Architecture, Governance, and Deferred ownership

## Closeout disposition

This document preserves the accepted Foundation target that guided delivery. It no longer authorizes implementation or overrides a durable successor. Current implemented facts are owned by [Current Architecture](../../../architecture/README.md); stable contracts by [Specifications](../../../specifications/README.md); durable choices by [Decisions](../../../decisions/README.md); dependency and process rules by [Governance](../../../governance/README.md); and non-authorizing future inputs by [Deferred](../../../deferred/README.md).

The Host boundary is retained only as an ownership rule: Runtime library code never calls `process.exit()`, while the Host owns process-level signal and exit policy and does not become Domain authority. Specific signal counts, exit codes, and Host deadlines remain deliberately unfrozen implementation details under ADR-005. The archived [Foundation Plan](plan.md) records the complete section-level authority transfer.

## Evidence rule

This document originally retained end-state constraints that guided change. Current Architecture alone describes implemented facts. Source/tests override stale observations; accepted ADRs override design alternatives; stable Specifications own extracted long-lived contracts.

## Scope and non-goals

Target concerns were dependency direction, Provider/Model ownership, Extension/Registry composition, generation/lifecycle transactions, Runtime call-flow ownership, and Legacy/Compatibility exit. It did not freeze package boundaries, public API spelling, deployment topology, a DI framework, distributed plugins, hot reload, or all future Provider/Channel/Tool behavior.

## Logical boundaries and dependencies

1. **Core contracts and execution:** Provider-neutral Runner, Session, Tool/Hook, Model invocation/resolution, and domain types.
2. **Adapters and Extensions:** concrete Provider, Channel, Tool, and infrastructure implementations depend inward on Core-owned contracts.
3. **Runtime application/composition:** the sole assembly and lifecycle authority; captures immutable projections for execution.
4. **Host:** obtains configuration/acquisition inputs, starts Runtime, owns the process/signal policy boundary, and does not become domain authority. Specific signal mechanics remain unfrozen.

Dependencies point inward. Core does not import concrete adapters, Runtime composition implementations, Host code, or Compatibility. Runtime may depend on Core and declared adapter contracts; concrete construction occurs through Unit factories. No general DI container or Service Locator is introduced.

## Provider and Model Resolution target

- Callers use structured Provider/Model identity; Provider owns opaque Model IDs.
- Core owns the invocation Port and resolution protocol, not concrete SDKs or endpoints.
- Providers publish closed Catalog membership and sourced execution facts from one immutable private source.
- Resolution is fail-closed, performs no paid/probe invocation, and yields one immutable per-Turn binding.
- A Turn never re-resolves during Tool loops or Compaction.
- A Child inherits Parent's effective reference only when configured as `inherit`, resolves independently, and retains Parent generation.
- No global model-fact fallback, first-Provider selection, brand guessing, or silent Provider switch.

Durable successors: [Model Resolution](../../../specifications/model-resolution.md) and [ADR-004](../../../decisions/adr-004-provider-model-identity-and-facts-ownership.md).

## Extension, contribution, and Registry target

- Host acquisition yields deterministic uncreated Units; loader does not register, start, or publish.
- Builtin and External Units share one factory/create/stage/start/publish/retire/stop path.
- Contributions are typed and staged; a Unit publishes atomically across Provider, Tool, Hook, and Channel kinds.
- Candidate identity, duplicate, Schema, dependency, and capability checks occur before publication.
- Published Registry Snapshots are deeply immutable narrow projections without factory, mutable registration, concrete instance, or lifecycle authority.
- Extension-private config/resources remain private and cannot be recovered through Runtime service lookup.
- Invalid optional Units are isolated; required/core failures prevent an unsafe candidate.

Durable successors: [Extension Acquisition](../../../specifications/extension-acquisition.md), [Runtime Composition](../../../specifications/runtime-composition.md), and [ADR-014](../../../decisions/adr-014-extension-packages-and-runtime-composition.md).

## Generations and lifecycle transactions

- Generations are process-local positive identifiers over immutable Snapshots.
- Root work captures one generation at start; queued work does not pin early; Children inherit Parent capture.
- Candidate build/start is isolated from current publication. Publish is atomic and linearizes against capture.
- Latest-wins coordination applies only before publication; an already published generation is never rolled back by retirement failure.
- Unchanged instances may be reused with exactly one lifecycle owner.
- Retirement drains leases, then applies bounded Abort convergence. Nonconverged resources remain protected and reported.
- Stop follows reverse dependencies and is never repeated after success.
- Reload cannot create a mixed-generation Turn, mutate a Snapshot, or replace same identity by arbitrary file execution.
- Shutdown closes admission/reload, drains and aborts under one deadline, seals request outcomes once, and reports residual resources without `process.exit()` from the library.

Durable successors: [Runtime Composition](../../../specifications/runtime-composition.md), [Abort](../../../specifications/abort.md), [ADR-014](../../../decisions/adr-014-extension-packages-and-runtime-composition.md), and current [Runtime](../../../architecture/runtime.md).

## Runtime call-flow ownership

Runtime owns ingress, per-session admission/queueing, steering classification, route/Fanout, tree/generation membership, public Abort, completion gates, reload, retirement, and Shutdown. Runner owns one Turn's Provider-neutral Model/Tool/Hook loop, persistence coordination, context budgeting, Compaction, Usage, and events. Session owns authoritative append-only transcript/tree state. Channels own transport framing and presentation, not execution authority.

Tool policy, approval, Hook interception/observation, and Tool closure remain distinct. Deny and approval are application policy; Hooks cannot grant authority. Controlled Abort closes complete calls from known execution facts; unknown crash recovery pairs only missing results and never replays side effects.

Subagent execution is same-process and blocking in the accepted base model. Runtime validates the real Parent and owns Child identity, route/tree, signal, generation, terminalization, and cleanup. Child history and Model binding are independent.

Durable successors are the corresponding Current Architecture pages, stable Specifications, [ADR-001](../../../decisions/adr-001-tool-result-closure-and-recovery.md), [ADR-002](../../../decisions/adr-002-context-budgeting-and-compaction-recovery.md), and ADR-005.

## Legacy and Compatibility exit

- Compatibility is one-way toward the target and never imported by target/Core code.
- Every temporary facade/alias/dual-read needs an owner, bounded callers, expiry Slice, tests, and deletion condition.
- A Slice must migrate real callers and reduce its frozen legacy count; adding a wrapper without removing the old path is not progress.
- No old/new architecture Feature Flag exists by default. Any future flag requires explicit old/new paths, default, observability, rollback trigger, owner, tests, and removal date.
- Unknown external consumers require an explicit breaking/deprecation decision; repository search alone is not proof of absence.
- Documentation authority exits only after unique value, inbound references, successor ownership, and validation are reviewed.

Durable successor: [ADR-006](../../../decisions/adr-006-legacy-and-compatibility-exit.md).

## Verification obligations

Changes touching these constraints require focused contract/integration tests, dependency/Fitness checks, relevant regression, lint/build, deterministic stale-path scans, and documentation link/authority validation. Tests are evidence, not alternate architecture authority. [Development Workflow](../../../governance/development-workflow.md) and [Architecture Principles](../../../governance/architecture-principles.md) own these continuing obligations.

## Open/deferred boundaries

Provider Catalog C4 and Slice 6 are accepted archived Changes. Subagent parallel/background/detached models remain deferred through [Subagent Concurrency](../../../deferred/subagent-concurrency.md) and [Subagent Evolution](../../../deferred/subagent-evolution.md). Marketplace/package SDK, watcher-driven hot reload, process isolation, arbitrary multi-generation replacement, generic DI, and distributed orchestration require a new accepted design; this archived record does not authorize them.
