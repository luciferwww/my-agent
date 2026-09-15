# ADR-005: Extension, Registry, Composition, and Runtime Lifecycle

> Status: Accepted
> Decision status: Accepted
> Decision date: 2026-09-04
> Owner: Project owner
> Authority: Durable decision
> Supersedes: None; does not redefine ADR-001 or ADR-002

## Context

Tool, Hook, Channel, Provider, and Subagent assembly was distributed across bootstrap, Runtime, Runner setters, and scripts. Adding central branches for every capability would increase coupling, while a generic Service Locator would hide contracts, dependencies, and resource ownership.

Foundation evidence showed that Builtin and External Units can share one staging and publication path after acquisition; cross-kind contributions can be accepted atomically; consumers can use narrow projections; and immutable generations can support enable/disable, rollback, retirement, and bounded Shutdown while leaving Extension-internal objects opaque.

## Decision drivers

- Add a Provider, Channel, Tool, or Hook without changing central Runtime/Runner branches.
- Use one mechanism for Builtin and External registration.
- Accept or isolate a Unit's contribution set atomically.
- Give consumers only narrow typed projections and capabilities.
- Keep one internally consistent Snapshot for each Turn.
- Give each lifecycle Unit one owner while keeping internal objects private.
- Prevent failed dynamic changes from contaminating the published generation.
- Avoid a generic container, scheduler, or internal resource graph.

## Options considered

1. Maintain separate central registries and Builtin switches: simple locally but cannot atomically validate cross-kind Units.
2. Use a generic Plugin Container or Service Locator: flexible but obscures contracts and ownership.
3. Use Unit staging, an immutable Snapshot, and instance lifecycle ownership: unifies publication while preserving encapsulation.

## Decision

Choose option 3.

### Acquisition and registration

Builtin Modules are provided explicitly by the Composition Root. External Extensions are discovered from configured Agent Home boundaries and validated before loading. Their difference ends at acquisition: every accepted `LoadedRuntimeUnit` follows the same create, staging, validation, publication, retirement, and stop path.

Each Unit registers into a private staging collector rather than mutating a shared Registry. Tool, Hook, Channel, and Provider contributions use Core-owned contracts. A new platform-level contribution kind requires an explicit contract and projection; arbitrary token registration is prohibited.

### Unit atomicity, configuration, and capabilities

A Unit's identity, contribution set, scoped configuration, startup requirements, and cross-contribution consistency are validated together. An invalid External Unit is isolated; an invalid required Builtin or missing required capability may fail startup.

A Unit receives only its validated config namespace and explicitly granted typed capabilities. It receives neither global configuration nor Runtime-private state.

### Registry Snapshot and consumers

One authoritative Registry Builder publishes one internally consistent immutable Snapshot. Tool, Hook, Channel, and Provider registries are narrow projections of the same generation, not independently versioned stores.

Publication is the commit point. Failure before publication leaves the current generation unchanged. Failure during old-generation retirement does not roll back the new Snapshot. A root Turn captures the current generation when it begins; a Child inherits its Parent generation; queued work does not pin early.

### Runtime and Composition responsibilities

Extension acquisition resolves, discovers, configures, imports, and validates not-yet-created Units. Runtime Composition owns Unit creation, dependency wiring, staging, validation, startup, publication, retirement, and instance stop coordination. Runtime application logic owns queues, Turn trees, routing, generation capture, Abort, Fanout, and process Shutdown. Runner consumes Turn-pinned projections and does not discover Extensions or own process resources.

### Lifecycle ownership

Each accepted Unit instance has one lifecycle owner. Runtime starts Units in dependency order and asks them to stop in reverse order. A Unit owns its internal connections, caches, SDK clients, credentials, rate limiters, and transports. Registry consumers gain no close authority over the Unit. A generation remains alive while a pinned Turn needs it.

### Dynamic boundary

Runtime enable/disable builds a complete candidate, validates it, and publishes atomically. Same-identity active enable is a no-op. Candidate failure cleans up without changing current publication. Non-converged cleanup or retirement is attributable and blocks unsafe later reload; bounded Shutdown reports residual failure rather than forcibly violating a generation lease.

Excluded designs include file watching, arbitrary hot code loading, in-place code upgrade, same-identity live replacement, multi-instance coexistence, multiple simultaneously retiring generations, generic DI/Service Locator, and Framework ownership of Extension-internal objects.

### Other decision boundaries

[ADR-001](adr-001-tool-result-closure-and-recovery.md) owns Tool Call/Result closure and recovery. [ADR-002](adr-002-context-budgeting-and-compaction-recovery.md) owns context budgeting, overflow correction, Compaction, Session commit, and observer settlement.

## Consequences

### Positive

- New Units do not require central Runtime or Runner branches.
- Cross-kind contributions share one validation and version boundary.
- A Turn cannot observe a mixed Registry generation.
- Extension-private resource ownership remains encapsulated.
- Dynamic changes have explicit commit, rollback, and residual semantics.

### Negative

- Composition requires staging, diagnostics, dependency, and cleanup machinery.
- Consumers must use projections rather than mutable bundles.
- Reload requires generation leases and bounded retirement handling.
- Required Builtin and optional External failures need different startup policy.

## Deliberately unfrozen details

This ADR does not fix specific TypeScript APIs, descriptors, schema fields, filesystem normalization, lock primitives, deadlines, events/errors, Host signals, persistence, marketplace behavior, or Extension-internal sharing policy.

## Implemented boundary and evidence

| Kind | Evidence |
|---|---|
| Current facts | [Extensions](../architecture/extensions.md), [Runtime](../architecture/runtime.md), [Tools](../architecture/tools.md), [Channels](../architecture/channels.md) |
| Stable contract | [Runtime Composition Specification](../specifications/runtime-composition.md), [Extension Acquisition Specification](../specifications/extension-acquisition.md) |
| Foundation provenance/evidence | [Archived Architecture Foundation Plan](../changes/archive/architecture-foundation/plan.md), [archived Target Architecture](../changes/archive/architecture-foundation/target-architecture.md), [AF-06 evidence](../evidence/spikes/af-06-extension-framework.md), [AF-07 closeout](../evidence/foundation/af-07-decision-closeout.md) |
| Governance | [Architecture Principles](../governance/architecture-principles.md), [Development Workflow](../governance/development-workflow.md) |
