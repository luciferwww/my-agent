# Providers and Model Invocation

> Status: Current Authority
> Authority: Current implemented Provider behavior
> Verified: 2026-09-14
> Ownership: Provider-neutral invocation, normalized invocation failures, and concrete Anthropic-compatible and Copilot Relay integrations
> Ownership key: provider-protocol-and-anthropic-adapter

---

## 1. Boundary

`src/core/model-invocation/` owns the Provider-neutral invocation port, canonical request/response/event types, and normalized invocation failure contract. `AgentRunner` consumes only the `ModelInvocationPort` bound into a Turn's immutable `ResolvedModel`; it does not import Provider SDK or wire types.

Concrete Providers own connection/model fact publication and protocol conversion. [Model Resolution](model-resolution.md) owns reference validation, Catalog membership, fact validation, policy, capability checks, and final Turn binding. Runtime owns Unit composition and generation publication.

## 2. Source layout

```text
src/core/model-invocation/
├── types.ts                    # request, response, stream event, and Port contracts
├── errors.ts                   # normalized failure and structural error boundary
└── index.ts

src/adapters/provider/anthropic/
├── AnthropicClient.ts          # Anthropic SDK/protocol adapter
├── AnthropicProvider.ts        # connection, Catalog, facts, and invocation binding
├── tool-codec.ts               # production Anthropic Tool-definition codec
└── index.ts

src/runtime-modules/
└── anthropic-provider.ts       # required bundled Provider Unit

src/extensions/copilot-relay-provider/
├── entry.ts
├── copilot-relay-provider-unit.ts
├── copilot-relay-provider.ts
├── responses-client.ts
├── model-metadata.ts
└── extension.json
```

## 3. Core invocation contract

```text
ModelInvocationPort {
  chatStream(request): AsyncIterable<ModelStreamEvent>
  chat(request): Promise<ModelInvocationResponse>
}

ModelInvocationRequest {
  model: string
  system?: string
  messages: ChatMessage[]
  tools?: ChatToolDefinition[]
  maxTokens: number
  signal?: AbortSignal
}

ModelStreamEvent =
  | message_start
  | text_delta
  | tool_call
  | message_end
  | error
```

Canonical history supports text, base64 image, Tool Use, and correlated Tool Result blocks. Image dimensions are internal metadata and Provider adapters remove them from the wire. `maxTokens` is required after Model Resolution; normal calls, Tool loops, and Compaction use the same Turn-bound `ResolvedModel.limits.maxTokens`. Provider adapters do not supply a local output default or reinterpret policy.

Provider fragments, indexes, SDK objects, Anthropic `input_schema`, and Responses `function.parameters` remain inside adapter/test boundaries. Complete canonical Tool Calls preserve Provider call identity, name, order, and either ready object input or explicit invalid input state.

## 4. Model Invocation failure boundary

Core defines six categories:

- `authentication`;
- `rate_limit`;
- `invalid_request`;
- `unavailable`;
- `transport`;
- `provider_failure`.

`ModelInvocationError` carries the structural identity `protocol: 'my-agent.model-invocation-error'` and `version: 1`. `toModelInvocationError(value)` is the Runtime canonicalization entry: it passes through a Host-local instance or accepts an `Error` with valid own data discriminator fields, then creates a Host-local error.

Only allowlisted diagnostics are copied: Provider ID, bounded Provider status/type/code/message/request ID, and a content-free request summary. The summary preserves the opaque model string exactly and counts roles/content block types/Tool definitions without retaining prompts, image data, Tool input, schema, foreign message, stack, cause, or unknown fields. Invalid diagnostics are discarded while a valid category remains usable. Canonical diagnostics and the nested request summary are frozen.

## 5. Anthropic-compatible adapter

### 5.1 Protocol conversion

`AnthropicClient` directly implements the Core `ModelInvocationPort` using the Anthropic SDK. It converts:

- canonical Tool definitions through production `tool-codec.ts` into Anthropic `input_schema`;
- canonical text/image/Tool history into Anthropic Messages content while removing image dimensions;
- streamed `content_block_start`, `input_json_delta`, and `content_block_stop` into complete canonical Tool Calls;
- canonical correlated Tool Result blocks into Anthropic `tool_result` history;
- SDK/protocol failures into Core-owned normalized errors.

The current stream decoder accumulates the active Anthropic Tool block until its stop event. Blank call ID/name and duplicate call IDs fail closed. Malformed JSON preserves identity with `input.state: 'invalid'` and reason `malformed_json`; decoded arrays, primitives, and other non-plain objects use `not_an_object`. `chat()` retains invalid calls in `toolCalls` but does not fabricate a valid `tool_use` content block.

Abort is passed to the SDK and remains `AbortError`. Recognized context-overflow messages become `ContextOverflowError`. HTTP status maps authentication, rate-limit, invalid-request, unavailable, and remaining Provider failures; absence of a status maps to transport failure.

### 5.2 Provider facts and Catalog

`AnthropicProvider` publishes Provider `anthropic-compatible`, protocol `anthropic-messages`, an invocation port, normalized endpoint connection, and a closed model Catalog.

- The official endpoint `https://api.anthropic.com` starts from the static Provider Catalog; exact matching deployment facts may supplement or override individual entries.
- A custom endpoint publishes only models proven by deployment facts matching Provider, normalized endpoint, protocol, and exact opaque Model ID.
- A model without authoritative maximum-output facts is not published. A Provider-default context limit alone does not make a custom model executable.
- Model IDs, including whitespace/control characters or the empty string, are preserved exactly.
- Missing API key is a connection failure at resolution time. Invalid endpoint or deployment-fact input fails Provider construction.

## 6. Portable Tool conversion evidence

Provider portability is demonstrated by independent test reference codecs in `provider-portability.test.ts`; these are not production codecs and do not import Anthropic/OpenAI SDKs. They verify shared semantics across Anthropic and OpenAI-compatible function Tool shapes for definitions, complete and fragmented calls, multiple/interleaved calls, identity/order, malformed/non-object input, duplicate identity, and Tool Result correlation/content.

Production Anthropic definition conversion is owned by `src/adapters/provider/anthropic/tool-codec.ts`. Production and reference codecs do not share implementation. They share only the test fixture vectors in `src/core/tools/provider-portability-fixtures.ts`; `tool-codec.test.ts` checks the production output against those vectors. Production code does not import the reference codec or fixtures.

`ToolResultOutcome` is Core-only shared semantics. Anthropic `is_error` is a lossy wire hint, and OpenAI-compatible role=`tool` history does not need to reconstruct that outcome.

## 7. Bundled Anthropic Runtime Unit

`createAnthropicProviderModule()` captures frozen Provider options and returns required, initially enabled builtin Unit `builtin-anthropic-provider`. Provider construction is deferred until Unit `create()`; its projection remains enclosed in the instance registration closure and enters Registry staging only through `registerProvider()`.

Runtime Builder maps validated configuration into module options and adds the single Unit to the catalog. Generic Runtime composition owns Unit creation, staging, publication, rollback, and cleanup. Because this Unit is required, construction/validation failure is startup-fatal and is attributed to its Unit/create phase; no application kernel or `app_ready` event is published on that path.

## 8. Copilot Relay external Unit

`copilot-relay-provider` is an optional external Unit. `create(signal)` validates a credential-free loopback HTTP(S) base URL, then performs one bounded `/v1/models` discovery. The default discovery deadline is 5 seconds and the response body is capped at 2 MiB. A blank API key emits no Authorization header.

Discovery publishes only exact `/responses` models with positive safe-integer output limits and at least one prompt/context limit. The smaller prompt/context value becomes the effective context limit. Tool support and image support are published only when metadata proves them; supported image MIME values are intersected with Core PNG/JPEG/WebP/GIF support. Duplicate eligible opaque Model IDs fail discovery. Unit creation failure follows optional external-Unit isolation and publishes no partial Provider.

### 8.1 Responses protocol

`CopilotRelayResponsesClient` uses raw `fetch` and SSE with `stream: true`; no OpenAI SDK or Runtime protocol branch exists. It:

- maps canonical text/image/Tool history to stateless Responses input;
- uses stable `call_id` for Tool replay instead of response item IDs;
- emits Tool Calls only from complete `response.output_item.done` function-call items;
- recognizes completed and max-output incomplete terminals;
- accepts usage only as non-negative safe integers;
- cancels pending body reads on Abort and preserves `AbortError`.

Malformed JSON/SSE framing, events before creation or after terminal, duplicate/unknown terminal states, invalid Tool identity, duplicate call IDs, invalid Usage, early stream close, HTTP failure, and explicit SSE failure all fail closed without a successful terminal.

The Relay emits a local `Error` satisfying the V1 structural invocation-error contract through type-only Core imports. It neither runtime-imports nor subclasses Host `ModelInvocationError`; Runtime canonicalizes the structural value at the existing Core boundary.

### 8.2 Artifact and supported Host

The repository build creates an exact seven-file ESM artifact at `dist/extension-artifacts/copilot-relay-provider`: five reachable JavaScript files plus `extension.json` and the ESM package marker. The artifact audit rejects extra files, source-map metadata, non-relative/escaping imports, and unreachable runtime files, then verifies relocated generic acquisition and invocation.

Deployment places the complete artifact directory directly under `<agent-home>/extensions`. Agent Home configuration enables Descriptor ID `copilot-relay-provider`; its scoped config may materialize `baseURL`, `apiKey`, and `discoveryTimeoutMs`. The Extension entry reads only its validated `ExtensionLoadContext.config`, not process environment.

`scripts/server.ts` uses the generic Extension acquisition boundary and passes acquired `LoadedRuntimeUnit[]` beside a static WebSocket Channel Unit. It does not import Relay implementation or infer the Relay Provider ID. A default Model Reference comes from ordinary agent configuration or the atomic `MY_AGENT_PROVIDER` plus `MY_AGENT_MODEL` environment override.

## 9. Evidence

| Kind | Evidence |
|---|---|
| Core source | [Invocation types](../../src/core/model-invocation/types.ts), [Invocation errors](../../src/core/model-invocation/errors.ts) |
| Anthropic source | [AnthropicClient](../../src/adapters/provider/anthropic/AnthropicClient.ts), [AnthropicProvider](../../src/adapters/provider/anthropic/AnthropicProvider.ts), [production Tool codec](../../src/adapters/provider/anthropic/tool-codec.ts), [Anthropic Runtime Unit](../../src/runtime-modules/anthropic-provider.ts) |
| Relay source | [Extension entry](../../src/extensions/copilot-relay-provider/entry.ts), [Relay Unit](../../src/extensions/copilot-relay-provider/copilot-relay-provider-unit.ts), [Relay Provider](../../src/extensions/copilot-relay-provider/copilot-relay-provider.ts), [Responses client](../../src/extensions/copilot-relay-provider/responses-client.ts), [Relay metadata](../../src/extensions/copilot-relay-provider/model-metadata.ts), [supported Host](../../scripts/server.ts), [Host acquisition](../../scripts/websocket-host-startup.ts), [artifact builder](../../scripts/build-relay-extension-artifact.mjs) |
| Core/Anthropic tests | [Invocation error tests](../../src/core/model-invocation/errors.test.ts), [AnthropicClient tests](../../src/adapters/provider/anthropic/AnthropicClient.test.ts), [AnthropicProvider tests](../../src/adapters/provider/anthropic/AnthropicProvider.test.ts), [production Tool codec tests](../../src/adapters/provider/anthropic/tool-codec.test.ts), [portability fixtures](../../src/core/tools/provider-portability-fixtures.ts), [independent portability tests](../../src/core/tools/provider-portability.test.ts), [Anthropic Runtime Unit tests](../../src/runtime-modules/anthropic-provider.test.ts) |
| Relay/Host tests | [Relay Unit tests](../../src/extensions/copilot-relay-provider/copilot-relay-provider-unit.test.ts), [Responses client tests](../../src/extensions/copilot-relay-provider/responses-client.test.ts), [Host startup tests](../../scripts/websocket-host-startup.test.ts), [artifact audit](../../scripts/audit-relay-extension-artifact.mjs) |
| Controlling authority | [ADR-002](../decisions/adr-002-context-budgeting-and-compaction-recovery.md), [ADR-004](../decisions/adr-004-provider-model-identity-and-facts-ownership.md), [ADR-005](../decisions/adr-005-extension-registry-runtime-composition.md), [Model Resolution Specification](../specifications/model-resolution.md), [Model Invocation Errors Specification](../specifications/model-invocation-errors.md), [Provider Model Catalog active change](../changes/active/provider-model-catalog/specification.md), [Source Layout Convergence archived change](../changes/archive/source-layout-convergence/specification.md) |
