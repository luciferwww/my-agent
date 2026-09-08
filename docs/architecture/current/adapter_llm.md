# Model Invocation 与 Anthropic Adapter

> 状态同步：2026-09-04（Provider-neutral Core invocation + Slice 3 Tool conversion）
> 关联文档：`core_runner.md` · `core_tools.md` · `runtime.md`

---

## 1. 边界

Provider-neutral invocation contracts 由 `src/core/model-invocation/` 拥有。`AgentRunner` 只消费 Turn-bound `ResolvedModel.invocationPort`，不导入 Anthropic SDK 或 Provider wire types。

`src/adapters/llm/AnthropicClient.ts` 实现 Core Port，并负责所有 Anthropic conversion：

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
