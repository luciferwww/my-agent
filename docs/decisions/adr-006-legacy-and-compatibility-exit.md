# ADR-006: Legacy Documentation and Compatibility Exit

> Status: Accepted
> Decision status: Accepted
> Decision date: 2026-09-04
> Owner: Project owner
> Authority: Durable decision
> Supersedes: None

## Context

A repository can contain current facts, target design, proposals, implementation records, accepted ADRs and Specifications, evidence, and historical material at the same time. Age or directory placement alone cannot determine authority. Leaving replaced documents discoverable encourages accidental citation and synchronization.

Production migrations similarly create old configuration, APIs, composition paths, and temporary flags. Permanently copying these paths produces reverse dependencies and dual authority, while immediate deletion can break callers or discard unique value.

## Decision drivers

- Maintain one active authority for each fact and production behavior.
- Distinguish historical value from current authority.
- Permit short-lived public Compatibility without giving it business ownership.
- Require reviewable deletion that preserves unique information.
- Use Git rather than permanent source/document backups for reconstructible history.
- Keep durable policy separate from mutable migration inventories.
- Require Legacy to decrease across each migration.

## Options considered

1. Permanently retain all old documents and code: minimizes deletion anxiety but creates duplicate authority and maintenance.
2. Delete old content immediately after a target exists: converges quickly but can lose facts, rationale, work, evidence, or callers.
3. Classify by authority, permit one-way Compatibility, and use an inventory to drive exit: preserves traceability while making deletion mandatory and reviewable.

## Decision

Choose option 3.

### Legacy classification

Legacy is determined by authority and status, not merely age, name, or directory:

- A document becomes a Legacy candidate when verified current facts, durable decisions/contracts, unfinished work, and retained evidence have different accepted owners and it must no longer guide implementation.
- Replaced production paths, old Config/API mappings, and temporary flags are Compatibility or Legacy candidates.
- Accepted ADRs, useful executed evidence, and active Changes do not become Legacy merely because they are old.
- Target design is not Current Architecture; current facts require source, test, or runtime evidence.
- An unaccepted proposal or implementation record is not implementation authority.

### Documentation port and deletion

Legacy documents progress through the accepted lifecycle:

`Pending -> Migrating -> Migrated -> Reviewed -> Deleted`

Every source document must have an explicit outcome and gate. `Migrated` means all retained value has an assigned successor, not that deletion is already allowed. Before deletion, verify:

1. current facts have one Current Architecture owner;
2. durable decisions and contracts have Decision or Specification owners;
3. unfinished work has an active Change owner;
4. retained observations have an Evidence owner;
5. active inbound links are switched;
6. unique content is ported, explicitly discarded after review, or retained by an accepted historical authority.

A replaced document leaves the active index when its successor takes authority. Any temporary status/successor pointer used during an ordinary in-place migration must not compete with the successor and is removed with the source at deletion. In this clean-room migration, the temporary old tree itself serves only as read-only construction evidence: it is not indexed or linked, is not a compatibility layer, and must be absent from final delivery. Git is the final record for discarded reconstructible narration.

### Production Compatibility

The only permitted direction is:

`Legacy Public API / Config Caller -> Compatibility Adapter -> New Authoritative Core`

Compatibility may map parameters, defaults, return values, and errors. It must not own Model facts, policy, Registry, lifecycle, Turn state, resources, or new features. New Core, Extensions, and new test fakes must not depend on Compatibility or Legacy, and Compatibility is not exported as the recommended API.

Every Compatibility entry records:

- source boundary and target authority;
- owner and affected callers;
- reason and exact mapping;
- rollback approach and flag observations when applicable;
- expiry slice or review date;
- deletion conditions;
- focused, contract, and regression validation.

A completed migration deletes the old path or explicitly retains a bounded Compatibility entry. After deletion, rollback uses a version or release rollback rather than hidden reverse dependencies or a permanent flag.

### Legacy must decrease

Each migration defines a countable inventory and satisfies:

$$
Legacy_{end} < Legacy_{start}
$$

Adding a facade, Adapter, Registry, or new document without migrating callers and retiring replaced authority does not satisfy this requirement.

### Inventory authority

This ADR owns the durable policy and required fields. Mutable inventories and closeout manifests are Change controls, not part of the ADR. They must identify artifact/category, authority/status, successor, unique-value disposition, inbound callers/links, owner, expiry, deletion conditions, and validation.

## Consequences

### Positive

- New implementation and documentation have one discoverable authority.
- Deletion cannot silently lose current facts, decisions, active work, or evidence.
- Public Compatibility is bounded, testable, and attributable.
- Accepted decisions and valuable evidence survive cleanup.
- Every migration must deliver convergence rather than only new abstraction.

### Negative

- Migration controls require maintenance until closeout.
- Link and unique-value review precede deletion.
- Remaining public callers impose short-term Compatibility tests.
- External callers can delay deletion only through an explicit reviewed extension.

## Deferred

This ADR does not itself classify every file, delete production code, set one universal expiry duration, or define deprecation policy for every API. Those decisions belong to accepted per-change inventories and contracts.

## Related authority and evidence

| Kind | Evidence |
|---|---|
| Governance | [Development Workflow](../governance/development-workflow.md), [Architecture Principles](../governance/architecture-principles.md) |
| Active Foundation control | [Architecture Foundation Plan](../changes/active/architecture-foundation/plan.md), [Target Architecture](../changes/active/architecture-foundation/target-architecture.md), [Slice 6 inventory](../changes/active/slice-6-closeout/legacy-migration-inventory.md) |
| Foundation evidence | [AF-05 evidence](../evidence/spikes/af-05-provider-model-resolution.md), [AF-06 evidence](../evidence/spikes/af-06-extension-framework.md), [AF-07 closeout](../evidence/foundation/af-07-decision-closeout.md) |

Slice 6 closeout and the clean-room audit apply this policy; they do not supersede it.
