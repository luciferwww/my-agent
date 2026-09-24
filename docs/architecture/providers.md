# Providers and Model Invocation

> Status: Current Authority
> Authority: Current implemented Provider behavior
> Verified: 2026-09-18
> Ownership: Provider-neutral invocation, normalized invocation failures, and concrete Built-in and Copilot Relay integrations
> Ownership key: provider-protocol-and-builtin-adapter

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

src/builtins/providers/builtin/
├── BuiltinLlmProvider.ts       # Catalog, facts, and private model-to-Protocol routing
├── AnthropicMessagesClient.ts  # Anthropic Messages protocol Client
├── OpenAIResponsesClient.ts    # OpenAI Responses protocol Client
├── OpenAIChatCompletionsClient.ts # OpenAI Chat Completions protocol Client
├── config.ts                   # module-owned configuration and operational defaults
├── client-common.ts            # shared HTTP/SSE conversion and error normalization
├── runtime-unit.ts             # optional configured builtin Provider Unit
└── index.ts

extensions/copilot-relay-provider/
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
  signal?: AbortSignal
}

ModelStreamEvent =
  | message_start
  | text_delta
  | tool_call
  | message_end
  | error
```

Canonical history supports text, base64 image, Tool Use, and correlated Tool Result blocks. Image dimensions are internal metadata and Provider adapters remove them from the wire. Core does not expose an output-token limit. Protocol clients omit one when optional; clients for protocols that require one own a private operational default.

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

## 5. Unified Built-in Provider

### 5.1 Protocol conversion

The three fetch-based Protocol Clients directly implement the Core `ModelInvocationPort`. Each appends only its operation path to the configured API prefix, uses only the materialized credential, performs one HTTP attempt, converts canonical text/image/Tool history, streams canonical events, preserves Abort, and normalizes failures through Model Invocation Error V1. OpenAI requests omit output limits; Anthropic Messages supplies its private required `4,096` fallback.

### 5.2 Provider facts and Catalog

`BuiltinLlmProvider` publishes Provider `builtin`, protocol `builtin-model-router`, and only explicitly configured models. Its private router selects the Client declared by each model registration without changing the public Provider ABI or opaque model ID. Each model receives the conservative effective Context limit `32,768`; Tool and Media capabilities remain unknown and therefore fail open. Unknown models fail closed.

## 6. Built-in Runtime Unit

`createBuiltinLlmProviderUnit()` captures frozen configuration and returns required, initially enabled Unit `builtin-llm-provider`. The Unit exists only when `llm.builtin` is configured. Provider construction is deferred until Unit `create()`; its projection remains enclosed in the instance registration closure and enters Registry staging only through `registerProvider()`.

An empty model registration list publishes an empty Catalog and creates no Protocol Clients or network traffic. Without `llm.builtin`, Runtime does not create the Unit, so empty and Extension-only configurations remain valid. Generic Runtime composition continues to own Unit creation, staging, publication, generation reload, rollback, retirement, and immutable per-Turn binding.

## 7. Copilot Relay external Unit

`copilot-relay-provider` is an optional external Unit. `create(signal)` validates a credential-free loopback HTTP(S) base URL, then performs one bounded `/v1/models` discovery. The default discovery deadline is 5 seconds and the response body is capped at 2 MiB. A blank API key emits no Authorization header.

Discovery publishes only exact `/responses` models with positive safe-integer output limits and at least one prompt/context limit. The smaller prompt/context value becomes the effective context limit. Tool support and image support are published only when metadata proves them; supported image MIME values are intersected with Core PNG/JPEG/WebP/GIF support. Duplicate eligible opaque Model IDs fail discovery. Unit creation failure follows optional external-Unit isolation and publishes no partial Provider.

### 7.1 Responses protocol

`CopilotRelayResponsesClient` uses raw `fetch` and SSE with `stream: true`; no OpenAI SDK or Runtime protocol branch exists. It:

- maps canonical text/image/Tool history to stateless Responses input;
- uses stable `call_id` for Tool replay instead of response item IDs;
- emits Tool Calls only from complete `response.output_item.done` function-call items;
- recognizes completed and max-output incomplete terminals;
- accepts usage only as non-negative safe integers;
- cancels pending body reads on Abort and preserves `AbortError`.

Malformed JSON/SSE framing, events before creation or after terminal, duplicate/unknown terminal states, invalid Tool identity, duplicate call IDs, invalid Usage, early stream close, HTTP failure, and explicit SSE failure all fail closed without a successful terminal.

The Relay emits a local `Error` satisfying the V1 structural invocation-error contract through type-only Core imports. It neither runtime-imports nor subclasses Host `ModelInvocationError`; Runtime canonicalizes the structural value at the existing Core boundary.

### 8.2 Package and supported Host

Copilot Relay is an npm workspace package under `extensions/copilot-relay-provider`. Its Descriptor points to `entry.ts`; Runtime Bootstrap loads it through the same Jiti path used for other source or built entries. The package imports Host contracts only from `my-agent/extension-api` and owns any package-manager dependencies it adds.

Development uses the tracked package directly. The npm package includes the same Extension package beneath `<installDir>/extensions`. Agent configuration under `<agentHome>/config.json` enables Descriptor ID `copilot-relay-provider`; its scoped config may materialize `baseURL`, `apiKey`, and `discoveryTimeoutMs`. The Extension entry reads only its validated `ExtensionLoadContext.config`, not process environment.

`src/hosts/standalone/standalone-host.ts` passes generic startup facts and zero
or one argument-selected Host-local CLI Unit to Runtime. Runtime Bootstrap
invokes the generic Extension Acquisition boundary and hands acquired
`LoadedRuntimeUnit[]` to composition. Neither Host nor Runtime imports Relay
or WebSocket Extension implementation or infers their identities. A default
Model Reference comes from ordinary Agent configuration or the atomic
`MY_AGENT_PROVIDER` plus `MY_AGENT_MODEL` environment override.

## 9. Evidence

| Kind | Evidence |
|---|---|
| Source | [Invocation errors](../../src/core/model-invocation/errors.ts), [Built-in Runtime Unit](../../src/builtins/providers/builtin/runtime-unit.ts), [Relay client](../../extensions/copilot-relay-provider/responses-client.ts) |
| Tests | [Invocation error tests](../../src/core/model-invocation/errors.test.ts), [Built-in protocol tests](../../src/builtins/providers/builtin/protocol-clients.test.ts), [Relay client tests](../../extensions/copilot-relay-provider/responses-client.test.ts) |
| Controlling authority | [Model Resolution Specification](../specifications/model-resolution.md), [Model Invocation Errors Specification](../specifications/model-invocation-errors.md) |
