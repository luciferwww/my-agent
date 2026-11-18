# Provider-owned Model Catalog Specification

> Status: Validated
> Date: 2026-11-18
> Owner: Project owner
> Related Plan: [Provider-owned Model Catalog](plan.md)
> Authority: Non-authoritative archived delivery record; owner accepted design and final delivery on 2026-11-18

## Purpose and observable outcome

Clients can query model catalogs without requiring Provider Unit recreation.
Core delegates catalog reads to registered Providers instead of retaining a
model catalog cache. Providers own model state and any upstream discovery or
cache policy. Relay can register while its discovery endpoint is unavailable,
with an explicit startup warning.

## Scope and non-goals

Update the model-discovery/catalog mechanism for all Providers: the public
Provider contract, Core query/validation path, directly dependent model
resolution and callers, and each concrete Provider implementation. This is not
a Relay-specific API or exception. It does not require every Provider to use
remote discovery; configuration-backed Providers remain configuration-backed.
Relay discovery lifecycle changes are one concrete part of this migration.

Include CLI/WebSocket on-demand age checks, catalog queries after explicit
model errors, and Provider cache invalidation after reliably identified
model-not-found errors. Do not add model fallback, automatic invocation retry,
timer-driven polling, background probes, change notifications, Core TTLs, an
independent refresh command, or client force-refresh flags. Do not redesign
model selection policy.

## Boundaries and dependency direction

- Provider Integration owns upstream access, credentials, metadata interpretation,
  model state, and optional caching. Each Provider decides whether and when to
  update its cache; Core neither dictates nor duplicates that policy.
- Core owns Provider identity validation, catalog-result validation, aggregation,
  policy/capability enforcement, and immutable Turn binding.
- Registry composition retains Provider registration and lifecycle ownership.
  It does not retain model catalogs as generation-scoped authority.
- Channels request a transport-safe catalog. A directory query is not a promise
  that every Provider performs a fresh upstream request. Presentation owns its
  local query timestamp, not the Provider's discovery timestamp or cache policy.
- Built-in remains configuration-backed; this Change does not add network
  discovery to it.

## Public and structural contracts

Replace the static public `models` array as catalog authority with a callable
Provider catalog-read boundary. It must accommodate asynchronous discovery and
request cancellation. The concrete contract below was accepted by the owner.

### Proposed API shape for acceptance

Use one Provider-owned read result for listing and resolution, rather than a
second Core catalog store:

```ts
interface ProviderModelSnapshot {
  readonly models: readonly ProviderCatalogModel[];
  resolveModel(modelId: string, connection: ProviderConnection): ProviderModelResult;
}

interface ProviderProjectionEntry {
  readonly id: string;
  readonly displayName?: string;
  readonly protocol: string;
  getModelCatalog(signal?: AbortSignal): Promise<ProviderModelSnapshot>;
  resolveConnection(): ProviderConnectionResult;
}
```

The successful `ProviderModelDescriptor` adds a required `invocationPort`.
Remove entry-level `models`, `resolveModel`, and `invocationPort`; do not keep
dual authoritative paths. The snapshot is a small frozen object backed by one
captured Provider collection, not a Core-managed version registry or a wire DTO.
Builtin may return the same immutable object on every read.

`ModelResolver.resolve(input, signal?)` becomes asynchronous. It obtains one
Provider snapshot, validates exact membership, resolves connection and model
from that captured object, validates facts/identity/policy, and freezes the
result with the descriptor's invocation Port. It does not store the snapshot
for future queries or resolutions. No lookup against a changing Provider map
may reroute the resulting Port on later Tool-loop or Compaction calls.

The Relay snapshot closes over its model/protocol map. Each successful model
resolution binds the selected Client and model binding; its wrapper may report
an error back to the Provider cache owner for invalidation, but cannot select a
different Client after a cache replacement.

`RuntimeApp.getModelCatalog(signal?)` and the Channel catalog capability return
`Promise<ModelCatalogSnapshot>`. Retain the current transport DTO and WebSocket
request/response names; no force option or availability field is added. Registry
registration validates Provider identity and callable members without discovering
models. Reuse catalog validation at read time for both aggregation and resolution
instead of copying catalogs into Registry staging.

Each Core catalog query invokes the relevant registered Provider read boundary,
validates identity, duplicate model IDs and published capability shapes, and
returns an immutable transport-safe result. Core does not reuse an earlier
catalog across queries or conceal failure by returning an old Core snapshot.
Per-request local values and the frozen response are not a Core cache.

The query captures a coherent Provider registration set. A Registry generation
identifies that composition, not the freshness or revision of Provider model
data. Model IDs remain opaque; no default/first-model substitution is introduced.
The query carries no client-controlled `rediscover`/force option.

An in-flight catalog query may return results from the Provider registration
set captured before a concurrent disable. The owner accepted this ordering on
2026-11-18: a query begun before disable need not be discarded merely because
its response arrives afterwards. Later queries use the current registration
set, and later Turns still resolve against their admitted registration set.

Catalog queries do not acquire a new generation pin or add a retirement drain
gate. Preserve existing Unit stop behavior: Core neither guarantees completion
of these queries nor automatically cancels them on disable. A Provider whose
stop closes query resources may cause an in-flight query to fail explicitly.
Do not re-register a disabled Provider or write query results back into Core
composition when a late response arrives.

## Channel query timing

The owner accepted a 60-second presentation query interval on 2026-11-18.
Check elapsed time when displaying the list; do not introduce a polling timer
or a new configuration setting. Explicit model-error queries bypass this
presentation interval.

CLI model-list commands and the WebSocket model picker check catalog age when
displaying the list. A missing or expired presentation result triggers a normal
Core query. A timestamp check is sufficient; no idle refresh timer is required.
Existing initial-connection queries remain supported.

An explicit model-not-found/unregistered/rejected error is still shown to the
user and triggers a new catalog query without waiting for presentation expiry.
Provider-private error codes must not be interpreted by Channels. Define a
minimal transport-safe semantic signal for upstream model-not-found if the
existing error categories cannot express it.

Record query-attempt time on completion, including failure, rather than treating
a failed query as a successful fresh result. Clear failed Provider entries from
the presentation when its returned model list is empty; do not retain the old
list. Expected discovery failures require no new client-visible unavailable/error
state. The accepted 60-second and 5-second intervals apply as described here.
Channel and Provider intervals are independent freshness limits, not an
end-to-end 60-second guarantee: a Channel can query just before Provider expiry
and keep that response for its own next interval. No activity means no refresh.

## Behavior and invariants

A Provider may return cached state or obtain new state according to its own
policy. Model listing and model resolution derive from the same authoritative
Provider-owned model collection. Where a Provider replaces that collection,
it builds and validates the complete replacement before publishing it; readers
must not observe a partially filled collection.

Relay checks its own discovery age on catalog reads and may reuse a valid cache.
Its discovery-cache interval is 60 seconds, accepted by the owner on 2026-11-18,
as an internal default without a new configuration setting. This interval is
independent of the Channel timestamp and does not apply to Built-in discovery.
An expired or invalidated cache causes discovery. Built-in reads its configured
models and requires no remote refresh. No new Core caching policy is introduced.

When Relay identifies a structured upstream model-not-found error, it invalidates
its cache before forwarding the original thrown error or streamed error event.
The Channel's subsequent ordinary query therefore cannot return a cache still
marked valid after that failure. This does not retry the invocation or silently
switch models. Do not infer model absence solely from HTTP 404, a generic
`invalid_request` category, or free-text matching.

If expected discovery fails, clear that Provider's published model collection,
log a warning with the concrete cause, and return an empty model list instead
of retaining the last successful directory. The owner accepted this minimal
behavior on 2026-11-18: callers need not distinguish discovery failure from a
valid empty catalog, and no Provider availability/error response protocol is
introduced. Other Providers' results remain unaffected.
Keep already-bound Turn resources intact; clearing the catalog is not disposal
of clients or bindings used by active Turns.

UI results are point-in-time observations, not availability guarantees.
Resolution must still validate the selected model and its facts. A removed
model can fail explicitly even if an earlier client response listed it.
Do not make listing and a later Turn one long-lived transaction.

An already-resolved Turn retains its invocation binding and facts across later
Provider model-state updates. Checking only frozen scalar facts is insufficient:
an invocation router must not silently rebind that Turn to a changed protocol,
endpoint, or replacement model entry.

## Lifecycle and resource ownership

Provider construction and registration do not depend on successful Relay
endpoint availability. Preserve the requested startup discovery attempt; an
expected discovery failure emits an explicit warning with the endpoint and
concrete failure cause, then allows registration without invented models.

Subsequent catalog reads reach the registered Provider even after startup
discovery failed. A successful discovery can publish usable models without
restarting Runtime or disabling/re-enabling the Unit.

Invalid local configuration, programming errors, startup cancellation, and
real Channel listener failures must not become successful registration through
a broad catch. General Unit lifecycle and cleanup remain authoritative.

## Failure, Abort, deadline, and concurrency semantics

Expected discovery failures are observable through Provider warning logs, not
a new catalog error response. Both internal startup discovery and query-driven
discovery use empty-list tolerance; no unsolicited client error is required.
This is not a broad catch for invalid configuration, programming errors, Core
contract-validation failures, or cancellation. Actual invocation failures remain
errors. Preserve bounded discovery time/body handling and explicit cancellation,
and avoid credential-bearing diagnostics.

The owner accepted a 5-second Relay discovery-failure retry interval on
2026-11-18. Measure it from the failed attempt's completion. Catalog reads during
that interval return the empty list without a new discovery attempt; after the
interval, the next read may attempt discovery again. No retry timer or new
configuration setting is introduced. This is separate from the Channel's
60-second query interval: recovery is possible only when another query occurs,
not guaranteed within 5 seconds. Cancellation is not classified as a discovery
outage for this rule.

Core introduces no cache or refresh scheduler. Provider-level concurrency and
cache behavior must not expose partial state or allow a cancelled operation to
publish invalid state. A discovery started before a model-not-found invalidation
must not restore a supposedly valid stale cache after the invalidation.
Coalesce concurrent Relay discovery requests. A shared attempt owns its bounded
5-second discovery timeout; a caller's AbortSignal cancels that caller's wait,
not unrelated waiters. No waiter-count lifecycle framework is required: a
bounded shared attempt may complete and publish valid state after a query waiter
leaves. Cancellation does not itself clear previously valid state or log an
outage. Startup cancellation still prevents registration and publication.

Use a private invalidation counter to reject publication from an attempt that
started before a later model-not-found invalidation. An overlapping query may
receive an empty snapshot; a later query starts the next eligible attempt.
Do not recursively retry discovery for the same query. Ordinary expected
failures clear state, record failure-completion time and log once per attempt,
not once per query during the 5-second failure interval.

Expected discovery failures include network failures, the owned discovery
timeout, non-success HTTP responses, missing/oversized bodies, invalid encoding
or JSON, and explicitly classified metadata validation failures. Convert these
at their narrow source boundaries to a Provider-private discovery error. Do
not catch every exception from Provider construction/parsing as an outage:
unknown exceptions and parent cancellation propagate.

### Structured model-not-found errors

Propose adding `model_not_found` to the existing invocation failure category
union and structural canonicalizer. Keep the existing structural protocol/version
and bounded diagnostics; migrate exhaustive consumers together. Channels query
again on this common category as well as existing `provider_unregistered` and
`model_rejected` resolution errors. Channels never inspect vendor error codes.

Relay recognizes exact structured `error.code: "model_not_found"` in an
invocation error envelope, except authentication, rate-limit and server-failure
responses, which retain their existing classifications. Do not equate
`invalid_model`, generic HTTP 404, or message substrings with this signal.
This is the supported compatibility rule to test, not a claim that every
deployed Relay emits that code. Unknown codes retain existing error handling
and ordinary 60-second expiry.

Both wire Clients preserve bounded code/type/message from explicit stream
error envelopes as well as HTTP errors. Responses reads structured code fields
on an `error` event (or its explicit nested `error` object) and `response.error`
on `response.failed`; Chat Completions reads the
chunk's `error` object. No payload content or arbitrary fields escape into
diagnostics. The Provider's bound Port invalidates before forwarding the common
error in either streaming or collected calls; the original failed invocation
is never replayed.

The existing Agent error event's optional `category` currently covers resolution
errors only. Extend its type/normalization to carry the common invocation
`model_not_found` category too, using the existing error-event envelope; do not
add a catalog-error response. Ensure Runner-originated invocation errors reach
this projection, not just Root setup/resolution failures. CLI handles the same
semantic trigger while preserving its existing single-display error behavior.
WebSocket forwards it to the originating session using existing event routing.

Only a binding from the currently published Provider model collection may
invalidate that collection. A late error from an already-replaced collection
still reaches the caller but must not repeatedly invalidate newer state.

## Security and capabilities

Core never interprets vendor metadata or guesses missing capabilities.
Preserve Provider-owned credential handling, endpoint validation, metadata
eligibility, exact membership checks and pre-invocation fact/policy validation.
Warnings and query errors must not expose API keys, headers, or prompt content.

## Compatibility and migration

Migrate registration validation, ModelResolver, Runtime catalog projection,
Built-in and Relay implementations, Extension API exports, Settings and Channel
callers/tests together as required by the accepted signatures.

Concrete dependent callers include Root admission, Child resolution using
the inherited Provider registration generation, Settings model tests, Settings
default-reference validation/availability, CLI and WebSocket catalog handlers,
and their mocks. Await resolution with each Turn/test's existing AbortSignal;
do not add query pins or change existing Turn/test pin ownership.

Settings must not introduce network I/O into synchronous section projections.
An action can obtain a request-local catalog and pass it to those projections.
Do not perform asynchronous catalog reads inside the atomic file-edit section.
Successful publication/file restoration outcomes remain authoritative even if
a later catalog enrichment fails unexpectedly; propagate a truthful action
failure through the existing Settings result contract without reporting a
rollback that never occurred or rolling back solely because enrichment failed.

Use a direct public API cutover: migrate bundled Providers, tests and exported
types together. Old external Provider shapes fail explicit registration
validation and require migration; no compatibility adapter or feature flag is
provided. The owner accepted this breaking API change before implementation.
Update durable contracts in
[Model Resolution Specification](../../../specifications/model-resolution.md)
and applicable Extension/Channel specifications; update
[Providers](../../../architecture/providers.md) and other owning Current
Architecture topics only when implementation evidence supports the new facts.

## Acceptance and validation

1. Repeated Core queries invoke a Provider even when composition is unchanged.
   A same-instance model update appears without a new Registry generation.
2. Provider-owned caching is permitted; Core does not add a TTL, cache previous
   results, or force an upstream fetch policy.
3. New valid state replaces old state completely. Invalid or interrupted
   discovery never exposes a partially updated model collection.
4. An unavailable Relay discovery endpoint produces a warning retaining
   endpoint/cause, yet Provider registration succeeds. A later successful
   catalog read exposes models without Unit recreation.
5. Local invalid configuration and startup cancellation still fail; query
   discovery outages return empty lists with concrete warning logs, while
   programming and contract-validation errors are not hidden by that tolerance.
6. Exact membership, duplicate detection, identity, facts, capabilities, and
   default-selection states remain validated using the accepted new boundary.
7. Updating/removing a model after Turn resolution does not change that Turn's
   invocation routing or facts. New resolutions use the Provider's current state.
8. Existing Built-in, WebSocket and Settings callers work through the migrated
   contract; no automatic fallback/retry or unsolicited client push is added.
9. CLI/WebSocket display-time checks query when expired, reuse presentation
   state within the interval, and query after a clear model error while showing
   that error. Query completion updates the attempt timestamp, including failure.
10. Relay invalidates before forwarding a confirmed model-not-found error in
    both collected and streaming invocation paths. The next catalog read
    discovers again even within the ordinary Provider cache interval.
11. Failed discovery clears the affected Provider's model collection and its
    client-visible entries with a concrete warning in Provider logs, without a
    new client-visible error state. It does not erase
    unrelated Providers or existing Turn bindings.
12. Generic HTTP 404, authentication, rate limits and transport errors do not
    independently assert model absence. Concurrent query/invalidation and
    cancellation do not publish partial or superseded state.

Use focused behavioral/contract tests first, relevant existing integration
tests next, then lint/build and documentation checks. Broader checks follow
evidence of affected boundaries, not a new framework or coverage target.

## Design review and acceptance gate

The preceding API shape, per-model invocation Port, common error category,
bounded shared discovery behavior, Settings migration and direct ABI cutover
were accepted for implementation on 2026-11-18. The owner also
accepted the product ownership boundary, 60-second intervals, 5-second failure
interval, empty-list-with-warning tolerance, and pre-disable query ordering.

The [accepted ADR-027](../../../decisions/adr-027-provider-owned-model-catalog.md) records the durable boundary change.
Accepted contracts were transferred to their stable owning documents before
implementation. The Plan records validation and Current Architecture
synchronization. The owner accepted final delivery and authorized archive,
commit and current-branch push on 2026-11-18.

No live upstream model-not-found response has been captured for this Change.
Existing local `invalid_model` test data demonstrates diagnostic preservation,
not upstream model-not-found semantics. Validate exact-envelope positive and
negative cases with controlled protocol fixtures; unknown real upstream error
codes do not trigger immediate invalidation and recover via normal expiry.
