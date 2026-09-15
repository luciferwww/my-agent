# Provider Model Catalog and Copilot Relay Plan

> Status: Active — C1 through C3 accepted; C4 open
> Date: 2026-09-14
> Owner: Project owner
> Type: Post-Foundation Architecture Slice

## Accepted direction

Providers publish closed, immutable model Catalogs and own opaque Model IDs, endpoint/protocol details, invocation mapping, and facts. Callers submit structured `{ providerId, modelId }`; Model Resolution rejects non-members before Provider work. Runtime exposes a generation-scoped, transport-safe Catalog DTO. Channels receive narrow Catalog/Abort capabilities, not Runtime authority. Defaults may be absent and never silently select the first entry.

Copilot Relay is an optional external Unit using native HTTP `/responses`. Its Catalog includes only eligible discovered models with required facts. Acquisition differences do not create a second Runtime path: all Units use common staging, Snapshot, generation, lifecycle, and retirement.

The durable implemented contract is extracted to [Model Resolution](../../../specifications/model-resolution.md). Decisions remain in [ADR-004](../../../decisions/adr-004-provider-model-identity-and-facts-ownership.md) and [ADR-005](../../../decisions/adr-005-extension-registry-runtime-composition.md).

## Gate record

| Gate | State | Retained result |
|---|---|---|
| R0 | Accepted | Relay `/models` and `/responses` protocol evidence captured |
| C1 | Accepted | Closed Catalog, structured default, pre-invocation membership, Runtime DTO |
| C2 | Accepted | Optional Relay Unit and supported WebSocket Host composition |
| C3 | Accepted | Channel capability binding and Catalog-driven CLI/Web selection |
| C4 | Open | Authority synchronization, residual deletion, validation, and owner closeout |

## C4 scope

C4 must:

1. verify Current Architecture, stable contracts, and indexes against source/tests;
2. remove superseded documentation/compatibility claims and confirm no second path;
3. run relevant regression, lint, clean build, Fitness, and link/residual checks;
4. distinguish environmental blocks from implementation failure;
5. record explicit project-owner closeout before archival.

C4 does not authorize a new Provider path, protocol, fallback, REST surface, background Catalog refresh, marketplace, or Extension SDK. The documentation clean-room migration may relocate authority surfaces but does not itself declare C4 complete.

## Risks retained

Catalog/invocation drift is prevented by one Provider-owned immutable fact source. UI bypass remains contained by Resolver validation. Reload cannot mix generations. Unavailable defaults remain visible preferences rather than startup failures or fallback triggers. Future package acquisition must still return common `LoadedRuntimeUnit[]`.

## Completion gate

The change remains active until C4 is separately validated and owner-accepted. Commit and push remain separate actions.
