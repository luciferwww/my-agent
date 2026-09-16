# Decisions

> Status: Decision Authority
> Authority: Accepted durable architectural decisions

This directory contains durable architectural decisions. It does not own current implementation facts, stable contracts, active Change scope, or execution evidence.

## ADRs

| Decision | Status | Scope |
|---|---|---|
| [ADR-001](adr-001-tool-result-closure-and-recovery.md) | Accepted | Tool Result closure and unknown recovery |
| [ADR-002](adr-002-context-budgeting-and-compaction-recovery.md) | Accepted | Context budgeting and Compaction recovery |
| [ADR-003](adr-003-progressive-architecture-migration.md) | Accepted | Progressive migration and authority convergence |
| [ADR-004](adr-004-provider-model-identity-and-facts-ownership.md) | Accepted | Provider/Model identity and Model Facts ownership |
| [ADR-005](adr-005-extension-registry-runtime-composition.md) | Accepted | Extension, Registry, Composition, and Runtime lifecycle |
| [ADR-006](adr-006-legacy-and-compatibility-exit.md) | Accepted | Legacy classification and Compatibility exit |
| [ADR-007](adr-007-builtin-capability-source-ownership.md) | Accepted | Builtin capability source ownership and layout |
| [ADR-008](adr-008-workspace-configuration-authority.md) | Superseded by ADR-010 | Former Workspace-root configuration/state authority and startup snapshot ownership |
| [ADR-009](adr-009-host-boundaries-and-standalone-npm-distribution.md) | Accepted | Environment Host source boundaries and standalone npm distribution |
| [ADR-010](adr-010-install-and-agent-home-ownership.md) | Accepted | Immutable `installDir`, writable `agentHome`, and non-owning working context |

## Authority rules

- Accepted ADRs own durable decisions and their consequences.
- Current Architecture owns verified implemented facts.
- Stable Specifications own long-lived contracts.
- Changes own authorized unfinished work and reviewed delivery history.
- Evidence records observations and cannot override a decision.
