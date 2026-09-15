# ADR-003: Progressive Architecture Migration

> Status: Accepted
> Decision status: Accepted
> Decision date: 2026-09-04
> Owner: Project owner
> Authority: Durable decision
> Supersedes: None

## Context

The system already had working Runner, Session, Tool, Channel, Abort, Compaction, and Subagent paths protected by characterization and Fitness evidence. Rewriting these paths together would make architectural defects difficult to distinguish from migration regressions. Long-term coexistence of old and new authority would instead split facts, fixes, and tests.

## Decision drivers

- Preserve characterized behavior, Session data, and failure semantics.
- Bound each migration to a real caller, explicit contract, validation, and deletion gate.
- Require replaced paths to decrease as new authority is established.
- Permit only one-way Compatibility into the new Core.
- Keep rollback executable without retaining permanent runtime dual paths.
- Avoid expanding scope into unapproved concurrency, marketplace, or arbitrary hot loading.

## Options considered

1. Rewrite in parallel and switch once: reopens too many settled behaviors simultaneously.
2. Migrate in reviewed slices and promptly remove replaced paths: localizes risk and preserves rollback.
3. Keep old and new implementations behind long-term flags: creates two authorities and a permanent test matrix.

## Decision

Choose option 2: migrate progressively and delete replaced paths as each boundary is accepted.

### Migration order and concurrency

The default production migration follows Slices 1 through 6 in the accepted Architecture Foundation Plan. Changing that order requires an accepted ADR, accepted Spike Results, or completed Slice evidence, followed by an accepted update to the parent Plan, validation gates, and deletion conditions before implementation changes order.

Slices 1 through 5 do not run in parallel by default, and at most one production Architecture Slice is active at a time. Documentation, Defect, and Small Change work may proceed independently only when it does not cross or silently alter the active Slice's approved architecture boundary.

### Authority and migration direction

- Characterization protects existing behavior until a target contract takes ownership; incidental implementation detail does not become permanent design.
- New capabilities enter only the new authoritative path.
- The only permitted transition direction is `Legacy/Public input -> Compatibility Adapter -> New Authoritative Core`.
- New Core, Registry Snapshot, Resolved Model, Extensions, and new test fakes must not depend on Compatibility or Legacy.
- A facade around an old implementation is not a new authority merely because its name changed.

### Slice completion

A migration slice is complete only when all applicable conditions hold:

1. at least one real production caller uses the new boundary;
2. the new contract and observable behavior pass accepted validation;
3. the replaced path is deleted, or a remaining public boundary is explicitly classified as Compatibility with owner, callers, expiry, tests, and deletion conditions;
4. new code does not depend on Compatibility or Legacy;
5. Legacy decreases across the slice;
6. ADR, Specification, evidence, Change status, Current Architecture, and indexes reflect actual state.

Adding an interface, Registry, Adapter, or wrapper without caller migration and removal does not complete a slice.

### Rollback

A delivery window may use a bounded Feature Flag to select one complete old or new path. It must have an owner, default, observations, trigger, and deletion point, and may not mix facts within one Turn or atomic operation. After completion, rollback uses a version or release rollback rather than a hidden permanent switch.

Rollback must preserve accepted Session, Tool Call/Result, data, and lifecycle invariants.

## Consequences

### Positive

- Each change affects a reviewable boundary.
- Current behavior stays comparable until the new contract takes ownership.
- New and old facts cannot diverge indefinitely.
- Completion and deletion become objectively reviewable.

### Negative

- Short-lived Compatibility and a finer validation matrix are required.
- Some target structures emerge only after several slices.
- Every slice must fund caller migration and cleanup.
- A sequence change requires authority updates before implementation.

## Deferred

This ADR does not decide Provider/Model ownership, Extension lifecycle, Tool closure, Compaction, concrete APIs, layouts, event/error shapes, locks, or persistence. It does not authorize Subagent concurrency, background/detached execution, teams, marketplace, arbitrary hot loading, or Session rewrite.

## Evidence and related authority

| Kind | Evidence |
|---|---|
| Governance | [Architecture Principles](../governance/architecture-principles.md), [Development Workflow](../governance/development-workflow.md) |
| Active Foundation authority | [Architecture Foundation Plan](../changes/active/architecture-foundation/plan.md), [Target Architecture](../changes/active/architecture-foundation/target-architecture.md) |
| Foundation evidence | [AF-07 decision closeout](../evidence/foundation/af-07-decision-closeout.md), [AF-05 evidence](../evidence/spikes/af-05-provider-model-resolution.md), [AF-06 evidence](../evidence/spikes/af-06-extension-framework.md) |
| Characterization Change | [AF-04 plan](../changes/archive/af-04-characterization-fitness/plan.md) |

Changes to migration order or authority require an accepted authority update; they must not be introduced silently in implementation.
