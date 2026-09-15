# Provider Model Catalog and Copilot Relay Change Specification

> Status: Active — implemented C1–C3; C4 authority closeout open
> Date: 2026-09-14
> Owner: Project owner

## Change boundary

This artifact retains the delivery boundary and unfinished C4 closeout. Implemented long-lived behavior is owned by [Model Resolution](../../../specifications/model-resolution.md), [Runtime Composition](../../../specifications/runtime-composition.md), and [Current Providers](../../../architecture/providers.md); this active Change does not duplicate or override them.

## Delivered slices

### C1 — closed Catalog

Each Provider publishes a duplicate-free frozen Catalog from the same immutable facts used by exact `resolveModel()`. Resolver checks membership before connection/model resolution or invocation. Runtime exposes a transport-safe generation DTO. Structured `AgentDefaults.model` is the only default input; missing/unavailable defaults do not trigger first-Provider fallback.

### C2 — Relay Provider Unit

The in-repository Relay implementation enters composition as an optional external Unit. Unit creation performs bounded discovery; only eligible HTTP `/responses` models with required facts publish. Discovery/candidate failure leaves the current generation unchanged. Relay implements the Core invocation Port and owns SSE, Tool/Image mapping, Usage, Abort, and normalized errors.

### C3 — Channel capability and selection

Channel instances receive grouped, narrow Runtime capabilities. CLI and WebSocket query the immutable Catalog and submit structured references. Resolver remains authoritative even if a client submits stale or bypassed input. New Catalog wire messages use snake_case without rewriting unrelated historical wire fields.

## Open C4 contract

C4 is documentation and compatibility closeout, not new feature delivery. It must:

- confirm each implemented claim against current source/tests;
- establish one final authority owner per Catalog/Relay fact;
- remove stale paths, temporary diagnostics, and duplicate compatibility narration;
- run full relevant validation and residual scans;
- capture explicit owner acceptance and then archive this Change.

Until then this file remains active and the C4 status must not be inferred from C1–C3 completion or from creation of stable successor documents.

## Non-goals

No marketplace/discovery redesign, additional Provider protocol, background refresh, REST administration, raw Provider metadata exposure, Session portability redesign, silent fallback, or second composition path.
