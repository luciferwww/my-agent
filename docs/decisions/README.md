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
| [ADR-004](adr-004-provider-model-identity-and-facts-ownership.md) | Accepted; per-fact provenance superseded by ADR-016 | Provider/Model identity and Model Facts ownership |
| [ADR-006](adr-006-legacy-and-compatibility-exit.md) | Accepted | Legacy classification and Compatibility exit |
| [ADR-007](adr-007-builtin-capability-source-ownership.md) | Accepted; package identity partially superseded by ADR-012 | Builtin capability source ownership and layout |
| [ADR-008](adr-008-workspace-configuration-authority.md) | Superseded by ADR-010 | Former Workspace-root configuration/state authority and startup snapshot ownership |
| [ADR-009](adr-009-host-boundaries-and-standalone-npm-distribution.md) | Accepted | Environment Host source boundaries and standalone npm distribution |
| [ADR-010](adr-010-install-and-agent-home-ownership.md) | Accepted; separate working context and fixed selection superseded by ADR-012 | Immutable `installDir` and writable `agentHome` ownership |
| [ADR-011](adr-011-standalone-agent-home-configuration-bootstrap.md) | Accepted; selected-path semantics refined by ADR-012 | Standalone materialization of the missing selected Agent Home configuration document before Runtime state initialization |
| [ADR-012](adr-012-agent-home-path-unification.md) | Accepted | Two-path Agent Home model, Environment Tool relative-path defaults, structured external-path Approval, and Exec semantics |
| [ADR-013](adr-013-standalone-host-arguments-and-channels.md) | Accepted | Standalone Host arguments, argument-selected Builtin Channels, and Host-neutral global configuration |
| [ADR-014](adr-014-extension-packages-and-runtime-composition.md) | Accepted | Extension packages, unified Jiti loading, public API, and Runtime composition lifecycle |
| [ADR-015](adr-015-session-identity-and-materialization.md) | Accepted | Canonical Session identity, Pending first-message materialization, and clean-format cutover |
| [ADR-016](adr-016-unified-builtin-llm-provider.md) | Accepted | One optional Built-in Provider with private per-model Protocol routing and explicit model registration |

## Authority rules

- Accepted ADRs own durable decisions and their consequences.
- Current Architecture owns verified implemented facts.
- Stable Specifications own long-lived contracts.
- Changes own authorized unfinished work and reviewed delivery history.
- Evidence records observations and cannot override a decision.
