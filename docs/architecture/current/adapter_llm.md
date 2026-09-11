# Model Invocation、Anthropic 与 Copilot Relay Adapter

> Status: Current Authority
> Verified: 2026-09-09
> Ownership: Provider protocol, normalized invocation events/errors, and Anthropic/Copilot Relay Adapter behavior
> Ownership key: provider-protocol-and-anthropic-adapter

---

## 1. 边界

Provider-neutral invocation contracts 由 `src/core/model-invocation/` 拥有。`AgentRunner` 只消费 Turn-bound `ResolvedModel.invocationPort`，不导入 Anthropic SDK 或 Provider wire types。

`src/adapters/provider/anthropic/AnthropicClient.ts` semantically implements the Core invocation contract and owns Anthropic conversion：

- canonical Tool definition → Anthropic `input_schema`；
- Anthropic streamed Tool blocks → complete canonical `tool_call`；
- malformed/non-object input → explicit canonical invalid state；
- canonical result history → Anthropic correlated `tool_result`；
- SDK errors → core-owned normalized invocation errors。

## 2. 目录结构

```text
src/core/model-invocation/
├── types.ts                    # ModelInvocationPort/request/event/message
├── errors.ts                   # normalized invocation errors
└── index.ts

src/adapters/provider/anthropic/
├── AnthropicClient.ts          # production Anthropic SDK/protocol adapter
├── AnthropicProvider.ts        # Provider facts and invocation binding
├── tool-codec.ts               # production Anthropic Tool definition codec
└── index.ts                    # concrete Anthropic adapter surface

src/core/tools/
├── provider-portability-fixtures.ts # test-only canonical vectors
└── provider-portability.test.ts     # independent reference codecs

src/runtime-modules/
└── anthropic-provider.ts       # required bundled Provider Unit

src/extensions/copilot-relay-provider/
├── copilot-relay-provider-unit.ts # optional external Unit and bounded discovery
├── copilot-relay-provider.ts      # closed endpoint-scoped Provider projection
├── responses-client.ts            # raw HTTP Responses/SSE adapter
├── model-metadata.ts              # Relay metadata eligibility and facts
└── index.ts
```

## 3. Core invocation shape

```text
ModelInvocationPort {
  chatStream(request): AsyncIterable<ModelStreamEvent>
  chat(request): Promise<ModelInvocationResponse>
}

ModelInvocationRequest {
  model: string
  system?: string
  messages: canonical ChatMessage[]
  tools?: canonical ToolDefinition[]
  maxTokens: number
  signal?: AbortSignal
}

ModelStreamEvent =
  | message_start
  | text_delta
  | { type: 'tool_call'; call: CanonicalToolCall }
  | message_end
```

`maxTokens` 是 post-resolution required value：normal、Tool loop 与 Compaction invocation 均从同一 Turn-bound `ResolvedModel.limits.maxTokens` 取得。Provider Adapter 不提供本地默认值，也不重新解释 Policy。

Fragments、Provider indexes、SDK objects、`input_schema` 和 `function.parameters` 不越过 Adapter boundary。

## 4. Anthropic streamed calls

Anthropic SDK 将 Tool block 分成 `content_block_start`、多个 `input_json_delta` 和 `content_block_stop`。Adapter 按 block identity/index 隔离累积，只在 block 完整时解析并输出 canonical call。

- id/name 缺失或空值：normalized Provider response failure；
- response 内 duplicate call ID：failure，任何 Tool 都不执行；
- JSON malformed：保留 id/name，`input.state = invalid/malformed_json`；
- decoded value 非 plain object：`input.state = invalid/not_an_object`；
- AbortSignal 透传 SDK，Runner 负责 Turn-level abort closure。

## 5. Portable conversion proof

`provider-portability.test.ts` 的独立 reference codecs 不依赖 Anthropic/OpenAI SDK。Contract tests 证明 canonical shared semantics 可转换为 Anthropic 和 OpenAI-compatible function tools：

- definition name/description/portable Schema；
- complete、streamed、multiple and interleaved calls；
- call order、identity、name、decoded object input；
- malformed/non-object input 和 duplicate identity fail-closed；
- result correlation/content。

Core-only `ToolResultOutcome` 不要求从 OpenAI-compatible role=`tool` message 反向恢复。Anthropic `is_error` 只是有损 projection hint，不扩大 portable shared contract。

Production `tool-codec.ts` 与 portability reference codecs 不共享实现；两侧测试共享 test-only canonical fixtures 和 expectations，防止 Anthropic definition conversion 静默漂移。Core test 不导入 Anthropic Adapter，production 不导入 reference codec 或 fixtures。

## 6. Provider Facts and public boundary

`AnthropicProvider` publishes Provider identity, endpoint normalization, model canonicalization, deployment facts and invocation construction to [Model Resolution](./core_model_resolution.md). Runner consumes only the resulting Turn-bound `ResolvedModel`; this topic does not own resolution policy, Runtime composition, or Config precedence.

Core Model Invocation is the sole type authority. `AnthropicClient` directly implements `ModelInvocationPort` and consumes `ModelInvocationRequest`, `ModelStreamEvent`, and `ModelInvocationResponse` from `src/core/model-invocation/`. The Adapter barrel exports the concrete Anthropic client/provider surface only; it does not re-export Core invocation contracts.

The former Adapter compatibility facade and its `LLMClient`, `ChatParams`, and `StreamEvent` aliases were removed in S6-D7 after repository callers migrated. No facade import path, alias export, or dual execution path remains. The Core `ChatResponse` alias is retained as a Core-owned type alias, but repository consumers use `ModelInvocationResponse` directly.

## 7. Bundled Runtime Module ownership

`src/runtime-modules/anthropic-provider.ts` owns the bundled construction boundary. `createAnthropicProviderModule()` captures immutable Provider options and returns the required, initially-enabled builtin Unit `builtin-anthropic-provider`. `AnthropicProvider` is constructed only when Composition invokes `LoadedRuntimeUnit.create()`; the resulting Provider entry remains enclosed in the instance registration closure and enters Registry staging only through `ExtensionRegistrationApi.registerProvider()`.

Runtime Builder maps validated Config into module options and adds the singular Unit to the catalog. It does not construct the concrete Adapter, inspect a Provider entry before staging, or own a Provider registration loop. Runtime Composition owns generic Unit creation, staging, publication and cleanup; the module owns Anthropic construction and any resources acquired inside that boundary.

`AnthropicProvider` publishes one closed, endpoint-scoped model Catalog. The official Anthropic endpoint seeds the static Catalog and exact matching `deploymentFacts` may supplement or override individual entries. A custom endpoint publishes only models proven by exact endpoint-scoped deployment facts; it does not inherit the official Catalog or a legacy context-window fallback. Registry staging validates, defensively copies, and freezes the public Catalog before publication.

Construction or Provider-option validation failure is startup-fatal for this required Unit and is attributed to `builtin-anthropic-provider`, phase `create`. No RuntimeApp kernel or `app_ready` event exists on that path. Default Provider selection and Snapshot publication remain Runtime responsibilities, not Adapter responsibilities.

## 8. Copilot Relay external Unit

`src/extensions/copilot-relay-provider/` implements the optional external Unit `copilot-relay-provider` and publishes Provider `copilot-relay`. Unit `create(signal)` validates a credential-free loopback HTTP(S) URL, performs one bounded `/v1/models` discovery, filters entries to exact `/responses` support plus usable prompt/output limits, and freezes an endpoint-scoped closed Catalog. A blank API key emits no Authorization header. Discovery failure follows generic optional external Unit isolation and publishes no partial Provider.

`CopilotRelayResponsesClient` uses raw `fetch` with `stream: true`; no OpenAI SDK or Runtime branch is involved. It maps canonical text/image/Tool history to stateless Responses input, uses `call_id` rather than unstable item IDs, emits complete Tool Calls from `response.output_item.done`, and derives the sole successful terminal from completed or recognized max-output incomplete events. Usage is accepted only as non-negative safe integers. Malformed framing, ordering, identity, Usage, unknown terminal, duplicate terminal, early close, HTTP failure, and SSE failure are normalized fail-closed; Abort remains AbortError and cancels pending body reads.

The supported Host in `scripts/server.ts` reads `COPILOT_RELAY_BASE_URL` and `COPILOT_RELAY_API_KEY`, directly acquires the in-repo Unit, and passes it through `RuntimeAppOptions.loadedUnits` beside the WebSocket Channel. The Extension itself reads no environment. Other scripts remain legacy and are not Provider contract authorities.

## 9. Evidence

| Kind | Evidence |
|---|---|
| Source | [AnthropicClient.ts](../../../src/adapters/provider/anthropic/AnthropicClient.ts), [AnthropicProvider.ts](../../../src/adapters/provider/anthropic/AnthropicProvider.ts), [tool-codec.ts](../../../src/adapters/provider/anthropic/tool-codec.ts), [Anthropic Provider Runtime Module](../../../src/runtime-modules/anthropic-provider.ts), [Copilot Relay Unit](../../../src/extensions/copilot-relay-provider/copilot-relay-provider-unit.ts), [Copilot Relay Provider](../../../src/extensions/copilot-relay-provider/copilot-relay-provider.ts), [Responses client](../../../src/extensions/copilot-relay-provider/responses-client.ts), [Relay metadata](../../../src/extensions/copilot-relay-provider/model-metadata.ts), [supported server Host](../../../scripts/server.ts), [runtime-builder.ts](../../../src/runtime/runtime-builder.ts), [Core invocation types](../../../src/core/model-invocation/types.ts) |
| Tests | [AnthropicClient.test.ts](../../../src/adapters/provider/anthropic/AnthropicClient.test.ts), [AnthropicProvider.test.ts](../../../src/adapters/provider/anthropic/AnthropicProvider.test.ts), [tool-codec.test.ts](../../../src/adapters/provider/anthropic/tool-codec.test.ts), [Relay Unit tests](../../../src/extensions/copilot-relay-provider/copilot-relay-provider-unit.test.ts), [Responses client tests](../../../src/extensions/copilot-relay-provider/responses-client.test.ts), [anthropic-provider.test.ts](../../../src/runtime-modules/anthropic-provider.test.ts), [runtime-builder.test.ts](../../../src/runtime/runtime-builder.test.ts), [provider-portability.test.ts](../../../src/core/tools/provider-portability.test.ts), [ft-03-runner-boundary.test.ts](../../../src/architecture-fitness/ft-03-runner-boundary.test.ts), [ft-08-contract-inventory.test.ts](../../../src/architecture-fitness/ft-08-contract-inventory.test.ts) |
| Controlling authority | [ADR-002](../adr-002-context-budgeting-and-compaction-recovery.md), [ADR-004](../adr-004-provider-model-identity-and-facts-ownership.md), [ADR-005](../adr-005-extension-registry-runtime-composition.md), [Model Resolution Module Spec](../model-resolution-module-spec.md), [Source Layout Convergence Migration Spec](../source-layout-convergence-migration-spec.md) |
