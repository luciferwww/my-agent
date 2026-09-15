# Target Architecture

> Status: Active target authority — not Current Architecture
> Date: 2026-09-14
> Owner: Project owner
> Supersession: Section-level only through an accepted Decision, stable Specification, or successor Target Architecture

## Evidence rule

This document retains end-state constraints that still guide change. [Current Architecture](../../../architecture/README.md) alone describes implemented facts. Source/tests override stale observations; accepted ADRs override design alternatives; stable Specifications own extracted long-lived contracts. A completed Slice does not silently supersede an unrelated target constraint.

## Scope and non-goals

Target concerns are dependency direction, Provider/Model ownership, Extension/Registry composition, generation/lifecycle transactions, Runtime call-flow ownership, and Legacy/Compatibility exit. It does not freeze package boundaries, public API spelling, deployment topology, a DI framework, distributed plugins, hot reload, or all future Provider/Channel/tool behavior.

## Logical boundaries and dependencies

1. **Core contracts and execution:** Provider-neutral Runner, Session, Tool/Hook, Model invocation/resolution, and domain types.
2. **Adapters and Extensions:** concrete Provider, Channel, Tool, and infrastructure implementations depend inward on Core-owned contracts.
3. **Runtime application/composition:** the sole assembly and lifecycle authority; captures immutable projections for execution.
4. **Host:** obtains configuration/acquisition inputs, starts Runtime, owns process/signal policy, and does not become domain authority.

Dependencies point inward. Core does not import concrete adapters, Runtime composition implementations, Host code, or Compatibility. Runtime may depend on Core and declared adapter contracts; concrete construction occurs through Unit factories. No general DI container or Service Locator is introduced.

## Provider and Model Resolution target

- Callers use structured Provider/Model identity; Provider owns opaque Model IDs.
- Core owns the invocation Port and resolution protocol, not concrete SDKs or endpoints.
- Providers publish closed Catalog membership and sourced execution facts from one immutable private source.
- Resolution is fail-closed, performs no paid/probe invocation, and yields one immutable per-Turn binding.
- A Turn never re-resolves during Tool loops or Compaction.
- A Child inherits Parent's effective reference only when configured as `inherit`, resolves independently, and retains Parent generation.
- No global model-fact fallback, first-Provider selection, brand guessing, or silent Provider switch.

Detailed contract: [Model Resolution](../../../specifications/model-resolution.md). Decision: [ADR-004](../../../decisions/adr-004-provider-model-identity-and-facts-ownership.md).

## Extension, contribution, and Registry target

- Host acquisition yields deterministic uncreated Units; loader does not register, start, or publish.
- Builtin and External Units share one factory/create/stage/start/publish/retire/stop path.
- Contributions are typed and staged; a Unit publishes atomically across Provider, Tool, Hook, and Channel kinds.
- Candidate identity, duplicate, schema, dependency, and capability checks occur before publication.
- Published Registry Snapshots are deeply immutable narrow projections without factory, mutable registration, concrete instance, or lifecycle authority.
- Extension-private config/resources remain private and cannot be recovered through Runtime service lookup.
- Invalid optional Units are isolated; required/core failures prevent an unsafe candidate.

Detailed contracts: [Extension Acquisition](../../../specifications/extension-acquisition.md) and [Runtime Composition](../../../specifications/runtime-composition.md). Decision: [ADR-005](../../../decisions/adr-005-extension-registry-runtime-composition.md).

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

## Runtime call-flow ownership

Runtime owns ingress, per-session admission/queueing, steering classification, route/Fanout, tree/generation membership, public Abort, completion gates, reload, retirement, and Shutdown. Runner owns one Turn's Provider-neutral Model/Tool/Hook loop, persistence coordination, context budgeting, Compaction, Usage, and events. Session owns authoritative append-only transcript/tree state. Channels own transport framing and presentation, not execution authority.

Tool policy, approval, Hook interception/observation, and Tool closure remain distinct. Deny and approval are application policy; Hooks cannot grant authority. Controlled Abort closes complete calls from known execution facts; unknown crash recovery pairs only missing results and never replays side effects.

Subagent execution is same-process and blocking in the accepted base model. Runtime validates the real Parent and owns Child identity, route/tree, signal, generation, terminalization, and cleanup. Child history and Model binding are independent.

## Legacy and Compatibility exit

- Compatibility is one-way toward the target and never imported by target/Core code.
- Every temporary facade/alias/dual-read needs an owner, bounded callers, expiry Slice, tests, and deletion condition.
- A Slice must migrate real callers and reduce its frozen legacy count; adding a wrapper without removing the old path is not progress.
- No old/new architecture Feature Flag exists by default. Any future flag requires explicit old/new paths, default, observability, rollback trigger, owner, tests, and removal date.
- Unknown external consumers require an explicit breaking/deprecation decision; repository search alone is not proof of absence.
- Documentation authority exits only after unique value, inbound references, successor ownership, and validation are reviewed.

Decision: [ADR-006](../../../decisions/adr-006-legacy-and-compatibility-exit.md).

## Verification obligations

Changes that touch these constraints must include focused contract/integration tests, dependency/Fitness checks, relevant full regression, lint/build, deterministic stale-path scans, and documentation link/authority validation. Tests are evidence, not alternate architecture authority.

## Open/deferred boundaries

Provider Catalog C4 remains an active Change; the accepted Slice 6 closeout is archived. Subagent parallel/background/detached models remain deferred. Marketplace/package SDK, watcher-driven hot reload, process isolation, arbitrary multi-generation replacement, generic DI, and distributed orchestration require separate accepted design.
