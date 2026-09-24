# ADR-016: Unified Built-in LLM Provider

> Status: Accepted
> Decision date: 2026-09-20
> Owner: Project owner
> Related Plan/Specification: [Unified Built-in LLM Provider Plan](../changes/active/builtin-llm-provider/plan.md), [Unified Built-in LLM Provider Specification](../changes/active/builtin-llm-provider/builtin-llm-provider-specification.md)
> Supersedes: the built-in Anthropic-only assembly after validated cutover, and ADR-004's requirement that every published model fact retain provenance
> Amendment: Model-Aware Output Control (2026-09-24) supersedes Decision 11 only for the new separate per-model invocation policy; the legacy global control remains removed.

## Context

The current required Built-in Provider binds every model to one Anthropic Messages Client. Modern gateways can expose Anthropic Messages, OpenAI Responses, and OpenAI Chat Completions through one endpoint and credential boundary. Treating each protocol as a separate Provider would duplicate connection configuration and expose transport choices in Provider identity.

Dynamic `/models` responses do not reliably describe context, output, Tool, Media, or endpoint compatibility. Requiring full capability metadata would make basic custom-gateway configuration burdensome, while silently inventing hard model limits would misrepresent unknown models.

The existing Provider interface already gives callers a stable `{ providerId, modelId }` identity and one invocation Port. Multi-Protocol routing can remain private to the Built-in Provider rather than changing the public Extension ABI.

## Decision drivers

- One user-visible Built-in Provider for one endpoint and credential boundary.
- Explicit, opaque model registration without provider-brand inference.
- Minimal configuration suitable for private and OpenAI-compatible gateways.
- No public Provider ABI migration solely for internal Protocol routing.
- Clear separation between model facts, Runtime assumptions, and protocol-required parameters.
- Failures that preserve user intent rather than silently changing requests.
- Empty-config startup and optional Extension-only deployments.

## Options considered

1. Keep separate Built-in Providers per protocol. This preserves simple adapters but duplicates endpoint identity and conflicts with one logical upstream.
2. Move invocation bindings into every public model descriptor. This supports multi-Protocol Providers directly but changes the Extension ABI and forces unrelated Providers to migrate.
3. Keep the public Provider contract and place a model-aware routing Port inside the Built-in Provider. This preserves external identity and isolates Protocol selection behind the Provider boundary.

## Decision

Adopt option 3 with these durable boundaries:

1. `builtin` is the single Built-in Provider identity. Callers continue to select `{ providerId, modelId }`.
2. A model registration owns its exact opaque ID and one explicit Protocol. The Built-in routing Port selects the corresponding Client internally.
3. The public `ProviderProjectionEntry` shape remains unchanged. Copilot Relay and third-party Extensions do not migrate for this routing design.
4. Built-in model discovery is configuration-only. Standard `/models` responses are not capability authority.
5. `llm.builtin` and `llm.defaultModel` are optional. Empty configuration starts; a configured default is both a Client preference and the Server fallback for requests without an explicit selection.
6. `baseURL` is the complete API prefix before the operation path. Clients append only their operation path and never guess a version segment.
7. `apiKey` remains a string. Exact `${ENV_VAR}` references are resolved only for explicit credential fields through one shared resolver; arbitrary configuration strings are not interpolated. The materialized value is the Protocol Clients' only credential source: vendor SDK environment fallback is disabled, and absent credentials produce no authentication header.
8. A manually registered model may independently declare positive safe-integer
   total Context, Prompt, and output limits. The effective compatibility limit
   is Prompt, otherwise Context, otherwise the conservative `32,768` fallback.
   Unknown Tool and Media capabilities fail open; explicit negative
   capabilities reject.
9. Known capabilities may be projected additively to clients. Client gating improves UX, while Server validation remains authoritative.
10. Inbound text and attachments are atomic. Any attachment-processing failure rejects the complete message before invocation. No valid attachment is silently removed and no failed Media request is retried as text-only.
11. The legacy global output-token control is removed. A later amendment adds optional per-model `outputTokenLimit` as invocation policy separate from model facts. When omitted, OpenAI requests still omit limits and the Anthropic Client privately supplies its required `4,096` fallback. This fallback is not a model fact.
12. Model Invocation Error V1 remains the common failure boundary. Its request diagnostic may omit the retired max-token value.
13. `ModelFactSource` and `SourcedFact<T>` are removed from the public model-fact contract. Provider Integration still owns source precedence and publishes only final plain values. This supersedes ADR-004 only where it requires per-fact provenance; ADR-004's Provider fact ownership and immutable per-Turn binding remain authoritative.
14. A configured Built-in Provider may have an empty model list. It publishes an empty Catalog, creates no Protocol Clients, and performs no network I/O.
15. The Built-in module owns its configuration contract, semantic validation, and operational defaults. Platform Configuration composes and materializes that contract but does not duplicate its defaults. Dependencies point from Platform composition to the module-owned leaf contract; the Built-in module does not import Platform Configuration. This is the project-wide module configuration boundary applied first to Built-in LLM, not an LLM-specific framework; later migrations of existing modules must be able to adopt the same pattern. The implementation also reuses established project naming, domain types, literal values, optionality, immutable projection, boundary serialization, and error conventions instead of introducing LLM-only synonyms.
16. Every Protocol Client makes one upstream HTTP attempt per invocation. SDK or library automatic retries are disabled; existing Runner-owned Context-compaction retry remains unchanged, and no retry changes Model, Protocol, Tools, Media, or content.
17. Anthropic Messages, OpenAI Responses, and OpenAI Chat Completions use project-owned minimal HTTP/SSE Clients. They implement the canonical Agent invocation capabilities and explicit compatibility behavior required by this project, not complete vendor SDK surfaces or unused vendor APIs. New protocol behavior is added only for an accepted Agent use case with contract tests.

## Consequences

### Positive

- One endpoint and credential configure heterogeneous models without duplicating Providers.
- Provider and Extension callers remain insulated from wire Protocol choice.
- Minimal model configuration remains practical when authoritative metadata is unavailable.
- Core model facts are simpler and match the final-value contracts used by mainstream Agent implementations.
- Built-in defaults have one owner, reducing drift between central configuration defaults and actual module behavior.
- Output-token semantics no longer conflate model capability with request policy.
- Unknown capabilities remain usable while explicit negative knowledge is enforced.
- Attachment failures are deterministic and preserve whole-message intent.

### Negative

- Unknown Tool or Media support can produce a first-call upstream error.
- Omitted Prompt and Context limits can underuse larger models or overestimate
  unusually small ones through the conservative `32,768` fallback; explicit
  registration avoids that mismatch.
- Core diagnostics no longer expose the origin of each individual model fact.
- Anthropic's required output fallback remains a protocol-specific constant.
- Reintroducing output control requires a separate policy contract rather than restoring the retired global field.
- Atomic attachment rejection is stricter than the previous partial-message behavior.
- Existing non-LLM module configuration remains centrally declared until a separate change migrates its ownership.

## Validation

- Contract tests prove Provider ABI stability and private model-to-Client routing.
- Configuration tests prove optional startup, strict Built-in validation, bounded credential interpolation, and legacy rejection.
- Resolution and Catalog tests prove three-state capabilities and Client projection.
- Attachment tests prove all-or-nothing admission and no Provider call on failure.
- Protocol tests prove path, authentication, output-limit, streaming, Tool, Media, Abort, and error behavior.
- Integration, Fitness, lint, build, Host, and independent-review gates are defined by the related Plan.

## Migration and rollback

The cutover removes the old Agent-level LLM configuration and required Anthropic Built-in Unit in one delivery. No dual configuration reader or Feature Flag is retained. Before users adopt the new configuration, rollback is a code rollback. After configuration migration, rollback requires restoring the previous configuration shape.

## Follow-up

- Review and accept or amend the related Plan and Specification.
- Do not begin production implementation while this ADR remains `Proposed` or the Specification remains `Draft`.
- After validated delivery, transfer current behavior to Architecture and stable Specifications, then archive the Change.

Process authority: [Development Workflow](../governance/development-workflow.md).
