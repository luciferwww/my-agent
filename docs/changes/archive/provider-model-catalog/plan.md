# Provider Model Catalog and Copilot Relay Plan

> Status: Archived — C1 through C4 accepted and completed
> Date: 2026-09-15
> Accepted: 2026-09-15
> Archived: 2026-09-15
> Owner: Project owner
> Type: Post-Foundation Architecture Slice

## Accepted direction

Providers publish closed, immutable model Catalogs and own opaque Model IDs, endpoint/protocol details, invocation mapping, and facts. Callers submit structured `{ providerId, modelId }`; Model Resolution rejects non-members before Provider work. Runtime exposes a generation-scoped, transport-safe Catalog DTO. Channels receive narrow Catalog/Abort capabilities, not Runtime authority. The optional configured default is a preferred Root-Turn reference when no explicit selection is supplied, not a startup requirement or fallback list. An unavailable selection is reported and the interactive client refreshes its Catalog for explicit reselection; no model is substituted and the failed Turn is not retried automatically.

Copilot Relay is an optional external Unit using native HTTP `/responses`. Its Catalog includes only eligible discovered models with required facts. Acquisition differences do not create a second Runtime path: all Units use common staging, Snapshot, generation, lifecycle, and retirement.

The durable implemented contract is extracted to [Model Resolution](../../../specifications/model-resolution.md). Decisions remain in [ADR-004](../../../decisions/adr-004-provider-model-identity-and-facts-ownership.md) and [ADR-005](../../../decisions/adr-005-extension-registry-runtime-composition.md).

## Gate record

| Gate | State | Retained result |
|---|---|---|
| R0 | Accepted | Relay `/models` and `/responses` protocol evidence captured |
| C1 | Accepted | Closed Catalog, structured default, pre-invocation membership, Runtime DTO |
| C2 | Accepted | Optional Relay Unit and supported WebSocket Host composition |
| C3 | Accepted | Channel capability binding and Catalog-driven CLI/Web selection |
| C4 | Accepted | Authority synchronization, residual deletion, validation, and owner closeout |

## C4 scope

C4 required:

1. verification of Current Architecture, stable contracts, and indexes against source/tests;
2. removal of superseded documentation/compatibility claims and confirmation of no second path;
3. relevant regression, lint, clean build, Fitness, and link/residual checks;
4. separation of environmental blocks from implementation failure;
5. explicit project-owner closeout before archival.

C4 did not authorize a new Provider path, protocol, fallback, REST surface, background Catalog refresh, marketplace, or Extension SDK.

## C4 validation record

On 2026-09-15, source/test review confirmed the C1–C3 claims, exact-selection behavior, common Runtime composition path, and current Anthropic/Relay snapshot discipline. Current and stable authority distinguish durable contracts from archived delivery records. The HTML client preserves classified stale-selection failures and requests the current Catalog for explicit reselection without substitution or automatic Turn retry.

Focused C4 and Architecture Fitness tests passed 82/82. The full suite passed 108 files and 1017 tests on Node 22.22.2. TypeScript lint, clean build, Relay error-boundary/artifact audits, 82-file Markdown target/anchor validation, stale-path/authority scans, and `git diff --check` passed. Independent review found no unresolved Critical, High, or Medium findings. No environmental block remained.

## Risks retained

Catalog/invocation drift is prevented by one Provider-owned immutable fact source. UI bypass remains contained by Resolver validation. Reload cannot mix generations. Unavailable defaults remain visible preferences rather than startup failures or fallback triggers. Future package acquisition must still return common `LoadedRuntimeUnit[]`.

## Closeout

The project owner accepted C4 and the complete Provider Model Catalog/Copilot Relay change on 2026-09-15. This plan is archived as bounded delivery and acceptance history; Current Architecture, stable Specifications, and accepted ADRs own ongoing behavior.
