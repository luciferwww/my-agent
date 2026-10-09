# Session-addressed Approval 设计草稿

> Status: Non-authoritative design draft
> Date: 2026-10-09
> Authorization: 仅记录调研结论与候选设计，不授权实现，不覆盖 Current Architecture、Accepted Decisions、Stable Specifications、已批准的 Active Change 或源代码

## 1. 问题

当前 Approval 是 current-call、origin-bound、process-local：

```text
Tool 需要 Approval
-> Runtime 根据 Turn 保存的 Origin Channel 路由请求
-> Channel 将请求交给 Origin Client
-> Origin Client 断开时 Approval 以 unavailable/origin_disconnected 结束
```

这个模型适合由在线 Client 发起的交互 Turn，但不能直接满足 Automation：

- Automation Run 没有 Origin Channel 或 Origin Client；
- Automation 可能在没有 Client 在线时触发；
- 用户需要从 Session/Automation 列表发现等待审批的 Run；
- 用户稍后打开对应 Session 时，需要看到仍在等待的真实 Tool Call 和参数；
- 不应为 Automation 另建一套 Tool policy、Approval result 或 AgentRunner 流程。

本草稿讨论一种最小扩展：保留现有 Origin 路由，同时允许没有 Origin route 的 Automation Approval 通过 Session 被多个现有 Interaction Channel 处理。

## 2. 当前实现事实

当前稳定事实包括：

1. `ChannelInstance.interaction?` 和 `ChannelRuntimeBinding.interaction?` 已表示一个 Channel 是否提供 Interaction transport。
2. Runtime 只向 Origin Channel 提交 Approval request 和 closure。
3. `ApprovalRequest.originClientId` 已是可选字段；CLI 的 Origin Channel 可以在没有 Client ID 的情况下直接提示。
4. WebSocket Channel 当前要求 `originClientId`，并只向该 Client 投递。
5. WebSocket `approval_requested` 是实时 Interaction 消息，不是 `AgentEvent`，不写入 Session Transcript，也不随 Session history 恢复。
6. `TurnInteractionManager` 是 canonical pending Promise 和 first-settlement-wins 的 Runtime owner。
7. WebSocket Channel 维护自己的 `pendingApprovals` 投递索引，但当前只保存 Client、Session 和 Turn，不足以重放完整 request。
8. 用户主动 Allow/Deny 当前不发送 `approval_closed`；提交 UI 依靠本地决定更新。
9. Tool policy 在 Approval capability 缺失时 fail closed。Exec、Agent Home 外结构化路径以及其他需要 Approval 的调用不会执行。
10. Pending Approval 和 Session `allow_all` 都是 process-local；Runtime 重启不恢复 suspended Tool Call。

当前权威仍是 [Approval Lifecycle Specification](../specifications/approval-lifecycle.md)。本草稿只描述候选演进方向。

## 3. 设计结论

### 3.1 统一 Approval 生命周期，不统一为单一投递方式

保留同一套：

- Tool policy；
- `ApprovalRequest` / `ApprovalResult`；
- `TurnInteractionManager`；
- AgentRunner Tool pipeline；
- first-settlement-wins；
- Abort 和 Shutdown 语义。

只扩展 Runtime 的投递选择：

```text
Turn 有 Origin Channel route
-> 只发送给该 Origin Channel

Turn 没有 Origin Channel route
-> 发送给当前所有带 interaction 的 Channel
```

判断依据是 Runtime 是否保存了 Origin Channel route，不是单独检查 `originClientId`。CLI 的正常交互 Turn 可以没有 Client ID，但仍有 Origin Channel，因此继续只在 CLI 中提示。

Automation Run 没有 Origin Channel route，因此使用第二条路径。

### 3.2 不新增 ChannelInteractionCapabilities

第一版不区分：

```text
originApproval
sessionApproval
```

现有：

```ts
readonly interaction?: ChannelInteractionTransport;
```

已经是所需的能力标记：

```text
有 interaction
-> 可以接收没有固定 Origin 的 Automation Approval

没有 interaction
-> 不参与 Approval
```

因此 Automation Approval 可以同时交给 CLI、WebSocket 和未来其他 Interaction Channel。任意一个合法响应先到达 Runtime 即可结算。

如果未来出现“支持 Origin Interaction，但明确不能接收 Automation Interaction”的真实 Channel，再基于实际需求增加能力细分；第一版不提前建模。

### 3.3 不新增 Runtime pending-list API

第一版不增加：

```ts
listPending(sessionId: string): readonly ApprovalRequest[]
```

Runtime 继续拥有 canonical pending interaction；各 Channel 只保存自己已经接受的 delivery projection。

WebSocket Channel 收到 Session-addressed Approval 后保存完整 request：

```text
approvalId
sessionId
turnId
callId
toolName
input
```

当前 Session audience 为空时，WebSocket 仍返回 `accepted` 并保留 projection。Client 稍后打开该 Session 时，WebSocket 从本地 projection 重放 `approval_requested`。

这个方案只保证：

```text
Approval 创建时已经存在并接受 request 的 Channel
-> 可以向后来连接的 Client replay
```

第一版不保证 Interaction Channel 被动态卸载、重新创建后恢复旧 projection。若未来要求 Channel 热重载后重新发现 pending interaction，再引入 Runtime snapshot/query，而不是现在提前增加。

### 3.4 不建立全局 Approval Inbox

Client 连接时不加载完整的全局 Pending Approval 列表。

Session 列表只携带轻量提醒：

```ts
pendingApprovalCount: number
```

Client 已在线但未打开相关 Session 时，通过轻量事件更新：

```ts
{
  type: 'session_attention_changed',
  sessionId: string,
  pendingApprovalCount: number
}
```

完整 Tool 名称、input 和决策按钮只在用户打开对应 Session 后展示。

## 4. Runtime 路由

### 4.1 Origin Turn

普通 WebSocket、CLI 或其他 Channel 发起的 Turn 已有 `routeContextByTurn`：

```text
Tool 请求 Approval
-> Runtime 找到 Origin Channel
-> Origin Channel 有 interaction
   -> 提供 Approval capability 并向该 Channel 投递
-> Origin Channel 无 interaction
   -> 不提供 Approval capability
   -> Tool policy fail closed
```

这保持当前安全边界。系统不能因为另一个 Channel 有 Interaction 能力，就替一个不支持 Approval 的 Origin Channel 批准 Tool。

Subagent 继续继承 Parent Turn 的 Origin route。

### 4.2 Automation Turn

Automation Run 是没有 Origin Channel route 的顶层 Turn：

```text
Tool 请求 Approval
-> Runtime 查找当前所有 binding.interaction
-> 至少一个 Interaction Channel 存在
   -> 提供 Approval capability
   -> 向全部 Interaction Channel 投递
-> 没有 Interaction Channel
   -> 不提供 Approval capability
   -> Tool policy fail closed
```

Delivery 结果聚合：

```text
至少一个 Channel accepted
-> 整体 accepted，Approval 保持 pending

所有 Channel unavailable，或没有 Interaction Channel
-> unavailable / fail closed
```

具体 failure reason 和部分 Channel 失败时的日志格式留待正式 Specification。

### 4.3 Automation Subagent

Automation 可以按统一 Agent 能力调用 Subagent。Child 使用 transient Session，但用户查看的是 Automation Run Session。

因此 Automation 执行树中的 Approval 必须继续使用 Automation Run 的用户可见 Session 作为 delivery Session：

```text
Automation Run Session
-> Child transient Session
-> Child Tool requests Approval
-> request 仍关联 Automation Run Session
```

具体如何在现有 route context 中继承该 Session identity 留待正式实现设计，但不能把 Approval 广播到用户无法打开的 transient Child Session。

## 5. Channel 行为

### 5.1 CLI

CLI 已提供 `interaction`：

```text
收到 Origin Approval
-> 当前 CLI prompt

收到无 Origin route 的 Automation Approval
-> 当前 CLI prompt
```

CLI 同一时刻不能承载第二个 Approval prompt 时，可以返回 `delivery_failed`。只要另一个 Channel accepted，整体 Approval 仍可等待。

如果 WebSocket Client 先完成决定，Runtime 向 CLI 发送 closure，CLI 取消尚未完成的 prompt。

### 5.2 WebSocket Origin Approval

普通 WebSocket Turn 保持现有语义：

```text
request.originClientId 有值
-> 只发给该 Client
-> 当前 Origin Client 断开
-> unavailable/origin_disconnected
```

本草稿不顺带修改普通浏览器 Turn 的断线恢复行为。

### 5.3 WebSocket Session-addressed Approval

Automation request 到达 WebSocket 时没有 `originClientId`：

```text
保存完整 pending delivery projection
-> 向当前 sessionId audience 广播 approval_requested
-> audience 为空也返回 accepted
```

Client 断开只移除 Session audience membership，不结束 Approval。

同一 Session 的任意当前 Client 都可以提交决定。WebSocket 校验：

1. Approval ID 仍在本地 pending projection；
2. Request 没有固定 Origin Client；
3. 提交 Client 属于 request.sessionId 的当前 audience。

满足后把 response 交给 Runtime；Runtime first-settlement-wins。

### 5.4 Session 切换与 replay

用户切换 Session 时：

```text
加载 Session history
-> 注册/确认该 Client 的 Session audience
-> WebSocket replay 该 Session 当前 pending Approval requests
-> 后续 request/closure 继续实时接收
```

第一版可以复用现有 Session audience 注册时机，不强制增加独立 `attach_session` 协议。若隐式注册导致 UI 生命周期不清晰，再单独设计 attach/detach。

Client 应按 Approval ID 幂等合并实时消息与 replay，避免重复卡片。

## 6. Session 列表提醒

只在打开 Session 后重放完整 Approval 会导致用户不知道其他 Session 正在等待。因此 Session 列表需要轻量 attention projection。

### 6.1 初始列表

WebSocket 返回 Session 列表时，为每项附加：

```ts
pendingApprovalCount: number
```

该值来自 WebSocket 当前保存的 Session-addressed pending delivery projection，不写入持久化 Session metadata。

普通 Origin-directed Approval 不必计入其他 Client 可见的 Session badge。

### 6.2 实时变化

Session-addressed Approval 从零变为非零、数量增加或结算后减少时，WebSocket 向当前所有已连接 Client 发送：

```ts
{
  type: 'session_attention_changed',
  sessionId: string,
  pendingApprovalCount: number
}
```

这个事件不携带 Tool input，不授予决策能力，只让 UI：

- 在 Session/Automation Run 列表显示醒目标记；
- 可选显示应用内通知；
- 导航到对应 Session。

### 6.3 完整请求

完整 request 仍只发送给对应 Session audience：

```text
列表 badge
-> 用户打开 Session
-> replay approval_requested
-> 用户核对 Tool 和 input
-> Allow / Deny
```

## 7. Settlement 与 closure

多 Channel 和多 Client 场景下，提交方本地知道决定已不够。第一版候选设计要求所有终态都产生 closure：

```text
approved/user
denied/user
approved/session_allow_all
aborted/turn
aborted/shutdown
unavailable/*
failed/*
```

时序：

```text
任意 Channel/Client 提交决定
-> Runtime first-settlement-wins
-> 清理 canonical pending entry
-> resolve AgentRunner waiting Promise
-> 向接受过 request 的 Channel 发送 closure
-> Channel 清理本地 projection
-> WebSocket 更新 pendingApprovalCount
-> Session audience 关闭 Approval card
```

迟到响应不得改变已经结算的结果。

若第一版不记录精确 accepted Channel set，Runtime 可以向当前全部 Interaction Channel 幂等广播 closure；正式 Specification 需要在“精确 delivery set”和“幂等全广播”之间选定一种。

## 8. Run 状态

Automation Run 遇到 pending Approval 时：

```text
running
-> waiting_approval
```

Approval 结算后：

```text
waiting_approval
-> running
```

然后由 AgentRunner/模型循环决定后续结果。

用户 Deny 只表示当前 Tool Call 返回 `denied`：

```text
deny
-> 当前 Tool implementation 不启动
-> Agent 可以继续、调整方案或结束
```

不能把 Deny 直接等价为 Automation Run failed/cancelled。

Automation Run 列表可以复用 `waiting_approval` 作为提醒，但完整 request 仍属于 Run Session。

## 9. 生命周期与持久化

第一版保持 process-local：

- canonical pending interaction 不写入 Automation SQLite；
- Channel delivery projection 不写入 Session Transcript；
- `pendingApprovalCount` 不写入 Session metadata；
- 没有 Approval timeout；
- Client disconnect 不结束 Session-addressed Approval；
- Turn Abort 或 Automation Run Cancel 结束对应 Approval；
- Runtime Shutdown 以 `aborted/shutdown` 结算；
- Runtime 重启后旧 Automation Run 标记为 `interrupted`，不恢复 suspended Tool Call。

只持久化 Approval request 不能恢复 AgentRunner Promise、Model loop、Abort tree 和执行栈，因此第一版不设计跨重启 Approval recovery。

## 10. 不做的事项

第一版不做：

- 全局 Approval Inbox；
- Runtime `listPending(sessionId)` API；
- `ChannelInteractionCapabilities`；
- Approval 持久化和跨重启恢复；
- 永久允许某个 Automation Job；
- Approval timeout/expiry；
- quorum/consensus；
- 风险等级和权限预测；
- 为 Automation 新建专用 Approval manager 或协议；
- 普通 WebSocket Origin Approval 的断线恢复；
- Interaction Channel 热重载后的 pending projection 恢复。

## 11. 预计改动面

核心改动集中在：

- `core/channel`：扩展 closure result，使用户主动 Allow/Deny 也可通知其他 Channel；
- `runtime/turn-interaction`：所有 settlement 产生 closure，保持 first-settlement-wins；
- `runtime/RuntimeApp`：Origin route 与无 Origin route 的投递选择及多 Channel delivery 聚合；
- WebSocket Channel：保存完整 pending projection、Session 广播、Session 列表 count、attention event、Session 切换 replay 和 Session audience response 校验；
- CLI Channel：接收来自其他 Channel settlement 的 closure 并取消 prompt；
- Automation Runtime：创建没有 Origin route 的顶层 Turn，并将 Root Run Session identity 传给 Child Approval。

第一版不需要修改 AgentRunner Tool pipeline、Tool policy ordering、Platform Config 默认值或 Session 持久格式。

## 12. 待正式 Specification 决定

实现前仍需明确：

1. Runtime 是否记录精确 accepted Channel set；
2. 多 Channel delivery 中全部失败时的规范化 reason；
3. WebSocket Session audience 的现有隐式注册时机是否足够；
4. Session 列表字段是固定 `pendingApprovalCount`，还是更通用的 attention projection；
5. Channel 动态卸载时，已接受的 Session-addressed Approval 如何避免永久 orphan；
6. Automation Root Session identity 如何通过现有 route context 传给 Child；
7. `approval_closed` 的最终 wire shape 是否继续使用 `reason`，或改为结构化 source/reason。

## 13. 与其他设计的关系

- [Automation 系统设计草稿](automation-system-design-draft.md) 负责 Job、Run、Schedule、Automation Session 和恢复边界；本文负责共享 Approval 路由与客户端发现。
- [Tool Activity 展示设计草稿](tool-activity-presentation-design-draft.md) 负责 Tool/Approval Card 的展示，不拥有 Approval authority。
- [Approval Lifecycle Specification](../specifications/approval-lifecycle.md) 是当前实现权威；本文在被正式接受和实现前不能改变其 origin-bound 契约。
