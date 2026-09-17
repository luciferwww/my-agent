# Documentation

> Status: Active authority index
> Authority: Documentation roles, precedence, and navigation

This index separates current authority from active work and historical or non-authoritative supporting material.

## Default reading path

For ordinary implementation work, start from source and focused tests, then read only the smallest applicable authority set:

1. [Current Architecture](architecture/README.md) for implemented ownership and dependency direction;
2. [Stable Specifications](specifications/README.md) when public behavior, lifecycle, or failure contracts matter;
3. [Decisions](decisions/README.md) only when rationale or a durable design constraint matters;
4. the relevant active entry under [Changes](changes/README.md) when work is part of an approved delivery;
5. [Governance](governance/README.md) when classifying, approving, validating, or reviewing work.

Do not routinely read or search archived Changes, Evidence, Deferred inputs, Research, superseded decisions, or Git history. Use them only for provenance, prior alternatives, migration reconstruction, or unresolved authority transfer.

## Current authority and work

- [Governance](governance/README.md) — project workflow, principles, terminology, and coding conventions
- [Current Architecture](architecture/README.md) — verified implementation topics and ownership
- [Decisions](decisions/README.md) — accepted durable architectural decisions
- [Stable Specifications](specifications/README.md) — durable behavioral and structural contracts
- [Changes](changes/README.md) — active work under the Development Workflow; its archive is historical

## Opt-in supporting material

- [Evidence](evidence/README.md) — dated observations and execution records; non-authoritative
- [Deferred](deferred/README.md) — frozen future inputs; non-authorizing
- [Research](research/README.md) — external and exploratory material; non-authoritative
- [Templates](templates/README.md) — ADR, Module Specification, Spike Specification, and Spike Results starting points

## Authority order

Source and tests provide implementation evidence. Current Architecture owns implemented boundaries; Stable Specifications own long-lived contracts; Accepted Decisions own durable rationale; Active Changes own approved unfinished work. Evidence, Deferred, Research, superseded Decisions, and archived Changes cannot override those surfaces.

The [Development Workflow](governance/development-workflow.md) is the sole development-process authority. Templates define artifact structure only and do not create another workflow.
