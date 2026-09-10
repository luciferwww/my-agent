# Copilot Relay Responses Protocol Spike Results

## 1. Record

- **Spike Status:** Completed
- **Outcome:** Provisional Pass（项目所有者已接受）
- **Execution Date:** 2026-09-10
- **Acceptance and Cleanup Date:** 2026-09-10
- **Owner:** 项目所有者
- **Spike Spec:** [Copilot Relay Responses Protocol Spike Spec](copilot-relay-responses-spike-spec.md)
- **Module Spec:** [Provider Model Catalog and Copilot Relay Module Spec](provider-model-catalog-and-copilot-relay-spec.md)
- **Environment:** Windows NT 10.0.26200.0；Node v22.22.2；Relay `http://127.0.0.1:5000`；目标模型 `gpt-5.6-sol`
- **Credential:** 未配置；请求未发送 `Authorization`
- **SDK:** `SDK_NOT_USED`；`npm ls openai --depth=0` 确认当前项目未安装 OpenAI SDK
- **Transport:** raw HTTP `fetch` + disposable bounded SSE parser
- **Starting HEAD:** `9f52737`

本 Results 只记录测试环境中的脱敏观察和由其直接支持的映射。项目所有者于 2026-09-10 确认 `Provisional Pass`；disposable artifact 已删除并完成 cleanup validation，因此 Spike 状态为 `Completed`。该确认不接受 Module Spec 或 production design，也不授权 C1/C2/C3/C4 Delivery、dependency 安装、commit 或 push。

## 2. Hypothesis

对于 `/v1/models` 声明支持 `/responses` 的 `gpt-5.6-sol`：

1. `/v1/responses` 接受非流式和 SSE stream 请求；
2. 文本增量、完成状态和 Usage 可确定性投影为 Core stream events；
3. function call arguments 可以完整累积并与后续 function output 关联；
4. Core image block 可以转换为 Responses image input；
5. AbortSignal 能及时取消客户端消费和底层 HTTP 请求，且不会产生成功 terminal event；
6. HTTP/Provider 错误包含足够的 status/type/request-id/message 供现有 `ModelInvocationError` 脱敏诊断；
7. 官方 OpenAI SDK 支持 custom base URL、Responses stream、Abort 和 Tool mapping，且不会要求 Provider-specific 类型越过 Extension boundary。

任一 required semantic 无法通过官方 SDK 实现时，原生 `fetch` + bounded SSE parser 仍能在 Extension 内实现同一 Port，而不改变 Core contract。

## 3. Execution

### 3.1 Worktree boundary

执行前运行 `git status --short`。边界外既有改动为：

- `scripts/server.ts`；
- Anthropic diagnostics、Runtime diagnostics 和 Abort/legacy Session 相关源码及 tests；
- `docs/CLAUDE.md`；
- `scripts/test-llm-proxy.ts`。

本 Spike 未修改、清理、stash 或 reset 上述文件。唯一 disposable artifact 是 `scripts/copilot-relay-responses-spike.mjs`。

### 3.2 Exact commands

```text
node --version
node scripts/copilot-relay-responses-spike.mjs --models-only
node scripts/copilot-relay-responses-spike.mjs
node scripts/copilot-relay-responses-spike.mjs --follow-up
node scripts/copilot-relay-responses-spike.mjs --terminal-only
node scripts/copilot-relay-responses-spike.mjs --fixtures-only
npm ls openai --depth=0
node scripts/copilot-relay-responses-spike.mjs --mapping-only
node scripts/copilot-relay-responses-spike.mjs --tool-only
```

所有 live Case 使用 `raw-http`。`npm ls openai --depth=0` 返回 empty tree 和 exit code 1；未安装 dependency，因此 S1 未执行 SDK 请求。

### 3.3 Method corrections and deviations

1. R4 首次以 `previous_response_id` 加单独 `function_call_output` 回传时得到 HTTP 400；随后按 stateless input 重放完整 `function_call` item，再追加同一 `call_id` 的 `function_call_output`，HTTP 200。Production mapping 因此不依赖 Relay response storage 或 `previous_response_id`。
2. R5 首次使用内嵌 1×1 PNG 常量得到 HTTP 400；改用项目已有 `sharp` 生成确定有效的 2×2 PNG buffer，并以 `data:image/png;base64,...` 发送后 HTTP 200。该修正不增加 dependency，且不把 base64 写入 Results。
3. R7 首次 disposable collector 在 `reader.read()` 抛出 AbortError 时丢失已收集事件；修正 collector 保留 partial sequence 后重测，确认在首个 text delta 后取消。
4. 为冻结 stop mapping，增加一个 `max_output_tokens: 16` 的 output-limit sample；为验证请求转换，增加 assistant text history sample。这些请求均属于既定 Text、terminal 和 history mapping 范围。
5. S1 未执行：当前项目没有 OpenAI SDK，dependency 安装未获授权。成功条件允许 SDK 或 raw fetch 至少一种方案封装全部 required semantics；本 Results 选择已完整取证的 raw fetch。

## 4. Evidence

### 4.1 Model discovery and eligibility

`GET /v1/models` 返回 HTTP 200，list shape 为 `data[]`，并包含 `gpt-5.6-sol`：

- `supported_endpoints`: `['/responses', 'ws:/responses']`；
- `max_context_window_tokens`: 1,050,000；
- `max_prompt_tokens`: 922,000；
- `max_output_tokens`: 128,000；
- `supports.streaming/tool_calls/vision`: `true`；
- image media types 至少包含 PNG、JPEG、WebP 和 GIF。

按 Module Spec 的保守投影，`effectiveContextLimit = min(922000, 1050000) = 922000`，`maximumOutputTokens = 128000`。

Disposable parser fixtures 验证：完整 metadata 和仅 prompt limit 的 entry 可接纳；空白 ID、缺 `/responses`、非正 output limit、缺 prompt/context limit 的 entry 均拒绝。

### 4.2 Case matrix

| Case | Result | Sanitized evidence |
|---|---|---|
| M1 | Pass | HTTP 200；`data[]`；目标模型存在并声明 `/responses` |
| R1 | Pass | non-stream HTTP 200；`status='completed'`；message output；terminal `usage` 存在 |
| R1 history | Pass | ordered user `input_text` + assistant `output_text` + user `input_text` 得到 HTTP 200 |
| R2 | Pass | SSE HTTP 200；text delta 与单一 completed terminal 可确定观察 |
| R2 limit | Pass | `response.incomplete`；`response.status='incomplete'`；`incomplete_details.reason='max_output_tokens'`；terminal usage 存在 |
| R3 | Pass | forced function call；arguments deltas 完整累积；done item arguments 是合法 JSON |
| R4 | Pass with mapping constraint | stateless `function_call` + 同 `call_id` 的 `function_call_output` 得到 HTTP 200、`status='completed'`、message output 和 terminal Usage；`previous_response_id` 方案在本环境被拒绝 |
| R5 | Pass | 2×2 locally generated PNG data URL 得到 HTTP 200 |
| R6 | Pass | request 发起后、首个 content 前 Abort；5 ms settled；AbortError；0 successful terminal |
| R7 | Pass | 首个 `response.output_text.delta` 后 Abort；2 ms settled；AbortError；0 terminal event |
| R8 invalid model | Pass | HTTP 400；body path `error.type='invalid_request_error'`、`error.message`；无 request-id header/body field |
| R8 invalid max output | Pass | HTTP 400；相同 bounded structured error shape |
| R8 malformed Tool output | Pass | HTTP 400；相同 bounded structured error shape |
| S1 | Deferred | SDK 未安装，且本 Spike 未获 dependency 安装授权；未执行 SDK 请求 |

### 4.3 SSE text sequence

Observed text sequence：

```text
response.created
response.in_progress
response.output_item.added (item.type='message')
response.content_part.added
response.output_text.delta (delta: string)
response.output_text.done
response.content_part.done
response.output_item.done
response.completed
```

`response.output_text.delta.delta` 是 Core `text_delta.text` 的来源。`response.completed.response.usage` 是 completed path 的 authoritative Usage；一次 terminal 只发送一次 Core Usage。

### 4.4 Tool identity and arguments

Observed Tool sequence：

```text
response.created
response.in_progress
response.output_item.added (item.type='function_call')
response.function_call_arguments.delta × N
response.function_call_arguments.done
response.output_item.done (item.type='function_call')
response.completed
```

Evidence：

- `response.output_item.done.item.call_id`、`.name` 和 `.arguments` 完整；
- arguments delta 拼接结果等于 `response.function_call_arguments.done.arguments` 和 `response.output_item.done.item.arguments`；
- `call_id` 在 output-item added/done 间稳定；
- `output_index` 在 added/delta/arguments-done/output-item-done 序列中稳定；
- Relay 的 `item.id` / delta `item_id` 不稳定：一次 sample 中每个 arguments delta 都观察到不同 `item_id`，且不等于 added/done item ID；Adapter 不得用 `item_id` 跨事件关联；
- Core 只需要 complete Tool Call，因此 Adapter 可以在 `response.output_item.done` 时读取完整 item 并发出一个 `tool_call`，无需把 Provider item ID 暴露给 Core；
- Core `ToolCall.callId` 使用 Responses `call_id`。历史重放使用 stateless `function_call` item，Tool Result 使用 `{ type: 'function_call_output', call_id, output }`。

### 4.5 Terminal and Usage

| Responses terminal | Required Core projection |
|---|---|
| `response.completed` + no function call output | one `message_end` with `stopReason='end_turn'` |
| `response.completed` + one or more complete function calls | one `message_end` with `stopReason='tool_use'` |
| `response.incomplete` + `incomplete_details.reason='max_output_tokens'` | one `message_end` with `stopReason='max_tokens'` |
| `response.failed` or SSE `error` | normalized Core `error`; no success `message_end` |
| AbortError | Core `error` carrying AbortError; no `message_end` |

For completed/incomplete terminal events, Usage comes from `event.response.usage.input_tokens` and `.output_tokens`. `total_tokens` and detail objects are Provider-private in v1. Non-stream responses use top-level `response.usage`.

### 4.6 Error shape

Observed invalid request shape：

```text
HTTP 400
content-type: application/json
error.code
error.message
error.type = 'invalid_request_error'
```

`code` was present as a key but not a string value in the sample. No `x-request-id`, `request-id`, `x-github-request-id`, or body `request_id` was present on tested failures. Successful responses did include `x-request-id` and `x-github-request-id` headers.

Adapter mapping：

- HTTP 400 → `ModelInvocationError('invalid_request')`；
- sanitize and bound `error.type` / `error.message`；
- request ID remains optional and is extracted from known headers/body only when present；
- do not record raw body, prompt, image data, Tool input/output or schema content。

## 5. Findings

### 5.1 Supported

- Native `/v1/responses` non-stream and SSE paths are sufficient for current Text semantics.
- Existing Core `ModelInvocationPort` can represent text, complete Tool Calls, terminal stop reason, Usage, Abort and normalized errors without Responses-specific Core types.
- Stateless Tool replay preserves the only identity Core requires: Responses `call_id`.
- A valid single PNG can be encoded as `input_image.image_url` data URL.
- `AbortController` cancels pre-content and mid-stream client consumption with no success terminal.
- raw `fetch` and a bounded SSE parser can remain fully private to the Relay Extension.

### 5.2 Unsupported or rejected in the tested environment

- The tested `previous_response_id` follow-up shape was rejected with HTTP 400. It is unnecessary because stateless replay succeeds.
- Relay event `item_id` is not a stable Tool correlation identity and must not be persisted or exposed.
- Tested invalid requests did not return a request ID; diagnostics must treat it as optional.

### 5.3 Deferred

- Official OpenAI SDK custom base URL, stream, Tool and Abort behavior was not tested because the SDK is not installed and dependency installation was not authorized.
- Multiple images, image size enforcement, parallel Tool Calls, structured output, reasoning policy, background responses, response storage and WebSocket Responses remain non-goals.
- Malformed/truncated SSE and early transport close belong to C2 parser fixtures, not this live Spike.

## 6. Hypothesis Assessment

Items 1–5 are supported in the tested environment. Item 6 is supported for the accepted success condition：HTTP status、structured type 和 bounded message 足以归一化 category 与 diagnostics；但 request-ID 子假设未获本次失败样本支持，因为错误响应没有提供 request ID。现有 diagnostics 已将 request ID 定义为可选，因此不需要改变 Core contract。

Item 7 is Deferred, not falsified. The accepted success condition requires SDK **or** raw fetch to encapsulate all required semantics. Raw fetch did so without changing Core, Runtime, Runner or Channel contracts, so the aggregate Question receives **Provisional Pass**.

No Stop Condition was hit：Text and Tool required paths worked；Tool output correlated statelessly；Streaming provided deterministic terminal/Usage；Abort settled promptly without success terminal；all Responses details remain inside the Extension boundary。

## 7. Decision Impact

1. Select raw HTTP `fetch` + bounded SSE parser for C2; do not add OpenAI SDK dependency for v1.
2. Keep `ModelInvocationPort`, normalized Core errors and Tool correlation contract unchanged.
3. Freeze the evidence-based mapping in Module Spec §9.4, including the Relay-specific unstable `item_id` rule.
4. Use stateless history replay; do not depend on Relay response storage or `previous_response_id`.
5. C2 remains blocked until the project owner separately accepts the completed Module Spec.

## 8. Limitations and Residual Risks

- Evidence applies to the local Relay and `gpt-5.6-sol` observed on 2026-09-10; upstream behavior can change independently.
- The live error surface returned only generic invalid-request text, so detailed Provider categories cannot be inferred beyond HTTP status/type.
- Abort proves client-side fetch/body settlement, not server-side compute cancellation telemetry.
- A bounded SSE parser still needs C2 fixture coverage for malformed frames, partial UTF-8, `[DONE]`, duplicate/out-of-order terminal events and early close.
- Ignored Relay metadata constraints can still cause normalized Provider errors at invocation time.

## 9. Follow-up

- [x] Module Spec §9.4, Errors, Acceptance and known limitations updated from evidence.
- [x] SDK/raw fetch selection recorded.
- [x] Disposable script removed after evidence capture.
- [x] Credential/base64/prompt/Tool argument raw captures excluded from repository artifacts.
- [x] Project owner confirmed `Provisional Pass` on 2026-09-10.
- [x] After owner confirmation and cleanup validation, mark Spike `Completed`.
- [ ] Separately decide whether to accept Module Spec.
