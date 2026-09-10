# Copilot Relay Responses Protocol Spike Spec

## 1. 状态

- **状态：** Completed
- **版本：** 0.4
- **日期：** 2026-09-10
- **所有者：** 项目所有者
- **Timebox：** 4 小时
- **关联 Plan：** [Provider Model Catalog and Copilot Relay Plan](../roadmap/provider-model-catalog-and-copilot-relay-plan.md) R0
- **关联 Module Spec：** [Provider Model Catalog and Copilot Relay Module Spec](provider-model-catalog-and-copilot-relay-spec.md)
- **关联 Results：** [Copilot Relay Responses Protocol Spike Results](copilot-relay-responses-spike-results.md)
- **工作流：** [Development Workflow](../development-workflow.md)

项目所有者于 2026-09-10 接受本 Spike Spec。该接受冻结实验范围，但不等于批准执行 Spike，也不授权 production code、dependency 安装、commit 或 push；这些控制点分别确认。

项目所有者随后于 2026-09-10 单独授权执行 R0，并于同日确认 `Provisional Pass` Results。Disposable artifact 已清理且验证完成，因此本 Spike 状态为 `Completed`。该确认不表示 Module Spec 已接受或 production Delivery 已授权。

R0 Results Review 已完成。当前源码、既有 Accepted Architecture 和 Module Spec 中已接受的部分仍是权威；实验观察只能作为证据，不得直接转化为未评审的 production contract。

## 2. Question

本地 Copilot Relay 的 HTTP `/v1/responses` 和 `/v1/models` 是否足以让一个 Provider Extension 在不泄漏 Responses/SDK 类型到 Core、Runtime、Runner 或 Channel 的前提下，正确实现现有 `ModelInvocationPort` 所需的 Text、stream projection、Tool round-trip、Image、Usage、Abort 和 normalized error 语义？

## 3. Hypothesis

对于 `/v1/models` 声明支持 `/responses` 的 `gpt-5.6-sol`：

1. `/v1/responses` 接受非流式和 SSE stream 请求；
2. 文本增量、完成状态和 Usage 可确定性投影为 Core stream events；
3. function call arguments 可以完整累积并与后续 function output 关联；
4. Core image block 可以转换为 Responses image input；
5. AbortSignal 能及时取消客户端消费和底层 HTTP 请求，且不会产生成功 terminal event；
6. HTTP/Provider 错误包含足够的 status/type/request-id/message 供现有 `ModelInvocationError` 脱敏诊断；
7. 官方 OpenAI SDK 支持 custom base URL、Responses stream、Abort 和 Tool mapping，且不会要求 Provider-specific 类型越过 Extension boundary。

任一 required semantic 无法通过官方 SDK 实现时，原生 `fetch` + bounded SSE parser 仍能在 Extension 内实现同一 Port，而不改变 Core contract。

## 4. Decision Unlocked

Spike Results 决定：

- Module Spec §9.4 的最终 Responses wire mapping；
- 使用官方 OpenAI SDK 还是原生 `fetch`；
- 是否需要扩展 `ModelInvocationPort`、normalized error 或 Tool correlation contract；
- Copilot Relay Extension 是否可以进入 production Delivery C2；
- 哪些 Relay 限制必须作为第一版已知限制或前置校验。

如果证据要求 Core/Runtime 理解 Responses item/stream/Endpoint，当前设计假设失败，必须回到 Spec Review，不直接实现旁路。

## 5. Scope

- 实际调用 `http://127.0.0.1:5000/v1/models`；
- 使用 `gpt-5.6-sol` 调用 HTTP `/v1/responses`；
- 非流式文本请求；
- SSE streaming 文本请求与事件序列采样；
- 强制单个 function call、参数流、output 回传、第二次响应；
- 单张 PNG/JPEG input；
- Usage 字段和 stop/completion 状态；
- Abort before first content 与 mid-stream abort；
- invalid model、invalid max output、malformed Tool output 等错误样本；
- 对官方 OpenAI SDK custom base URL 的最小验证；
- `/v1/models` 必要字段 Schema、缺失字段和不合格 entry 过滤 fixture。

## 6. Non-goals

- production Adapter、重试、缓存、日志或配置实现；
- `/chat/completions`、Anthropic Messages、WebSocket Responses、Realtime 或 Embeddings；
- 性能、吞吐、并发、rate limit 或长期稳定性基准；
- 多图限制、图片 resize 策略或所有模型的穷举测试；
- reasoning effort、structured outputs、parallel Tool Calls；
- Session 写入、RuntimeApp/Channel 接线或 UI；
- 修改 Relay 服务。

## 7. Method

### 7.1 环境记录

记录：

- 日期、OS、Node 版本；
- Relay base URL 和健康状态，不记录 credential；
- `/v1/models` 中目标 entry 的 ID、supported endpoints、基本 limits 和 supports；
- 每个 Case 的准确执行命令，以及该 Case 使用 `raw-http` 还是 `openai-sdk`；
- 使用 SDK 时记录解析到的 package name/version；未使用时明确记录 `SDK_NOT_USED`。若安装新 dependency 必须另行授权，优先用 `npx`/disposable workspace 或 raw HTTP 完成前半证据；
- disposable artifacts 的路径和用途；Results 完成后记录删除或经项目所有者另行接受保留的结果。

执行任何实验前先记录 `git status --short`，标明用户改动、既有 Defect 改动和本 Spike disposable artifacts 的边界。Spike 不修改或清理边界外文件；若无法隔离，停止并回报，不以 reset/stash/覆盖方式处理。

### 7.2 实验矩阵

| Case | 输入 | 必须观察 |
|---|---|---|
| M1 | `GET /v1/models` | list shape、目标模型、必要 limits、`/responses` membership |
| R1 | non-stream text | HTTP 200、response status、output text、usage |
| R2 | `stream:true` text | SSE event type/order、delta、terminal、usage |
| R3 | forced function tool | function call ID/name/arguments、completion state |
| R4 | function output follow-up | correlation identity、最终文本、usage |
| R5 | one image | accepted image wire shape、最终文本 |
| R6 | abort before content | request cancellation、无成功 terminal |
| R7 | abort mid-stream | bounded cancellation、无重复 terminal |
| R8 | invalid model/max output | status、structured error type/message/request ID |
| S1 | SDK custom base URL | 与 raw HTTP 等价的 R1/R2/R3/R4/Abort 核心结果 |

每个请求使用最小 token 和最小 payload；Tool 无副作用；Image 使用本地合成的最小有效 fixture。输出只保留事件类型、ID/计数、status、usage 和脱敏错误，不保留 credential 或完整生成内容。

### 7.3 Tool correlation

Tool 实验必须使用 Relay 实际返回的 function call identity，不伪造 ID。第二次请求回传 exact function output correlation item，验证同一 Provider 环境中的正常 round-trip。

### 7.4 Abort

Abort 使用 `AbortController`，记录发起取消到客户端 settled 的时间和 observed terminal events。禁止通过固定长 sleep 伪造通过；测试应由首个可观察事件或确定性短流触发取消。

## 8. Required Evidence

- 每个 Case 的请求结构摘要、HTTP status 和 event type 序列；
- R2/R3/R4 的原始 event type 名称与必要字段路径；
- R6/R7 的时间与 terminal count；
- R8 的 structured error shape；
- SDK 与 raw HTTP 的差异；
- `/v1/models` parser 的 valid/invalid fixtures；
- 每个 Case 的准确执行命令、`raw-http`/`openai-sdk` transport 标记和环境版本；
- SDK package/version 或 `SDK_NOT_USED`；
- disposable artifacts 清单、路径与 cleanup 结果；
- 一份 Spike Results 文档，明确 Supported、Unsupported、Deferred 和 Spec amendments。

不得把含 Authorization、base64、prompt 正文或完整 Tool arguments 的 raw capture 提交到仓库。

## 9. Success Conditions

Hypothesis 获得支持需同时满足：

- R1–R5 可映射到现有 `ModelInvocationPort`，不新增 Provider-specific Core type；
- R2 能产出确定性 text delta 和单一 terminal Usage；
- R3/R4 保持完整 Tool identity、name、object arguments 和 output correlation；
- R6/R7 有界取消且不产生 completed terminal；
- R8 足以归一化 category 和脱敏 diagnostics；
- SDK 或 raw fetch 至少一个方案可以把全部实现封装在 Extension；
- 没有证据要求 Runtime/Runner 按 Relay/Responses 分支。

## 10. Failure and Stop Conditions

以下任一项使 Spike 失败并停止 production Delivery：

- Relay 声明 `/responses` 但 Text/Tool required path 不可用；
- Tool identity/output 无法跨 required follow-up 关联；
- Streaming 没有可靠 terminal/usage 且非流式 fallback 也不能投影现有 Port；
- Abort 无法取消底层请求并造成不可接受的资源泄漏；
- 必须把 Responses SDK objects 或 Endpoint logic暴露给 Core/Runner；
- Relay 不可达、认证需要未授权 secret 或环境无法形成可重复证据；
- 实验需要修改 Relay、付费扩大调用或超出 4 小时时间盒。

失败后只记录证据和选项，不在 production 增加特例。

## 11. Constraints

- 不读取、输出或提交 credential；
- 只访问用户提供的 loopback Relay；
- 不写 Session、不启动长期 Server、不修改生产文件；
- 调用次数保持实验矩阵最小值；
- disposable scripts 在 Results 完成后删除，除非项目所有者另行接受其作为长期诊断工具；
- Spike Results 必须记录执行前后工作树边界和 cleanup 结果；
- dependency 安装、production 修改、commit 和 push 均需独立授权。

## 12. Outputs

- `copilot-relay-responses-spike-results.md`；
- 对 Module Spec §9.4、Errors、Acceptance 和已知限制的证据化更新；
- SDK/raw fetch 选择及理由；
- disposable code/resource cleanup 记录；
- 项目所有者对 Results 和是否进入 C1/C2 Delivery 的确认。
