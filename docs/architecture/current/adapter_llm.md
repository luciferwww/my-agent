# Model Invocation 与 Anthropic Adapter

> Status: Current Authority
> Verified: 2026-09-09
> Ownership: Provider protocol, normalized invocation events/errors, and Anthropic Adapter behavior
> Ownership key: provider-protocol-and-anthropic-adapter

---

## 1. 边界

Provider-neutral invocation contracts 由 `src/core/model-invocation/` 拥有。`AgentRunner` 只消费 Turn-bound `ResolvedModel.invocationPort`，不导入 Anthropic SDK 或 Provider wire types。

`src/adapters/llm/AnthropicClient.ts` semantically implements the Core invocation contract and owns Anthropic conversion：

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

src/adapters/llm/
├── AnthropicClient.ts          # production Anthropic adapter
├── tool-contract-codecs.ts     # Anthropic/OpenAI-compatible pure reference codecs
├── types.ts                    # deprecated compatibility re-export only
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

Fragments、Provider indexes、SDK objects、`input_schema` 和 `function.parameters` 不越过 Adapter boundary。

## 4. Anthropic streamed calls

Anthropic SDK 将 Tool block 分成 `content_block_start`、多个 `input_json_delta` 和 `content_block_stop`。Adapter 按 block identity/index 隔离累积，只在 block 完整时解析并输出 canonical call。

- id/name 缺失或空值：normalized Provider response failure；
- response 内 duplicate call ID：failure，任何 Tool 都不执行；
- JSON malformed：保留 id/name，`input.state = invalid/malformed_json`；
- decoded value 非 plain object：`input.state = invalid/not_an_object`；
- AbortSignal 透传 SDK，Runner 负责 Turn-level abort closure。

## 5. Portable conversion proof

`tool-contract-codecs.ts` 不依赖 OpenAI SDK。Contract tests 证明 canonical shared semantics 可转换为 Anthropic 和 OpenAI-compatible function tools：

- definition name/description/portable Schema；
- complete、streamed、multiple and interleaved calls；
- call order、identity、name、decoded object input；
- malformed/non-object input 和 duplicate identity fail-closed；
- result correlation/content。

Core-only `ToolResultOutcome` 不要求从 OpenAI-compatible role=`tool` message 反向恢复。Anthropic `is_error` 只是有损 projection hint，不扩大 portable shared contract。

## 6. Provider Facts and compatibility boundary

`AnthropicProvider` publishes Provider identity, endpoint normalization, model canonicalization, deployment facts and invocation construction to [Model Resolution](./core_model_resolution.md). Runner consumes only the resulting Turn-bound `ResolvedModel`; this topic does not own resolution policy, Runtime composition, or Config precedence.

The production client currently imports `LLMClient`, `ChatParams`, and `StreamEvent` through `src/adapters/llm/types.ts`. That file is a deprecated compatibility re-export of Core contracts, so current behavior remains Core-compatible while the import path and aliases are still an API-M04 residual. Tests, scripts and the barrel also retain recorded facade references. Alias/path removal remains separately gated and is not authorized by this Current description.

## 7. Evidence

| Kind | Evidence |
|---|---|
| Source | [AnthropicClient.ts](../../../src/adapters/llm/AnthropicClient.ts), [AnthropicProvider.ts](../../../src/adapters/llm/AnthropicProvider.ts), [tool-contract-codecs.ts](../../../src/adapters/llm/tool-contract-codecs.ts), [Core invocation types](../../../src/core/model-invocation/types.ts), [compatibility facade](../../../src/adapters/llm/types.ts) |
| Tests | [AnthropicClient.test.ts](../../../src/adapters/llm/AnthropicClient.test.ts), [AnthropicProvider.test.ts](../../../src/adapters/llm/AnthropicProvider.test.ts), [tool-contract-codecs.test.ts](../../../src/adapters/llm/tool-contract-codecs.test.ts), [ft-03-runner-boundary.test.ts](../../../src/architecture-fitness/ft-03-runner-boundary.test.ts), [ft-08-contract-inventory.test.ts](../../../src/architecture-fitness/ft-08-contract-inventory.test.ts) |
| Controlling authority | [ADR-002](../adr-002-context-budgeting-and-compaction-recovery.md), [ADR-004](../adr-004-provider-model-identity-and-facts-ownership.md), [Model Resolution Module Spec](../model-resolution-module-spec.md) |
