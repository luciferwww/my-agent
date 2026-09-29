# Thinking 展示与开关设计草稿

> Status: Non-authoritative design draft
> Authorization: 不授权实现，不覆盖 Current Architecture、Accepted Decisions、Stable Specifications 或源代码
> 创建日期：2026-09-29
> Scope: 全 Provider 的 thinking 内容采集、核心事件透传、Channel 展示，以及 `llm.thinking` 全局开关（覆盖 Built-in 三协议与 Extension Provider）
> Evidence: 2026-09-29 针对 Ollama + Qwen3.8-27B-UD-IQ4_XS 的三协议本地实测（§2.1–2.3）；同日核实 OpenAI（Azure OpenAI 官方文档 + Codex 源码）与 Anthropic（官方 TypeScript SDK）的官方参数支持矩阵（§2.4）；主流 agent 持久化与回放策略调研（§14，证据含 Claude Agent SDK / OpenClaw / Codex 源码引用）
> Related: [Built-in LLM Provider 设计草稿](builtin-llm-providers-design-draft.md)、[Tool Activity 展示设计草稿](tool-activity-presentation-design-draft.md)、[Model-Aware Output Control](../changes/archive/model-aware-output-control/plan.md)（其非目标中的 Thinking 项由本文跟进）

## 1. 问题与结论

thinking 类模型（Qwen3、Claude extended thinking、OpenAI reasoning 模型）在思考阶段可能持续数十秒。当前实现中，思考内容在 Protocol Client 层被静默丢弃，用户在此期间观察不到任何输出；同时 thinking token 计入 `usage.output_tokens`，成本已经发生。配置层面没有控制上游 thinking 行为的开关。

术语约定：canonical 内部术语统一为 thinking；OpenAI wire 层称 reasoning，字段名差异由各 Client 吸收。

本草稿结论：

1. 核心流契约 `ModelStreamEvent` 新增 `thinking_delta` 事件；Built-in 三个 Protocol Client 与 Copilot Relay 把各自协议的 thinking/reasoning 增量映射为该事件。
2. `ChatContentBlock` 新增 `thinking` 块；Runner 组装进 Assistant 消息并随 Transcript 持久化，Anthropic 协议续轮原样回传（含 `signature`）。
3. `AgentEvent` 新增 `thinking_delta`；Channel 走既有 Fanout。Web 客户端渲染可折叠 Thinking 卡片（流式时展开、回答开始后自动折叠），CLI 以暗色文本内联输出。
4. 开关位于 `llm.thinking`（可选 boolean），是 Provider 中立的全局设置。Runner 把生效值注入每一次 `ModelInvocationRequest.thinking`，覆盖全部 Provider；Built-in 三个 Protocol Client 与 Copilot Relay 映射为各自 wire 参数，其他 Extension Provider 可自行采纳。
5. 展示与开关解耦：开关只决定是否发送 wire 参数；上游返回 thinking 内容时一律展示。

事件流：

```text
上游 SSE
  → Protocol Client        （thinking_delta / signature 捕获）
  → ModelStreamEvent       （thinking_delta）
  → AgentRunner            （转发 AgentEvent + 组装 thinking 块）
  → Channel Fanout         （Web / CLI 展示）
  → Session Transcript     （assistant content 含 thinking 块）
```

## 2. 协议事实（2026-09-29 实测）

实测环境：Ollama `127.0.0.1:11434`，模型 `Qwen3.8-27B-UD-IQ4_XS:latest`（该模型默认思考模式开启）。实测方法：PowerShell `Invoke-WebRequest`/`Invoke-RestMethod` 直接向三个端点发送最小请求，检查响应中 thinking/reasoning 字段的实际形态与参数接受度。

### 2.1 anthropic-messages（`/v1/messages`）

缺省请求（不带 thinking 参数）思考开启，流式响应：

```json
{"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}
{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"The"}}
{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":" user"}}
{"type":"content_block_stop","index":0}
{"type":"content_block_start","index":1,"content_block":{"type":"text","text":""}}
{"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"2"}}
```

参数实测：

| 请求参数 | 结果 |
|---|---|
| 省略 | 思考开启 |
| `thinking:{type:"disabled"}` | 接受，思考关闭 |
| `thinking:{type:"enabled"}` | 接受（不要求 budget_tokens） |
| `thinking:{type:"enabled",budget_tokens:2048}` | 接受 |

Ollama 返回的 thinking block 只有 `thinking` 字段，没有 `signature`。

### 2.2 openai-chat-completions（`/v1/chat/completions`）

缺省请求思考开启。流式 chunk 中思考内容位于 `delta.reasoning`，且每个思考 chunk 同时携带空字符串 `content`：

```json
{"choices":[{"index":0,"delta":{"role":"assistant","content":"","reasoning":"The"},"finish_reason":null}]}
{"choices":[{"index":0,"delta":{"content":"","reasoning":" user"},"finish_reason":null}]}
```

回答阶段 `delta.content` 非空、`reasoning` 消失。

参数实测：

| 请求参数 | 结果 |
|---|---|
| 省略 | 思考开启 |
| `reasoning_effort:"none"` | 接受，思考关闭（流式无 reasoning 字段） |
| `reasoning_effort:"minimal"` | 接受，但思考仍开启（Ollama 未把 minimal 映射为关闭） |
| `chat_template_kwargs:{enable_thinking:false}` | 接受但被忽略，思考仍开启 |
| 顶层 `enable_thinking:false` | 接受但被忽略，思考仍开启 |

### 2.3 openai-responses（`/v1/responses`）

端点存在。`reasoning:{effort:"low"}` 时流式推送：

```json
{"item":{"id":"rs_903796","summary":[],"type":"reasoning"},"output_index":0,"type":"response.output_item.added"}
{"delta":"The","item_id":"rs_903796","summary_index":0,"type":"response.reasoning_summary_text.delta"}
```

`reasoning:{effort:"none"}` 接受，思考关闭（无 reasoning item，直接输出 message）。

实测补充：该端点要求 `input` 为结构化数组（`[{role, content:[{type:"input_text",...}]}]`），与 Chat Completions 的 `messages` 形态不同；`response.created` 事件回显请求的 `reasoning` 配置。

### 2.4 官方 API 事实（2026-09-29 核实）

**Anthropic Messages API**（来源：官方 TypeScript SDK `anthropics/anthropic-sdk-typescript` `src/resources/messages/messages.ts` 类型定义）：

- `ThinkingConfigParam` 有四种 type：`enabled`（必须携带 `budget_tokens`，最小 `1024` 且小于 `max_tokens`）、`disabled`、`between_tools`、`adaptive`（较新模型推荐，部分旧模型 SDK 对 `enabled` 发出迁移警告）；

  ```ts
  /**
   * Body param: Configuration for enabling Claude's extended thinking.
   *
   * When enabled, responses include `thinking` content blocks showing Claude's
   * thinking process before the final answer. Requires a minimum budget of 1,024
   * tokens and counts towards your `max_tokens` limit.
   */
  thinking?: ThinkingConfigParam;
  ```

- thinking block 携带 `signature`，流式以 `signature_delta` 下发（在 `content_block_stop` 之前）；

  ```ts
  export interface ThinkingBlockParam {
    /**
     * The `signature` value of this thinking block, exactly as returned by the API in
     * a previous response. Used to verify that the block was generated by Claude.
     *
     * Thinking blocks must be passed back unmodified and in their original order; a
     * modified block results in a 400 `invalid_request_error`.
     */
    signature: string;
    thinking: string;
    type: 'thinking';
  }
  ```

- 工具调用续轮必须把当前 Turn 的 thinking block（含 signature）**原序原样**回传；修改过的 block 返回 400 `invalid_request_error`；
- 存在 `redacted_thinking` block：安全审查脱敏的 thinking 以加密 `data` 返回（无可读文本），同样必须原样回传；

  ```ts
  export interface RedactedThinkingBlock {
    /**
     * The contents of this redacted thinking block, returned when portions of the
     * model's thinking were safety-redacted. This field is opaque and encrypted, with
     * no readable content.
     *
     * Pass `redacted_thinking` blocks back to the API unchanged when continuing a
     * multi-turn conversation.
     */
    data: string;
    type: 'redacted_thinking';
  }
  ```

- `usage.output_tokens_details.thinking_tokens` 提供思考 token 分解。

**OpenAI Chat Completions / Responses**（来源：Azure OpenAI 官方文档 `learn.microsoft.com/en-us/azure/ai-foundry/openai/how-to/reasoning`（2026-09-21 更新，与 OpenAI API 行为一致）+ Codex 源码，见 §14.3）：

- `reasoning_effort` 合法值：`none` / `minimal` / `low` / `medium` / `high` / `xhigh` / `max`，**因模型而异**。文档原文：

  > The `reasoning_effort` parameter controls how much the model thinks before it answers. Supported values vary by model and include `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, and `max`. Defaults vary by model as well.

- GPT-6 系列支持 `none`（特性表 "Reasoning effort ✅ (including `none`)"）；gpt-5.1 默认值即 `none`（脚注 "gpt-5.1 reasoning_effort defaults to none"）；
- `minimal` 只被初代 GPT-5 接受（脚注 "`minimal` works only with the original GPT-5 reasoning models. `minimal` doesn't work with `gpt-5.1` or greater"）；
- gpt-5-pro 只支持 `high`（脚注 "gpt-5-pro only supports reasoning_effort high"）；o1-mini 完全不支持 `reasoning_effort`（"Note: `o1-mini` doesn't support `reasoning_effort`"）；
- gpt-5.6 在 Chat Completions 上携带 `tools` 时只接受 `reasoning_effort: "none"`，否则 400：

  > Function tools with reasoning_effort are not supported for gpt-5.6-sol in /v1/chat/completions. To use function tools, use /v1/responses or set reasoning_effort to 'none'.

- Responses API 的 reasoning summary 是思考摘要（`response.reasoning_summary_text.delta`），原始 reasoning 不透出；
- **两协议 reasoning 回传能力不同**：Chat Completions 的 `messages` 没有 reasoning 输入类型，无法回传；Responses API 接受并推荐回传 reasoning item。文档原文：

  > When a reasoning model calls functions through the Responses API, pass the reasoning items from the previous response back along with your function output. If the model called several functions in a row, send every reasoning item, function call item, and function call output item since the last user message.

  Codex 的实际做法见 §14.3（`include: ["reasoning.encrypted_content"]` + 加密 blob 回放 + `reasoning.context: "all_turns"`）。

设计按上述官方约束取值；Ollama 对放宽字段均兼容（§2.1–2.3 实测）。

## 3. 当前实现事实

- `AnthropicMessagesClient` 只处理 `text_delta` 与 `input_json_delta`；thinking block 的 `content_block_start`、`thinking_delta`、`signature_delta` 落入既有分支被静默忽略。
- `OpenAIResponsesClient` 的 default 分支只拒绝 `response.xxx` 形态的单级事件名；`response.reasoning_summary_text.delta` 与 reasoning 类 `response.output_item.added` 含多级点号，被静默忽略。
- Copilot Relay 的 `responses-client` 同样只处理 `output_text` / `function_call`；`response.reasoning_summary_text.delta` 与 reasoning 类 `response.output_item.added` 落入 default 分支被静默忽略（其未知状态检测只匹配单级点号事件名）。
- `OpenAIChatCompletionsClient` 只读 `delta.content`；Ollama 思考阶段每个 chunk 的 `content:""` 会产生空字符串 `text_delta` 事件。
- `ModelStreamEvent`、`ChatContentBlock`、`AgentEvent`、Session `ContentBlock` 均无 thinking 概念。
- Web 客户端 Turn 气泡在首个 `text_delta`/`tool_use` 才创建；Ollama 思考期间的空 `text_delta` 会创建空文本气泡（无可见内容）；`llm_call` 只进事件日志面板。
- thinking token 已计入 `usage.output_tokens`（三协议一致）。

## 4. 配置设计

### 4.1 字段与位置

开关位于 `llm.thinking`，与 `llm.defaultModel` 平级：

```json
{
  "llm": {
    "thinking": false,
    "defaultModel": {
      "providerId": "builtin",
      "modelId": "Qwen3.8-27B-UD-IQ4_XS:latest"
    },
    "builtin": {
      "baseURL": "http://127.0.0.1:11434/v1",
      "models": [
        {
          "modelId": "Qwen3.8-27B-UD-IQ4_XS:latest",
          "protocol": "anthropic-messages"
        },
        {
          "modelId": "gemma4:26b",
          "protocol": "openai-chat-completions"
        }
      ]
    }
  }
}
```

`llm` 是 Provider 中立的 LLM 模块配置层。thinking 开关作用于所有 Provider（Built-in 与 Extension），因此放在 `llm` 顶层而非 `llm.builtin` 内。

### 4.2 语义

三态语义：

| 值 | 含义 | wire 行为 |
|---|---|---|
| 省略（默认） | 无偏好 | 不发送任何 thinking/reasoning 参数，各模型默认行为生效 |
| `true` | 显式开启 | 各 Provider 发送其协议的 enable 参数 |
| `false` | 显式关闭 | 各 Provider 发送其协议的 disable 参数 |

缺省不发参数是安全默认：Ollama 上游对未知参数宽松（实测 `chat_template_kwargs`、顶层 `enable_thinking` 均被静默忽略），Qwen3 默认思考、Claude 默认不思考，缺省行为即模型自身默认。显式设置时，严格上游（OpenAI、Anthropic 官方 API）对不支持 thinking 的模型会拒绝参数（OpenAI 返回 400 "Unrecognized request argument"，Anthropic 返回 400 "thinking is not supported for this model"）；该失败按既有 Model Invocation Error V1 归一为 `invalid_request` 上浮，用户改回省略或换模型即可。个人 agent + 本地 Ollama 场景下该风险实际不存在。

### 4.3 校验与所有权

- `llm.thinking`：可选 `boolean`；存在且非 boolean 时配置失败，路径 `llm.thinking`。
- 校验位于 `platform/config`（`agent-config-loader.ts` 的 `validateLlm`），与 `llm.defaultModel` 同层；`LLMConfig` 增加 `thinking?: boolean` 字段。`LLMConfig` 由 `src/builtins/providers/builtin/config.ts` 拥有，但 `thinking` 字段语义是 Provider 中立调用策略，注释需明确这一点。

### 4.4 注入路径

```text
config.json llm.thinking
  → AppConfig.llm.thinking（platform/config 校验、冻结）
  → RuntimeResourceSet.appConfig
  → RuntimeApp.runTurn → agentRunner.run({ ..., thinking })
  → AgentRunner.callLLMStream → chatStream({ ..., thinking })
  → ModelInvocationRequest.thinking（全部 Provider 可见）
```

- `RunParams` 增加 `thinking?: boolean`；RuntimeApp 从 `appConfig.llm.thinking` 读取并传入（与 `maxLlmCalls` 的传递方式一致）；
- `AgentRunner.callLLMStream` 把 `params.thinking` 写入 `ModelInvocationRequest`（与 `outputTokenLimit` 的注入方式一致）；
- Compaction 摘要调用（`compactMessages`）不注入 thinking（摘要请求无需思考，且剥离 thinking 块后无回传需求）。

### 4.5 与既有设计的关系

- [Model-Aware Output Control](../changes/archive/model-aware-output-control/plan.md) 将 "Reasoning Effort / Thinking Budget / Thinking 选择 UI" 列为非目标；本文是该项的后续设计，首期只提供 boolean 开关，不提供 effort/budget 数值配置。
- [Built-in LLM Provider 设计草稿](builtin-llm-providers-design-draft.md) §6.2 把 `reasoning` 列为"不要求用户配置"的字段；该原则保持——`thinking` 是可选开关，缺省不增加配置负担。

## 5. 核心契约变更

### 5.1 ModelStreamEvent

```ts
export type ModelStreamEvent =
  | { type: 'message_start' }
  | { type: 'text_delta'; text: string }
  | { type: 'thinking_delta'; text?: string; signature?: string }
  | { type: 'tool_call'; call: ToolCall }
  | { type: 'message_end'; stopReason: string; usage: TokenUsage }
  | { type: 'error'; error: Error };
```

`thinking_delta` 的 `text` 与 `signature` 至少一个存在，均为增量，消费方自行累积。`signature` 仅 Anthropic 协议产生，供 thinking 块回传使用。

### 5.2 ChatContentBlock

```ts
| { type: 'thinking'; thinking: string; signature?: string }
| { type: 'redacted_thinking'; data: string }
```

`thinking` 字段名与 Anthropic wire 形态一致，回传时原样序列化。Ollama 产生的 thinking 块无 `signature`。`redacted_thinking` 是 Anthropic 安全脱敏的加密块（无可读文本），同样必须原样回传；Runner 对其不产生 `thinking_delta` 事件，仅保留在 content 中供回传。

### 5.3 ModelInvocationRequest

```ts
export interface ModelInvocationRequest {
  model: string;
  system?: string;
  messages: ChatMessage[];
  tools?: ChatToolDefinition[];
  outputTokenLimit?: number;
  thinking?: boolean;
  signal?: AbortSignal;
}
```

`thinking` 是已解析的调用策略，定位与 `outputTokenLimit` 相同：缺省表示无偏好，Client 不发送相关参数。该字段由 Runner 从全局配置注入，对所有 Provider 生效；各 Provider 自行决定映射方式，不支持的 Provider 忽略即可。

### 5.4 AgentEvent

```ts
| { type: 'thinking_delta'; sessionId: string; turnId: string; text: string }
```

只携带 `text`；`signature` 不出 Core 边界。

## 6. Protocol Client 行为

### 6.1 AnthropicMessagesClient

事件采集：

- `content_block_start` 且 `content_block.type === 'thinking'`：进入 thinking 采集状态；
- `content_block_start` 且 `content_block.type === 'redacted_thinking'`：记录 redacted 块（不产生 `thinking_delta`），`content_block_stop` 时组装 `{ type: 'redacted_thinking', data }`；
- `content_block_delta` 且 `delta.type === 'thinking_delta'`：`yield { type: 'thinking_delta', text: delta.thinking }`；
- `content_block_delta` 且 `delta.type === 'signature_delta'`：`yield { type: 'thinking_delta', signature: delta.signature }`；
- `content_block_stop`：结束采集状态。

历史回传（`convertMessages`）：只回传**最后一条** assistant 消息中的 `thinking` / `redacted_thinking` 块（含 `signature` / `data`，保持原始顺序）；更早的 assistant 消息剥离 thinking 块。真实 Anthropic 只要求当前轮（发起 tool call 的那条 assistant 消息）的 thinking 完整回传，修改过的块会得到 400 `invalid_request_error`；更早轮次的 thinking 回传无收益且浪费上下文 token（OpenClaw `dropThinkingBlocks` 采用同款策略，见 §15）。Ollama 无 signature，回传无害。

请求参数（`buildRequest`）：

- `request.thinking === true`：

  ```text
  maxTokens    = request.outputTokenLimit ?? 4096
  maxTokens    = max(maxTokens, 2048)      // 协议要求 max_tokens > budget_tokens ≥ 1024
  budgetTokens = max(1024, min(floor(maxTokens / 2), maxTokens - 1024))
  → thinking: { type: "enabled", budget_tokens: budgetTokens }
  ```

  4096 → budget 2048；2048 → budget 1024；8192 → budget 4096。抬升 `max_tokens` 属于协议适配，与既有 `4,096` fallback 同类。

- `request.thinking === false`：`thinking: { type: "disabled" }`。
- 缺省：不发送 `thinking` 字段。

### 6.2 OpenAIChatCompletionsClient

事件采集：

- `delta.reasoning` 为非空字符串：`yield { type: 'thinking_delta', text: delta.reasoning }`；
- `delta.content` 为非空字符串才产生 `text_delta`；空字符串跳过（修正当前实现对 Ollama 思考阶段 `content:""` 产生空 `text_delta` 的行为）。

历史转换：assistant content 中的 `thinking` 块在 `convertMessages` 中剥离（OpenAI 协议不接受回传 reasoning 内容）。

请求参数：

- `true` → `reasoning_effort: "medium"`；
- `false` → `reasoning_effort: "none"`；
- 缺省 → 不发送。

### 6.3 OpenAIResponsesClient

事件采集：

- `response.output_item.added` 且 `item.type === 'reasoning'`：进入采集状态；
- `response.reasoning_summary_text.delta`：`yield { type: 'thinking_delta', text: event.delta }`。

历史转换：Responses 协议**接受** reasoning item 回传（Codex 实证，见 §2.4）。首期实现剥离 `thinking` 块（与 Chat Completions 一致），原因：

1. 我们采集的是 reasoning **summary**（摘要文本），不是可回传的 `encrypted_content`——回传摘要文本不是该协议的有效输入形态；
2. 采集并回传 `encrypted_content` 需要请求带 `include: ["reasoning.encrypted_content"]` 并在 `ChatContentBlock` 中新增加密 blob 字段，属于独立增强，首期不做。

后续增强方向（记录，不实施）：`thinking` 块增加可选 `encryptedContent` 字段，请求带 `include`，历史转换把带加密内容的 thinking 块映射回 reasoning item 回传，获得跨轮推理连续性。

请求参数：

- `true` → `reasoning: { effort: "medium" }`；
- `false` → `reasoning: { effort: "none" }`；
- 缺省 → 不发送。

### 6.4 映射总表

| `request.thinking` | anthropic-messages | openai-responses | openai-chat-completions |
|---|---|---|---|
| 缺省 | 省略字段 | 省略字段 | 省略字段 |
| `true` | `thinking:{type:"enabled",budget_tokens:推导}` | `reasoning:{effort:"medium"}` | `reasoning_effort:"medium"` |
| `false` | `thinking:{type:"disabled"}` | `reasoning:{effort:"none"}` | `reasoning_effort:"none"` |

严格上游兼容性（官方支持矩阵见 §2.4）：`reasoning_effort` 的合法值因模型而异——gpt-5.1+ 不接受 `minimal`，gpt-5-pro 只接受 `high`，o1-mini 完全不接受该参数，gpt-5.6 在 Chat Completions 带 tools 时只接受 `none`。被拒绝时按既有 Model Invocation Error V1 归一为 `invalid_request` 上浮；用户改回省略或换模型。

## 7. Copilot Relay Provider

Copilot Relay 使用 OpenAI Responses 协议，行为与 `OpenAIResponsesClient` 对齐：

事件采集：

- `response.output_item.added` 且 `item.type === 'reasoning'`：进入采集状态；
- `response.reasoning_summary_text.delta`：`yield { type: 'thinking_delta', text: event.delta }`。

历史转换：`convertMessages` 剥离 `thinking` 块（switch 增加 default 跳过）。Chat Completions 的 `messages` 没有 reasoning 输入类型，无法回传；Copilot Relay 上游行为同 Responses，首期同样剥离（同 §6.3 的理由与增强方向）。

请求参数（`buildResponsesRequest`）：

- `true` → `reasoning: { effort: "medium" }`；
- `false` → `reasoning: { effort: "none" }`；
- 缺省 → 不发送。

Relay 的上游是 GitHub Copilot 模型网关；effort 参数的实际接受度以网关行为为准，被拒绝时同样归一为 `invalid_request` 上浮。

其他 Extension Provider 通过 `ModelInvocationRequest.thinking` 收到该全局设置，可自行映射；不支持的 Provider 忽略该字段不影响现有行为。

## 8. Runner 行为

`callLLMStream`：

- `thinking_delta` 事件：`signature` 累积到当前 thinking 签名；`text` 非空时累积到 `currentThinking` 并 `emit { type: 'thinking_delta', text }`；
- 内容组装顺序：thinking 块在 text / tool_use 之前。`tool_call` 到达或流结束时先 flush `currentThinking`（组装 `{ type: 'thinking', thinking, ...(signature ? { signature } : {}) }`），再 flush `currentText`；
- Abort 分支同样 flush thinking 块后返回 partial 内容。

持久化：Assistant 消息 content 含 thinking 块，随既有 `appendMessage` 写入 Transcript。

`collectChat`（`chat()` 非流式路径）同步支持 thinking 累积，thinking 块置于 content 首位。

## 9. Session 持久化与历史

- Session `ContentBlock` 增加 `thinking` / `redacted_thinking` 块（与模型消息格式对齐的既有模式）；
- Transcript JSONL 原样持久化 thinking 块（含 `signature`）——signature 是服务端签发的加密凭证，不可再生，不持久化则 Anthropic 工具续轮无法恢复；
- `projectHistoryMessage` 原样投影；`SessionHistoryContentBlock` 包含 thinking；
- thinking 块不参与 `capToolResults`（该裁剪只作用于 tool_result）；
- **回放策略与持久化分离**：Transcript 保存全部 thinking 块；构建 Provider 请求历史时只回放最后一条 assistant 消息的 thinking 块（§6.1），更早轮次的 thinking 在 `convertMessages` 中剥离。Runner 的 `loadHistory` 不做剥离——剥离发生在各 Protocol Client 的历史转换层，因为"哪些块可回传"是协议知识；
- **signature 体积**：真实 Anthropic 的 signature 是加密大对象（OpenClaw 测试用例按 4000 字符模拟），历史加载与上下文预算估算需计入其体积；Web 历史展示可考虑不投影 signature 字段（对用户无意义），首期原样投影亦可接受。

## 10. Channel 展示

### 10.1 WebSocket Channel

- `serializeEvent` 通用透传，无协议变更；
- `send()` 的 per-event debug 日志把 `thinking_delta` 与 `text_delta` 同样排除，避免逐 chunk 日志噪声；
- Subagent Child Turn 的 `thinking_delta` 沿用既有复合 key 路由，与 `text_delta` 一致。

### 10.2 Web 客户端（chat.html）

Turn segments 新增 `thinking` 类型：

```text
流式中（展开）：
┌─ Thinking ────────────────────────── 12s ─┐
│ The user asks 1+1 and wants just the ...  │
└───────────────────────────────────────────┘

回答开始后（自动折叠）：
▶ Thinking · 12s
```

行为：

- 首个 `thinking_delta` 创建 Turn 气泡与 thinking segment（`getOrCreateTurn` 路径），默认展开、流式追加、自动滚动；
- 同一 segment 内追加文本；`text_delta` / `tool_call` 到达后，把未终结的 thinking segment 标记完成（记录起止时间）、自动折叠；
- `run_end` / `error` 终结所有未完成 thinking segment；
- 多轮调用（工具后续轮）各自形成新的 thinking segment；
- 历史加载（`buildHistoryItems`）把 thinking 块重建为折叠 segment；
- 渲染使用文本插值 + `white-space: pre-wrap` 纯文本，不经过 markdown 与 `v-html`。

### 10.3 CLI

`thinking_delta` 以暗色（dim）内联输出，与正文的区分依赖颜色；`inStream` 状态与 `text_delta` 一致。

## 11. Compaction 与上下文

- Compaction 摘要请求构建时剥离输入消息中的 thinking 块（thinking 属于过程产物，摘要面向对话内容；同时避免 Anthropic 在无工具上下文的请求中收到 thinking 块）；
- `extractText` 等文本抽取只读取 `text` 块，thinking 自然跳过；
- 上下文预算估算照常计入 thinking 块字符（thinking token 真实占用上下文；signature 体积一并计入）。

## 12. 测试

### 12.1 配置与注入

- `llm.thinking` boolean 校验与错误路径；
- 省略时 `ModelInvocationRequest.thinking` 缺省，行为与现状一致；
- RuntimeApp → RunParams → ModelInvocationRequest 的注入链路；
- Compaction 摘要调用不注入 thinking。

### 12.2 Client 合同（每协议，含 Copilot Relay）

- thinking 流 → `thinking_delta` 序列；
- Anthropic `signature_delta` → signature 累积，`chat()` content 含 signature；
- Anthropic `redacted_thinking` 块：不产生事件、原样保留并回传；
- Anthropic thinking + tool_use 续轮：仅最后一条 assistant 消息的 thinking / redacted_thinking 块原序原样回传，更早 assistant 消息剥离；
- OpenAI Chat Completions 历史 thinking 块剥离（协议无 reasoning 输入类型）；OpenAI Responses / Copilot Relay 首期剥离（回传需 encrypted_content，属后续增强）；Anthropic 仅最新一条 assistant 消息回传 thinking；
- `request.thinking` 缺省 / `true` / `false` 的 wire 参数映射（含 Anthropic budget 推导与 `max_tokens` 抬升）；
- Chat Completions 空 `content` + `reasoning` chunk 只产生 `thinking_delta`；
- usage 语义不变。

### 12.3 Runner / Session

- `thinking_delta` AgentEvent 转发；
- 内容组装顺序 thinking → text → tool_use；Abort flush；
- Transcript 持久化与历史投影含 thinking 块（含 signature）；
- 回放策略：Provider 请求历史只含最后一条 assistant 消息的 thinking 块。

### 12.4 Channel

- WebSocket `thinking_delta` 透传与 debug 日志排除；
- Web 实时展开 / 自动折叠 / 历史折叠 / 多轮 segment；
- CLI dim 输出。

### 12.5 Compaction

- 摘要输入剥离 thinking 块。

## 13. 非目标

- per-request / steering 级动态 thinking 控制；
- per-model / per-provider 覆盖（全局开关足够；将来有需要再扩展）；
- effort / budget 数值配置（仅 boolean 开关）；
- 非 thinking 模型的通用等待指示器；
- thinking 内容的 markdown 渲染与编辑 / pin 交互。

## 14. 主流实现参考

### 14.1 Claude Code / Claude Agent SDK

- Transcript JSONL 持久化完整 `ThinkingBlock(thinking, signature)`；resume 重放 transcript 恢复会话；
- 新增 `ThinkingDisplay: "summarized" | "omitted"`，Opus 4.7+ 默认 `omitted`（只留 signature、丢弃思考文本）。

证据（2026-09-29，GitHub `anthropics/claude-agent-sdk-python`）：

- `src/claude_agent_sdk/types.py`：

  ```py
  @dataclass
  class ThinkingBlock:
      """Thinking content block."""
      thinking: str
      signature: str
  ```

- `src/claude_agent_sdk/_internal/message_parser.py`：解析 assistant 消息时把 `{"type":"thinking"}` 内容块还原为 `ThinkingBlock(thinking=block["thinking"], signature=block["signature"])`，随消息进入会话历史；
- `src/claude_agent_sdk/types.py`：

  ```py
  # Controls whether thinking text is returned summarized or omitted. Opus 4.7+
  # defaults to "omitted" (signature-only); pass "summarized" to receive text.
  ThinkingDisplay = Literal["summarized", "omitted"]
  ```

- 会话持久化机制（`_internal/sessions.py`、`session_resume.py`）：transcript JSONL 按 `uuid`/`parentUuid` 链组织，resume 时把 JSONL 物化回项目目录后由 CLI 重放；`SessionStore` 协议（`append`/`load`）镜像同一格式，thinking 块随 assistant 消息整体持久化与恢复。

### 14.2 OpenClaw

- 全量持久化 thinking + `thinkingSignature`；
- 发送前 `dropThinkingBlocks` 只保留最新一条 assistant 消息的 thinking；
- 跨模型切换时 thinking 降级为 text 块、redacted 丢弃；
- 历史召回工具截断 thinking 文本并删除 signature；
- 捕获 Anthropic "thinking blocks cannot be modified" 400 后去 thinking 重试一次；
- 上下文裁剪把 signature 字节计入消息体积。

证据（2026-09-29，本仓库 `openclaw/src/agents/`）：

- `pi-embedded-runner/thinking.ts` `dropThinkingBlocks()` 文档注释：

  ```ts
  /**
   * Strip `type: "thinking"` and `type: "redacted_thinking"` content blocks from
   * all assistant messages except the latest one.
   *
   * Thinking blocks in the latest assistant turn are preserved verbatim so
   * providers that require replay signatures can continue the conversation.
   */
  ```

  剥离后若 assistant 消息变空，替换为合成 `{ type: "text", text: "" }` 保持 user/assistant 交替结构；
- 同文件 `wrapAnthropicStreamWithRecovery`：`THINKING_BLOCK_ERROR_PATTERN = /thinking or redacted_thinking blocks?.* cannot be modified/i`，流开始前捕获该错误则去 thinking 重试一次（每 session 仅一次，`recoveredAnthropicThinking` 标记防循环）；
- `transport-message-transform.ts`：`isSameModel`（provider + api + model 三者一致）时 thinking 块原样保留；跨模型时带 signature 的 thinking 降级为 `{ type: "text", text: block.thinking }`，redacted 块直接丢弃，`thoughtSignature` 从 toolCall 上删除；
- `tools/sessions-history-tool.ts` `sanitizeHistoryContentBlock`：

  ```ts
  if (type === "thinking") {
    // ...truncate entry.thinking...
    // The encrypted signature can be extremely large and is not useful for history recall.
    if ("thinkingSignature" in entry) {
      delete entry.thinkingSignature;
    }
  }
  ```

  测试 `openclaw-tools.sessions.test.ts` 用 `"sig".repeat(4000)` 模拟大 signature；
- `pi-hooks/context-pruning/pruner.ts`：估算 assistant 消息体积时计入 `thinkingSignature` 字节数（测试 `counts thinkingSignature bytes when estimating assistant message size`）；
- `transcript-policy.ts`：`TranscriptPolicy` 含 `dropThinkingBlocks` / `sanitizeThinkingSignatures` / `preserveSignatures` 开关，按 provider 运行时插件解析。

### 14.3 Codex（OpenAI 官方 agent，开源）

- rollout 持久化完整 reasoning item（含 `encrypted_content`）；
- 每个请求带 `include: ["reasoning.encrypted_content"]`；
- 历史全量保留加密 reasoning 并回放；
- Responses Lite 模式设置 `reasoning.context: "all_turns"`；
- 上下文预算把加密 reasoning 体积计入估算。

证据（2026-09-29，GitHub `openai/codex` `codex-rs/`）：

- `core/src/client.rs` `build_responses_request`：

  ```rust
  let include = vec!["reasoning.encrypted_content".to_string()];
  ```

  每个请求都要求服务端返回加密 reasoning blob；
- 同文件 `build_reasoning`：

  ```rust
  context: model_info
      .use_responses_lite
      .then_some(ReasoningContext::AllTurns),
  ```

- `core/src/context_manager/history.rs` `get_non_last_reasoning_items_tokens()`：对最后一条 user 消息之前的所有 `ResponseItem::Reasoning { encrypted_content: Some(_), .. }` 项做 token 估算求和——加密 reasoning 全量保留在回放历史中，该函数用于服务端已计入 reasoning token 时的预算修正。测试 `non_last_reasoning_tokens_ignore_entries_after_last_user` 验证计数逻辑；
- 同文件：

  ```rust
  // Plaintext reasoning is excluded from replay accounting.
  ResponseItem::Reasoning { encrypted_content: None, .. } => 0,
  ```

  明文 reasoning 不参与回放计数（回放的是加密 blob）；
- `rollout-trace/src/reducer/conversation.rs` 注释：

  ```rust
  // The Responses API may return readable reasoning on completion, but later
  // request snapshots often replay only the encrypted blob. Treat the blob as
  // stable model-visible identity and merge readable text as best-effort
  ```

  加密 blob 是跨请求的稳定身份标识；
- 测试 `rollout-trace/src/reducer/conversation_tests.rs` `encrypted_reasoning_reuses_response_item_in_later_request`：后续请求 `input` 包含 `[user, encrypted_reasoning, function_call, function_call_output]`——加密 reasoning 与工具调用配对回传；
- `core/tests/suite/client.rs`：断言请求体 `request_body["include"][0] == "reasoning.encrypted_content"`。

### 14.4 共同模式

**持久化全量、回放最小化**：

- signature / encrypted_content 必须持久化——服务端签发的加密凭证，不可再生，续轮依赖；
- 回传范围因协议而异：Anthropic 只需最后一条 assistant 消息（更早轮次剥离无损失）；OpenAI Responses 回传加密 blob（明文摘要不是有效回传形态）；
- thinking 明文对历史展示有价值、对回传无价值：Claude Code 的 `omitted` 模式（只留 signature）、OpenClaw 历史工具删 signature、Codex 明文 reasoning 不计入回放，三者从不同角度印证。

## 15. 文档与 Fitness 更新

实现时需同步：

- `docs/architecture/providers.md`：ModelStreamEvent 清单、§5.1 wire 映射、§5.2、Copilot Relay §7；
- `docs/architecture/runner.md`：事件清单；
- `docs/architecture/channels.md` / `docs/specifications/channel.md`：AgentEvent 相关描述；
- `docs/architecture/session.md`：ContentBlock；
- `docs/architecture/configuration.md`：`llm` 字段；
- `docs/specifications/runner-turn-flow.md`：事件与不变量；
- `src/architecture-fitness/ft-08-contract-inventory.json` 及相关 fitness 断言。
