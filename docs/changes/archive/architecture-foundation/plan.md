# Architecture Foundation Plan

> Status: Archived — Foundation packages, Slices 1–6, authority transfer, and closeout completed
> Date: 2026-09-15
> Owner: Project owner
> Role: Foundation delivery and closeout provenance; not current or contract authority

## Purpose and completed scope

The Architecture Foundation established governance, terminology, target boundaries, characterization/Fitness evidence, Provider/Model and Extension spikes, durable ADRs, and the migration sequence used by Slices 1–6.

AF-01 through AF-07 and production Slices 1–6 are complete. Source Layout Convergence, Extension Acquisition, Provider Catalog, Model Invocation Error Boundary, and Builtin Source Ownership were completed through separately accepted Changes. Their stable ADRs, Specifications, Current Architecture pages, tests, and archived Change records now own the resulting decisions, contracts, facts, and delivery provenance.

## Final authority disposition

| Foundation target area | Durable successor |
|---|---|
| Architecture terminology and dependency principles | [Domain Glossary](../../../governance/domain-glossary.md), [Architecture Principles](../../../governance/architecture-principles.md), and [Current Architecture Overview](../../../architecture/overview.md) |
| Provider and Model Resolution | [ADR-004](../../../decisions/adr-004-provider-model-identity-and-facts-ownership.md), [Model Resolution Specification](../../../specifications/model-resolution.md), and current [Model Resolution](../../../architecture/model-resolution.md) / [Providers](../../../architecture/providers.md) pages |
| Extension acquisition, Contributions, Registry, generations, reload, retirement, and Shutdown | [ADR-014](../../../decisions/adr-014-extension-packages-and-runtime-composition.md), [Extension Acquisition](../../../specifications/extension-acquisition.md), [Runtime Composition](../../../specifications/runtime-composition.md), and current [Extensions](../../../architecture/extensions.md) / [Runtime](../../../architecture/runtime.md) pages |
| Runtime/Runner/Session/Channel/Tool ownership and execution contracts | [ADR-001](../../../decisions/adr-001-tool-result-closure-and-recovery.md), [ADR-002](../../../decisions/adr-002-context-budgeting-and-compaction-recovery.md), stable Specifications, and the corresponding Current Architecture topic pages |
| Legacy and Compatibility exit | [ADR-006](../../../decisions/adr-006-legacy-and-compatibility-exit.md), [Development Workflow](../../../governance/development-workflow.md), and the archived [Slice 6 closeout](../slice-6-closeout/specification.md) |
| Builtin source ownership | [ADR-007](../../../decisions/adr-007-builtin-capability-source-ownership.md) and Current Architecture |
| Deferred Subagent concurrency/evolution | [Deferred Subagent Concurrency](../../../deferred/subagent-concurrency.md) and [Deferred Subagent Evolution](../../../deferred/subagent-evolution.md); neither authorizes implementation |

The Host boundary remains stable only at the ownership level: Runtime library code never calls `process.exit()`, while the Host owns process-level signal and exit policy and does not become Domain authority. Current signal counts, exit codes, and Host deadlines are implementation facts, deliberately unfrozen by ADR-005 rather than stable contract.

## Closeout result

Every retained Target Architecture constraint now has a durable owner or is explicitly deferred/unfrozen. No unfinished implementation remains authorized by this Plan. The archived [Target Architecture](target-architecture.md) preserves the accepted design record but no longer controls current facts, stable contracts, or future work.

Foundation can be reactivated only through a new owner-accepted Change. This archive does not authorize implementation, commit, push, or release.
