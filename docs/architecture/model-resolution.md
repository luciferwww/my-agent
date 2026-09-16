# Model Resolution

> Status: Current Authority
> Authority: Current implemented Model Resolution behavior
> Verified: 2026-09-16
> Ownership: Model references, Provider projections, canonical identity, Model Facts, effective limits, capability validation, and resolution failures
> Ownership key: model-resolution-and-facts

---

## 1. Boundary

`src/core/model-resolution/` converts a Turn request plus an immutable Provider projection into one frozen `ResolvedModel`. It is the sole owner of canonical Model identity, reference provenance, effective Model Facts and limits, capability checks, and resolution failure categories.

Providers publish connection/model facts and a `ModelInvocationPort` through `ProviderProjectionEntry`. Runtime captures a Registry generation and supplies request/policy inputs. Model Resolution does not own Provider SDK conversion, Runtime publication, configuration precedence, Channel presentation, or Runner execution.

## 2. Inputs and output

```text
ModelResolutionInput
├── reference                         ModelReference | undefined
├── referenceSource                   native | turn-explicit | config-default
├── request.tools                     boolean
├── request.mediaKinds                string[]
├── requestOverride.maxOutputTokens
└── policy.default/maximumMaxTokens + allowModel
             |
             v
ModelResolver.resolve(...)
             |
             v
ResolvedModel
├── canonical identity + reference source
├── protocol + endpoint/deployment identity
├── Turn-bound ModelInvocationPort
├── sourced context/output/Tool/media facts
└── effective maxTokens + source
```

A root Turn resolves against the Provider projection from its captured published generation. A Child resolves independently from the same immutable Parent-generation projection, using either the Parent's effective reference or the Child profile's explicit reference; it does not sample the latest publication.

Runtime supplies one complete structured reference from the Turn or configured default. Resolution never selects the first Provider/model, reprioritizes Providers, or inspects a pre-staging projection.

## 3. Reference and Catalog resolution

A reference supplies both `providerId` and `modelId`.

- The application-owned Provider ID is trimmed and must match `[A-Za-z0-9_-]{1,64}`. Published Provider IDs must already be in canonical form and must be unique when `ModelResolver` is constructed.
- The Provider-owned Model ID is an arbitrary opaque string. It is not trimmed, filtered, or rewritten; the empty string is valid identity when it is an exact Catalog member.
- Missing/non-string Model ID, invalid Provider ID, or missing reference fails as `reference_invalid`.

Resolution then:

1. finds the registered Provider projection;
2. checks exact Model ID membership in that Provider's closed Catalog;
3. resolves the Provider connection;
4. asks the Provider for the exact model descriptor;
5. verifies descriptor Provider/Model identity, protocol, and selected endpoint consistency;
6. applies application policy and request requirements;
7. freezes identity, facts, limits, and media-kind values.

An out-of-Catalog model fails before connection or descriptor resolution. No failure silently changes Provider or Model identity. The returned invocation port comes from the selected Provider projection and is atomically bound with the validated descriptor.

For each Provider instance, `models` and `resolveModel()` must derive from the same immutable model snapshot. Registry and Model Resolution enforce unique membership and observable identity/protocol/selected-endpoint consistency; `resolveModel()` may add the selected model's deployment identity. The Provider owns the private fact source and compliance with the shared-snapshot obligation. The current Anthropic and Relay implementations use one captured model map for both projections.

## 4. Facts, provenance, and limits

Every execution-critical numeric fact must be a positive integer with a recognized `ModelFactSource`:

- `deployment-config`;
- `provider-metadata`;
- `static-provider-catalog`;
- `provider-default`.

`effectiveContextLimit` accepts all four sources. `maximumOutputTokens`, Tool support, and media support accept only capability-authoritative deployment, metadata, or static-Catalog sources; Provider defaults cannot assert those capabilities.

The effective output request uses `policy.defaultMaxTokens` unless a positive integer request override is supplied. An invalid policy default or a default above `maximumMaxTokens` is `policy_denied`. An invalid override or one above the policy maximum is `override_unauthorized`. Only after policy checks does resolution compare the selected value with the Provider's maximum-output capability.

Required Tool/media behavior is fail-closed:

- missing required Tool/media facts → `facts_insufficient`;
- explicitly unsupported Tool capability or any requested media kind absent from the supported list → `capability_unsupported`;
- requested output above the Provider maximum → `capability_unsupported`.

Runner consumes only the resulting `ResolvedModel`: context budgeting uses `effectiveContextLimit`, invocation uses the bound port/protocol/model identity, and every model call uses resolved `limits.maxTokens`.

## 5. Failure contract

`ModelResolutionError.category` is a closed classification that does not expose Provider SDK errors:

| Area | Categories |
|---|---|
| Reference/registration | `reference_invalid`, `provider_unregistered` |
| Connection/model lookup | `connection_missing`, `connection_invalid`, `model_rejected`, `model_ambiguous` |
| Facts/policy | `facts_insufficient`, `policy_denied`, `override_unauthorized` |
| Binding/capability | `protocol_incompatible`, `capability_unsupported` |

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
| Source | [ModelResolver](../../src/core/model-resolution/ModelResolver.ts), [Model Resolution types](../../src/core/model-resolution/types.ts), [Registry contracts](../../src/core/registry/types.ts), [Runtime root resolution](../../src/runtime/RuntimeApp.ts), [Subagent orchestration](../../src/runtime/subagent-orchestration.ts), [AnthropicCompatibleProvider](../../src/builtins/providers/anthropic/AnthropicCompatibleProvider.ts), [Copilot Relay Provider](../../src/extensions/copilot-relay-provider/copilot-relay-provider.ts) |
| Tests | [ModelResolver tests](../../src/core/model-resolution/ModelResolver.test.ts), [AnthropicCompatibleProvider tests](../../src/builtins/providers/anthropic/AnthropicCompatibleProvider.test.ts), [Copilot Relay Unit tests](../../src/extensions/copilot-relay-provider/copilot-relay-provider-unit.test.ts), [Runtime tests](../../src/runtime/RuntimeApp.test.ts), [Subagent orchestration tests](../../src/runtime/subagent-orchestration.test.ts) |
| Controlling authority | [ADR-004](../decisions/adr-004-provider-model-identity-and-facts-ownership.md), [Model Resolution Specification](../specifications/model-resolution.md), [Runtime Composition Specification](../specifications/runtime-composition.md), [Subagent Model Resolution Specification](../specifications/subagent-model-resolution.md) |
