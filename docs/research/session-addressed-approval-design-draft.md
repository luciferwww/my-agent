# Session-addressed Approval 设计草稿

> Status: Non-authoritative design draft
> Date: 2026-10-09
> Authorization: 仅记录调研结论与候选设计，不授权实现，不覆盖 Current Architecture、Accepted Decisions、Stable Specifications、已批准的 Active Change 或源代码

## 草稿与当前 Change 的边界

普通 Turn 的候选契约和模块改动已提炼到
[Accepted Plan](../changes/active/session-scoped-approval-delivery/plan.md) 与
[Accepted Specification](../changes/active/session-scoped-approval-delivery/specification.md)。
评审普通 Turn 时以这些 Change 文档为提案入口，不从本草稿另推导实现要求；
所有者已于 2026-10-10 接受这些文档并明确授权 Delivery；
当前 Stable Authority 的同步仍以实现和验证结果为准。

下文 Automation fanout、Run 状态、Child Session 和多 Channel 聚合均为未来
Automation Change 的研究输入，不属于当前 Approval Change 的“第一版”交付范围。
WebSocket 消息与浏览器展示步骤只是模块候选适配，不是共享 Approval 数据契约。

2026-10-10 范围收敛：当前 Change 只包含 Client-independent delivery（包括
无 Origin Channel 时取消 Channel 限制）、全量或按 Session 的 pending query，
以及 chat 自有的定期刷新和本地 Session 提示。共享 Session 类型不增加全局
待处理标识；此前的共享标识候选已撤出当前范围。下文关于 per-binding query、
WebSocket 专属 count/attention 协议和 Automation delivery 聚合的细节属于
历史研究候选，不能作为额外实施要求；以当前 Change 为准。

## 1. 问题

当前 Approval 是 current-call、origin-bound、process-local：

```text
Tool 需要 Approval
-> Runtime 根据 Turn 保存的 Origin Channel 路由请求
-> Channel 将请求交给 Origin Client
-> Origin Client 断开时 Approval 以 unavailable/origin_disconnected 结束
```

这个模型不仅不能直接满足 Automation，也把普通 WebSocket Turn 绑定到短暂页面连接：

- Automation Run 没有 Origin Channel 或 Origin Client；
- Automation 可能在没有 Client 在线时触发；
- 普通浏览器页面误关后，当前 pending Approval 会立即 unavailable，重新打开同一 Session 也无法继续；
- 如果把所有 Approval 无条件转移到任意 Interaction Channel，不支持 Approval 的 Origin UI 又可能在无提示的情况下长期等待后台 Client；
- 用户需要从 Session/Automation 列表发现等待审批的 Run；
- 用户稍后打开对应 Session 时，需要看到仍在等待的真实 Tool Call 和参数；
- 不应为 Automation 另建一套 Tool policy、Approval result 或 AgentRunner 流程。

本草稿选择 Channel + Session 投递范围：

```text
普通 Turn：
  Origin Channel 不支持 interaction -> fail closed
  Origin Channel 支持 interaction   -> 只在该 Channel 内按 Session 投递和恢复

Automation Turn：
  没有 Origin Channel -> 按 Session 投递到当前所有 Interaction Channel
```

普通 Turn 不离开发起它的 Channel，但不再绑定某个短暂 Client；Automation 没有 Origin，才使用跨 Channel 的 Session Approval。

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

### 3.1 Channel 决定入口，Session 决定 Channel 内的归属

保留同一套：

- Tool policy；
- `ApprovalRequest` / `ApprovalResult`；
- `TurnInteractionManager`；
- AgentRunner Tool pipeline；
- first-settlement-wins；
- Abort 和 Shutdown 语义。

Runtime 的投递选择是：

```text
Turn 有 Origin Channel route
-> Origin Channel 有 interaction
   -> 只发送给该 Origin Channel
   -> Channel 按用户可见 Session 投递
-> Origin Channel 无 interaction
   -> 不提供 Approval capability
   -> Tool policy fail closed

Turn 没有 Origin Channel route
-> 发送给当前所有带 interaction 的 Channel
-> 每个 Channel 按用户可见 Session 投递
```

判断依据是 Runtime 是否保存了 Origin Channel route，不是单独检查 `originClientId`。CLI 的正常交互 Turn 可以没有 Client ID，但仍有 Origin Channel，因此继续只在 CLI 中提示。普通 WebSocket request 以 Session 标识业务归属；其 audience 是 Channel 的传输策略，不代表当前视图或审批权限。

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
-> 可以为本 Channel 发起的普通 Turn 提供 Approval
-> 可以接收没有固定 Origin 的 Automation Approval

没有 interaction
-> 由该 Channel 发起的普通 Turn 无 Approval capability
-> 不参与 Automation Approval
```

因此 Automation Approval 可以同时交给 CLI、WebSocket 和未来其他 Interaction Channel。任意一个合法响应先到达 Runtime 即可结算。

如果未来出现“支持 Origin Interaction，但明确不能接收 Automation Interaction”的真实 Channel，再基于实际需求增加能力细分；第一版不提前建模。

### 3.3 Runtime 保持唯一 pending registry

Runtime 提供只读、按绑定 Channel 过滤的 pending snapshot：

```ts
getPending(sessionId?: string): readonly ApprovalRequest[]
```

查询复用现有 `ApprovalRequest`，不新增 Snapshot、QueryResult 或 Closure 包装类型。
返回请求和嵌套 input 不共享 canonical pending 的可变引用。

Runtime 继续拥有唯一 canonical pending interaction。WebSocket 不保存第二份完整 request registry，而是基于 Runtime snapshot 计算 Session count、响应显式 Session query，并校验 response。

没有 Client 连接时，WebSocket 仍返回 `accepted`。Client 稍后打开该 Session 时，显式查询该 Channel、该 Session 仍 pending 的完整 requests。

这个方案只保证：

```text
Runtime 仍存活并保留 canonical pending
且原 Origin Channel binding 仍有效
-> 后来连接的 Client 可以按 Session replay
```

第一版不保证 Interaction Channel 被动态卸载、重新创建后恢复原 Origin route；Runtime query 本身不改变已捕获的 Channel binding。

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

何时获取和展示完整请求由对应 Channel/Client 决定；不作为 Approval 路由约束。

## 4. Runtime 路由

### 4.1 Origin Turn

普通 WebSocket、CLI 或其他 Channel 发起的 Turn 已有 `routeContextByTurn`：

```text
Tool 请求 Approval
-> Runtime 找到 Origin Channel
-> Origin Channel 有 interaction
   -> 提供 Approval capability
   -> 只向该 Channel 投递
   -> Channel 按用户可见 Session 展示和恢复
-> Origin Channel 无 interaction
   -> 不提供 Approval capability
   -> Tool policy fail closed
```

这保持当前安全边界。系统不能因为另一个 Channel 有 Interaction 能力，就替一个不支持 Approval 的 Origin Channel 批准 Tool。

Origin Client 只记录来源，不再是 pending Approval 的生命周期 owner。WebSocket Client 断开不结束 Approval；重新连接后可以查询仍 pending 的请求。

Subagent 继续继承 Parent Turn 的 Origin Channel 和用户可见 Root Session。

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

普通 CLI Turn 的 Approval 不广播到 WebSocket。CLI 同一时刻不能承载第二个 Approval prompt 时，可以返回 `delivery_failed`。对于 Automation，只要另一个 Channel accepted，整体 Approval 仍可等待。

如果 WebSocket Client 先完成决定，Runtime 向 CLI 发送 closure，CLI 取消尚未完成的 prompt。

### 5.2 WebSocket Channel + Session Approval

普通 WebSocket Turn 仍只投递到 Origin WebSocket Channel，但在该 Channel 内改为 Session-addressed：

```text
Runtime 保存 canonical pending request
-> WebSocket 向所有 Client 广播轻量 Session attention
-> 保留现有 realtime approval_requested，按现有 Session audience 投递
-> 没有 Client 也返回 accepted
-> Client 断开不结算 Approval
-> 后来打开同一 Session 的 Client 可以 query 并处理
```

`originClientId` 可以继续作为 provenance、日志和 UI 信息，但不再限制谁可以处理该 WebSocket Session 中的 Approval。

### 5.3 WebSocket Automation Approval

Automation request 没有 Origin Channel。Runtime 将它发送给 WebSocket 后，WebSocket 使用与普通 WebSocket Turn 相同的 Session-addressed presentation：

```text
Runtime 保存 canonical pending request
-> WebSocket 向所有 Client 广播轻量 Session attention
-> 没有 Client 也返回 accepted
```

普通 WebSocket Turn 允许初始化完成的 Client 对该 binding 内仍 pending 的请求提交决定，不要求它先登记当前视图或查询记录。Automation 的 binding 可见范围须由未来 fanout 设计确定。WebSocket 校验：

1. Approval ID 仍在该 Channel 可见的 Runtime canonical pending snapshot；
2. request 仍属于该 WebSocket Channel binding。

满足后把 response 交给 Runtime；Runtime first-settlement-wins。

### 5.4 Session 切换与 replay

用户切换 Session 时：

```text
加载 Session history
-> 显式查询该 Session 当前 pending Approval requests
-> 后续 attention 是否触发查询由 Channel/Client 自己的展示策略决定
```

Approval delivery 不定义 Channel/Client 的 Session 展示拓扑或导航策略。

Client 应按 Approval ID 幂等合并查询结果，并消费权威 closure。

## 6. Session 列表提醒

只在打开 Session 后重放完整 Approval 会导致用户不知道其他 Session 正在等待。因此 Session 列表需要轻量 attention projection。

### 6.1 初始列表

WebSocket 返回 Session 列表时，为每项附加：

```ts
pendingApprovalCount: number
```

该值来自 Runtime 向该 Channel 暴露的 canonical pending snapshot，不写入持久化 Session metadata。普通 WebSocket Turn 和 Automation 的 pending Approval 都计入对应 Session。

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

显式 Session query 补充现有 realtime request，支持稍后发现和重连：

```text
列表 badge
-> 用户打开 Session
-> get_session_approvals(sessionId)
-> 用户核对 Tool 和 input
-> Allow / Deny
```

## 7. Settlement 与 closure

同一 Channel 的多 Client 以及 Automation 的多 Channel 场景下，提交方本地知道决定已不够。第一版候选设计要求所有终态都产生 closure：

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
任意合格 Channel/Client 提交决定
-> Runtime first-settlement-wins
-> 清理 canonical pending entry
-> resolve AgentRunner waiting Promise
-> 向接受过 request 的 Channel 发送 closure
-> WebSocket 更新 pendingApprovalCount
-> Channel/Client 更新已有 Approval presentation
```

迟到响应不得改变已经结算的结果。

普通 Turn 的 closure 只返回 Origin Channel。Automation 若不记录精确 accepted Channel set，Runtime 可以向当前全部 Interaction Channel 幂等广播 closure；正式 Specification 需要在“精确 delivery set”和“幂等全广播”之间选定一种。

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
- Runtime pending snapshot 不写入 Session Transcript；
- `pendingApprovalCount` 不写入 Session metadata；
- 没有 Approval timeout；
- WebSocket Client disconnect 不结束该 Channel 内的 Session-addressed Approval；
- 不支持 Interaction 的 Origin Channel 不创建 Approval；
- Turn Abort 或 Automation Run Cancel 结束对应 Approval；
- Runtime Shutdown 以 `aborted/shutdown` 结算；
- 普通 Turn 的 Origin Channel 永久停止时，以 `unavailable/origin_channel_stopped` 结算，避免永久等待；
- Runtime 重启后旧 Automation Run 标记为 `interrupted`，不恢复 suspended Tool Call。

只持久化 Approval request 不能恢复 AgentRunner Promise、Model loop、Abort tree 和执行栈，因此第一版不设计跨重启 Approval recovery。

## 10. 不做的事项

当前 Approval Change 不做以下扩展；Automation 相关授权也不由本草稿产生：

- 全局 Approval Inbox；
- `ChannelInteractionCapabilities`；
- Approval 持久化和跨重启恢复；
- 永久允许某个 Automation Job；
- Approval timeout/expiry；
- quorum/consensus；
- 风险等级和权限预测；
- 为 Automation 新建专用 Approval manager 或协议；
- 普通 Turn 跨 Origin Channel 转移 Approval；

## 11. 预计改动面

共享 Approval 数据和查询契约归 `core/approval`；`core/channel` 负责集成接口。
WebSocket wire message、CLI prompt 和浏览器适配是各模块的实施改动，
不构成共享 Approval 协议。当前 Change 的具体划分见
[Specification](../changes/active/session-scoped-approval-delivery/specification.md)。

当前 Approval Change 的改动面以链接的 Plan/Specification 为准。下列包含
Automation 的项目仅描述未来研究范围：

- `core/approval` 与 `core/channel`：统一 Approval domain request/result，定义 per-binding 只读 pending snapshot capability，并扩展 closure result，使用户主动 Allow/Deny 也可通知 Channel；
- Runtime：提供按 Channel binding 隔离的 canonical pending query，校验 response 来源，所有 settlement 产生 closure，保持 first-settlement-wins；
- `runtime/RuntimeApp`：普通 Turn 的 Origin Channel gate、Automation 的多 Channel delivery 聚合，以及用户可见 Root Session 继承；
- WebSocket Channel：基于 Runtime pending query 完成 Session 列表 count、attention event、显式 Session query 和 response 校验，不复制完整 pending registry；
- CLI Channel：保持普通 Turn 本地 prompt，以 active Approval ID 限制 closure，并在 Automation 被其他 Channel 结算时取消匹配 prompt；
- Automation Runtime：创建没有 Origin route 的顶层 Turn，并将 Root Run Session identity 传给 Child Approval。

第一版不需要修改 AgentRunner Tool pipeline、Tool policy ordering、Platform Config 默认值或 Session 持久格式。

## 12. 待正式 Specification 决定

实现前仍需明确：

1. Automation delivery 是否记录精确 accepted Channel set；
2. Automation 多 Channel delivery 中全部失败时的规范化 reason；
3. Automation Root Session identity 如何通过现有 route context 传给 Child。

## 13. 与其他设计的关系

- [Automation 系统设计草稿](automation-system-design-draft.md) 负责 Job、Run、Schedule、Automation Session 和恢复边界；本文负责共享 Approval 路由与客户端发现。
- [Tool Activity 展示设计草稿](tool-activity-presentation-design-draft.md) 负责 Tool/Approval Card 的展示，不拥有 Approval authority。
- [Approval Lifecycle Specification](../specifications/approval-lifecycle.md) 是当前实现权威；本文在被正式接受和实现前不能改变其 origin-bound 契约。
