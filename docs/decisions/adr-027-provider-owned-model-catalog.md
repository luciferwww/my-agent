# ADR-027: Provider-owned Model Discovery and Catalog Reads

> Status: Accepted
> Decision date: 2026-11-18
> Owner: Project owner
> Authority: Accepted durable decision
> Supersedes: ADR-016 Decision 3 only for the public Provider ABI

## Context

Before this decision, Registry staging copied a Provider's model catalog into its immutable
registration projection. Remote model additions, removals and capability changes
therefore required Unit recreation. Relay discovery failure also prevented Provider
registration. This unnecessarily couples model availability to Unit lifecycle.

Provider Integration already owns metadata interpretation and invocation routing.
Core must not become a cross-Provider model cache or own upstream refresh policy.
[ADR-004](adr-004-provider-model-identity-and-facts-ownership.md)
leaves catalog storage/refresh unfrozen and preserves immutable Turn bindings.
[ADR-016](adr-016-unified-builtin-llm-provider.md) kept the
public Provider ABI unchanged for its private routing change; this decision
intentionally revises that boundary for dynamic catalog reads.

## Decision drivers

- Provider-owned model state and optional cache policy.
- No Core catalog cache or TTL.
- Model updates without Unit reload.
- Existing Turn bindings remain stable.
- Minimal query-driven discovery without timers, force flags or push.

## Options considered

1. Recreate Units to update models: retains unnecessary lifecycle coupling.
2. Introduce Core cache, refresh scheduling and catalog publication generations:
   duplicates Provider state and expands scope.
3. Use async Provider-owned reads with captured listing/resolution state and
   model-bound invocation Ports: preserves ownership and existing Turn safety.

## Decision

Choose option 3:

1. Registry snapshots own Provider registration, not a frozen model directory.
2. Each Core catalog query calls Providers, validates and aggregates results,
   and returns a transport-safe value without retaining a catalog cache.
3. Providers own model state, discovery, optional caching and update timing.
   Configuration-backed Built-in requires no remote discovery.
4. A small Provider-owned read result exposes a catalog and resolution over
   the same captured collection. Core uses it locally, not as a version store.
5. Resolution binds the invocation Port and facts before execution. Provider
   state updates do not reroute active Turns.
6. Expected Relay discovery outages warn and yield an empty model collection,
   without blocking registration or adding a client availability protocol.
   Config/code errors and cancellation are not discovery tolerance.
7. Clients request catalogs without controlling cache bypass. Channels decide
   when to query; Providers decide when to contact upstream.
8. A query started before disable may complete afterwards under existing stop
   semantics. It adds no generation pin or retirement drain requirement.

This decision does not add model fallback, invocation retry, a cache framework,
scheduled refresh or service-pushed catalog notifications.

## Consequences

### Positive

- Provider ownership is explicit and independent of Unit recreation.
- Core remains vendor-neutral and cache-free.
- Existing transport catalog DTOs remain usable.

### Negative

- The Provider ABI changes, including async reads and model-bound invocation.
- Root, Child, Settings and Channel callers must migrate together.
- UI catalogs are point-in-time observations, not availability guarantees.
- Empty results cannot distinguish a valid empty catalog from a discovery outage;
  operators use warning logs.

## Validation

Prove same-instance updates without Registry reload, no Core result reuse,
coherent membership/descriptor/route binding, active-Turn routing stability,
nonfatal discovery outage and clear-on-failure, Channel query timing, and
structured-error invalidation in both Relay wire protocols. Include negative
classification cases, concurrent discovery/cancellation, pre-disable query
completion, existing Settings outcomes and full lint/build.

## Migration and rollback

Migrate bundled Providers, exported API, Registry validation, resolution and all
catalog callers together. No dual static/dynamic adapter or feature flag is
provided. Old external Provider shapes fail explicit registration validation.
Rollback is a coordinated code/API rollback, not a persisted configuration
migration; no new cache settings or on-disk catalog are introduced.

## Follow-up

The owner accepted the design and authorized contract synchronization,
implementation and validation on 2026-11-18, without commit, push or archive.
Current Architecture and Stable Specifications record the implemented boundary.

Process authority: [Development Workflow](../governance/development-workflow.md).
