# Providers and Model Invocation

> Status: Current Authority
> Authority: Current implemented Provider behavior
> Verified: 2026-11-19
> Ownership: Provider-neutral invocation, normalized invocation failures, and concrete Built-in and Copilot integrations
> Ownership key: provider-protocol-and-builtin-adapter

---

## 1. Boundary

`src/core/model-invocation/` owns the Provider-neutral invocation port, canonical request/response/event types, and normalized invocation failure contract. `AgentRunner` consumes only the `ModelInvocationPort` bound into a Turn's immutable `ResolvedModel`; it does not import Provider SDK or wire types.

Concrete Providers own connection/model fact publication and protocol conversion. [Model Resolution](model-resolution.md) owns reference validation, Catalog membership, fact validation, policy, capability checks, and final Turn binding. Runtime owns Unit composition and generation publication.

## 2. Source layout

```text
src/core/model-invocation/
├── types.ts                    # request, response, stream event, and Port contracts
├── stream-collector.ts         # ordered text/Tool/Thinking assembly and safe projection
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

extensions/copilot-provider/
├── entry.ts
├── auth.ts
├── credentials.ts
├── login-server.ts
├── inference.ts
├── responses-client.ts
├── chat-client.ts
├── catalog-metadata.ts
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
  sessionId?: string
  invocationId?: string
  system?: string
  messages: ChatMessage[]
  tools?: ChatToolDefinition[]
  outputTokenLimit?: number
  signal?: AbortSignal
}

ModelStreamEvent =
  | message_start
  | thinking_start
  | thinking_delta
  | thinking_end
  | text_delta
  | tool_call
  | message_end
  | error
```

Canonical history supports text, base64 image, Tool Use, correlated Tool Result,
and Thinking blocks. Complete Thinking carries normalized display text plus a
Provider-owned JSON replay envelope; partial Thinking carries display text only.
Core persists and orders the envelope but never interprets its format or payload.
Presentation projection exposes only `id`, `text`, and `status`. Image dimensions
are internal metadata and Provider adapters remove them from the wire. The
optional output limit is an already-resolved invocation policy, not a model
capability fact.

An invocation may also carry a resolved reasoning policy with an optional
Thinking switch and an effort value. `default` means the Client leaves its wire
request unchanged; it is not a model capability. Model capabilities publish
only explicitly supported `on`/`off` switches and non-default effort values.

`sessionId` is optional conversation identity for routing/cache affinity, not
the per-call `invocationId`. Runner supplies the existing Session ID for normal
and Compaction calls. Independent Provider implementations may ignore it.

Provider fragments, indexes, SDK objects, Anthropic `input_schema`, and Responses `function.parameters` remain inside adapter/test boundaries. Complete canonical Tool Calls preserve Provider call identity, name, order, and either ready object input or explicit invalid input state.

Each actual invocation has a local identity and source facts. Concrete Clients
map wire Thinking to invocation-local block IDs, validate their own replay codec
and source compatibility before sending, and restore wire fields only inside the
Client boundary. When a Built-in request switches wire protocols, the target
Chat Completions, Responses, or Anthropic Client omits Thinking blocks it cannot
consume from its wire projection while preserving ordinary assistant text and
Tool history; the internal Transcript remains unchanged. At `runAttempt` entry,
Runner applies `filterIncompatibleThinking` to loaded history before pruning
and budget checks. Historical Thinking is retained only when its invocation
source matches the bound Provider ID, request model ID, and connection endpoint.
Missing or mismatched sources lose only their Thinking blocks; assistant
messages emptied by that filtering are omitted from the request context.
The stored Transcript is unchanged, and current-Turn Thinking remains available
throughout the tool loop. This is a conservative source policy, not a claim
about upstream cross-model compatibility. Clients still validate replay formats
and protocol compatibility; Runner does not interpret replay payloads or treat
a model router's protocol as the wire protocol. Chat Completions
reasoning fields and Responses reasoning item shapes do not enter Runner,
Session, Runtime, or Channel protocol branches.

## 4. Model Invocation failure boundary

Core defines seven categories:

- `authentication`;
- `rate_limit`;
- `invalid_request`;
- `model_not_found`;
- `unavailable`;
- `transport`;
- `provider_failure`.

`ModelInvocationError` carries the structural identity `protocol: 'my-agent.model-invocation-error'` and `version: 1`. `toModelInvocationError(value)` is the Runtime canonicalization entry: it passes through a Host-local instance or accepts an `Error` with valid own data discriminator fields, then creates a Host-local error.

Only allowlisted diagnostics are copied: Provider ID, bounded Provider status/type/code/message/request ID, and a content-free request summary. The summary preserves the opaque model string exactly and counts roles/content block types/Tool definitions without retaining prompts, image data, Tool input, schema, foreign message, stack, cause, or unknown fields. Invalid diagnostics are discarded while a valid category remains usable. Canonical diagnostics and the nested request summary are frozen.

Copilot's protocol Clients emit local structural invocation errors with bounded
diagnostics, including replay validation failures before HTTP is sent. They do
not reflect raw upstream error messages into public invocation diagnostics.
Absent optional diagnostic fields are omitted rather than emitted as
`undefined`, so partial HTTP error details survive Host structural validation.
Thinking blocks are not counted as Tool Results. Runner filters historical
Thinking from another Provider, model, or connection before budget checks and
invocation, so normal model switching does not require a new session.
Direct Client callers remain responsible for supplying source-compatible replay.

Copilot Clients encode `execution_accepted` as a correlated tool output containing
`{"status":"accepted","executionId":"..."}`, matching Built-in receipt content.
Later Host completion notifications remain separate context, not a second
output for the original tool call.

## 5. Unified Built-in Provider

### 5.1 Protocol conversion

The three fetch-based Protocol Clients directly implement the Core
`ModelInvocationPort`. Each uses the model's optional relative `endpoint` as
the complete operation path, or appends its existing protocol-default path when
the field is absent. Explicit endpoints join the configured `baseURL` with one
boundary slash; they do not discard its path or receive another protocol suffix.
The Provider captures a per-protocol model-to-endpoint map once; concurrent
requests select their own model path without mutating shared client state.
Protocol conversion, credential source, and shared connection identity remain
unchanged. Chat Completions retains its existing `max_tokens` HTTP 400
compatibility retry; other calls make one HTTP attempt.

All three Clients send `User-Agent: my-agent/0.1.0` and `x-opencode-session`
without hostname checks. The latter uses the request's Session ID, or a UUID
generated once per logical invocation when absent; HTTP compatibility retries
reuse it. Streaming and collected calls share this behavior. Independent
Extension transports are unchanged.

Clients convert canonical text/image/Tool history, preserve Abort, and normalize
failures through Model Invocation Error V1. A configured effective policy maps
to Anthropic `max_tokens`, Responses `max_output_tokens`, or Chat Completions
`max_tokens`. Without one, OpenAI requests omit output limits and Anthropic
Messages supplies its private required `4,096` fallback.

Responses maps explicit effort to `reasoning.effort` and requests readable
summary only when the model registration declares that private adapter. Chat
Completions maps explicit effort to `reasoning_effort`. Anthropic uses its
configured adaptive or budget adapter and rejects invalid budget/output
combinations before fetch. No Client invents a non-default policy.
For a Built-in OpenAI model that explicitly declares Thinking switches,
`on + default` preserves the deployment's default reasoning behavior by
omitting effort, while `off` maps once to effort `none`. Models without that
declaration reject the switch before fetch.

OpenAI Chat Completions captures ordered reasoning text and at most one non-empty
opaque reasoning value per Assistant response. OpenAI Responses captures summary
deltas for presentation and treats the complete reasoning item as replay
authority. Abort, stream failure, or incomplete item state may preserve readable
partial text but never replay state. Copilot applies the same canonical
Responses boundary through its own Client implementation.

### 5.2 Provider facts and Catalog

`BuiltinLlmProvider` publishes Provider `builtin`, protocol
`builtin-model-router`, and only explicitly configured models. Its private
router selects the Client declared by each model registration without changing
the public Provider identity or opaque model ID. A registration may
independently declare positive safe-integer total Context, Prompt, and output
limits. Its compatibility effective limit is the Prompt limit, otherwise the
Context limit, otherwise the conservative `32,768` fallback. Tool and Media
capabilities remain unknown and therefore fail open. Unknown models fail
closed. Optional `outputTokenLimit` is published separately as an invocation
default and clamped to known maximum output capability.

Each registration may also publish strictly validated reasoning capabilities
and protocol-private mapping facts. The Copilot Provider derives effort
capabilities from discovery metadata, binds each model immutably to Responses
or Chat Completions with Responses precedence, and keeps one stable public
router protocol without retrying through the other wire protocol.

## 6. Built-in Runtime Unit

`createBuiltinLlmProviderUnit()` captures frozen configuration and returns required, initially enabled Unit `builtin-llm-provider`. The Unit exists only when `llm.builtin` is configured. Provider construction is deferred until Unit `create()`; its projection remains enclosed in the instance registration closure and enters Registry staging only through `registerProvider()`.

An empty model registration list publishes an empty Catalog and creates no Protocol Clients or network traffic. Without `llm.builtin`, Runtime does not create the Unit, so empty and Extension-only configurations remain valid. Generic Runtime composition continues to own Unit creation, staging, publication, generation reload, rollback, retirement, and immutable per-Turn binding.

## 7. Copilot external Unit

The experimental `copilot-provider` Unit registers Provider
`copilot-login-experiment`. Registration performs no credential reads, network
requests, or browser launch. Catalog reads or invocations can initiate sign-in
when a valid saved sign-in is unavailable.

The Extension owns GitHub device authorization, its loopback account page,
cross-platform filesystem credentials, and short-lived Copilot access exchange.
Discovery requests `/models` on the authenticated account's HTTPS API endpoint;
inference uses `/responses` or `/chat/completions` directly, without `/v1` or an
intermediate Relay. The Extension does not accept a configured base URL or API key.
Credential and headless-login details are in the
[Copilot Provider guide](../../extensions/copilot-provider/README.md).

Discovery publishes declared `/responses` or `/chat/completions` models with positive safe-integer
output limits and at least one Prompt/Context limit. Copilot preserves the exact
known total Context, Prompt, and output facts; the smaller known Prompt/Context
input boundary remains the compatibility effective limit. Tool support and
image support are published only when metadata proves them; supported image
MIME values are intersected with Core PNG/JPEG/WebP/GIF support. Duplicate
eligible opaque Model IDs fail discovery. Models supporting both routes prefer
Responses. Genuine network, HTTP, metadata and programming failures remain
explicit errors.

Discovery is query-driven, without a Provider TTL or background refresh.
Closing the sign-in page or choosing Cancel returns an empty Copilot catalog
and pauses automatic sign-in for the lifetime of that Provider instance.
Restarting the Host or disabling and re-enabling the Extension resets the pause.
Caller cancellation and Host shutdown do not count as dismissing sign-in.
Unauthenticated bound invocations still fail explicitly, without reopening a
dismissed page or returning an empty successful response.

Already-bound Turns keep their captured facts, account endpoint and private wire
route. A later catalog cannot reroute them; an account endpoint change requires
refresh and reselection.

### 7.1 Responses protocol

The Copilot Responses Client uses raw `fetch` and SSE with `stream: true`; no OpenAI SDK or Runtime protocol branch exists. It:

- maps canonical text/image/Tool history to stateless Responses input;
- uses stable `call_id` for Tool replay instead of response item IDs;
- emits Tool Calls only from complete `response.output_item.done` function-call items;
- recognizes completed and max-output incomplete terminals;
- accepts usage only as non-negative safe integers;
- cancels pending body reads on Abort and preserves `AbortError`.

Malformed JSON/SSE framing, events before creation or after terminal, duplicate/unknown terminal states, invalid Tool identity, duplicate call IDs, invalid Usage, early stream close, HTTP failure, and explicit SSE failure all fail closed without a successful terminal.

The Extension emits a local `Error` satisfying the V1 structural invocation-error contract through type-only public Extension API imports. It neither runtime-imports nor subclasses Host `ModelInvocationError`; Runtime canonicalizes the structural value at the existing Core boundary.

Both Copilot Clients recognize the exact structured `model_not_found` code in
HTTP and explicit SSE errors, preserving bounded diagnostics. Authentication,
rate-limit and server status classifications take precedence. Generic 404,
`invalid_model`, free text and transport failures do not assert model absence.
Runner preserves the common category through its execution wrapper for Channel
refresh, without retry or automatic reselection.

### 7.2 Package and supported Host

Copilot is an npm workspace package under `extensions/copilot-provider`. Its Descriptor points to `entry.ts`; Runtime Bootstrap loads it through the same Jiti path used for other source or built entries. The package imports Host contracts only from `my-agent/extension-api` and owns any package-manager dependencies it adds. Its protocol implementations are local adaptations of the retired Relay implementation, not cross-Extension private imports.

Development uses the source workspace package directly; it is not included in
the root npm release. Agent configuration under `<agentHome>/config.json` controls
Descriptor ID `copilot-provider` through the ordinary `enabled` flag. Its scoped
configuration is empty and rejects unknown fields; there is no separate `active`
switch.

`src/hosts/standalone/standalone-host.ts` passes generic startup facts and zero
or one argument-selected Host-local CLI Unit to Runtime. Runtime Bootstrap
invokes the generic Extension Acquisition boundary and hands acquired
`LoadedRuntimeUnit[]` to composition. Neither Host nor Runtime imports Copilot
or WebSocket Extension implementation or infers their identities. A default
Model Reference comes from ordinary Agent configuration or the atomic
`MY_AGENT_PROVIDER` plus `MY_AGENT_MODEL` environment override.

## 9. Evidence

| Kind | Evidence |
|---|---|
| Source | [Invocation errors](../../src/core/model-invocation/errors.ts), [Built-in Runtime Unit](../../src/builtins/providers/builtin/runtime-unit.ts), [Copilot client](../../extensions/copilot-provider/responses-client.ts) |
| Tests | [Invocation error tests](../../src/core/model-invocation/errors.test.ts), [Built-in protocol tests](../../src/builtins/providers/builtin/protocol-clients.test.ts), [Copilot inference tests](../../extensions/copilot-provider/inference.test.ts) |
| Controlling authority | [Model Resolution Specification](../specifications/model-resolution.md), [Model Invocation Errors Specification](../specifications/model-invocation-errors.md) |
