# Core Model Resolution Current Architecture

> Status: Current Authority
> Verified: 2026-09-09
> Ownership: Model reference resolution, Provider projections, canonical identity, Model Facts, effective limits, capability validation, and resolution failures
> Ownership key: model-resolution-and-facts

## 1. Boundary

`src/core/model-resolution/` converts a Turn request plus an immutable Provider projection into one `ResolvedModel`. It is the sole owner of canonical Model identity, fact provenance, effective model limits, capability checks, and resolution failure categories.

Providers publish connection and model facts through `ProviderProjectionEntry`; Runtime selects the generation and supplies request/policy inputs. Model Resolution does not own Provider SDK conversion, Runtime generation publication, Config precedence, or Runner execution.

## 2. Resolution inputs and output

```text
ModelResolutionInput
├── reference                         ModelReference | undefined
├── referenceSource                   native | turn-explicit | config-default
├── request                           required Tool/media capabilities
├── requestOverride.maxOutputTokens
└── policy                            default/maximum output limits + allowModel
             |
             v
ModelResolver.resolve(...)
             |
             v
ResolvedModel
├── canonical identity + reference source
├── protocol + endpoint/deployment identity
├── Turn-bound ModelInvocationPort
├── sourced effective context/output/capability facts
└── effective maxTokens + source
```

A root Turn resolves against the Provider projection captured from its published generation. A Child Turn resolves independently from the Parent generation's same immutable Provider projection; it does not sample the latest publication.

Runtime supplies a complete structured reference from a per-Turn override or configured default. Model Resolution neither selects nor reprioritizes Providers, and it never inspects a pre-staging projection.

## 3. Reference and binding resolution

A reference always supplies both `providerId` and `modelId`. The application-owned Provider ID is normalized; the Provider-owned Model ID is an arbitrary string opaque identity, including the empty string, and is preserved exactly without trimming, character filtering, or rewriting. A missing/non-string Model ID or missing configured/explicit reference fails as `reference_invalid`; empty is distinct from missing and may resolve only when it is an exact Catalog member. Resolution never selects the first Provider or model.

Resolution then:

1. finds one registered Provider projection;
2. verifies exact membership in that Provider's closed model Catalog;
3. resolves and validates the Provider connection;
4. asks that Provider to resolve the model descriptor;
5. verifies Provider identity, protocol, endpoint, and descriptor consistency;
6. applies model policy and required capabilities;
7. freezes the resulting identity, facts, limits, and media-kind list.

Duplicate or invalid Provider identities are rejected when `ModelResolver` is constructed. An out-of-Catalog model is rejected before connection or model resolution. No fallback silently changes Provider or model identity.

## 4. Model Facts and limits

Every execution-critical numeric fact is positive, integral, and carries a `ModelFactSource`. `effectiveContextLimit` accepts all recognized sources. `maximumOutputTokens`, Tool support, and media support require capability-authoritative sources: deployment config, Provider metadata, or a static Provider catalog.

The effective output limit is the policy default unless a valid request override is supplied. Policy ceilings are checked before Provider capability ceilings. Missing required Tool/media facts produce `facts_insufficient`; declared unsupported capabilities or excessive output produce `capability_unsupported`.

Runner consumes only the frozen `ResolvedModel`: context budgeting uses `effectiveContextLimit`, invocation uses the bound port/model identity, and request output uses the resolved `maxTokens`.

## 5. Failure contract

`ModelResolutionError.category` classifies failures without exposing Provider SDK errors:

- identity/registration: `reference_invalid`, `provider_unregistered`;
- connection/model lookup: `connection_missing`, `connection_invalid`, `model_rejected`, `model_ambiguous`;
- evidence/policy: `facts_insufficient`, `policy_denied`, `override_unauthorized`;
- binding/capability: `protocol_incompatible`, `capability_unsupported`.

Runtime maps a resolution failure into Turn failure closure. Runner never performs resolution or Provider fallback.

## 6. Related boundaries

- [Runtime](./runtime.md) owns generation capture and root/Child Turn orchestration.
- [Provider Adapter](./adapter_llm.md) owns Provider fact publication and Anthropic protocol conversion.
- [Media](./core_media.md) owns normalized media kinds presented as resolution requirements.
- [Configuration](./platform_config.md) supplies defaults/deployment inputs but does not establish canonical identity or effective facts.

## 7. Evidence

| Kind | Evidence |
|---|---|
| Source | [ModelResolver.ts](../../../src/core/model-resolution/ModelResolver.ts), [types.ts](../../../src/core/model-resolution/types.ts), [RuntimeApp.ts](../../../src/runtime/RuntimeApp.ts), [subagent-orchestration.ts](../../../src/runtime/subagent-orchestration.ts) |
| Tests | [ModelResolver.test.ts](../../../src/core/model-resolution/ModelResolver.test.ts), [AnthropicProvider.test.ts](../../../src/adapters/provider/anthropic/AnthropicProvider.test.ts), [RuntimeApp.test.ts](../../../src/runtime/RuntimeApp.test.ts), [subagent-orchestration.test.ts](../../../src/runtime/subagent-orchestration.test.ts) |
| Controlling authority | [ADR-004](../adr-004-provider-model-identity-and-facts-ownership.md), [Model Resolution Module Spec](../model-resolution-module-spec.md), [Runtime Composition Module Spec](../runtime-composition-module-spec.md) |
