# Unified Built-in LLM Provider Specification

> Status: Implemented and Validated
> Date: 2026-09-20
> Owner: Project owner
> Related Plan/Decision: [Unified Built-in LLM Provider Plan](plan.md), [ADR-016](../../../decisions/adr-016-unified-builtin-llm-provider.md)
> Authorization: Implemented under the accepted Plan and manually accepted by the project owner on 2026-09-20.

## 1. Observable outcome

An empty Agent configuration still starts. A configured Built-in LLM Provider connects to one explicit API prefix and exposes only manually registered models. Each model selects one supported wire Protocol while callers continue to identify it only by `{ providerId, modelId }`.

## 2. Configuration contract

The Built-in Provider owns its configuration contract and operational defaults in
`src/builtins/providers/builtin/`. Platform Configuration imports that contract to
compose the top-level document; the Built-in Provider never imports
`src/platform/config/`.

`src/platform/config/` owns document reading, top-level namespace validation,
credential materialization, immutable projection, and composition. It does not
duplicate Built-in model, Protocol, Context, or Client defaults in
`platform/config/defaults.ts`.

This ownership boundary follows a project-wide convention rather than creating
an LLM-specific exception: a module owns the leaf configuration types,
module-specific semantic validation, and operational defaults that describe its
behavior; Platform Configuration owns application-document composition and
cross-module materialization. Migrating existing non-LLM modules is outside this
Change.

The implementation follows existing project conventions across the complete
surface, not only the dependency direction:

- reuse the established domain vocabulary and types for Provider, Model,
  `ModelReference`, Protocol, Client, Catalog, Runtime Unit, and invocation
  errors; do not add structurally equivalent LLM-only aliases;
- exported TypeScript types and classes use PascalCase, properties use
  camelCase, and the established `baseURL`, `apiKey`, `providerId`, and
  `modelId` spellings remain unchanged;
- stable Provider, Protocol, Unit, reason, and category values reuse existing
  lowercase kebab-case or snake_case values according to their current
  boundary; no differently cased synonym is introduced;
- persisted JSON property names match the corresponding configuration contract,
  while Channel wire DTOs continue to follow that Channel's established
  serialization convention rather than leaking configuration naming into the
  wire protocol;
- absence is represented with an optional property, not `null`, an empty-string
  sentinel, or a second boolean flag;
- immutable application projections and captured Runtime values use `readonly`,
  readonly collections, and freezing in the existing projection style; raw
  document input remains a validation input and is not presented as a trusted
  Runtime contract;
- existing error categories, configuration error construction, field paths,
  and secret-redaction rules are reused at their respective boundaries;
- shared constants and existing exported discriminants are imported from their
  owner instead of repeating string or numeric literals across modules.

These rules are verified against neighboring project APIs during implementation.
If an existing convention is internally inconsistent, this Change must preserve
the public boundary and document any narrowly necessary internal normalization;
it must not silently establish another competing convention.

```ts
type BuiltinProtocol =
  | "anthropic-messages"
  | "openai-responses"
  | "openai-chat-completions";

interface BuiltinModelRegistration {
  readonly modelId: string;
  readonly protocol: BuiltinProtocol;
  readonly displayName?: string;
}

interface BuiltinLlmProviderConfig {
  readonly baseURL: string;
  readonly apiKey?: string;
  readonly models: readonly BuiltinModelRegistration[];
}

interface LLMConfig {
  readonly defaultModel?: ModelReference;
  readonly builtin?: BuiltinLlmProviderConfig;
}

interface ApplicationConfigProjection {
  readonly llm: LLMConfig;
  readonly agents: AgentsConfig;
  readonly logger: LoggerModuleConfig;
}
```

The interfaces above describe the validated immutable projection consumed by
Runtime. Platform Configuration may use a separate raw document shape for
structural validation, following the existing document/projection distinction.
`ModelReference` is the existing Core type and is not redeclared by this module.

`llm` may be absent in the persisted document and projects to an empty object. `llm.builtin` and `llm.defaultModel` are independently optional.

The module-owned constants include `DEFAULT_BUILTIN_CONTEXT_LIMIT` and
`DEFAULT_ANTHROPIC_MAX_TOKENS`. Configuration references these module-owned
values where validation or projection requires them; it does not redeclare
numeric copies.

When `llm.builtin` exists:

- `baseURL` is a valid HTTP or HTTPS URL without username, password, query, or fragment;
- trailing slashes are removed without changing the remaining path;
- `models` is an array and may be empty;
- model IDs are non-empty and unique;
- every Protocol is one of the three supported values;
- blank `displayName` values are rejected;
- `apiKey` is optional and blank values normalize to absent.

The old `agents.defaults.model`, `agents.defaults.llm`, and corresponding `agents.list[]` fields are rejected. No compatibility read path remains.

An empty `models` array registers an empty Built-in Catalog, creates no Protocol Client, and performs no network request. A configured default that points to the empty Provider is reported as `unavailable` with reason `model_rejected`.

## 3. API-key materialization

`apiKey` accepts either a literal string or one exact environment-variable reference:

```json5
apiKey: "literal-key"
apiKey: "${SILICONFLOW_API_KEY}"
```

The reference name matches `[A-Z_][A-Z0-9_]*`. Only a complete `apiKey` value is interpreted; embedded interpolation and interpolation of Prompt, command, URL, or arbitrary configuration strings are not supported.

One shared resolver is used by Built-in configuration and Copilot Relay configuration. A missing or blank referenced value is a secret/configuration failure that may report the variable name but never its value. Copilot Relay's existing `$env` and `$secret` object forms remain supported.

The materialized `apiKey` is the only credential source passed to a Protocol
Client. Clients explicitly disable SDK or library fallback to ambient
credential environment variables. When the field is absent, they omit
authentication headers; they do not inherit a vendor-specific environment
variable or send a placeholder credential.

## 4. Provider and routing

The Provider identity is:

```text
Provider ID: builtin
Display name: Built-in LLM
Runtime Unit ID: builtin-llm-provider
Provider protocol: builtin-model-router
```

The public `ProviderProjectionEntry` contract remains unchanged. The Provider publishes one internal routing `ModelInvocationPort`. For every request, that Port:

1. finds the exact captured model registration by `request.model`;
2. reads its configured Protocol;
3. selects the matching Client from the immutable Protocol Client Registry;
4. delegates without changing the opaque Model ID;
5. fails explicitly if the model or Client is absent.

Only Clients referenced by configured models are created. There is no Protocol
inference, Protocol fallback, or semantic replay through another Client.

The three Protocol Clients are project-owned, minimal HTTP/SSE adapters rather
than wrappers around vendor SDKs. They implement only the capabilities required
by the canonical `ModelInvocationPort`: system and conversation messages, text,
Tools, supported Media, streaming deltas, usage, stop reasons, Abort, and
normalized errors. Canonical Agent contracts remain the implementation
boundary; Clients do not reproduce complete Anthropic or OpenAI SDK type
surfaces.

The Clients do not implement unused vendor APIs such as model administration,
Files, Batches, Embeddings, Audio, Assistants, fine-tuning, pagination helpers,
webhooks, or general-purpose request builders. A newly required Agent behavior
must be added from an accepted canonical use case and corresponding contract
test, not speculatively for vendor SDK parity.

## 5. Endpoint paths and authentication

`baseURL` is the complete API prefix immediately before the operation path. It need not end in `/v1`, and no Client guesses or inserts a version segment.

```text
anthropic-messages         -> <baseURL>/messages
openai-responses           -> <baseURL>/responses
openai-chat-completions    -> <baseURL>/chat/completions
```

When a materialized credential exists, Anthropic sends an `x-api-key` header
and OpenAI protocols send a bearer `Authorization` header. Without one, the
corresponding authentication header is omitted. Anthropic requests also send
the protocol-required `anthropic-version: 2023-06-01` header. All three Clients
send the JSON content headers required by their wire protocol.

## 6. Model facts and capabilities

Every manually registered unknown model receives:

```ts
effectiveContextLimit = 32_768
```

This is a conservative Runtime history boundary, not a claim about the model's hard Context limit.

Model facts use plain optional values:

```ts
interface ProviderModelFacts {
  readonly effectiveContextLimit?: number;
  readonly maximumOutputTokens?: number;
  readonly toolUse?: boolean;
  readonly mediaKinds?: readonly string[];
}
```

`ModelFactSource` and `SourcedFact<T>` are removed. Provider Integration still owns precedence among deployment configuration, Provider Metadata, static Catalog data, and code fallbacks, but publishes only the final value to Core. Source details may be retained in Provider-private diagnostics when useful; they are not part of the public fact contract.

For the Built-in Provider in this Change, `maximumOutputTokens`, `toolUse`, and
`mediaKinds` remain absent. Other Provider implementations may publish those
plain optional facts when they have an authoritative source. No hidden or
advanced Built-in capability configuration is introduced. Unknown Tool and
Media capabilities fail open:

- missing `toolUse` permits standard Tool encoding;
- explicit `toolUse: false` rejects before invocation;
- missing `mediaKinds` permits supported Client encoding;
- explicit `mediaKinds` rejects a requested kind that is absent.

There is no runtime capability probe.

## 7. Catalog and Client behavior

The transport Catalog adds optional known capabilities:

```ts
interface ModelCatalogEntry {
  readonly modelId: string;
  readonly displayName: string;
  readonly capabilities?: {
    readonly toolUse?: boolean;
    readonly mediaKinds?: readonly string[];
  };
}
```

Unknown fields remain absent. They are never rewritten as `false` or `[]`.

For the selected model, the HTML Client:

- enables image attachment when image capability is unknown or explicitly supported;
- disables the attachment control and explains the reason when Media capability is explicitly known and excludes image.

Server validation remains authoritative.

## 8. Default model

`llm.defaultModel` is a preferred Root-Turn reference with two uses:

1. the Runtime Catalog exposes it as the Client's initial selection;
2. the Server uses it when a request omits `modelReference`.

Its structure is validated during configuration loading. Availability does not block startup:

- absent becomes `defaultSelection: { state: "unset" }`;
- currently resolvable becomes `available`;
- missing Provider or rejected Model becomes `unavailable`.

A request uses its explicit reference first and the configured default second. If neither exists, it fails recoverably as `MODEL_MISSING`. A request depending on an unavailable default fails with the corresponding resolution category. No Provider or Model is substituted.

## 9. Output-token behavior

The public output-token control chain is removed:

- no legacy `llm.maxTokens` and no replacement `llm.maxOutputTokens`;
- no `ModelRequestOverride.maxOutputTokens`;
- no `ModelPolicy.defaultMaxTokens` or `maximumMaxTokens`;
- no `ResolvedModel.limits.maxTokens`;
- no `ModelInvocationRequest.maxTokens`;
- no Channel or WebSocket output-token override.

OpenAI Clients omit output-token limit parameters. Anthropic Messages requires `max_tokens` and therefore uses a Client-private constant:

```ts
const DEFAULT_ANTHROPIC_MAX_TOKENS = 4_096;
```

The constant is not user configuration and is not published as a model capability. Trusted `maximumOutputTokens` metadata may remain informational, but Model Resolution does not require it or use it to reject requests.

## 10. Attachment atomicity

Text and attachments form one atomic inbound message. Any unsupported MIME, MIME mismatch, unreadable metadata, oversize input, compression failure, post-compression oversize result, count overflow, or total-size overflow fails the whole message before Provider invocation.

For multiple attachments, one failure prevents all text and attachments from being enqueued. No path deletes an attachment and automatically retries a text-only request.

When Media capability is unknown, the request is attempted. When capability is explicitly unsupported, the request fails before invocation. When the upstream rejects Media, that invocation fails and is not automatically replayed.

## 11. Error compatibility

Clients preserve Model Invocation Error V1:

```ts
type ModelInvocationFailureCategory =
  | "authentication"
  | "rate_limit"
  | "invalid_request"
  | "unavailable"
  | "transport"
  | "provider_failure";
```

The `protocol`, `version`, category set, and diagnostics envelope remain stable. `diagnostics.request.maxTokens` becomes optional: old Providers may continue to provide it, OpenAI Clients omit it, and Anthropic records the actual `4,096` request value.

`ContextOverflowError` remains separate. Runtime owns retry decisions from normalized categories; Clients do not add a parallel `retryable` field.

Each Protocol Client performs one upstream HTTP attempt for one invocation.
Library or SDK automatic HTTP retries are disabled so Provider calls have the
same observable retry behavior across all three Protocols. Context-compaction
retry remains the existing Runner-owned behavior; no Client retries a request
after changing its Model, Protocol, Tools, Media, or content.

## 12. Runtime composition

The Built-in Runtime Unit exists only when `llm.builtin` is configured. Extension Providers remain independently loadable when it is absent. Empty `{}` configuration starts successfully.

The prior required Anthropic Built-in Unit and Agent-level LLM assembly are removed in the same cutover. Runtime publication, generations, reload, immutable Turn binding, and Extension lifecycle remain unchanged.

This Change applies module-owned configuration contracts and defaults to the
new Built-in LLM module only. Moving existing Runner, Memory, Prompt, Tool,
Context, Compaction, or Subagent configuration out of
`src/platform/config/types.ts` and `defaults.ts` is a separate architecture
change.

## 13. Acceptance scenarios

- Empty configuration starts with no Built-in Provider and an unset default.
- Built-in configuration validates endpoint, credentials, models, duplicates, and Protocols.
- Built-in configuration types and operational defaults have one owner under the Built-in module and are not duplicated by Platform Configuration.
- The Built-in configuration boundary follows the same reusable module-owned leaf-contract and Platform-composition pattern intended for the rest of the project; no LLM-only configuration framework is introduced.
- Public names, types, literal values, optionality, immutability, serialization, and error shapes conform to their existing project boundaries without introducing synonymous LLM-only forms.
- An empty Built-in model list registers an empty Catalog without creating Clients or performing I/O.
- Literal and `${ENV_VAR}` API keys resolve without leaking values.
- Protocol Clients use only the materialized credential, do not read ambient vendor credential variables, and omit authentication when it is absent.
- Copilot Relay uses the same string resolver and retains old object references.
- One Built-in Provider routes each model to its configured Protocol Client.
- Protocol Clients remain minimal Agent adapters and do not expose general-purpose vendor SDK surfaces.
- Provider selection remains `{ providerId, modelId }`; public Provider ABI remains unchanged.
- Unknown Tool and Media capabilities are attempted; explicit negative capabilities reject.
- Model facts contain plain values without per-fact provenance wrappers.
- Known capabilities survive Catalog and WebSocket projection.
- Invalid attachments fail the complete message before Provider invocation.
- OpenAI omits output limits; Anthropic sends the private `4,096` fallback.
- Default selection supports unset, available, and unavailable states without blocking startup.
- All Clients emit the existing normalized error structure.
- Every Client performs one upstream HTTP attempt per invocation; protocol libraries do not introduce hidden retries.
- Legacy Agent-level model/LLM fields, including `llm.maxTokens`, are rejected and no old Built-in assembly remains.

## 14. Validation

Delivery must satisfy the focused and final commands in the related Plan. Tests must prove negative behavior, including no Provider invocation after resolution or attachment failure, no secret values in diagnostics, no silent model substitution, and no Tool/Media-stripping retry.
