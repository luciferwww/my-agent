# Tool Result 结果状态持久化设计草稿

> Status: Non-authoritative design draft
> Authorization: 不授权实现，不覆盖 Current Architecture、Accepted Decisions、Stable Specifications 或源代码
> 创建日期：2026-09-30
> Scope: 保留执行层已知的 Tool Result 结果状态，并将临时审批按钮内嵌到 Tool Call 卡片；不持久化 Approval
> Related: [Session Architecture](../architecture/session.md)、[Runner Architecture](../architecture/runner.md)、[ADR-001](../decisions/adr-001-tool-result-closure-and-recovery.md)、[Tool Activity 展示草稿](tool-activity-presentation-design-draft.md)
> Follow-up: 四态 Tool Result 与 Inline Approval 已由完成并归档的 [Unified Async Tool Execution Framework Plan](../changes/archive/async-tool-use/plan.md) 和 [Specification](../changes/archive/async-tool-use/specification.md) 承接；本文仅保留讨论来源。

## 1. 已确认需求与文档边界

用户已确认需要保存 Tool Result 是否出错的信息；Approval 不加入持久化。本轮仅讨论和形成草稿，此前试写的实现已撤销。

进一步确认的范围：

- 统一以 Runner 持有的执行结果为事实来源，不依赖 LLM Provider 判断 Tool 是否失败。
- 每次 Tool 调用的结果独立保存，包括同一 Turn 内先失败、再调整尝试、最后成功的完整过程。
- 单次 Tool 失败不等于整个 Turn 失败；本次仅补充持久化状态，不改变既有 continuation 控制流程。
- 后续 Tool 成功或 Turn 正常结束，不覆盖、不清除先前 Tool Result 的失败状态。
- 不修改任何 Provider 请求编码，包括 Anthropic 的 `is_error` 映射。
- Approval 不再作为独立气泡；Allow / Deny 按钮放在对应 Tool Call 卡片底部，发送后乐观隐藏，不新增确认回执协议。

2026-09-30 最新讨论将第四态命名统一为 `aborted`，采用必填 `status: 'success' | 'error' | 'denied' | 'aborted'`，不兼容旧数据。实时与 History 使用同一四态，Runner 内部 canonical outcome 保持不变。`aborted` 描述 Tool 调用的取消/中断及未知恢复，不要求整个 Turn 必须中断；不保证工具未执行或副作用已撤销，也不改写已经完成的 Tool Result。本期不新增单工具取消机制。

这些是草稿中的已确认设计决定，不等于正式 Specification 已 Accepted 或实现已获授权。

本任务当前分类为 Documentation。后续实现将改变 Session、Model Invocation 和 History 的跨模块数据契约，应按 [Development Workflow](../governance/development-workflow.md) 建立 Plan / Specification，并经项目所有者批准进入 Delivery；本草稿不能代替该批准。

## 2. 当前事实与缺陷

以下为当前源码事实，不代表已完成新方案的测试：

| 环节 | 当前行为 | 证据 |
|---|---|---|
| Tool 执行 | Tool 实现返回 `success` / `failed`；Core canonical result 还区分拒绝、取消、未执行等结果 | [Tool types](../../src/core/tools/types.ts) |
| Runner | 持有 `{ callId, outcome, content }`，实时结果由 `outcome !== 'success'` 派生 `isError` | [AgentRunner](../../src/core/runner/AgentRunner.ts) |
| Transcript 写入 | 同一个 Runner 构造 `tool_result` 时只保留关联 ID 和 content，没有保留 outcome | [AgentRunner](../../src/core/runner/AgentRunner.ts)、[Session types](../../src/core/session/types.ts) |
| History | 从持久化消息生成展示页，没有额外执行状态来源 | [SessionManager](../../src/core/session/SessionManager.ts) |
| Web 客户端 | 实时使用 `isError`；History 重建默认 `isError: false`，收到结果便标记 completed | [chat.html](../../extensions/websocket-channel/client/chat.html) |

因此失败 Tool 的错误文本已经保存，但机器可判断的失败状态被丢弃。Turn 终态后使用 History 替换实时内容时，卡片可能由 Failed 变成 Succeeded。

这不是 OpenAI 缺少错误字段导致的：Tool 由本地执行层执行，结果写盘也由 Runner 发起。上游协议不决定本地能否保存执行事实。

## 3. 目标与非目标

目标：

- 同一次 Tool 调用的实时展示与 History 展示不矛盾。
- 状态来自执行层结果，不从 content 文本、HTTP 字样或异常消息猜测。
- 按 `tool_use_id` 保存和关联每个调用的结果，支持同一消息内的多 Tool Result 和跨页配对。
- 保留各次尝试的顺序、调用参数、结果内容与独立状态；不按 Tool 名称或 Turn 最终状态合并为一个结果。
- 未知执行结果不得被宣称为成功或已确认失败。
- Provider 请求行为保持不变，本地新增状态不泄漏到上游请求。
- 审批仅作为 Tool Call 卡片中的临时操作区，调用结果仍由 Runner 提供，History 不恢复审批按钮。

非目标：

- 不持久化 Approval，不重建 Approval 卡片。
- 不修改服务端 Approval 生命周期、权限模型或消息协议；仅调整客户端审批呈现与按钮状态。
- 不处理旧 Runtime 红框的自动清理。
- 不修改 Provider 请求编码，不新增 Anthropic `is_error` 投影。
- 不重写 History 分页、滚动锚点或 Turn presentation identity 机制。
- 不引入 Tool 自动重试、恢复执行、工作流日志或并行调用。
- 不因新增状态字段让普通 Tool 失败中断 Turn，也不绕过既有 Abort、预算或其他终止条件。
- 不保存原始 Error 对象、堆栈、底层响应对象或新增敏感诊断数据。

保存 `denied` 只表达 Tool 调用未获准执行，不等于保存 Approval 交互；也不能由此推断一定弹出过审批卡片。

## 4. 已确认数据设计：四态 status

```ts
{
  type: 'tool_result';
  tool_use_id: string;
  content: string;
  status: 'success' | 'error' | 'denied' | 'aborted';
}
```

字段命名保留现有 `tool_use_id`；`status` 是单词字段，没有 camelCase / snake_case 混用问题。新写入记录必须包含合法 status，不再增加 `is_error`、`failed` 或完整 outcome 作为第二份持久化状态。具体原因沿用已有 content，不增加重复的错误原因字段。

| status | 含义 |
|---|---|
| `success` | 调用成功 |
| `error` | 调用出错或无法成功完成，包括无效输入、工具不存在、不可用、未执行等；不专指 Tool 实现抛异常 |
| `denied` | 调用未获准执行 |
| `aborted` | Tool 调用的取消/中断及未知恢复，包括随 Turn 取消和崩溃恢复；不要求整个 Turn 中断，不声明工具一定没有执行或已经撤销 |

Runner 继续保留既有 canonical outcome 分类和控制流程，在发布实时结果、构造持久化 Tool Result 时使用同一四态映射。四态是持久化与展示分类，不替代内部执行事实。采用布尔值会丢失用户希望区分的拒绝和中断；暴露完整 canonical 枚举则超出本次展示需求，因此不采用这两个候选。

数据流建议：

```text
Tool 执行 / Runner 分类
  -> CanonicalToolResult
  -> Runner 统一映射四态 status
     -> 实时事件携带 status -> UI
     -> tool_result block 保存 status -> Session Transcript -> History -> UI

既有模型 continuation：
  tool_result content -> Model Invocation -> Provider 既有投影（不变）
```

Session 负责保留执行层提交的结果，不重新推断业务成败。Model Invocation 和 Session 的内容契约需同步；具体类型引用位置应沿用既有 Core 依赖方向，不额外扩大类型重构范围。

## 5. 结果来源与恢复语义

### 5.1 每次调用独立记录，失败后允许继续

普通 Tool 执行失败会成为提供给模型的 Tool Result。模型可以据此调整参数、换用工具或采用另一种方式继续，直到完成任务或触发既有终止条件。这不是 Runner 自动重试同一个调用，也不保证最终一定成功。

同一个 Turn 可以包含：

```text
Tool Call A -> Failed：路径不存在
模型调整路径
Tool Call B -> Failed：权限不足
模型改用另一种方式
Tool Call C -> Succeeded
Assistant -> 最终回答
Turn -> 正常结束
```

A、B、C 必须分别通过各自的 `tool_use_id` 保存结果。即使调用同名 Tool，也不能把后一次成功当作前一次结果的更新。失败结果的 content 继续沿既有路径供模型读取，本次只补充写盘时丢失的状态，不改变模型输入文本或调用循环。

History 收敛、重新打开 Session 或从磁盘重载后，A、B 仍显示 Failed，C 显示 Succeeded；Turn 的正常结束只代表 Turn 完成，不代表该 Turn 内每个 Tool 都成功。不能只记录最后成功的一次，也不能在成功后清理失败的 Tool Result。

### 5.2 受控 Abort 与未知恢复

依据 [ADR-001](../decisions/adr-001-tool-result-closure-and-recovery.md)：

| 执行事实 / canonical outcome | 持久化与实时 status |
|---|---|
| `success` | `success` |
| `denied`，包括用户、策略或 hook 拒绝 | `denied` |
| `failed`、`invalid_input`、`unknown_tool`、`unavailable` | `error` |
| `not_executed`，因 Turn 停止而尚未启动 | `error`，content 保留未执行原因 |
| `aborted`，沿用既有 canonical 分类 | `aborted` |
| 未知恢复 / `outcome_unknown` 语义 | `aborted`，content 保留未知结果的恢复说明 |

不能只因 `signal.aborted` 就覆盖已完成成功结果；真实终态优先。孤儿修复仅补缺失调用，不覆盖已有结果、不自动重放，并保留原 Tool Use 所属 Turn。

当前孤儿修复直接补写 `[tool call interrupted; session recovered]`，并非重新执行工具。新格式对此补写 `status: 'aborted'`，保留原文和原 Turn 关联，不增加第五态。

这不把未知事实改写成 canonical `aborted` 或 `failed`，也不把恢复说明改成“用户取消”或“工具已取消”。展示层 status 的 `aborted` 包含未知恢复，语义比内部 canonical `aborted` 更宽，不推导安全重试或副作用撤销，维持 ADR-001 对未知结果的约束。

## 6. Provider 不变边界与 UI 投影

### 6.1 Provider 不参与本地结果判定

本地结果的权威来源是 Runner 持有的 canonical result。Provider 仅负责既有的模型协议转换，既不决定执行结果，也不决定 History 应保存什么。本期不新增任何 Provider 字段映射：

| Adapter | 当前发送结构 | 本期约束 |
|---|---|---|
| [Anthropic Messages](../../src/builtins/providers/builtin/AnthropicMessagesClient.ts) | `tool_result`、`tool_use_id`、`content` | 保持现有投影，不新增 `is_error` 或本地 status |
| [OpenAI Responses](../../src/builtins/providers/builtin/OpenAIResponsesClient.ts) | `function_call_output`、`call_id`、`output` | 保持现有投影，不发送本地 status |
| [OpenAI Chat Completions](../../src/builtins/providers/builtin/OpenAIChatCompletionsClient.ts) | `role: tool`、`tool_call_id`、`content` | 保持现有投影，不发送本地 status |
| [Copilot Relay Responses](../../extensions/copilot-relay-provider/responses-client.ts) | Responses 风格输出 | 同 OpenAI Responses，验证独立 Extension 边界 |

错误描述继续经既有 `content` 进入模型输入；不另加包装、前缀或 JSON 编码。选择何种 Provider 不应影响本地保存的 Tool 状态。

未来如需新增 Anthropic `is_error` 等 wire 映射，应另行设计和验证，不作为本次交付的决策项或前置依赖。

### 6.2 History / Web UI

实时和历史统一按四态展示：

- `success`：Succeeded。
- `error`：Failed，具体原因查看 content。
- `denied`：Denied。
- `aborted`：Aborted，具体中断或恢复说明查看 content。

跨页配对必须同时缓存 content 与 status，不能继续只缓存字符串。文本裁剪、分页、重载和 Turn 替换均不得丢失 status；presentation identity 复用只保留 UI 身份，不覆盖结果状态。

现有实时事件只有 `isError`，不足以区分四态。为满足实时与历史一致的目标，实时 Tool Result 也应携带 Runner 映射的同一 status，而不是让客户端从 content 猜测 Denied 或 Aborted。不把完整 canonical outcome 暴露给 UI。

正式 Spec 需定义实时 result 的精确字段形状、既有 `isError` 的迁移及 Web/CLI/Extension 消费端调整；不能维护两份独立判定的结果状态。卡片现有 running/completed 生命周期与新增结果 status 需明确区分，避免同名属性混用。Approval 不进入 History；临时审批操作区的处理见下一节。

### 6.3 Approval 按钮内嵌（已确认设计方向）

不再创建独立 Approval 气泡。收到真实 `approval_requested` 后，将 Allow / Deny 按钮显示在对应 Tool Call 卡片底部；卡片折叠时按钮也必须可见，审批所需完整 input 仍可查看。没有审批请求时，不根据 Tool outcome 推断或创建按钮。

```text
Tool Call 卡片
  工具名称 / 等待审批
  参数摘要（可展开完整审批参数）
  [Deny] [Allow]
```

| 阶段 | 审批操作区 | Tool Call 结果 |
|---|---|---|
| 等待审批 | 显示两个按钮 | 等待审批 |
| 用户提交 Allow / Deny | 发送后乐观隐藏按钮，禁止重复提交 | 尚不能据此宣称执行成功或收到权威结果 |
| Allow 后实际执行 | 无按钮 | 等待 Runner 的 Tool Result |
| Deny 后收到结果 | 无按钮 | 显示 Runner 返回的拒绝结果；不执行 Tool |
| Abort / Session Allow All 关闭待审批请求 | 按现有关闭消息移除按钮 | 后续状态以 Runner 结果为准 |
| WebSocket 断开 | 清除或禁用待审批按钮，沿用连接状态提示 | 不伪造执行结果、不自动重发决定 |
| History 重建 | 不恢复按钮 | 从持久化 Tool Result 恢复状态 |

“发送后隐藏”是乐观 UI，不等于服务端确认接受。当前普通用户 Allow / Deny 不触发 `approval_closed`，因此不能等待该消息才移除按钮。现有事实见 [客户端 resolveApproval](../../extensions/websocket-channel/client/chat.html)、[WebSocket Approval 路由](../../extensions/websocket-channel/WebSocketChannel.ts)及 [TurnInteractionManager](../../src/runtime/turn-interaction/TurnInteractionManager.ts) 的关闭通知条件。本期不新增 ack、请求超时或重试机制。

若发送同步失败，不应把决定视为已提交；沿用现有错误/连接提示处理。已有 `channel_error` 也不能因隐藏按钮而被吞掉。当前没有独立审批过期计时器，但 Abort、关闭或 Session Allow All 可以在连接仍正常时结束待审批请求；沿用这些已有路径，不另造“过期”生命周期。

按钮持有真实 Approval ID，以该 ID 提交和关闭；UI 合并不把 Approval ID 与 Tool Call ID 混为一谈。当前 wire 审批请求没有 `callId`，Tool 事件按同一 Turn 串行执行，客户端关联应限定在同一 Session / Turn 内对应的待完成 Tool Call，不能按工具名称或整个页面最后一张卡片匹配。需验证重复同名调用、steering 分段和跨 Session 场景；匹配不到时明确暴露异常，不将按钮挂到无关调用。

完整审批参数以 `approval_requested.input` 为准，不因合并卡片而省略或误用可能未经 hook 修改的早期 Tool input。审批临时数据不得覆盖持久化 Tool Result 状态，最终 Tool 成功也不代表应保留一张“审批成功”历史卡片。

此方向与早先 [Tool Activity 展示草稿](tool-activity-presentation-design-draft.md) 的“两类独立卡片”方案不同。这里只记录新的讨论结论，不改写已接受的展示契约；进入 Delivery 前应在正式 Spec 中明确该 UI 行为调整。

## 7. 旧数据策略（已确认：Clean-format）

不兼容旧数据，不提供缺失 status 的旧格式读取分支或迁移推断。新格式 Tool Result 必须具有合法四态 status。

- 缺失、非法类型或不在四态范围内的 status 应明确报错，不能默认 success。
- 不根据旧 content 猜测状态，也不将缺失状态自动补成 aborted。
- 正式 Spec 明确格式识别、数据校验、错误提示及旧 Session 处置流程；本决定不授权实施时自动删除用户数据。

## 8. 拟验证清单

以下是后续验收建议，尚未执行：

1. Runner 对成功、失败、拒绝、无效输入、不可用及受控 Abort 写入正确结果；同批多调用逐个关联，互不串状态。
2. 全新 SessionManager 从磁盘重载后仍能查询到相同四态 status，而非只检查进程内缓存。
3. 存储截断、上下文裁剪、History 分页与 fork 保留状态。
4. 孤儿修复保留旧 Turn、写入 aborted 并保留恢复说明，不将未知结果描述成已确认取消，且不覆盖真实结果。
5. 客户端实际执行 History 重建和终态收敛测试：失败不变成功；空结果内容不丢失状态；跨页结果与调用正确配对；UI identity 复用不篡改状态。不能仅用 HTML 字符串包含断言代替行为测试。
6. 验证 clean-format：缺失 status、非法类型和非法枚举值明确拒绝，无兼容或文本猜测路径。
7. Provider 编码回归测试检查实际请求体：相同调用 ID 和 content 在新增本地状态前后生成相同 wire 输出；Anthropic 不新增 `is_error`，OpenAI 两协议与 Relay 不发送内部字段，content 不被额外包装。
8. Approval 服务端协议和权限保持原样；真实审批请求只在对应 Tool Call 底部展示按钮，不创建独立 Approval 气泡，也不由 outcome 推断审批。
9. 按受影响边界执行 Unit、契约/Integration、类型检查和构建，记录环境或既有基线阻塞。
10. 同一 Turn 内连续产生失败 A、失败 B、成功 C，再正常结束：验证失败没有提前中断既有 continuation，后续模型调用仍收到先前错误内容，三次调用及结果按序全部写盘。
11. 对上述 Turn 做 History 收敛和磁盘重载：A、B 仍为失败、C 为成功，状态按各自 `tool_use_id` 关联；同名 Tool 的后一次成功不覆盖前一次失败，Turn 成功不清除失败记录。
12. 实际执行客户端交互测试：按钮折叠态可见，完整审批参数可查看；Allow / Deny 仅发送一次并乐观隐藏，不等待普通决定不会产生的 `approval_closed`；最终显示 Runner 结果而非把 Allow 当作成功。
13. 验证 Abort、Session Allow All、断线、发送异常及既有协议错误路径；无自动重发、无残留可操作按钮，History 不恢复按钮。重复同名调用、steering 分段及跨 Session 的审批不得错配。
14. 对四态逐一验证实时事件与 History 返回相同 status；拒绝和中断不在历史替换前后变为 Failed 或 Succeeded。Runner 内部细分类别、控制流程和 Provider wire 输出不受四态展示归类影响。

## 9. 设计决定与进入正式 Change 的条件

本轮已确认：

1. 持久化四态 `status: 'success' | 'error' | 'denied' | 'aborted'`，不采用布尔或完整 canonical outcome。
2. Clean-format，不兼容旧数据。
3. 实时与历史统一四态，具体原因保留在已有 content；内部 canonical 分类不变。

Runner 统一提供结果事实、逐次保留失败与成功过程、Provider 编码不变，以及 Approval 按钮内嵌、发送后乐观隐藏、不新增回执、不持久化已是本草稿的确认范围，不再作为候选扩展项。

已并入已完成并归档的统一 Framework [Plan](../changes/archive/async-tool-use/plan.md) / [Specification](../changes/archive/async-tool-use/specification.md)，补齐实时事件迁移、字段校验和格式识别、受影响消费端及验收要求。本文不再作为平行实施契约维护；实现与验证状态以 Current Architecture、Stable Specification 和归档 Change 为准。
