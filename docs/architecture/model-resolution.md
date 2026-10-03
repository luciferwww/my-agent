# Model Resolution

> Status: Current Authority
> Authority: Current implemented Model Resolution behavior
> Verified: 2026-09-18
> Ownership: Model references, Provider projections, canonical identity, Model Facts, capability validation, and resolution failures
> Ownership key: model-resolution-and-facts

---

## 1. Boundary

`src/core/model-resolution/` converts a Turn request plus an immutable Provider projection into one frozen `ResolvedModel`. It is the sole owner of canonical Model identity, reference provenance, effective Model Facts, capability checks, and resolution failure categories.

Providers publish connection/model facts and a `ModelInvocationPort` through `ProviderProjectionEntry`. Runtime captures a Registry generation and supplies request/policy inputs. Model Resolution does not own Provider SDK conversion, Runtime publication, configuration precedence, Channel presentation, or Runner execution.

## 2. Inputs and output

`ModelResolver.resolve(...)` accepts one structured reference and provenance, Tool/media requirements, and application policy. It returns one frozen `ResolvedModel` containing canonical identity, protocol/deployment identity, a Turn-bound invocation Port, plain model facts, and separate frozen invocation defaults.

A root Turn resolves against the Provider projection from its captured published generation. A Child resolves independently from the same immutable Parent-generation projection, using either the Parent's effective reference or the Child profile's explicit reference; it does not sample the latest publication.

Runtime supplies one complete structured reference from the Turn or configured default. Resolution never selects the first Provider/model, reprioritizes Providers, or inspects a pre-staging projection.

## 3. Reference and Catalog resolution

The implementation canonicalizes the application-owned Provider ID while preserving the Provider-owned Model ID as opaque identity. It checks exact closed-Catalog membership before resolving the connection and descriptor, then validates identity/protocol consistency, policy, and requested capabilities before freezing the result. No failure changes Provider or Model identity.

For each Provider instance, `models` and `resolveModel()` must derive from the same immutable model snapshot. Registry and Model Resolution enforce unique membership and observable identity/protocol/selected-endpoint consistency; `resolveModel()` may add the selected model's deployment identity. The Provider owns the private fact source and compliance with the shared-snapshot obligation. The current unified Built-in and Copilot Relay implementations use one captured model map for both projections.

## 4. Facts and capabilities

Providers own fact-source precedence and publish only final values. The
Resolver requires a positive `effectiveContextLimit`, validates optional raw
total Context, Prompt, and output limits plus capability facts, rejects
Context-inconsistent limits, and rejects only explicitly unsupported
Tool/media requirements before binding.

An optional positive output invocation default is validated separately from
facts and clamped to a known maximum output capability. Omission resolves to
an empty frozen defaults object; capability metadata is never promoted into an
invocation policy.

Runner consumes only the resulting `ResolvedModel`: context budgeting prefers
a known Prompt limit, otherwise derives bounded output headroom from a known
total Context limit, otherwise uses the required effective fallback.
Invocation uses the bound port/protocol/model identity. Tool and Media facts
are optional: unknown capabilities fail open, while explicit negative
capabilities reject incompatible requests.

## 5. Failure contract

`ModelResolutionError.category` is a closed classification that does not expose Provider SDK errors; the Stable Specification owns the category contract.

Root Runtime maps resolution failure into Turn failure closure before Runner invocation. A Child converts it to a terminal Subagent result with `failure.phase: 'resolution'`, the same category, and zero Usage; the Child executor and invocation ports are not called.

For an interactive Root Turn, `provider_unregistered` and `model_rejected` tell the client that its exact selection is no longer available. The client can refresh the Catalog and ask for explicit reselection; Runtime does not choose a replacement or retry the failed Turn.

## 6. Related boundaries

- [Runtime](runtime.md) owns generation capture, root/Child orchestration, and terminal closure.
- [Providers and Model Invocation](providers.md) own Provider fact publication and concrete protocol conversion.
- [Media](media.md) owns normalized content from which image requirements are derived.
- [Configuration](configuration.md) supplies defaults and deployment inputs but does not establish canonical identity or effective facts.
- [Channels](channels.md) expose Catalog query/selection UX but cannot bypass final resolution.

## 7. Evidence

| Kind | Evidence |
|---|---|
| Source | [ModelResolver](../../src/core/model-resolution/ModelResolver.ts), [Runtime root resolution](../../src/runtime/RuntimeApp.ts) |
| Tests | [ModelResolver tests](../../src/core/model-resolution/ModelResolver.test.ts), [Runtime tests](../../src/runtime/RuntimeApp.test.ts) |
| Controlling authority | [Model Resolution Specification](../specifications/model-resolution.md), [Subagent Model Resolution Specification](../specifications/subagent-model-resolution.md), [ADR-004](../decisions/adr-004-provider-model-identity-and-facts-ownership.md) |
