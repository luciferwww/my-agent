# ADR-004: Provider/Model Identity and Model Facts Ownership

> Status: Accepted
> Decision status: Accepted
> Decision date: 2026-09-04
> Owner: Project owner
> Authority: Durable decision
> Supersedes: None; does not supersede ADR-002

## Context

Static LLM configuration and Runtime assembly previously mixed Provider connection, Model identity, context limits, output limits, and client binding. Changing a Model string did not prove that endpoint, protocol, capabilities, and limits changed consistently. Stable Core must not maintain Provider brand knowledge or guess unknown facts.

Foundation evidence showed that Provider-owned facts and Model Resolution can form a consistent immutable per-Turn binding and fail before invocation when an input is unavailable or disallowed.

## Decision drivers

- Atomically bind Model identity, invocation Port, protocol, endpoint, and facts.
- Keep Provider SDKs, metadata, errors, and fallback inside Provider Integration.
- Separate Facts, Connection, Policy, Config input, and Request Override.
- Make Runner execute a resolved binding rather than resolve or guess facts.
- Resolve every Parent and Child Turn independently.
- Fail before network invocation when execution-critical facts are missing or inconsistent.

## Options considered

1. Continue assembling execution parameters from global config in Runtime/Runner: duplicates facts and can retain stale bindings.
2. Build a Core-owned cross-Provider model database: centralizes querying but duplicates Provider knowledge and deployment semantics.
3. Let Providers interpret facts and Model Resolution create an immutable per-Turn binding: preserves Provider knowledge boundaries while centralizing selection and validation.

## Decision

Choose option 3.

### Ownership

| Concept | Authority |
|---|---|
| Provider and Model canonical identity | Model Resolution |
| Provider connection and protocol behavior | Provider Integration |
| Model Reference normalization, Catalog view, policy, and override validation | Model Resolution |
| Provider-private fact interpretation and source precedence | Provider Integration |
| Application allow/deny policy | Application Policy |
| Provider Integration binding | Provider Extension contract supplied by Composition |
| Immutable Resolved Model | Created by Model Resolution and consumed by Turn execution |

Configuration loads and structurally validates input; it does not own Connection or Model Facts. Composition supplies bindings but does not interpret Provider facts. Compatibility maps old input in one direction and does not own resolution policy.

### Resolution and fail-closed behavior

Before Runner starts a Parent or Child Turn, Model Resolution:

1. normalizes the Model Reference;
2. selects a Provider identity and binding;
3. obtains Provider-produced descriptors and facts;
4. applies Model policy;
5. validates allowed request overrides;
6. checks protocol, endpoint/deployment, capability, and limit consistency;
7. emits one immutable Resolved Model or a classified failure.

An unregistered Provider, invalid connection, missing or ambiguous Model, policy denial, unauthorized override, incompatible protocol, or missing execution-critical fact fails before Provider invocation. The system does not silently change Provider, substitute a test fake, or let Core invent a value.

### Per-Turn binding

A Resolved Model atomically contains canonical identity, the Core-owned invocation Port binding, protocol and endpoint/deployment identity, Provider-produced capabilities and limits with provenance, and validated policy/override results.

Later Catalog, Registry, Policy, or Config changes do not affect an active Turn. Tool-loop and Compaction retry calls reuse the same binding. A Child resolves independently and may use `inherit` to reuse the Parent effective Model Reference, not the Parent mutable state.

### Facts and provenance

Provider Integration may combine deployment overrides, trusted Provider metadata, static catalog facts, Provider fallback, and conservative observations isolated by Provider/endpoint/Model. Every resulting fact retains provenance. Fallback fills only missing facts; an observation may tighten but not loosen a limit.

This ADR does not define a generic merge algorithm or freeze every capability precedence. Those details belong to Provider and Model Resolution contracts.

### Boundary with ADR-002

[ADR-002](adr-002-context-budgeting-and-compaction-recovery.md) remains authoritative for context budgeting, overflow correction, Runner prune/compact/retry/fail decisions, Session commit, Tool-exchange integrity, no-progress recovery, deadlines, and observer settlement.

## Consequences

### Positive

- Model switches cannot retain stale clients, endpoints, or facts.
- Provider-specific metadata and SDK types remain at the integration boundary.
- Runner does not own configuration, Catalog, or Provider selection.
- Parent and Child model selection remain isolated.
- Unsafe input fails before a paid invocation.

### Negative

- Every Provider must publish and interpret facts with provenance.
- Model Resolution requires explicit consistency validation and failure categories.
- Old static configuration requires one-way migration.
- Capability precedence must be defined field by field in contracts.

## Deliberately unfrozen details

This ADR does not fix production TypeScript shapes, Catalog storage/refresh, client pooling, credential injection, policy language, fallback values, persistence, or observability payloads.

## Implemented boundary and evidence

| Kind | Evidence |
|---|---|
| Current facts | [Model Resolution](../architecture/model-resolution.md), [Providers](../architecture/providers.md), [Runtime](../architecture/runtime.md) |
| Source/tests | [ModelResolver](../../src/core/model-resolution/ModelResolver.ts), [ModelResolver tests](../../src/core/model-resolution/ModelResolver.test.ts) |
| Stable contract | [Model Resolution Specification](../specifications/model-resolution.md) |
| Foundation provenance/evidence | [Archived Architecture Foundation Plan](../changes/archive/architecture-foundation/plan.md), [archived Target Architecture](../changes/archive/architecture-foundation/target-architecture.md#provider-and-model-resolution-target), [AF-05 evidence](../evidence/spikes/af-05-provider-model-resolution.md), [AF-07 closeout](../evidence/foundation/af-07-decision-closeout.md) |
| Governance | [Architecture Principles](../governance/architecture-principles.md), [Development Workflow](../governance/development-workflow.md) |
