# Thinking 采集与展示设计草稿

> Status: Non-authoritative design draft
> Authorization: 不授权实现，不覆盖 Current Architecture、Accepted Decisions、Stable Specifications 或源代码
> 创建日期：2026-09-29
> 更新日期：2026-10-02
> 核实状态：§17.3–17.5为前期官方资料复核结论。实现与验收已由[归档Change](../changes/archive/thinking-capture-and-display/plan.md)及其[Specification](../changes/archive/thinking-capture-and-display/thinking-capture-and-display-specification.md)记录；当前权威以Architecture、Stable Specifications和源码为准。本文只保留研究演进证据，§5、早期Anthropic-only范围及预算假设不是最终实现契约。
> Historical scope: 全 Provider 的 thinking 内容采集、核心事件透传、Channel 展示，以及首期 Anthropic Tool continuation 所需 opaque state 的持久化与安全回放；当前Delivery阶段已缩减为Chat Completions与Responses
> Evidence: 2026-09-29 针对 Ollama + Qwen3.8-27B-UD-IQ4_XS 的三协议本地实测（§2.1–2.3）；同日核实 OpenAI（Azure OpenAI 官方文档 + Codex 源码）与 Anthropic（官方 TypeScript SDK）的官方参数支持矩阵（§2.4）；协议专用实现参考（§14）；2026-09-30 OpenCode / OpenClaw / Goose / Continue 多协议横向调研（§15）
> Related: [Built-in LLM Provider 设计草稿](builtin-llm-providers-design-draft.md)、[Tool Activity 展示设计草稿](tool-activity-presentation-design-draft.md)、[Model-Aware Output Control](../changes/archive/model-aware-output-control/plan.md)（其非目标中的 Thinking 项由本文跟进）

## 1. 问题与结论

thinking 类模型（Qwen3、Claude thinking、OpenAI reasoning 模型）在思考阶段可能持续数十秒。当前实现中，思考内容在 Protocol Client 层被静默丢弃，用户在此期间观察不到任何输出；同时 thinking token 计入 `usage.output_tokens`，成本已经发生。

术语约定：canonical 内部术语统一为 thinking；OpenAI wire 层称 reasoning，字段名差异由各 Client 吸收。

本草稿结论：

1. 核心流契约新增带`blockId`的`thinking_start` / `thinking_delta` / `thinking_end`与`redacted_thinking`事件；Built-in三个Protocol Client与Copilot Relay把各自协议的thinking/reasoning内容映射为明确的块生命周期。
2. `ChatContentBlock` 新增 `thinking` / `redacted_thinking` 块；Runner 按上游块边界和顺序组装进 Assistant 消息并随 Transcript 持久化。Anthropic `signature` / `data` 作为 Core-owned opaque continuation state 原样保存，只在来源兼容的续轮中回传。
3. `AgentEvent`新增不含opaque state的thinking start/delta/end生命周期；Channel走既有Fanout。Web客户端渲染可折叠Thinking卡片（流式时展开、回答开始后自动折叠），CLI以暗色文本内联输出。
4. 本期不控制上游是否生成 thinking，也不向请求注入 thinking / reasoning 参数；各模型沿用自身默认行为，上游返回 thinking 内容时一律采集和展示。
5. thinking 生成控制需要按模型能力映射 effort、budget、toggle 或 adaptive mode，后续作为独立设计处理，不在本期引入不可靠的跨模型 boolean。

事件流：

```text
上游 SSE
  → Protocol Client        （识别块边界，累积 signature）
  → ModelStreamEvent       （thinking 生命周期 / redacted 块）
  → AgentRunner            （只转发可见文本，原序组装 content）
  → Channel Fanout         （Web / CLI 展示）
  → Session Transcript     （保存 thinking + opaque state）
  → Provider projection    （来源兼容时最小化原样回放）
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
- `signature` 是不透明字符串，官方没有承诺可解析的内部格式。它通常很长、外观可能类似 Base64，但客户端只能逐字符拼接、保存和回传，不得解析、重编码、截断或自行生成。官方示例使用 `"WaUjzkypQ2mUEVM36O2Txu...."` 这类截断值；真实值可达到数千字符；
- `signature_delta` 可能分成多个增量，Client 必须按到达顺序连接；完整 signature 与产生它的单个 thinking block 绑定，不能跨块合并或移动；
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

采集、持久化与回放设计遵守上述官方内容形态和续轮约束；参数控制不在本期范围。Ollama对放宽字段均兼容（§2.1–2.3实测）。

## 3. 当前实现事实

- `AnthropicMessagesClient` 只处理 `text_delta` 与 `input_json_delta`；thinking block 的 `content_block_start`、`thinking_delta`、`signature_delta` 落入既有分支被静默忽略。
- `OpenAIResponsesClient` 的 default 分支只拒绝 `response.xxx` 形态的单级事件名；`response.reasoning_summary_text.delta` 与 reasoning 类 `response.output_item.added` 含多级点号，被静默忽略。
- Copilot Relay 的 `responses-client` 同样只处理 `output_text` / `function_call`；`response.reasoning_summary_text.delta` 与 reasoning 类 `response.output_item.added` 落入 default 分支被静默忽略（其未知状态检测只匹配单级点号事件名）。
- `OpenAIChatCompletionsClient` 只读 `delta.content`；Ollama 思考阶段每个 chunk 的 `content:""` 会产生空字符串 `text_delta` 事件。
- `ModelStreamEvent`、`ChatContentBlock`、`AgentEvent`、Session `ContentBlock` 均无 thinking 概念。
- Web 客户端 Turn 气泡在首个 `text_delta`/`tool_use` 才创建；Ollama 思考期间的空 `text_delta` 会创建空文本气泡（无可见内容）；`llm_call` 只进事件日志面板。
- thinking token 已计入 `usage.output_tokens`（三协议一致）。

## 4. 生成控制决策

本期不新增配置字段，不改变任何 Provider 请求参数。Built-in Protocol Client、Copilot Relay 和 Extension Provider 均沿用模型与上游的默认 thinking / reasoning 行为。

统一 boolean 不能可靠表达当前模型能力：

- Anthropic 同一 API 下同时存在 extended、adaptive、默认开启、默认关闭和不可关闭的模型；
- OpenAI 的合法 effort 值及默认值因模型和端点而异；
- Gemini 等 Provider 还可能分别使用 budget、level 和返回内容控制；
- `include thoughts` 或展示开关不等于关闭模型内部 reasoning。

后续若增加生成控制，应作为独立设计，基于 resolved model capabilities 只暴露当前模型支持的 effort、budget、toggle 或 variant；不支持的值应在调用前拒绝或按明确的 Provider 规则降级，不能由 Protocol Client 盲目映射。

本期只保证捕获和展示：无论 thinking 来自模型默认行为、Provider 默认行为还是调用方通过其他机制启用，只要上游返回可识别的 thinking 内容，就按本文契约处理。

## 5. 核心契约变更

### 5.1 ModelStreamEvent

```ts
export type ModelStreamEvent =
  | { type: 'message_start' }
  | { type: 'text_delta'; text: string }
  | { type: 'thinking_start'; blockId: string }
  | { type: 'thinking_delta'; blockId: string; text: string }
  | { type: 'thinking_end'; blockId: string; signature?: string }
  | { type: 'redacted_thinking'; blockId: string; data: string }
  | { type: 'tool_call'; call: ToolCall }
  | { type: 'message_end'; stopReason: string; usage: TokenUsage }
  | { type: 'error'; error: Error };
```

- `thinking_start` / `thinking_end`定义一个可读thinking块的边界；`thinking_delta`只携带可展示文本；三者必须使用相同`blockId`关联，不能依赖单个全局“当前thinking块”猜测归属；
- ModelStreamEvent的`blockId`只要求在一次Model Invocation内唯一。Runner向AgentEvent投影时，将调用身份（包括重试attempt）与原始blockId组合成Turn内唯一ID；工具续轮重新从index 0开始不得更新上一轮的segment。不为此引入通用并发块调度框架；
- Anthropic Client 在块内累积所有 `signature_delta`，并在对应 `thinking_end` 中一次性交付完整 signature，避免把块级凭证伪装成文本增量；
- OpenAI Chat Completions 在首个非空 `delta.reasoning` 前合成 `thinking_start`，在首个正文、Tool Call 或消息结束前合成 `thinking_end`；
- OpenAI Responses / Copilot Relay 根据 reasoning output item 的生命周期产生边界；
- `redacted_thinking` 是已完成的不可读块，不产生 Channel 文本事件。

### 5.2 ChatContentBlock

```ts
type ThinkingReplayBinding = {
  providerId: string;
  modelId: string;
  protocol: string;
  routeFingerprint: string; // 候选字段，生成与恢复规则见§15.6
};

| {
    type: 'thinking';
    thinking: string;
    signature?: string;
    replayBinding?: ThinkingReplayBinding;
  }
| {
    type: 'redacted_thinking';
    data: string;
    replayBinding: ThinkingReplayBinding;
  }
```

- `thinking` 是可展示摘要；`signature` 与 `redacted_thinking.data` 是 Provider-issued opaque continuation state；
- `replayBinding`表达Core内部来源信息，兼容性判断由Provider拥有。上面的routeFingerprint是候选形态，不表示已经解决endpoint/account/auth scope识别、重启稳定性或凭证轮换；最小持久字段须通过§15.6验证后确定，不直接保存API Key或其可逆形式；
- Provider提供当前binding及兼容性判断，Runner只保留和传递，不读取连接配置或推导账户身份。是否经Model Resolution暴露给`ResolvedModel`，须在接线验证后确定；不为一期建立账户级回放管理框架；
- Anthropic signature-bearing块和redacted块必须带`replayBinding`；无signature的Ollama/OpenAI thinking只用于展示和持久化，可不带binding；
- `signature` 保持可选，因为兼容端点可能只返回thinking文本，Abort也可能在signature到达前留下partial block；无signature块不得作为官方Anthropic continuation state回放。

### 5.3 AgentEvent

```ts
| { type: 'thinking_start'; sessionId: string; turnId: string; blockId: string }
| { type: 'thinking_delta'; sessionId: string; turnId: string; blockId: string; text: string }
| { type: 'thinking_end'; sessionId: string; turnId: string; blockId: string }
```

AgentEvent只投影可展示生命周期；`signature`、`redacted_thinking.data`和`replayBinding`不进入Channel、History API或普通日志，只能在Core持久化与兼容Provider回放路径中流动。

### 5.4 Opaque state规则

Anthropic signature的典型wire形态：

```json
{
  "type": "thinking",
  "thinking": "Let me break this down...",
  "signature": "WaUjzkypQ2mUEVM36O2Txu...."
}
```

示例值是官方文档中的截断表示。真实signature可能达到数千字符；其编码和内部结构不属于客户端契约，即使外观看起来类似Base64也不得据此解析。`redacted_thinking.data`遵循相同的opaque处理原则。

不变量：

- 按delta到达顺序逐字符连接，不trim、不做Unicode normalization、不重新编码；
- signature只属于产生它的单个thinking块，data只属于对应redacted块；
- 不跨块合并，不随thinking摘要一起截断，不由客户端生成或修复；
- Transcript保存原值；Provider continuation原样使用；History、Channel和普通日志删除原值；
- 它不是用户API Key，但仍按Provider-issued continuation credential处理，诊断输出最多记录长度和来源；
- signature为空、缺失、binding不兼容或块未完成时，不得把该块作为完整Anthropic continuation state发送。若当前Tool续轮要求该数据，应阻止请求并通过既有调用错误路径报告，不能删除必需块后假装正常继续；仅对协议允许省略的历史块执行过滤。

## 6. Protocol Client 行为

### 6.1 AnthropicMessagesClient

事件采集：

- `content_block_start`且`content_block.type === 'thinking'`：以Anthropic block index派生`blockId`，建立当前thinking块，清空signature缓冲，产生`thinking_start`；
- `content_block_start`且`content_block.type === 'redacted_thinking'`：暂存opaque `data`；收到匹配的`content_block_stop`后才产生单个`redacted_thinking`完成事件，不产生可见文本；中途Abort不得提交该块；
- `content_block_delta`且`delta.type === 'thinking_delta'`：产生带对应`blockId`的`thinking_delta`；
- `content_block_delta` 且 `delta.type === 'signature_delta'`：按到达顺序追加到当前块的signature缓冲，不直接yield；
- 对thinking块的`content_block_stop`：产生`thinking_end { blockId, signature }`并清理当前块状态；
- thinking、redacted_thinking和tool_use块不得重叠；非法边界、错误类型或重复结束显式抛出协议错误。

历史回传（`convertMessages`）：

- 官方已确认一个连续Tool loop属于同一个assistant turn：回传当前循环内每条assistant消息的完整content及对应tool_result，包括较早步骤的thinking/signature/redacted，不只保留最后一条assistant。承载tool_result的user角色消息不是新的真实用户输入（依据见§17.3）；
- 块完成且Provider确认来源兼容时，按原始Content Block顺序原样序列化；一期不承诺跨模型或跨账户可移植性；
- 不修改thinking文本，不截断或重编码signature/data，不合并多个thinking块，不把thinking统一移动到消息开头；
- 对协议允许省略的旧历史thinking/redacted块，可以从请求投影中删除而不修改Transcript；不能笼统删除所有更早assistant块；
- 当前Tool continuation必需的签名数据缺失、损坏或不能证明兼容时，显式阻止调用；禁止以“剥离后重试”掩盖该错误。模型切换也不得绕过此检查；
- 无signature的兼容端点thinking和Abort partial文本可以保留展示；是否允许不带这些块续轮取决于该端点的已验证协议行为，不能因字段可选就推定允许。

请求参数（`buildRequest`）：不新增或修改 `thinking` 字段，沿用上游默认行为。

### 6.2 OpenAIChatCompletionsClient

事件采集：

- 首个非空`delta.reasoning`前分配调用内单调`blockId`并产生`thinking_start`，随后产生带相同ID的`thinking_delta`；
- 首个非空正文、Tool Call或消息结束前产生带相同ID的`thinking_end`；
- `delta.content` 为非空字符串才产生 `text_delta`；空字符串跳过（修正当前实现对 Ollama 思考阶段 `content:""` 产生空 `text_delta` 的行为）。

历史转换：assistant content 中的 `thinking` 块在 `convertMessages` 中剥离（OpenAI 协议不接受回传 reasoning 内容）。

请求参数：不新增或修改 `reasoning_effort`，沿用上游默认行为。

### 6.3 OpenAIResponsesClient

事件采集：

- `response.output_item.added`且`item.type === 'reasoning'`：以item id作为`blockId`产生`thinking_start`并进入采集状态；
- `response.reasoning_summary_text.delta`：产生带对应item id的`thinking_delta`；
- reasoning item结束时产生带对应item id的`thinking_end`；边界不完整或item id不匹配时显式报错。

历史转换：旧“summary不是合法输入，所以首期统一剥离”的论证撤回。官方输入schema允许reasoning item中的summary，encrypted_content不是全局必填字段；但裸摘要文本不能代替完整reasoning item。

官方工具调用指导要求将返回的reasoning items与Tool outputs一起回传。本地Spike已证实当前Client丢弃这些items，因此不能再把统一剥离作为已批准的延期方案。建议保存`response.output_item.done`中的完成reasoning item及其实际返回的id、summary、encrypted_content，并保持与function_call/output的顺序；未返回的字段不伪造。该建议会影响§5的内容契约，待所有者确认范围后再定型。

是否额外请求encrypted_content、是否改变store必须分别决定：当前Client省略store，不是显式store:false；直连官方默认存储也不意味着下一次手工history会自动恢复丢掉的reasoning。当前store:false/ZDR返回规则与旧include要求的差异见§17.3，不在本轮实验中改变请求策略。

请求参数：不新增或修改 `reasoning`，沿用上游默认行为。

## 7. Copilot Relay Provider

Copilot Relay 使用 OpenAI Responses 协议，行为与 `OpenAIResponsesClient` 对齐：

事件采集：

- `response.output_item.added`且`item.type === 'reasoning'`：以item id作为`blockId`产生`thinking_start`并进入采集状态；
- `response.reasoning_summary_text.delta`：产生带对应item id的`thinking_delta`；
- reasoning item结束时产生带对应item id的`thinking_end`。

历史转换：不能从Relay使用Responses形态推定其存储默认值、签名兼容性或服务端接受规则。当前Client丢弃完成reasoning item已由本地Spike确认；建议采用§6.3的不主动丢失返回item原则，但网关行为仍需有界实测，不能把“统一剥离后仍成功”视为已验证设计。

请求参数（`buildResponsesRequest`）：不新增或修改 `reasoning`，沿用上游默认行为。

其他 Extension Provider 无需新增请求控制字段；若其上游返回 thinking 内容，应映射为相同的核心事件和内容块。

## 8. Runner 行为

`callLLMStream`：

- `thinking_start`：先flush此前正文，按`blockId`建立builder并预留有序Content Block位置，同时emit不含opaque state的`AgentEvent.thinking_start`；重复ID显式失败；
- `thinking_delta`：按`blockId`追加到对应builder并emit同文本的`AgentEvent.thinking_delta`；未知或已结束ID显式失败；
- `thinking_end`：按`blockId`finalize已预留位置并emit`AgentEvent.thinking_end`；有signature时同时写入当前resolved route的`replayBinding`；
- `redacted_thinking`：在Content Block当前位置追加opaque块并写入当前resolved route的`replayBinding`，不emit Channel事件；
- `text_delta`、`tool_call`与thinking边界共同决定append顺序。Runner不把thinking统一放到首位，不合并跨块内容，最终Content Block顺序与上游顺序一致；
- Abort发生在活动thinking块内时，允许把当前可读文本保存为无signature的partial thinking块供UI恢复，但该块不可用于Anthropic回放；未完成的redacted块不持久化。

持久化：Assistant 消息 content 含 thinking 块，随既有 `appendMessage` 写入 Transcript。

`collectChat`（`chat()`非流式路径）复用相同的块生命周期和顺序规则。

## 9. Session 持久化与历史

- Session `ContentBlock`增加thinking/redacted块及其内部`replayBinding`；Transcript JSONL原样持久化完整块。signature/data不可再生，不持久化会破坏Anthropic Tool continuation和Session恢复；
- `SessionHistoryContentBlock`使用独立的安全投影类型：thinking只投影`{ type: 'thinking'; thinking: string }`；signature、data和replayBinding永不进入History API。redacted块默认不投影；若UI需要表示其存在，只投影不含data的占位块；
- thinking 块不参与 `capToolResults`（该裁剪只作用于 tool_result）；
- **回放策略与持久化分离**：Transcript保存全部块；哪些块可回传由Provider projection根据协议、continuation位置和replayBinding决定，Runner的`loadHistory`不破坏opaque state；
- **日志边界**：不得记录signature/data原值；诊断最多记录块类型、thinking字符数、signature/data长度和非秘密binding字段；
- **体积**：signature/data可能达到数千字符，Transcript大小和实际Provider请求估算必须计入；History响应和浏览器内存不计入已剥离的opaque字段。

## 10. Channel 展示

### 10.1 WebSocket Channel

- `serializeEvent` 通用透传，无协议变更；
- `send()` 的 per-event debug 日志把 `thinking_delta` 与 `text_delta` 同样排除，避免逐 chunk 日志噪声；
- Subagent Child Turn的thinking生命周期事件沿用既有复合key路由；`blockId`只在对应Session/Turn内解释。

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

- `thinking_start`按`blockId`创建Turn气泡与thinking segment（`getOrCreateTurn`路径），默认展开并记录起始时间；
- `thinking_delta`只追加到相同`blockId`的segment并自动滚动；未知ID显式记录协议错误，不创建无主segment；
- `thinking_end`完成对应segment并记录结束时间；后续`text_delta` / `tool_call`到达时自动折叠已完成segment；
- `run_end` / `error` 终结所有未完成 thinking segment；
- 多轮调用（工具后续轮）各自形成新的 thinking segment；
- 历史加载（`buildHistoryItems`）把含可读文本的thinking块重建为默认折叠segment，用户可展开查看；刷新页面、切换Session及加载旧页均遵循此规则；
- 本期耗时仅在实时展示中计算，不写入Transcript。历史卡片显示`▶ Thinking`，不显示`12s`等时长，也不根据消息时间戳推测耗时；
- 仅有signature、没有可读文本的块不生成可展开的历史Thinking卡片；redacted data不用于生成展示文本，未保存thinking的旧记录不补造内容；
- 渲染使用文本插值 + `white-space: pre-wrap` 纯文本，不经过 markdown 与 `v-html`。

### 10.3 CLI

`thinking_start`建立CLI thinking stream，`thinking_delta`以暗色（dim）内联输出，`thinking_end`关闭该stream；正文样式和状态不与thinking共用。

## 11. Compaction 与上下文

- Compaction摘要请求构建时剥离输入消息中的thinking/redacted块（thinking属于过程产物，摘要面向对话内容；同时避免摘要Provider收到不可回放的opaque state）；
- 当前仍在等待Tool Result或即将继续Tool loop的Anthropic continuation链不得被摘要或裁掉；它必须作为未压缩tail完整保留，直到对应Tool continuation结束；
- 对启用prefix检查的preserved-thinking模型，仅保留tail还不够：system、tools或块前历史被Compaction/模板重建改变也可能使签名上下文失配。必须按目标模型的规则处理或限制此场景，不能宣称“有signature就能恢复”；具体恢复支持边界见§17.4；
- `extractText` 等文本抽取只读取 `text` 块，thinking 自然跳过；
- 请求上下文预算必须基于目标Provider的实际projection估算：被Client剥离的thinking不计入；实际回放的thinking、signature和redacted data按完整体积计入。Transcript存储体积另行统计，不能与Provider输入预算混为一谈。

## 12. 测试

### 12.1 Client 合同（每协议，含 Copilot Relay）

- thinking流产生blockId一致的start/delta/end序列；重复、未知、错配ID显式失败；空摘要但有signature时仍产生start/end并持久化块；
- Anthropic多个`signature_delta`按序累积，只在对应`thinking_end`交付完整值；多个thinking块的signature不得串块；
- Anthropic`redacted_thinking`产生内部opaque事件，不产生AgentEvent，原样保留；
- Anthropic单次及连续Tool续轮：协议要求的完整消息段原序回传，仅允许省略的历史块被过滤；
- 来源兼容时回传；必需signature缺失、块不完整或来源无法证明兼容时阻止请求并报告错误，测试断言上游未收到降级请求；
- 修改、截断、重排或合并thinking/signature/data的实现必须被测试拒绝；
- OpenAI Chat Completions历史thinking块剥离；OpenAI Responses / Copilot Relay须验证实际请求模式下的工具续轮，才能确认encrypted replay可延期；Anthropic回放目标协议要求的完整块；
- 请求构建不新增 thinking / reasoning 控制参数；
- Chat Completions空`content` + `reasoning` chunk产生thinking生命周期事件，但不产生空`text_delta`；
- usage 语义不变。

### 12.2 Runner / Session

- thinking start/delta/end投影为不含opaque state的AgentEvent；signature/data/replayBinding不进入Channel或History API；
- 同一Turn中多次调用和重试均返回相同block index时，公共blockId仍唯一，前一segment不被覆盖；
- thinking、text和tool_use按流中块边界保持原序，覆盖多thinking块与交错Tool Call；
- Abort只保存可读partial thinking，不生成可回放signature；
- Transcript持久化完整opaque state；History投影删除signature/data/replayBinding；
- 普通日志不含opaque原值，诊断仅允许长度和来源；
- Provider projection只保留当前兼容continuation链所需块。

### 12.3 Channel

- WebSocket thinking生命周期透传，delta排除debug逐块日志；
- Web 实时展开 / 自动折叠 / 历史折叠 / 多轮 segment；
- 刷新、切换Session及旧页加载后可展开已保存的thinking文本；历史卡片无推测耗时，空摘要及无thinking旧记录不生成可展开卡片；
- CLI dim 输出。

### 12.4 Compaction

- 摘要输入剥离thinking/redacted块；
- 活动Tool continuation链保留在未压缩tail；
- 上下文预算与目标Provider实际projection一致。

## 13. 非目标

- thinking / reasoning 生成开关；
- effort、budget、adaptive mode、model variant 与 per-request / steering 控制；
- reasoning capability discovery、Provider 映射与自动降级；
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
- 回传范围由目标协议及调用方式决定；外部项目的“最后一条assistant”策略不是通用API保证。活动Tool链需要完整保留，旧历史是否可省略须分别验证；
- 可见文本与opaque状态承担不同职责，但不能由此推出thinking文本可随意删除：Anthropic返回非空thinking文本时，回放应保持原块；上游返回空摘要与客户端主动删掉摘要不是同一件事。

## 15. 多协议 Agent 横向对比（2026-09-30）

本节优先比较同时支持多个Provider或协议的OpenCode、OpenClaw、Goose和Continue。Claude Agent SDK与Codex分别作为Anthropic和OpenAI协议专用参考，证据见§14。

### 15.1 总表

| 维度 | OpenCode | OpenClaw | Goose | Continue | 本草稿 |
|---|---|---|---|---|---|
| Canonical thinking | 有序reasoning part | 有序ThinkingContent | Thinking / RedactedThinking强类型块 | thinking role/message | 有序thinking / redacted块 |
| 流生命周期 | ReasoningStart/Delta/End + ID | thinking_start/delta/end | partial Message，无统一生命周期 | ChatMessage fragments，reducer合并 | start/delta/end + blockId |
| Anthropic signature | 保存并回放 | 保存并严格route fencing | 保存并回放 | 保存，reducer合并晚到signature | 完整块结束后保存，Provider验证兼容性 |
| redacted_thinking | 原生Anthropic路径支持证据不完整；AI SDK metadata可保留 | 完整 | 独立块完整支持 | 完整，UI显示占位 | 独立内部块，Public History不含data |
| OpenAI encrypted_content | 完整，支持store false/reference | 完整保存reasoning item并严格fencing | 未实现 | 已实现但状态分散 | 原延期假设已撤回，完整item保留待范围确认 |
| 跨route处理 | provider/model变化时剥离metadata | provider/API/model/endpoint/session/auth严格匹配 | 主要按模型名，Provider围栏较弱 | 各adapter自行处理 | Provider判断兼容性，最小binding待验证 |
| Public History | UI不显示opaque | 明确剥离signature/providerReplay | redacted data不显示 | UI不显示payload，持久history仍含opaque | 独立安全投影，永不返回opaque |
| Replay顺序 | 严格保序并有回归测试 | 严格保序 | 存储/Anthropic回放保序，UI可分组 | 基本保序，Tool Result会关联重排 | Transcript/Provider projection严格保序，UI可独立组织 |
| Compaction | 文本summary不含opaque | 完整Transcript + active summary，支持Provider compaction state | 旧记录model-invisible | summary marker前不再回放 | 完整Transcript + 未压缩兼容suffix |
| 生成控制 | Provider variants | Provider/model-aware levels | 明确capability model | 部分Provider-aware | 本期不做 |

### 15.2 关键证据

**OpenCode**

- `ReasoningPart`统一可展示文本，但把encrypted/provider metadata保留为Provider-specific字段：[messages.ts](https://github.com/anomalyco/opencode/blob/2fa3363c924c5c3e367b84a87ae478296a0ed59b/packages/llm/src/schema/messages.ts#L169-L189)；
- 流事件使用带content block ID的ReasoningStart/Delta/End：[events.ts](https://github.com/anomalyco/opencode/blob/2fa3363c924c5c3e367b84a87ae478296a0ed59b/packages/llm/src/schema/events.ts#L106-L126)；
- OpenAI Responses保存item ID和encrypted content，并覆盖`store:false`完整回放与reference模式：[openai-responses.ts](https://github.com/anomalyco/opencode/blob/2fa3363c924c5c3e367b84a87ae478296a0ed59b/packages/llm/src/protocols/openai-responses.ts#L283-L453)；
- provider/model变化时删除Provider metadata并将非空reasoning降级为普通文本：[message-v2.ts](https://github.com/anomalyco/opencode/blob/2fa3363c924c5c3e367b84a87ae478296a0ed59b/packages/opencode/src/session/message-v2.ts#L248-L379)。

**OpenClaw**

- `ThinkingContent`与`ProviderReplayState`分离可展示内容、opaque payload和回放binding：[types.ts](https://github.com/openclaw/openclaw/blob/667f3c0cdd4693b941be704afbb5420c0b1f4666/packages/llm-core/src/types.ts#L263-L413)；
- Anthropic reducer完整捕获signature/redacted data并在回放时还原wire块：[anthropic-stream-reducer.ts](https://github.com/openclaw/openclaw/blob/667f3c0cdd4693b941be704afbb5420c0b1f4666/packages/ai/src/transports/anthropic-stream-reducer.ts#L270-L320)、[anthropic-messages.ts](https://github.com/openclaw/openclaw/blob/667f3c0cdd4693b941be704afbb5420c0b1f4666/packages/ai/src/transports/anthropic-messages.ts#L210-L275)；
- OpenAI保存整个reasoning output item，不只保存ciphertext：[openai-responses-stream-internal.ts](https://github.com/openclaw/openclaw/blob/667f3c0cdd4693b941be704afbb5420c0b1f4666/packages/ai/src/transports/openai-responses-stream-internal.ts#L509-L535)；
- replay context检查provider/API/model/base URL/session/auth profile：[provider-replay-context.ts](https://github.com/openclaw/openclaw/blob/667f3c0cdd4693b941be704afbb5420c0b1f4666/packages/ai/src/transports/provider-replay-context.ts#L31-L57)；
- Public History显式删除thinkingSignature和providerReplay：[chat-display-projection.sanitize.ts](https://github.com/openclaw/openclaw/blob/667f3c0cdd4693b941be704afbb5420c0b1f4666/src/gateway/chat-display-projection.sanitize.ts#L173-L242)。

**Goose**

- Canonical模型使用独立Thinking与RedactedThinking块：[message.rs](https://github.com/aaif-goose/goose/blob/ff24a5e5f8addee526494d35c25665f4a09505c1/crates/goose-provider-types/src/conversation/message.rs#L231-L330)；
- Anthropic捕获、持久化和回放signature/redacted data有独立分支：[anthropic.rs](https://github.com/aaif-goose/goose/blob/ff24a5e5f8addee526494d35c25665f4a09505c1/crates/goose-provider-types/src/formats/anthropic.rs#L444-L469)；
- OpenAI Responses reasoning类型没有`encrypted_content`，因此不具备stateless opaque continuation：[openai_responses.rs](https://github.com/aaif-goose/goose/blob/ff24a5e5f8addee526494d35c25665f4a09505c1/crates/goose-provider-types/src/formats/openai_responses.rs#L58-L89)；
- 模型能力显式表达thinking支持和effort capability：[model.rs](https://github.com/aaif-goose/goose/blob/ff24a5e5f8addee526494d35c25665f4a09505c1/crates/goose-provider-types/src/canonical/model.rs#L102-L140)。

**Continue**

- Anthropic streaming分别处理redacted block、thinking delta和signature delta：[Anthropic.ts](https://github.com/continuedev/continue/blob/5522c6f44ca0ac3528b37244818fbfa39b5af470/core/llm/llms/Anthropic.ts#L315-L400)；
- OpenAI在`output_item.done`捕获ciphertext并在下一次请求重建reasoning item：[openaiTypeConverters.ts](https://github.com/continuedev/continue/blob/5522c6f44ca0ac3528b37244818fbfa39b5af470/core/llm/openaiTypeConverters.ts#L494-L578)；
- UI对redacted block显示说明而不显示payload：[ThinkingBlockPeek.tsx](https://github.com/continuedev/continue/blob/5522c6f44ca0ac3528b37244818fbfa39b5af470/gui/src/components/mainInput/belowMainInput/ThinkingBlockPeek.tsx#L40-L107)；
- 其opaque状态分布在signature、redactedThinking、reasoning_details和metadata，说明“能工作”不等于边界清晰：[core/index.d.ts](https://github.com/continuedev/continue/blob/5522c6f44ca0ac3528b37244818fbfa39b5af470/core/index.d.ts#L335-L445)。

### 15.3 对本草稿的验证

得到多项目直接验证：

1. **统一可展示thinking，保留Provider-specific opaque state。** OpenCode、OpenClaw和Continue都没有尝试在Anthropic signature与OpenAI ciphertext之间做语义转换。
2. **明确的start/delta/end生命周期。** OpenCode和OpenClaw直接采用该模型；增加`blockId`可以避免连续或交错块依赖隐式全局状态。
3. **Internal Transcript、Provider projection、Public History三层分离。** OpenClaw提供最强源码与测试证据；Public History不能作为replay source。
4. **严格保序。** thinking、tool call和tool result的顺序属于协议语义；UI可以折叠或分组，但不能把展示重组写回Transcript。
5. **只在块完成后admit durable replay state。** Anthropic signature和OpenAI ciphertext都可能晚到，partial stream只能用于UI恢复。
6. **按目标Provider实际projection估算预算。** Canonical Transcript体积、Public History体积和最终wire输入不是同一个量。

### 15.4 本草稿相对主流的取舍

**更保守但合理：**

- AgentEvent只暴露无opaque的thinking生命周期，避免把Provider continuation credential变成公共产品接口；
- 首期不提供生成开关或effort选择，优先保证采集、展示与Anthropic Tool continuation正确；
- Public History始终剥离opaque state，比“持久history直接给UI”的实现边界更严格；
- 首期由Provider判断回放兼容性，不照搬完整账户/Session绑定框架；无法证明当前必需数据兼容时显式报错，不实现跨模型兼容矩阵。

**已知能力缺口：**

- OpenAI Responses原“只捕获summary”候选已被§17官方工具回放指导否决；完整reasoning item保留应纳入下一次范围决策，尚未修改生产契约；
- OpenAI完整reasoning item回放尚未实现，范围待§17.5确认；`item_reference`、`previous_response_id`及Provider compaction仍明确延期；
- Anthropic回放只覆盖硬要求的活动Tool continuation链，不扩展到普通跨Turn preserved thinking；
- 尚无通用`ProviderReplayState` envelope。当前显式`signature`/`data`模型足以完成首期Anthropic范围，但不能直接承载OpenAI完整reasoning item。

这些缺口是明确的阶段边界，不应在实现中用“丢失后静默继续”伪装成已支持。后续若引入第二种opaque replay协议，再把`signature`/`data`提升为带schema version和Provider binding的通用`ProviderReplayState`，避免为一期提前抽象只有一个实现的框架。

### 15.5 对比后的设计决定

采纳：

- blockId关联的thinking start/delta/end；
- Internal Transcript、Provider projection、Public History三层模型；
- Provider-owned回放兼容性判断；最小来源标识待接线验证，不先建立账户级框架；
- replay顺序与UI顺序分离；
- partial display state与durable replay state分离；
- Compaction保留活动兼容suffix，summary不复制opaque state。

暂不采纳：

- OpenAI完成reasoning item保留不再作为已批准延期项；按§17.5提请范围确认，服务端缓存与存储策略仍可独立延期；
- Provider server-side compaction item；
- previous response continuation cache；
- 通用ProviderReplayState envelope；
- reasoning生成控制和capability UI。

### 15.6 实施前必须闭合的验证

本节区分已接受原则与尚未验证的设计细节。草稿仍不授权实现，也不能仅凭外部Agent采用相似方案判定通过。

1. **Anthropic保留范围与失败语义**：覆盖单次和连续Tool调用、签名为空/缺失、redacted块中断、旧历史及活动链中的模型切换。明确哪些历史块允许省略；当前必需数据不可用时，断言调用被阻止且错误可见。禁止统一使用“删除signature后继续”。
2. **最小来源绑定**：由Provider定义兼容性，不让Runner读取Endpoint或猜测账户。先验证同一运行期、Session重载、进程重启、连接配置改变与凭证轮换，再决定是否需要routeFingerprint及其生成方式。不得仅以provider/model相等证明兼容，也不得把未知身份当成匹配。
3. **OpenAI延期条件**：核对Built-in Responses与Copilot Relay实际的store、history和工具调用方式，验证多次Tool续轮及Session重载。若所支持场景要求reasoning item或encrypted_content，则将必要回放纳入范围，或明确缩小支持场景；不因“暂不做生成控制”排除协议必需参数。
4. **跨调用块身份**：同一Turn内各次调用、重试均可能从block index 0开始。Runner公共ID必须包含调用身份；无需增加任意并发调度框架。
5. **三层边界**：Internal Transcript是恢复源；Provider projection负责协议回放；Public History仅用于展示。验证UI重排、折叠与截断不改变原始块，凭证不进入Channel、History或普通日志。

验收优先级：**显示不丢、续轮不坏、凭证不外泄**。若其中一项需要扩大实现范围，应先明确取舍，不用静默降级换取表面成功。

## 16. 文档与 Fitness 更新

实现时需同步：

- `docs/architecture/providers.md`：ModelStreamEvent 清单、§5.1 wire 映射、§5.2、Copilot Relay §7；
- `docs/architecture/runner.md`：事件清单；
- `docs/architecture/channels.md` / `docs/specifications/channel.md`：AgentEvent 相关描述；
- `docs/architecture/session.md`：ContentBlock、opaque state持久化与History安全投影；
- `docs/specifications/runner-turn-flow.md`：事件与不变量；
- `src/architecture-fitness/ft-08-contract-inventory.json` 及相关 fitness 断言。

## 17. 协议核实与本地 Spike（2026-09-30）

### 17.1 有界实验说明

- Status: Accepted（仅实验范围）；用户于2026-09-30要求结合官方文档、代表性Agent与Spike核实§15.6前三项，不授权生产实现。
- 决策问题：当前Client是否已保留续轮所需状态；现有模型来源是否足以区分实际协议；哪些未知仍需上游证据。
- 可证伪假设：当前Client往返会丢失thinking/reasoning状态；两个Responses Client均使用手工history且不发送previous_response_id；ResolvedModel的逻辑protocol不一定是实际wire协议。
- 方法：使用现有Vitest runner和真实Client类，注入本地合成SSE及捕获fetch请求。覆盖两次连续Tool Call、重新创建Client后的第三次调用、空/非空summary及带/不带signature。所有请求由测试替身截获，不访问网络。
- 输出：`extensions/copilot-relay-provider/thinking-replay.spike.test.ts`中的独立表征测试；该目录的既有tsconfig允许同时引用Built-in源码和Relay，避免跨越Core构建rootDir。本节记录实际结果和官方依据，修正候选设计，不修改生产逻辑。
- 安全边界：只使用虚构signature/ciphertext和虚构模型；不读取用户连接、凭证、真实会话，不产生API费用，不把仓库数据发给第三方。
- 通过标准：测试能精确定位状态保留/丢失及请求模式，且明确区分实现事实与上游接受性；不能将本地返回200的测试替身作为真实API兼容性证明。
- 停止条件：遇到需要真实签名、真实账户或网关策略才能回答的问题，标记未实测，不用模拟测试填补事实。

### 17.2 本地实测结果

Status: Provisional Pass（仅本地表征；不是上游兼容性认证）。

| ID | 观察 | 结论及边界 |
|---|---|---|
| L1 | Anthropic带两段signature delta及redacted data的响应，经现有`chat()`后只剩tool_use | 采集路径已丢失状态，后续Transcript不可能恢复未被捕获的数据 |
| L2 | 相同响应不带signature时也被当成普通Tool调用成功返回 | 当前实现没有Thinking块校验；不代表无签名请求被官方API接受 |
| L3 | Built-in Responses空/非空summary、done事件含encrypted_content，均只得到tool_use | summary和最终reasoning item均被丢弃 |
| L4 | Copilot Relay对上述两种响应同样丢弃reasoning | 本地Relay Client与Built-in存在相同信息缺口，网关内部行为未实测 |
| L5 | 两次Tool调用后创建新Client发起第三次请求，history只有function_call/function_call_output或tool_use/tool_result | 没有依靠Client内存保留reasoning；这是新Client复用内存消息测试，不是Session磁盘恢复测试 |
| L6 | 两个Responses请求均未设置store、previous_response_id、include或reasoning | 是手工history重建；**没有设置store不等于store:false**，不能套用纯stateless假设 |
| L7 | Built-in相同model改wire protocol或换虚构API key后，resolveModel描述符仍相同；换baseURL后endpointId不同 | `ResolvedModel.protocol`为builtin-model-router，不是实际wire协议；现有descriptor不足以证明账户/协议兼容，必须在Provider侧判断 |

执行记录：

- 精确Spike：7/7通过；改到Extension测试目录后再次7/7通过。
- 相关既有Client与Builtin Provider测试：45/45通过。
- Extension TypeScript检查通过。
- 根目录`tsc --noEmit`仍有本次未修改的`AgentRunner.test.ts:731`缺少`ChatMessage`导入诊断；未为本Spike修改该独立Subagent测试。
- 首次将跨Client测试放在Core源码目录导致rootDir越界，已改放既有Extension测试目录；没有为Spike更改构建配置或生产源码。

这些测试故意记录当前缺口，不是未来实现必须保持的行为。进入正式实现时，应改成保留完整块和正确回放的契约测试；不得以“当前丢弃也能通过模拟测试”批准延期。

### 17.3 官方资料复核：确认与纠正

证据分层：本节为2026-09-30实际读取的官方资料及固定版本源码；§17.2为本地合成测试；二者均不冒充真实API实验。§14–15其他历史引用并未在本轮逐条重验。

| 原说法 | 本轮判定 | 正确边界 |
|---|---|---|
| Anthropic只需最后一条assistant thinking | 否定 | 连续Tool loop为一个assistant turn，保留循环中所有assistant完整块及结果 |
| signature跨模型必然不兼容 | 否定 | 官方存在跨模型可读关系与指定平台兼容；不可读、请求拒绝和服务端丢块不是同一回事 |
| 重启后signature不可使用 | 否定 | 官方支持保存后恢复，但适用prefix检查时必须保留实际system/tools/messages，而非重新渲染 |
| OpenAI summary不是合法输入 | 否定 | summary是reasoning item输入字段；裸summary_text不是完整reasoning item |
| encrypted_content总是必填 | 否定 | 通用schema中可选；这不授权丢弃已返回item，也不保证任意summary-only请求被接受 |
| OpenAI回放只是一项质量优化 | 不足以成立 | Function calling指导使用must，要求随工具结果回传reasoning items；是否丢掉后必然400仍未知 |
| OpenClaw存在严格回放围栏 | 有限确认 | 本轮确认的是Responses路径的provider/api/model/baseURL/session/authProfile匹配；authProfile不是服务端账户证明 |

**Anthropic官方依据**

- [Thinking with tool use](https://platform.claude.com/docs/en/build-with-claude/thinking#thinking-with-tool-use)：原文“A tool-use loop is one assistant turn.”；[Preserving thinking blocks](https://platform.claude.com/docs/en/build-with-claude/thinking#preserving-thinking-blocks)要求工具循环内完整、原样回传thinking；
- [ThinkingBlockParam](https://github.com/anthropics/anthropic-sdk-python/blob/a7285e919ab79998d9380b3b57f6315b7860b8d8/src/anthropic/types/thinking_block_param.py#L8-L21)要求signature及原始顺序；[RedactedThinkingBlockParam](https://github.com/anthropics/anthropic-sdk-python/blob/a7285e919ab79998d9380b3b57f6315b7860b8d8/src/anthropic/types/redacted_thinking_block_param.py#L8-L15)要求opaque data原样回传；
- [Thinking encryption](https://platform.claude.com/docs/en/build-with-claude/thinking#thinking-encryption)明确指定平台间签名兼容；不能外推到任意兼容网关；
- [Preserved thinking](https://platform.claude.com/docs/en/build-with-claude/preserved-thinking)区分模型可读关系、prefix检查及部分模型account-bound规则。其switching-models指导为“Keep sending the full history … and let the API drop what the current model can't read.”。这不是要求客户端复制完整跨模型矩阵；
- 同页FAQ确认恢复是普通follow-up请求；对适用模型，prefix检查包含system、tools及先前messages。签名篡改错误不能与prefix mismatch可配置行为混为一谈。本期不自动设置drop_block来掩盖问题。

**OpenAI官方依据**

- [Function calling](https://developers.openai.com/api/docs/guides/function-calling)：返回的reasoning items“must also be passed back” with tool call outputs；[Keeping reasoning items in context](https://developers.openai.com/api/docs/guides/reasoning#keeping-reasoning-items-in-context)说明连续工具调用保留最近真实user输入后的reasoning/function_call/function_call_output；
- [ResponseReasoningItemParam](https://github.com/openai/openai-python/blob/58aca1dcfd8d04a3c6352fa2c34b3035ea850f57/src/openai/types/responses/response_reasoning_item_param.py#L31-L60)：id、summary、type为required；encrypted_content可选。`added`中的encrypted内容可能不完整，应取done item；
- [ResponseCreateParams.store](https://github.com/openai/openai-python/blob/58aca1dcfd8d04a3c6352fa2c34b3035ea850f57/src/openai/types/responses/response_create_params.py#L248-L254)：省略时默认true；[Conversation state](https://developers.openai.com/api/docs/guides/conversation-state)将存储与previous_response_id/conversation/手工history分开。上述默认值不能直接推广到Relay；
- [Preserve reasoning without stored responses](https://developers.openai.com/api/docs/guides/reasoning#preserve-reasoning-without-stored-responses)：本轮文档说明store:false/ZDR默认返回encrypted_content，旧include方式仍兼容。不能把“必须添加include才能获得字段”当作所有模式的当前事实。

**代表性源码复核**

- OpenCode固定提交`2fa3363c924c5c3e367b84a87ae478296a0ed59b`：[原生Responses路径](https://github.com/anomalyco/opencode/blob/2fa3363c924c5c3e367b84a87ae478296a0ed59b/packages/llm/src/protocols/openai-responses.ts#L395-L453)在store:false过滤无encrypted state的reasoning；[Copilot converter](https://github.com/anomalyco/opencode/blob/2fa3363c924c5c3e367b84a87ae478296a0ed59b/packages/core/src/github-copilot/responses/convert-to-openai-responses-input.ts#L185-L237)则可构建带缺省encrypted_content的reasoning。这是两条不同实现策略，不是网关保证；
- OpenClaw本轮固定提交`bc6039c578939a14db313b5de52a235311824ddc`：[provider-replay-context](https://github.com/openclaw/openclaw/blob/bc6039c578939a14db313b5de52a235311824ddc/packages/ai/src/transports/provider-replay-context.ts#L31-L57)和[Responses回放测试](https://github.com/openclaw/openclaw/blob/bc6039c578939a14db313b5de52a235311824ddc/packages/ai/src/transports/openai-responses-reasoning-replay.test.ts#L79-L108)证实严格客户端围栏。此结果不追认旧SHA的全部引用，也不将Responses策略升级为Anthropic API硬要求。

### 17.4 三个问题的当前收敛程度

1. **Anthropic保留范围：文档层已闭合。** 保存并回传整个当前Tool loop，而非最后消息；模型适用的preserved prefix规则单独处理。现有缺失字段可在本地校验，密码学有效性由上游判断，客户端不能凭非空字符串证明签名正确。
2. **兼容性：职责已闭合，最小持久结构未闭合。** 实际wire协议、生产模型、可信后端来源有用；进程ID、Session ID、API key全等不是Anthropic通用要求。恢复是否需要原始system/tools快照取决于目标模型prefix约束；当前仅有内容块和routeFingerprint的候选不足以证明完整恢复。接线方案应复用现有Provider事实，不能先实现账户注册表。
3. **Responses延期：原假设已被否决，网关行为仍未知。** 不能将已返回reasoning item主动丢弃作为正式目标；建议纳入完成item的无损保存/回放。是否必须主动请求ciphertext与当前store默认行为、模型和endpoint相关，Relay需单独验证。

尚未执行的最小真实上游对照：Anthropic完整Tool loop与缺块路径；OpenAI store省略和显式false分别测试完整output与丢item；Relay维持当前store省略模式单独测试。只发送合成输入和无副作用工具，需先确定可用测试连接及调用预算；本轮未读取或使用真实凭证。HTTP成功仅证明接受性，不证明模型恢复了原reasoning或质量等价。

### 17.5 范围决策（已确认，未授权生产实施）

2026-09-30所有者确认将“保留并回放上游实际返回的完整Responses reasoning item”纳入本Change必要协议工作，而不是扩展为通用Replay Registry。UI、生成开关非目标及三层投影原则不变；store策略、服务端缓存、previous_response_id和Provider compaction仍不顺带引入。

这是对原“先做Anthropic opaque replay”的实质范围调整。后续已通过[归档Plan](../changes/archive/thinking-capture-and-display/plan.md)、[Specification](../changes/archive/thinking-capture-and-display/thinking-capture-and-display-specification.md)及[验证记录](../changes/archive/thinking-capture-and-display/validation.md)完成Chat Completions/Responses的最小实现与验收；Anthropic专项仍为Deferred。
