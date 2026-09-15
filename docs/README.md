# Documentation

> Status: Active authority index
> Authority: Documentation roles, precedence, and navigation

This index separates permanent authority from active work and non-authoritative supporting material.

## Authority and work surfaces

- [Governance](governance/README.md) — project workflow, principles, terminology, and coding conventions
- [Current Architecture](architecture/README.md) — verified implementation topics and ownership
- [Decisions](decisions/README.md) — accepted durable architectural decisions
- [Stable Specifications](specifications/README.md) — durable behavioral and structural contracts
- [Changes](changes/README.md) — active work and bounded delivery archives under the Development Workflow
- [Evidence](evidence/README.md) — dated observations and execution records; non-authoritative
- [Deferred](deferred/README.md) — frozen future inputs; non-authorizing
- [Research](research/README.md) — external and exploratory material; non-authoritative
- [Templates](templates/README.md) — ADR, Module Specification, Spike Specification, and Spike Results starting points

## Authority order

For implemented behavior, start with Current Architecture and follow its source/test evidence. Decisions explain durable choices. Stable Specifications define long-lived contracts. Active Changes own unfinished work. Evidence, Deferred, Research, and archived Changes cannot override those surfaces.

The [Development Workflow](governance/development-workflow.md) is the sole development-process authority. Templates define artifact structure only and do not create another workflow.
