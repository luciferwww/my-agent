# Model Resolution Specification

> Status: Stable Authority
> Contract status: Implemented and Validated
> Verified: 2026-11-18
> Authority: Stable Model identity, Catalog, facts, and Turn-binding contract

## Scope

Own structured Model References, Provider projection and closed Catalog membership, Provider-ID normalization, opaque Model-ID preservation, connection/model resolution, plain Model Facts, policy/capability checks, immutable per-Turn binding, and failure categories.

## Contracts

```ts
interface ModelReference { readonly providerId: string; readonly modelId: string }
interface ProviderProjectionEntry {
  readonly id: string;
  readonly displayName?: string;
  readonly protocol: string;
  getModelCatalog(signal?: AbortSignal): Promise<ProviderModelSnapshot>;
  resolveConnection(): ProviderConnectionResult;
}
interface ProviderModelSnapshot {
  readonly models: readonly ProviderCatalogModel[];
  resolveModel(modelId: string, connection: ProviderConnection): ProviderModelResult;
}
```

A Resolved Model atomically binds canonical identity, reference source,
protocol, endpoint/deployment identity, invocation Port, and final plain
effective/raw Context, Prompt, output, Tool, and Media facts. It also contains
a separate frozen invocation-default object. An optional positive
`outputTokenLimit` is clamped to known `maximumOutputTokens`; omission remains
empty and never inherits the capability value.

## Resolution order and invariants

1. Normalize Provider ID using `[A-Za-z0-9_-]{1,64}`.
2. Preserve Model ID exactly as an opaque Provider-owned string.
3. Find Provider.
4. Check exact closed Catalog membership.
5. Resolve connection.
6. Resolve the exact model descriptor.
7. Verify identity, protocol, endpoint, and facts.
8. Apply policy.
9. Validate required capabilities.
10. Freeze the Turn binding.

Catalog membership is checked after an asynchronous Provider catalog read and before connection/model resolution; it never invokes a model. A positive effective Context limit is required. Tool and Media facts are optional: unknown capabilities fail open, while an explicit negative or missing requested media kind fails before invocation. `ModelFactSource` and `SourcedFact<T>` are not public contracts; Provider Integration owns precedence and publishes final values.

Each Provider read returns `models` and `resolveModel()` over one captured
Provider-owned model collection. Registry retains Provider registration, not a
model catalog cache. Core validates each read and aggregates a frozen DTO without
retaining results across queries. Providers decide caching and update timing.
Resolution is asynchronous, obtains a fresh read handle, checks exact membership,
then validates connection, descriptor identity/protocol/endpoint, facts and policy.
The successful descriptor owns a model-bound `invocationPort`; later Provider
updates cannot reroute an existing Turn. No dual static/dynamic Provider API or
compatibility adapter remains after cutover.

No first-Provider/default fallback, brand guessing, paid probing, silent
Provider switch, or Core-owned Provider table is allowed. Optional trusted
`maximumOutputTokens` metadata may bound Runner headroom when only a total
Context limit is known, but does not become an invocation output cap.
Provider descriptors may separately publish an `outputTokenLimit` invocation
default. Active Turns keep one binding through Tool rounds and Compaction
retries. Children resolve independently against the inherited generation.

## Failure categories

Exactly: `provider_unregistered`, `connection_missing`, `connection_invalid`, `reference_invalid`, `model_rejected`, `model_ambiguous`, `facts_insufficient`, `policy_denied`, `override_unauthorized`, `protocol_incompatible`, and `capability_unsupported`. Every failure occurs before invocation.

## Catalog and Channel boundary

Each Provider read describes a closed, duplicate-free collection coherent with its captured `resolveModel()` facts and routing. Core validates each read and defensively freezes its listing. Runtime exposes a frozen transport-safe DTO with optional known Tool/Media and reasoning capabilities; absent capabilities remain absent. Reasoning capabilities contain only explicit `on`/`off` switches and non-default effort values, preserve Provider order, and never define a request default. A requested explicit value must be present in the resolved model facts or resolution fails as `capability_unsupported`; `default` requires no capability. `llm.defaultModel?: ModelReference` is an optional preferred reference for a Root Turn that omits an explicit selection and the Catalog's client default; it is not a fallback list and is not inherited directly by Children. Its Catalog state is `unset`, `available`, or `unavailable`. An absent or unavailable default does not select the first Provider.

Relay attempts bounded startup discovery but expected discovery failure warns
and permits registration with an empty model collection. Query-driven discovery
uses Provider-owned 60-second success caching and a 5-second failure retry
interval, measured at completion; no timer or client force flag is added.
Expected network/HTTP/timeout/body/metadata discovery failures clear that
Provider's collection, warn with the cause, and return an empty list. Config/code
errors and cancellation are not tolerated outages. Shared attempts have their
own deadline; caller cancellation only cancels that wait. Structured missing-model
invocation errors invalidate the current collection before error delivery.
Stale attempts and old bindings cannot invalidate or replace newer state.
Builtin remains configuration-backed.

Catalog queries capture the registration set without adding generation pins.
A pre-disable query may return after disable; normal stop behavior may also
cause query failure. A late response never re-registers a Provider. Registry
generation identifies registration composition, not model-data freshness.
Channels submit structured `{ providerId, modelId }`; Resolver remains authoritative.

An unavailable explicit or configured reference fails as `provider_unregistered` or `model_rejected` before invocation. Presentation clients may refresh the current Catalog and require explicit reselection, but Runtime does not substitute a Provider/Model or automatically retry the Turn. Compaction recovery is not model-selection retry and reuses the same Turn binding.

## Acceptance scenarios

Cover exact Catalog membership before connection, opaque Model IDs, connection/fact failures, policy/capability checks, unknown versus explicit-negative capabilities, no invocation on failure, immutable result, all default-selection states, no first-Provider fallback, Parent/Child generation consistency, Relay Catalog eligibility, frozen transport DTO, and Channel structured selection.

## Related authority

[Model Resolution](../architecture/model-resolution.md) owns current implementation facts. [ADR-004](../decisions/adr-004-provider-model-identity-and-facts-ownership.md) retains Provider fact ownership and immutable Turn binding; [ADR-016](../decisions/adr-016-unified-builtin-llm-provider.md) supersedes its public per-fact provenance requirement.
