# Provider Model Catalog and Copilot Relay Change Specification

> Status: Archived — implemented, validated, and project-owner accepted
> Date: 2026-09-15
> Accepted: 2026-09-15
> Archived: 2026-09-15
> Owner: Project owner

## Change boundary

This artifact retains the completed delivery boundary and C4 closeout. Implemented long-lived behavior is owned by [Model Resolution](../../../specifications/model-resolution.md), [Runtime Composition](../../../specifications/runtime-composition.md), and [Current Providers](../../../architecture/providers.md); this archived Change does not duplicate or override them.

## Delivered slices

### C1 — closed Catalog

Each Provider publishes a duplicate-free frozen Catalog from the same immutable facts used by exact `resolveModel()`. Resolver checks membership before connection/model resolution or invocation. Runtime exposes a transport-safe generation DTO. Structured `AgentDefaults.model` is the only default input; missing/unavailable defaults do not trigger first-Provider fallback.

### C2 — Relay Provider Unit

The in-repository Relay implementation enters composition as an optional external Unit. Unit creation performs bounded discovery; only eligible HTTP `/responses` models with required facts publish. Discovery/candidate failure leaves the current generation unchanged. Relay implements the Core invocation Port and owns SSE, Tool/Image mapping, Usage, Abort, and normalized errors.

### C3 — Channel capability and selection

Channel instances receive grouped, narrow Runtime capabilities. CLI and WebSocket query the immutable Catalog and submit structured references. Resolver remains authoritative even if a client submits stale or bypassed input. An interactive stale-selection failure preserves `provider_unregistered` or `model_rejected`; the HTML client refreshes the Catalog for explicit reselection without model substitution or automatic Turn retry. New Catalog wire messages use snake_case without rewriting unrelated historical wire fields.

## Completed C4 contract

C4 was documentation and compatibility closeout, not new feature delivery. It:

- confirmed each implemented claim against current source/tests;
- recorded the Provider obligation that Catalog and exact resolution derive from one immutable Provider-instance snapshot while Host validation remains limited to observable identity, protocol, and selected-endpoint consistency;
- preserved `AgentDefaults.model` as an optional preferred Root-Turn reference rather than a startup requirement, Child default, or fallback list;
- established one final authority owner per Catalog/Relay fact;
- removed stale paths, temporary diagnostics, and duplicate compatibility narration;
- ran full relevant validation and residual scans;
- captured explicit owner acceptance and archived this Change.

## C4 validation state

The 2026-09-15 closeout pass verified implementation claims and final authority ownership, removed archived Changes from controlling-authority roles, clarified Provider snapshot and configured-default responsibilities, and completed interactive stale-selection recovery presentation. Focused tests, full regression, lint, clean build and Relay audits, Architecture Fitness, Markdown links/anchors, residual scans, patch checks, and independent review passed without unresolved Critical/High/Medium findings. The project owner accepted C4 on 2026-09-15.

## Non-goals

No marketplace/discovery redesign, additional Provider protocol, background refresh, REST administration, raw Provider metadata exposure, Session portability redesign, silent fallback, or second composition path.

## Closeout

This archived Specification preserves the accepted C1–C4 delivery boundary and validation provenance. It is historical change evidence, not Current Architecture or stable contract authority.
