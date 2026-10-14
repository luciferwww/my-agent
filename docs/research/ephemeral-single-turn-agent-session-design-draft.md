# 临时单 Turn Agent Session 观察与保留设计调研

> Status: Non-authoritative research draft
> Authorization: 不授权实现，不覆盖 Current Architecture、Accepted Decisions、Stable Specifications 或源代码
> Scope: 研究 Subagent Session 与 Automation Run Session 共用的 Session-addressed 只读观察、短期详情保留和最终清理；不统一两者的编排、控制、长期摘要或恢复语义

## 1. 结论

Subagent 与候选 Automation Run 有三个足以形成共享 Session 能力的共同点：

1. 当前都执行一个 Agent Turn；Turn 内可以包含多次 Model 调用和 Tool round。
2. Session 内容都可以只读观察；cancel、steer、approval 等控制不属于观察接口。
3. 详细 Session/Transcript 都不需要成为长期普通 Chat History；终态后短期只读保留，固定 TTL 到达后删除。

建议统一建模为：

> **Ephemeral Single-Turn Agent Session**

共享能力包括：

- 以 `sessionId` 寻址；
- History/snapshot 与 Session live events；
- `subscribe_session(sessionId)` / `unsubscribe_session(sessionId)`；
- 同一条 WebSocket 上的多 Session audience；
- 安全的 Turn presentation projection；
- 共用只读 Turn viewer；
- `preparing -> active -> terminal_retained -> physically deleted` 生命周期；
- 第一版在当前 Runtime lifetime 内最长保留 24 小时，并复用现有 startup sweep。

不引入额外的 observation `executionId`、`resourceId`、`subscriberId` 或 `subscriptionId`。Session 是天然的订阅与 History 边界：

```text
sessionId -> Session stream
turnId    -> Session stream 内的某个 Turn
callId    -> Turn 内的某个 Tool Call
```

当前普通 Agent Session 已经可以包含多个 Turn，其最小订阅边界仍是整个 Session。客户端由 History 和增量事件中的 `turnId` 重建具体 Turn，不需要 execution-level subscription。

## 2. 事实与候选边界

### 2.1 当前 Subagent

[Subagent Specification](../specifications/subagent.md)规定一次 `task` 调用执行一个 same-process、blocking Child。每个 Child：

- 获得一个 transient `childSessionId` 和 `childTurnId`；
- 通过一次 `AgentRunner.run()` 执行一个 Turn；
- 可在该 Turn 内进行多次 Model 调用和 Tool round；
- 终态后返回 bounded Parent Tool Result；
- 当前在 terminal cleanup 中删除 transient Transcript。

Sibling `task` calls 可以并发，但每个 Child 都拥有独立 Session 和 Turn。

### 2.2 候选 Automation Run

[Automation 系统设计草稿](automation-system-design-draft.md)提出：

```text
Automation Job
-> Automation Run
-> 新 Session
-> 一个无 Parent 的 Root Agent Turn
```

候选第一版中：

- Run 非终态时 Session 可见；
- Run 使用一个 Turn；
- Automation Store 持久化 Run terminal summary；
- 详细 Session/Transcript 只短期保留。

Automation 尚未成为当前实现或稳定契约。本草稿只为其提供可复用的 Session observation/retention 候选。

### 2.3 共享与专有

| 能力 | 共享 | 保持专有 |
|---|---:|---:|
| Session-addressed History/live observation | 是 |  |
| Single-Turn presentation | 是 |  |
| subscribe/unsubscribe | 是 |  |
| terminal retention 与 GC | 是 |  |
| 浏览器 Turn viewer 与页面内缓存 | 是 |  |
| Parent/Child、depth、Parent Tool Result |  | Subagent |
| Job、Schedule、occurrence、Run Store |  | Automation |
| Approval/Cancel/Steering control |  | 各 owner |
| Owner-level restart reconciliation |  | Automation |
| 长期 terminal summary |  | 各 owner |

## 3. 为什么以 Session 为订阅边界

### 3.1 已有身份已经足够

当前 Agent events 已携带：

- `sessionId`：路由和 History 容器；
- `turnId`：Session 内 Turn；
- `callId`/Tool execution identity：Turn 内 Tool lifecycle。

因此：

```text
subscribe Session
-> load Session History
-> receive Session live events
-> group by turnId
-> correlate Tool lifecycle by callId
```

无需增加另一层 execution address。

### 3.2 当前多 Turn Session 仍按 Session 订阅

当前普通 Agent Session 已经是一个 Session 包含多个 Turn：

```text
Session A
├─ Turn 1
├─ Turn 2
└─ Turn 3
```

客户端仍只需要：

```text
subscribe_session(A)
```

历史记录和增量事件可以重建每个 Turn。只有当一个执行脱离 Session、跨多个 Session，或 Session 被替换后执行仍独立存在时，才有证据考虑新的观察地址；当前和已讨论候选均无此需求。

### 3.3 三种 Session 的发现入口

```text
普通 Chat Session
-> Session list
-> sessionId

Subagent Session
-> Parent task Tool Result 的稳定 `sessionId` header
-> childSessionId

Automation Session
-> Scheduled/Run list
-> sessionId
```

发现入口不同，订阅方式相同。

## 4. Session 类型与能力

```ts
type EphemeralSessionSource =
  | {
      kind: 'subagent';
      callerSessionId: string;
      parentTurnId: string;
      parentToolUseId: string;
      depth: number;
      agentId: string;
    }
  | {
      kind: 'automation';
      jobId: string;
      runId: string;
      occurrenceAt: number;
      agentId: string;
    };
```

第一版不引入通用 Session lifecycle registry 或完整 snapshot schema。Subagent 只增加最小的内存 `preparingTranscriptIds`，用于表达 `subagent_start` 已发布、transient Transcript 尚未创建的短暂窗口；现有 Transcript 和 Parent Tool lifecycle 继续拥有 running/terminal 事实。

能力矩阵：

| Session 类型 | Turn | 发送新消息 | 普通 presentation subscription | Terminal detail |
|---|---:|---:|---:|---:|
| 普通 Chat | 多个 | 是 | 当前 focus 时订阅 | 长期 History |
| Subagent | 当前一个 | 否 | 详情窗口打开时订阅 | TTL retained |
| Automation | 当前一个 | 观察只读；控制分离 | Run 详情打开时订阅 | TTL retained |

Subagent/Automation Session 不获得普通 Chat Session 的 rename、fork、resume、archive 或继续对话能力。

## 5. WebSocket 事件作用域

WebSocket outbound message 分为两类。

### 5.1 Session-scoped

只有 Client 订阅对应 `sessionId` 后才投递：

- user message 与 Turn lifecycle；
- Assistant `text_delta` / `thinking_delta`；
- Tool lifecycle；
- Session permission change；
- 其他只对正在查看该 Session 有意义的 presentation events。

Session-scoped event 通过现有 Session audience 路由。它们通常频率高、数据量大；switch-out 后停止投递可以显著减少非关注 Session 的 Assistant delta 与 Tool event 流量。

### 5.2 Connection-scoped

不经过 Session audience 过滤：

- Session list、Model catalog、Session CRUD 等请求响应；
- 全局或 Session-filtered pending Approval 查询响应；
- 实时 `approval_requested`，用于更新全局 pending collection 和 Session list indicator；
- 当前发送给全部 bound Clients 的 `approval_closed`；
- Channel error；
- 未来与具体 Session 无关的 notification。

Connection-scoped 不等于向任意外部连接无条件广播。请求响应仍只返回请求连接；Interaction 仍按 Origin Channel、Channel acceptance 和 settlement 规则投递。分类只表示这些消息不以 `subscribe_session(sessionId)` 作为接收前提。当前实现尚未符合该目标：`approval_requested` 仍按 Session audience 路由。

### 5.3 同一连接上的订阅集合

普通主 Session 与 Subagent Child Session 复用同一条 WebSocket 和同一套 Session audience：

```text
one WebSocket connection
├─ focusedMainSessionId?       # 普通 Session，默认最多一个
└─ observedChildSessionIds[]   # 打开的 Subagent detail，可临时附加
```

服务端保持 `Client -> Set<sessionId>`，不把“主 Session”或“Child Session”编码进通用订阅协议。普通 Session 的互斥 focus 和 Subagent detail 的打开/关闭是 Vue Client policy。

## 6. 普通 Session subscription

### 6.1 当前实现

WebSocket Channel 当前内部维护：

```ts
sessions: Map<sessionId, Set<clientId>>
clientSessions: Map<clientId, Set<sessionId>>
```

`registerSessionAudience(clientId, sessionId)` 的行为就是让该 Client 持续接收该 Session 的实时事件。历史实现由 `run_turn`、Session create 和 permission query 等操作隐式触发；切换 UI focus 不会移除旧 membership，只在 WebSocket disconnect 时批量清理。

这使一个长连接逐渐接收所有曾访问 Session 的 token delta、Tool lifecycle 和其他事件，即使用户已经不关心它们。

### 6.2 建议行为

对于当前单 focus Web 客户端：

```text
focus Session A
-> subscribe_session(A)

switch A -> B
-> unsubscribe_session(A)
<- session_unsubscribed(A)
-> subscribe_session(B)
<- session_subscribed(B)
-> load B History
-> receive B live events
```

一个 Client 默认只订阅当前 focus 的普通 Session。切换回来时重新加载 History，再接收新的增量事件；无需为了保存所有 token delta 而永久订阅后台 Session。

未来若出现多窗格或 pin/watch 的真实需求，再允许同一 Client 显式订阅多个普通 Session，不保留当前“访问过即永久加入”的隐式策略。

### 6.3 最小协议

```text
subscribe_session { requestId, sessionId }
-> session_subscribed { requestId, sessionId }

unsubscribe_session { requestId, sessionId }
-> session_unsubscribed { requestId, sessionId }
```

WebSocket connection 已绑定 `clientId`，请求不需要发送额外 subscriber identity。

服务端候选方法直接使用领域名称：

```ts
registerSessionAudience(clientId: string, sessionId: string): void;
unregisterSessionAudience(clientId: string, sessionId: string): void;
```

不提前抽象泛型 `resourceId/subscriberId` registry。若未来多处实现产生真实重复，再提取内部 helper。

### 6.4 语义

`unsubscribe_session`：

- 只停止该 Client 对指定 Session 的 presentation events；
- 不取消 active Turn；
- 不删除 Session、History 或队列；
- 不影响其他 Client；
- 不影响 Approval/Interaction；
- 不从 Parent Session 隐式级联到 Child Session；
- 重复调用幂等成功；
- disconnect 时仍批量移除该 Client 的全部 membership。

`create_session` 应在返回 `session_created` 前为创建连接建立
membership；`run_turn(sessionId)` 只接受已订阅的调用 Client，不改变
membership。History、permission、Session metadata 和 pending Interaction
查询不应产生订阅副作用。

Vue Client 从普通 Session A 切换到 B 时，如果当前打开 A 的 Child C：

```text
关闭 C 的 detail
-> unsubscribe_session(C)
-> unsubscribe_session(A)
-> subscribe_session(B)
<- session_subscribed(B)
-> load B History
```

服务端不根据 Parent/Child provenance 推导额外 unsubscribe。取消 Child subscription 也不终止正在运行的 Subagent。

## 7. History 与重新进入

重新进入 Session 时：

```text
subscribe_session(Session)
<- session_subscribed(Session)
-> load History
-> load pending Interactions
-> receive subsequent live events
```

History 是切回后的内容恢复来源；实时事件只改善当前观看体验。切出期间遗漏的 token/thinking delta 不需要逐条补回，已完成的 message、Tool Use/Result 和 terminal facts由 History重建。第一版不增加 runtime snapshot；Child和普通 Chat Session使用相同的 History presentation边界。

Child History不独立恢复Subagent lifecycle。Subagent detail组合Parent `task` Tool lifecycle与Child History/live presentation：Parent task的running/success/failed/aborted状态提供owner状态，Child History提供已持久化内容。空Child History无需进一步区分preparing与active但尚无消息；两者在Parent task仍running时均呈现为Starting/Running。

`session_subscribed` 是 live delivery 已生效的确认边界。确认后发起 History 请求；History 返回前到达的 live events 继续写入现有 per-Session realtime state。History 响应不能覆盖这些 live events。

第一版复用 Vue Client 现有 `mergeRealtimeWithHistory`，利用稳定 `turnId`、message ID 和 `callId` 合并 History 与 realtime presentation。只有出现可复现的数据完整性缺口时，才另行研究 snapshot/cursor，不把它作为第一版 subscribe/unsubscribe 的前置条件。

## 8. Interaction/Interruption

Approval 和未来其他 Interaction 是特殊的 interruption：

- 会阻塞 Agent execution；
- 需要优先处理；
- 不进入 Session Transcript History；
- 不能因 Session switch-out/unsubscribe 而延迟 Session list indicator 更新；
- 必须能在 reconnect 后重新发现。

当前 Vue Client 在 `hello_ack` 后立即查询 Session list 和全部 locally acceptable pending Approvals，随后每 10 秒重复查询；两类请求各有 8 秒超时和单 in-flight 去重。Client 在本地按 `sessionId` 过滤 pending collection。除此之外，实时投递目前是：

```text
approval_requested
-> 当前按对应 Session audience 路由

approval_closed
-> 当前发送给全部 bound WebSocket Clients

pending recovery
-> hello_ack 后立即全局查询
-> 连接期间每 10 秒全局查询
-> Runtime canonical pending registry
```

因此，`unsubscribe_session` 不改变 Runtime pending state、WebSocket Channel eligibility 或处理资格，且定时查询可以最终恢复遗漏的 request；但当前会停止该 Session 的实时 `approval_requested`，对应 Session list indicator 最坏需要等待下一轮查询才更新。`approval_closed` 不受 Session subscription 影响。

候选设计已经确定：

```text
approval_requested
-> connection-scoped realtime pending-state update
-> 不依赖 focused Session subscription
-> 写入 Client 全局 pending Approval collection
-> 对应 Session list item 显示醒目标记

approval_closed
-> connection-scoped realtime pending-state cleanup
-> 移除对应 Session list item 标记

pending query
-> connection-scoped startup/reconnect/periodic reconciliation
```

这样，Session subscription 只控制普通 presentation event 流量；Approval request/closure 作为高优先级 interruption，只要 WebSocket 已连接且符合现有 Interaction delivery eligibility，就可以即时同步全局 pending 状态。当前 Vue Client 用 Session list indicator 呈现该状态。

当前用户发现 Session list item 的醒目标记后，主动切换到对应 Session；Conversation 再从 Client 全局 pending Approval collection 中按当前 `sessionId` filter in，并显示可处理的 Approval Tool card。其他提醒 presentation 不在本草稿范围内。定时 pending query 保留，但定位是恢复和对账，不是正常实时状态更新路径。

该候选会改变当前 ADR-019、Approval Lifecycle 和 Channel Specification 中 `approval_requested` 的 WebSocket audience 事实。本 Research 只记录项目所有者选择，不直接覆盖这些权威；后续仍须通过正式 Change 修订并接受相应契约后才能实现。

该改造不并入 Session subscription/Subagent History 的首期交付，也不扩大既有 Approval Change 的 closeout 范围；它由独立的小型 Approval Change 承载。在该 Change 完成前，非 focus Session 的 pending Approval 仍由连接后查询和每 10 秒周期查询最终恢复。

Observation 是只读能力。Automation 或未来 Subagent 的 Approval/Cancel UI 必须组合独立 control/interaction capability，不能放进 observation port。

## 9. Subagent Session subscription

### 9.1 同一 WebSocket 上的附加订阅

现有 WebSocket Channel 保持 full WebSocket；本草稿不要求拆分 REST。

Subagent detail 不创建独立 Observation WebSocket。它复用 Vue Client 已连接的主 WebSocket，并在 focused main Session subscription 之外临时附加 Child Session subscription：

```text
已订阅普通 Session A
-> 收到 subagent_start { sessionId: Child C, callerSessionId: A, ... }

打开 Subagent task detail
-> subscribe_session(C)
<- session_subscribed(C)
-> load C History
-> 接收 C live events

关闭详情
-> unsubscribe_session(C)
<- session_unsubscribed(C)
-> 停止 Child presentation，不取消 Child Turn
```

关闭 Child detail 不影响普通 Session A 的订阅。当前 Vue Client 同一时刻最多打开一个 Child detail；该限制是 Client UX policy，不编码进通用订阅协议。

WebSocket disconnect 继续幂等清理该 Client 的全部主/Child Session audience。重新连接并收到 `hello_ack` 后，Vue Client 重新订阅当前 focused main Session；仍打开的 Child detail 也重新订阅其 Child Session，等待 subscribed ack 后重新加载 History。若 Child 已被 TTL 删除，详情容器保留并显示不可用，直到用户关闭。订阅和 viewer presence 不刷新 Agent execution activity，也不延长 terminal retention。

### 9.2 现有 Subagent 的最小接入缺口

现有 Subagent 已经生成独立 `childSessionId`、`childTurnId` 和 transient Transcript，且 `subagent_start` 可以向 Parent audience 暴露 Child `sessionId`。第一阶段仍需补齐：

- 保持当前 `subagent_start` 先于 transient Transcript 创建的顺序，并以最小内存 `preparingTranscriptIds` 表达该短暂窗口；
- 建立明确的 happens-before：生成Child identity后先加入preparing集合，再发布`subagent_start`；Transcript创建成功后由transient Transcript接管存在性并移除marker；
- preparing Child 可以被订阅，统一 History API 对其返回成功的空 History page；
- `subagent_start`发布失败、route注册失败、Transcript创建失败、abort和shutdown等所有退出路径都必须清除preparing marker；现有Parent Tool execution lifecycle继续负责terminal completion；
- Session History capability 必须允许 active/terminal-retained transient Child History 读取，但 Child 不进入普通 Session list；
- `task` Tool terminal Result 需要以稳定 Host格式返回 `childSessionId`，Vue Client从对应Tool Result恢复关联并提供只读detail；
- 当前 terminal cleanup 立即删除 Child Transcript；在 retention 实现前，完成后的详情只能依赖已打开 viewer 的页面缓存。

第一版不增加 Child 专用权限推导、完整生命周期 registry、持久化 preparing metadata、tombstone、新错误码或 Child 专用 History 接口。

### 9.3 Active 与 retained 使用同一 Session API

```text
subscribe_session(preparing childSessionId)
-> empty History + subsequent live events

subscribe_session(active childSessionId)
-> existing Session History + live events

subscribe_session(terminal_retained childSessionId)
-> existing Session History
-> no further live events

subscribe_session(expired childSessionId)
-> session_subscription_error { code: SESSION_NOT_FOUND }
```

`subscribe_session` 不返回 Session metadata，也不做Parent/Child派生权限推导，但必须在写入audience maps前完成最小existence admission。普通Pending/持久化Session、preparing Child、active Child和terminal-retained Child可以订阅；未知或已删除Session返回`SESSION_NOT_FOUND`，不得为随机ID创建membership。`session_subscribed`确认该Session在请求处理时存在且live delivery已生效。调用方随后通过统一History API取得当前内容；普通Pending Session在materialize前返回空History。Terminal retention尚未实现时，只支持preparing/active Child和当前页面已经缓存的terminal presentation。

### 9.4 Presentation policy

Session History/live event 的用户投影必须决定：

- thinking 是否可见；默认不暴露内部 chain-of-thought；
- Tool input/result 是否清洗或截断；
- error 是否只显示稳定分类；
- artifact 是否只返回 reference；
- 未来若增加统一授权，应在 Channel/API 边界对所有 Session 类型一致应用，而不是从 Parent subscription 隐式推导 Child权限。

原始 `AgentEvent` 和 canonical Transcript 不直接成为公开 wire contract。

## 10. Terminal retention

### 10.1 生命周期

```text
preparing
-> active
-> terminal_retained
-> physically deleted
```

普通 `archived` 通常表示用户主动、长期保留、可恢复的 Chat Session，不适合这里的自动 TTL。`deleted` 表示已经不可访问，也不适合描述仍保留 detail 的阶段。

物理删除后统一按不存在处理，History 返回 `SESSION_NOT_FOUND`。第一版不增加公开 `expired` 状态、`SESSION_EXPIRED` 错误或 tombstone；Client 可以根据 Parent task 已知该 Child 曾经存在的上下文，将 `SESSION_NOT_FOUND` 呈现为详情已不可用。

### 10.2 收益

短期 retention 支持：

- Subagent 完成后点击 task 气泡；
- Automation Run 完成后查看刚才的详情；
- 同一 Runtime lifetime 内，页面刷新后在最长保留期内重新打开；
- live observation 断线后读取最终 History；
- 避免把完成后回看完全依赖浏览器内存。

### 10.3 Policy

第一版使用 Runtime 内部固定策略，不提供 per-Role、per-Job 或 per-Subagent 配置：

```text
subagent_end
-> terminal retention starts
-> retain for at most 24 hours in the current Runtime lifetime
-> physically delete transient Transcript
```

Viewer connection 不延长 retention，避免半开连接无限保留敏感数据。TTL 到期后客户端已加载的页面内缓存可以继续展示，但服务端不再提供详情。

第一版不增加容量上限、LRU、per-Session TTL、持久化 retention index 或跨 Runtime restart 恢复。实际可用期为`subagent_end + 24小时`和Runtime shutdown/restart中的较早者。现有startup sweep删除不在持久化Session store中的遗留JSONL。

因此，24小时是最长保留时间，不是跨Runtime restart保证。第一版明确接受该窗口内retained Child没有容量上限的本地运营风险；出现实际问题后再由独立Change处理。

### 10.4 Cleanup 顺序

```text
AgentRunner terminal
-> 固化最终 Session History/Turn presentation
-> owner 选择并保存自己的 terminal fact
-> 交付 terminal event
-> Subagent Orchestration通知SessionManager从subagent_end开始retention
-> SessionManager在当前Runtime lifetime内安排最长24小时保留
-> TTL 到期
-> 删除 transient Transcript 和内存状态
```

Owner terminal fact：

- Subagent：Parent-facing bounded Tool Result 和 Parent Tool lifecycle；
- Automation：持久 Run/Job 最近状态、时间和必要错误。

SessionManager作为现有transient Transcript owner负责TTL删除；Subagent Orchestration只在`subagent_end`后启动retention。具体调度结构留给正式Change按现有模式选择。

Cleanup failure显式记录，不改变terminal outcome，也不把Session改回active；第一版不额外设计重试系统。

Runtime startup 使用现有 orphan sweep 删除全部非持久化 Child JSONL，不尝试恢复或推断上一次 Runtime 中遗留 Child 的 outcome。

## 11. Discovery 与权限

### 11.1 Subagent

```text
Parent task Tool Call
-> persisted task Tool Result
-> stable sessionId header
-> subscribe_session(childSessionId)
```

`task` 与现有 `exec`/`process` 句柄模式保持一致：`exec` 在 Tool Result `content` 中返回 `runId`，后续 `process` Tool 再通过结构化 input 接收并验证该句柄；`task` 同样在 Host生成的 terminal Result头部返回 `childSessionId`。第一版不为此扩展通用 `ToolExecutionOutput`、Tool terminal record或History metadata schema。

候选稳定格式：

```text
Subagent completed.
sessionId: <childSessionId>
Result:
<subagent final text>
```

该格式是 `task` Tool Result contract的一部分：

- Parent LLM可以读取`sessionId`，并在未来存在显式Session-addressed Tool时将其作为参数；
- Parent History持久化同一Result，Vue Client只对`task` Tool Result的固定Host header提取`sessionId`；
- UI不扫描任意正文或Subagent final text；header缺失、格式非法或旧History不含该字段时，不显示`View detail`；
- Result中的ID只是句柄，不证明Session仍存在，也不赋予能力；subscribe/History仍由Session owner验证当前状态；
- 第一版只保证completed task在Parent History仍可见时可恢复详情入口；running Child只对已收到`subagent_start`并保留其ID的Client可发现，错过该事件后需等待terminal Parent Tool Result成为持久发现入口。

选择content句柄而非新增metadata schema，是为了复用当前项目已经用于`exec -> process`的模式，并避免仅为一个内置Tool扩展通用Tool output、Transcript和History wire结构。代价是上述header格式成为稳定兼容性契约；未来若多个Tool都出现结构化presentation需求，再以实际重复为依据引入通用metadata。

Subagent Session 不进入普通 Session list。Parent task Tool Call 是当前 Vue Client 的发现入口，但 provenance 不作为新的隐式权限模型。

### 11.2 Automation

```text
Scheduled/Automation list
-> jobId/runId/sessionId
-> subscribe_session(sessionId)
```

Automation Session 可在 Scheduled 视图展示，但不因此获得普通 Session CRUD。

### 11.3 API 边界

第一版沿用当前WebSocket Channel默认loopback、本地单信任域的部署前提，不增加Child/Automation特有的Parent派生权限判定。给定已存在的`sessionId`，subscribe和History使用统一Session API；Parent/Child provenance用于发现、展示和lifecycle关联。

只读Child不因此获得普通Chat Session的message、rename、archive、fork、resume或其他lifecycle operation。远程多主体authorization不属于本设计范围；第一版不增加当前架构中不存在的per-Session ACL。

## 12. Runtime 所有权

```text
Session/Transcript owner
  -> canonical History
  -> retained Child TTL deletion

WebSocket Channel
  -> subscribe_session/unsubscribe_session
  -> Session audience routing

Subagent Orchestration
  -> Parent/Child execution and Parent Tool Result

Automation Runtime/Store
  -> Job/Run/Schedule and durable terminal summary

TurnInteractionManager
  -> canonical pending Interaction
```

共享观察层不拥有：

- AgentRunner；
- Subagent Parent tree；
- Automation Job/Run Store；
- Approval manager；
- cancel/steer control；
- 长期 terminal summary。

第一阶段不增加独立 Observation adapter、Observation port 或 Child 专用 History 方法。WebSocket Channel 继续调用已有 Runtime Session History capability；该统一入口需要接受普通持久化 Session、preparing Child、active Child 和 terminal-retained Child：

```text
persisted Session
-> existing History

preparing Child
-> empty History page

active / terminal-retained Child
-> existing Transcript History

unknown / TTL-deleted Child
-> SESSION_NOT_FOUND
```

Child 仍不进入普通 Session list；第一版也不要求扩展 `get_session` descriptor。

## 13. Vue Client 边界

```text
SessionTurnViewer
  -> 纯只读 Session History + Turn live presentation

SubagentSessionDetail
  -> task Tool Call / childSessionId
  -> Parent task lifecycle owner state
  -> SessionTurnViewer

AutomationRunDetail
  -> jobId/runId/sessionId
  -> SessionTurnViewer
  -> separate Approval/Cancel controls when authorized
```

当前 Vue/Vite Client 的建议落点：

| Owner | 候选职责 |
|---|---|
| `App.vue` | 协调 focused main Session 与 opened Child Session subscription set；重连后恢复当前集合 |
| `client/protocol.ts` | `subscribe_session` / `unsubscribe_session` 与确认消息的 wire projection |
| `client/socket.ts` | 只拥有 WebSocket 连接、重连和 JSON send，不拥有 Session focus policy |
| `client/session-state.ts` | 每个主/Child Session 的 History、realtime presentation 和订阅状态 |
| `client/history.ts` | 复用现有 History/realtime identity 合并 |
| Conversation/Tool components | 从 Parent task Tool Call 打开只读 Child detail，不直接发送协议消息 |

同一时刻最多打开一个 Child detail。宽屏使用右侧详情面板，窄屏使用 Modal；根据可用内容宽度自动切换。布局变化只改变 presentation，不关闭详情、不重新订阅。生产 UI 不需要保留 Demo 中用于比较方案的手动布局切换。

terminal 后客户端可以保持窗口。同一Runtime lifetime内、未超过最长保留期时，重新打开会读取与普通Chat Session相同结构的retained History；不为Child额外持久化所有realtime `AgentEvent`。删除后只能显示当前页面已经拥有的内容或详情不可用状态。

## 14. 风险与决策

| 问题 | 候选方向 |
|---|---|
| 旧 Session audience 无限累积 | switch-out 时 `unsubscribe_session` |
| permission query 意外订阅 | query 不改变 audience；只有显式 subscribe 或创建连接的 `create_session` 建立 membership |
| 切回期间遗漏 delta | History恢复已持久化内容，随后继续接收live events；第一版不增加snapshot |
| History/live 竞态 | 等 subscribed ack 后加载 History，并复用现有稳定 ID 合并；有证据不足时再考虑 cursor |
| 空Child History无法表达lifecycle | Subagent detail组合Parent task owner状态；History只恢复Child内容 |
| 随机Session ID放大audience maps | subscribe写入membership前验证persisted/preparing/active/retained存在性 |
| Interaction 随 unsubscribe 丢失 | 独立 pending registry、优先通知和 query recovery |
| 普通 Session 语义污染 | Ephemeral Session 使用受限 capability |
| 敏感详情保存时间变长 | 当前Runtime lifetime内最长24小时；viewer不延长TTL |
| 24小时窗口磁盘峰值无硬上限 | 第一版接受本地运营风险；有实际压力后独立增加容量保护 |
| Observation 变成控制面 | 读取与 control/interaction capability 分离 |
| Viewer 无限延长保留 | Viewer 不延长 TTL |
| GC 删除 active Session | TTL 只从 `subagent_end` 开始 |
| Runtime crash 留下 Child JSONL | 复用现有 startup orphan sweep；不恢复 Child execution |
| 过度抽象 identity | Session subscription 只使用 `sessionId` |

## 15. 与当前权威的差异

本Change实施前的权威记录行为是：

- successful `run_turn`、Session create 和 permission query/change 会累积 Session audience；
- 没有单 Session unsubscribe；
- `get_session_history` 不加入 audience；
- WebSocket `approval_requested` 仍按 Session audience 路由；
- `approval_closed` 已发送给全部 bound Clients；
- transient Child 不进入 Session get/list，且 terminal cleanup 立即删除 Transcript。

本候选确定改变以下公共契约：

1. **Session audience：** 从隐式累积改为显式 subscribe/unsubscribe；`create_session` 在确认前订阅创建连接，`run_turn` 要求已有 membership。
2. **Subagent detail：** preparing Child 返回空 History，active/terminal-retained Child 复用统一 History，并允许同一 WebSocket 临时订阅 Child Session；Child 仍不进入普通 Session list。
3. **Subagent retention：** `subagent_end` 后在当前Runtime lifetime内最长保留24小时；到期或Runtime restart后删除并按`SESSION_NOT_FOUND`处理。

另一个已确认目标是将 `approval_requested` 改为 connection-scoped 实时 pending-state 更新，但该变化不属于上述 Session subscription/Subagent History交付。它不能由本 Research 草稿覆盖当前 [ADR-019](../decisions/adr-019-origin-channel-and-session-scoped-approval-delivery.md)、[Approval Lifecycle](../specifications/approval-lifecycle.md)和[Channel Specification](../specifications/channel.md)，也不应静默扩大既有 Approval Change 的 closeout范围；应由独立的小型 Approval Change承载。

## 16. 候选交付阶段

### 阶段 A：主 Session + active Subagent Session

- 增加显式 `subscribe_session/unsubscribe_session`；
- 增加 `unregisterSessionAudience(clientId, sessionId)`；
- Vue Client 主 Session switch-out 时 unsubscribe，switch-in 时等待 subscribed ack 后 load History；
- 同一 Vue Client 打开 Child detail 时附加 Child subscription，关闭时只移除该 Child；
- 生成Child identity后先写入最小`preparingTranscriptIds`，再发布`subagent_start`；preparing History返回空页，所有退出路径清除marker；
- subscribe在写入audience前验证普通Pending/persisted/preparing/active/retained存在性，未知或已删除ID返回`SESSION_NOT_FOUND`；
- `create_session`在确认Runtime已知的Pending Session前为创建连接建立membership，`run_turn`不改变membership；
- 允许 active Child 通过现有统一 History API读取 Transcript；
- `task` Tool terminal Result以稳定Host header返回`childSessionId`，Parent History和Vue Client复用该content句柄打开只读Child detail；
- permission/history/query 不再隐式注册 audience；
- `run_turn` 要求调用连接已订阅；
- Parent switch-out 时 Client 显式取消当前 Child 后再取消 Parent，服务端不做隐式级联；
- 宽屏使用右侧详情面板、窄屏使用 Modal，同一时刻最多打开一个 Child detail；
- 验证主/Child 同连接订阅、重连、terminal、disconnect和只读边界。

### 阶段 B：Terminal retention

- `subagent_end` 后由SessionManager在当前Runtime lifetime内最长保留Child Transcript 24小时；
- completed task气泡在同一Runtime lifetime的最长保留期内可打开；
- TTL 到期删除 transient Transcript，后续 History 返回 `SESSION_NOT_FOUND`；
- Runtime restart 继续由现有 startup sweep 删除所有遗留 Child JSONL，不恢复 retention；
- 保持普通 Session discovery 不变。

### 独立 Approval Change

- 将 `approval_requested` 从 Session audience改为 connection-scoped pending-state更新；
- 保留 `approval_closed` connection-scoped cleanup和 canonical pending query reconciliation；
- 独立验证多 Client delivery、Origin Channel eligibility、settlement和 query/realtime去重；
- 在该 Change完成前，非 focus Session的 Approval由全局 pending query最终恢复。

### 阶段 C：Automation 复用

- Scheduled/Run list 提供 `sessionId`；
- Automation Run detail 复用同一个 viewer 和 subscribe-by-session；
- Automation control capability 保持独立；
- Automation Store 继续拥有 durable Run summary。

## 17. 验收建议

1. 一个普通 Client switch-out 后不再收到旧 Session 的 presentation events；
2. switch-in 收到 subscribed ack 后加载 History，并与新 live events 正确合并；
3. 重复 subscribe/unsubscribe 幂等；
4. `create_session` 在确认前完成创建连接的订阅，未订阅的 `run_turn` 被拒绝；
5. permission、History 和 metadata query 不改变 Session audience；
6. disconnect 清理该 Client 的全部 Session membership；
7. Session unsubscribe 不取消 Turn、不删除 History、不影响其他 Client；
8. Approval 在 Session unsubscribe 后仍可通过全局 pending query 恢复；
9. 独立 Approval Change 完成后，connection-scoped `approval_requested` 在 Session unsubscribe 后仍立即更新全局 pending collection 和对应 Session list indicator；
10. 当前 Vue Client 以 Session list indicator 呈现非 focus Session Approval，切入后按当前 `sessionId` 显示 Approval Tool card；
11. focused main Session 与 opened Child Session 可在同一 WebSocket 同时接收各自事件；
12. 关闭 Child detail 只取消 Child subscription，不影响 Parent main Session；
13. preparing marker的建立先于`subagent_start`发布，发布后立即subscribe可成功且History在Transcript创建前返回空页；
14. subscribe未知或已删除Session不创建audience membership，并返回`SESSION_NOT_FOUND`；
15. transient Child 不进入普通 Session get/list 或 lifecycle operation；
16. Subagent 与未来 Automation 都通过 `sessionId` 观察，不要求 execution address；
17. `turnId` 正确重建 Session 内 Turn，`callId` 正确关联 Tool lifecycle；
18. active ephemeral Session 晚观察时通过现有 History/realtime merge获得与普通 Chat Session一致的 presentation；
19. Subagent detail使用Parent task lifecycle呈现running/success/failed/aborted，Child History只恢复内容；
20. terminal 后 Session 只读；
21. completed `task` Result持久化稳定Host header，Parent LLM可读取其中的`sessionId`，Vue Client刷新后只从该header恢复detail入口；非法或旧格式不猜测；
22. 当前Runtime lifetime内最长24小时保留只从`subagent_end`开始，不删除active Session；
23. Viewer subscription 不延长 retention；
24. Runtime restart 时现有 startup sweep 删除全部遗留 Child JSONL，不恢复或推断遗留 active outcome；
25. thinking、Tool input/result 和 error 按 projection policy 清洗；
26. WebSocket重连后恢复 focused Parent和仍打开 Child的subscription，等待 ack 后重新加载History；
27. Parent switch-out 时 Client显式取消当前 Child和Parent，服务端不隐式级联；
28. 宽屏使用右侧详情面板，窄屏使用Modal，布局变化不触发重新订阅；
29. 普通 Session list、archive、fork 和长期 History 语义不被改变。

## 18. 与其他研究和权威的关系

- [Subagent Structured Tool Execution 隔离草稿](subagent-identity-event-routing-design-draft.md)继续拥有 Parent/Child、context firewall、identity、route、depth 和 terminal aggregation。
- [Automation 系统设计草稿](automation-system-design-draft.md)继续拥有 Job、Run、Schedule、持久化、admission、Approval 和 restart。
- [Session-addressed Approval 设计草稿](session-addressed-approval-design-draft.md)继续拥有 pending Interaction、跨 focus 投递、恢复和 first-settlement。
- [REST 状态管理与实时事件传输边界调研](rest-and-realtime-transport-boundary-design-draft.md)研究未来其他 Channel 的传输职责；当前 full WebSocket 保持不变。
- 本草稿拥有 Session-addressed presentation subscription、Subagent/Automation 临时 Session 观察、terminal retention、viewer 和 GC 候选。

Session subscription/Subagent History方向改变 WebSocket Session audience、Session History capability、Subagent transient retention和公共 wire contract，属于 Architecture Slice。`approval_requested` connection-scoped方向另由独立小型 Approval Change承载。本 Research不授权实现；两者都必须分别按 [Development Workflow](../governance/development-workflow.md)核对并接受所需工件后才能进入 Delivery。
