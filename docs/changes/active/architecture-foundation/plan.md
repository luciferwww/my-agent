# Architecture Foundation Plan

> Status: Active — Foundation packages and Slices 1–6 complete; deferred ownership and unsuperseded Target Architecture constraints remain open
> Date: 2026-09-14
> Owner: Project owner

## Purpose

The Foundation established governance, terminology, target boundaries, characterization/Fitness evidence, Provider/Model and Extension spikes, and durable ADRs before production migration. It remains active only for unfinished closeout ownership.

## Completed Foundation packages

AF-01 through AF-07 are complete: governance, glossary/principles, Target Architecture, characterization/Fitness, Provider/Model spike, Extension Framework spike, and ADR closeout. Their durable outputs now live in [Governance](../../../governance/README.md), [Decisions](../../../decisions/README.md), [Current Architecture](../../../architecture/README.md), [Specifications](../../../specifications/README.md), and [Evidence](../../../evidence/README.md).

## Production migration state

| Slice | State | Durable owner |
|---|---|---|
| 1 Model Resolution | Complete | Model Resolution specification and ADR-004 |
| 2 Subagent Model Resolution | Complete | Subagent specifications |
| 3 Tools and Hooks | Complete | Tools and Hooks specification |
| 4 Channels | Complete | Channel specification |
| 5 Runtime Composition | Complete | Runtime Composition specification |
| 6 Documentation and Legacy | Complete and owner-accepted | [Archived Slice 6 closeout](../../archive/slice-6-closeout/specification.md) |

Source Layout Convergence and Extension Acquisition were later completed as separately accepted post-Foundation changes; their archives and stable contracts own those results.

## Remaining authority

- [Target Architecture](target-architecture.md) remains active design authority only for constraints not formally superseded.
- Slice 6 is accepted and retained as an [archived closeout record](../../archive/slice-6-closeout/specification.md).
- Deferred Subagent concurrency/evolution remains non-authorizing under [Deferred](../../../deferred/README.md) until a new accepted Plan/Specification supersedes it.

## Closeout gate

Foundation can archive only when every retained target constraint has a current durable owner or remains explicitly active, deferred ownership is transferred, and no active link relies on obsolete Foundation paths. This plan does not authorize implementation, commit, push, or release by itself.
