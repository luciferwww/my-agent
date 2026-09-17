# Model Resolution Specification

> Status: Stable Authority
> Contract status: Implemented and Validated
> Verified: 2026-09-15
> Authority: Stable Model identity, Catalog, facts, and Turn-binding contract

## Scope

Own structured Model References, Provider projection and closed Catalog membership, Provider-ID normalization, opaque Model-ID preservation, connection/model resolution, fact provenance, policy/override/capability checks, immutable per-Turn binding, and failure categories.

## Contracts

```ts
interface ModelReference { readonly providerId: string; readonly modelId: string }
interface ProviderProjectionEntry {
  readonly id: string;
  readonly displayName?: string;
  readonly models: readonly ProviderCatalogModel[];
  readonly protocol: string;
  readonly invocationPort: ModelInvocationPort;
  resolveConnection(): ProviderConnectionResult;
  resolveModel(modelId: string, connection: ProviderConnection): ProviderModelResult;
}
```

A Resolved Model atomically binds canonical identity, reference source, protocol, endpoint/deployment identity, invocation Port, sourced context/output/tool/media facts, and effective output limit/source.

## Resolution order and invariants

1. Normalize Provider ID using `[A-Za-z0-9_-]{1,64}`.
2. Preserve Model ID exactly as an opaque Provider-owned string.
3. Find Provider.
4. Check exact closed Catalog membership.
5. Resolve connection.
6. Resolve the exact model descriptor.
7. Verify identity, protocol, endpoint, and facts.
8. Apply policy.
9. Validate request override.
10. Validate required capabilities.
11. Freeze the Turn binding.

Catalog membership is checked before connection/model resolution and never invokes a Provider. All execution-critical facts are positive and sourced. Context may use Provider default; output/Tool/media capabilities require specific trusted provenance. Missing requirements fail closed.

`models` and `resolveModel()` are two projections of one immutable Provider-instance model snapshot. This is a Provider contract obligation because the Host must not inspect or duplicate Provider-private fact sources. Registry and Model Resolution enforce the observable boundary: unique exact Model IDs, membership before Provider work, and returned identity/protocol/selected-endpoint consistency. The model descriptor may add its model-specific deployment identity. Current Anthropic and Relay Providers derive both projections from one captured model map.

No first-Provider/default fallback, brand guessing, paid probing, silent Provider switch, or Core-owned Provider table is allowed. Active Turns keep one binding through Tool rounds and Compaction retries. Children resolve independently against the inherited generation.

## Failure categories

Exactly: `provider_unregistered`, `connection_missing`, `connection_invalid`, `reference_invalid`, `model_rejected`, `model_ambiguous`, `facts_insufficient`, `policy_denied`, `override_unauthorized`, `protocol_incompatible`, and `capability_unsupported`. Every failure occurs before invocation.

## Catalog and Channel boundary

Each Provider publishes a closed, duplicate-free, deeply frozen Catalog derived from the same immutable facts as `resolveModel()`. Runtime exposes a frozen transport-safe DTO. `AgentDefaults.model?: ModelReference` is an optional preferred reference for a Root Turn that omits an explicit selection; it is not a fallback list and is not inherited directly by Children. An absent or invalid default does not select the first Provider.

Optional Relay acquisition resolves eligible `/responses` models during Unit creation and publishes only entries with required facts. Discovery/candidate failure cannot replace the current generation. Channels receive only immutable Catalog query and Abort capabilities and submit structured `{ providerId, modelId }`; Resolver remains authoritative.

An unavailable explicit or configured reference fails as `provider_unregistered` or `model_rejected` before invocation. Presentation clients may refresh the current Catalog and require explicit reselection, but Runtime does not substitute a Provider/Model or automatically retry the Turn. Compaction recovery is not model-selection retry and reuses the same Turn binding.

## Acceptance scenarios

Cover exact Catalog membership before connection, opaque Model IDs, connection/fact failures, policy/override/capability checks, no invocation on failure, immutable result, default absence, no first-Provider fallback, Parent/Child generation consistency, Relay Catalog eligibility, frozen transport DTO, and Channel structured selection.

## Related authority

[Model Resolution](../architecture/model-resolution.md) owns current implementation facts and [ADR-004](../decisions/adr-004-provider-model-identity-and-facts-ownership.md) owns identity and fact provenance.
