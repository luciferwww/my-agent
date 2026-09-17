# Current Authority Audit

> Status: Archived — completed delivery audit
> Date: 2026-09-17
> Archived: 2026-09-17
> Scope: `docs/architecture/*.md` and `docs/specifications/*.md`
> Authority: [Documentation Authority Simplification](specification.md)

This audit is a temporary delivery control. It identifies content disposition; it is not current architecture or a stable contract.

## Dispositions

- **KEEP:** already focused on current facts or contracts.
- **SIMPLIFY:** remove history, delivery evidence, or repeated implementation detail without changing the owner.
- **DEDUPLICATE:** retain a concise boundary summary and link to the named normative owner.
- **INDEX:** keep navigation only and remove duplicated summaries.

## Current Architecture

| Document | Disposition | Retained owner and cleanup |
|---|---|---|
| `README.md` | INDEX | Architecture topic navigation only; do not duplicate the overview. |
| `overview.md` | SIMPLIFY | Retain system map and ownership; remove the source/test/authority evidence table. |
| `configuration.md` | SIMPLIFY | Retain current configuration ownership; remove the completed removed-field inventory and evidence table. Configuration Specification owns schema and precedence contracts. |
| `runtime.md` | SIMPLIFY | Retain Runtime ownership and flows; remove evidence/delivery-history rows. Runtime Composition Specification owns Unit lifecycle contracts. |
| `runner.md` | DEDUPLICATE | Retain Runner ownership and concise flow. Runner Turn Flow Specification owns lifecycle, recovery, Compaction, Abort, and event contracts. |
| `model-resolution.md` | DEDUPLICATE | Retain implementation boundary. Model Resolution Specification owns identity, facts, capability, and failure contracts. |
| `providers.md` | SIMPLIFY | Retain current adapter behavior; remove validation narration, oversized evidence, and archived delivery-history links. |
| `extensions.md` | SIMPLIFY | Retain package/acquisition boundary; remove package-verification narration and oversized evidence. Extension Acquisition Specification owns behavior. |
| `channels.md` | DEDUPLICATE | Retain transport/runtime ownership and concise flows. Channel and related interaction/message Specifications own protocol behavior. |
| `media.md` | DEDUPLICATE | Retain implementation ownership and fail-closed boundary. Attachments Support Specification owns formats, limits, and drop semantics. |
| `tools.md` | DEDUPLICATE | Retain Tool/Hook ownership and policy boundary. Tools and Hooks plus Approval Specifications own lifecycle and closure semantics. |
| `builtin-tools.md` | SIMPLIFY | Retain concrete Tool behavior; remove registration/source/test inventory. Generic policy remains in Tools and Hooks. |
| `session.md` | KEEP | Current persistence ownership is focused; preserve negative persistence boundaries. |
| `prompt.md` | KEEP | Current prompt ownership and media placement are focused. |
| `memory.md` | KEEP | Current optional-degradation and configuration facts are focused. |
| `agent-context.md` | KEEP | Current initialization and allowlist ownership is focused. |
| `observability.md` | KEEP | Current Logger/Runtime ownership and adapter behavior are focused. |

Architecture totals: KEEP 5, SIMPLIFY 6, DEDUPLICATE 5, INDEX 1.

## Stable Specifications

| Document | Disposition | Retained owner and cleanup |
|---|---|---|
| `README.md` | INDEX | Stable-contract navigation only. |
| `abort.md` | DEDUPLICATE | Own cross-cutting cancellation; link instead of repeating Runner, Tool, Subagent, and shutdown-local behavior. |
| `approval-lifecycle.md` | SIMPLIFY | Retain lifecycle/failure contract; remove validation/evidence inventory. |
| `attachments-support.md` | SIMPLIFY | Retain limits and failure semantics; remove source/evidence inventory. |
| `channel.md` | DEDUPLICATE | Own Channel contract and transport lifecycle; Runtime Composition owns Unit lifecycle. |
| `configuration.md` | DEDUPLICATE | Own schema and precedence; Host owns bootstrap and Runtime Composition owns path semantics. Remove retired-field inventory. |
| `extension-acquisition.md` | SIMPLIFY | Retain acquisition contract; remove repeated implementation observability and evidence inventory. |
| `model-invocation-errors.md` | SIMPLIFY | Retain behavioral/privacy contract; remove current-fact evidence inventory. |
| `model-resolution.md` | DEDUPLICATE | Own identity, resolution, and fact provenance; link Runtime/Channel boundaries. |
| `multi-client-user-messages.md` | SIMPLIFY | Retain event/routing contract; remove evidence inventory. |
| `runner-turn-flow.md` | DEDUPLICATE | Own Runner lifecycle; link Abort, Tools, Session, and Compaction owners. |
| `runtime-composition.md` | DEDUPLICATE | Own Unit, generation, reload, and retirement; link Agent Home, Channel, Abort, and shutdown-local owners. |
| `standalone-service-host.md` | DEDUPLICATE | Own Host behavior; remove build/package validation chronology and evidence inventory. |
| `subagent-model-resolution.md` | DEDUPLICATE | Own Child-specific resolution and terminalization; link general Model/Runtime/Abort contracts. |
| `subagent.md` | SIMPLIFY | Retain profile/context/blocking Child contract; remove evidence inventory. |
| `tools-and-hooks.md` | DEDUPLICATE | Own Tool/Hook pipeline and closure semantics; link Runner, Abort, and Approval contracts. |

Specification totals: KEEP 0, SIMPLIFY 6, DEDUPLICATE 9, INDEX 1.

## Cross-cutting Decisions

1. Current Architecture remains the implementation-boundary owner; Stable Specifications remain behavioral-contract owners.
2. Small evidence tables in the five KEEP Architecture pages remain unless topic editing later proves them distracting. This avoids line-count-driven churn.
3. Accepted ADR content is out of D2/C2 scope. Only refinement/supersession metadata needed for current authority remains eligible.
4. Archive and Evidence content is not edited. Current links into archive are removed from ordinary reading flows.
5. FT-08/FT-12 are reviewed only after prose simplification; durable coverage is preserved unless duplicate maintenance is demonstrated.

## Exit Check

All 33 in-scope files have one disposition and retained owner. No production code, Accepted ADR body, Archive, or Evidence rewrite is authorized by this audit.