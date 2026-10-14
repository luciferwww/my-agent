# REST 状态管理与实时事件传输边界调研

> Status: Non-authoritative research draft
> Authorization: 不授权实现，不覆盖 Current Architecture、Accepted Decisions、Stable Specifications 或源代码
> Scope: 研究 Web 客户端中 REST 查询/管理平面、Chat WebSocket 实时平面和可选专用观察流的职责划分

## 1. 问题与结论

当前 WebSocket Channel 同时承载：

- Chat 消息和流式输出；
- Turn、Tool、Approval 等实时生命周期；
- Session、History、Catalog、Permission 等请求/响应式能力；
- 客户端和 Session audience 管理。

随着能力增加，单一 WebSocket 协议容易累积大量 request、response、error 和 event 类型，并重复设计 HTTP 已有的分页、状态码、缓存、幂等与重试语义。

建议把 Web 传输拆为两个主要平面和一个可选专用流：

| 平面 | 建议传输 | 责任 |
|---|---|---|
| 状态/管理平面 | REST | 查询、分页、配置、资源管理、当前 snapshot |
| Chat 实时平面 | WebSocket | Chat/Turn 的流式输出、交互和强时序生命周期 |
| Detail 观察流 | 独立 WebSocket，按需 | 用户当前打开的单个 Subagent 或其他高频 detail |

核心原则：

> REST 回答“现在是什么状态”，WebSocket 通知“刚刚发生了什么变化”。

拆分的是传输和客户端投影，不是 Runtime 事实来源。REST、Chat WebSocket、Observation WebSocket、CLI 和未来 Channel 必须消费同一组 transport-neutral application capabilities 与 Runtime 状态。

## 2. 目标与非目标

### 2.1 目标

1. 减少 Chat WebSocket 中与实时对话无关的 RPC 消息类型。
2. 让管理页、设置页、脚本和未来 Channel 能复用查询与管理能力。
3. 用标准 HTTP 语义表达分页、错误、条件请求、幂等和资源寻址。
4. 保留 Chat 流式输出、Approval、steering 和 terminal 的低延迟与确定顺序。
5. 通过 snapshot + delta 支持断线恢复，而不是要求无限事件 replay。
6. 保持 Runtime/Application 为唯一状态与行为权威。

### 2.2 非目标

- 不授权替换现有 WebSocket Channel；
- 不决定最终 URL、DTO、认证或版本策略；
- 不将所有命令一律迁移到 REST；
- 不把内部 `AgentEvent` 联合类型直接公开为 HTTP API；
- 不引入第二套 Session、Turn、Approval 或 Subagent 状态机；
- 不承诺持久保存所有实时事件；
- 不以本草稿替代正式 Plan、ADR、Specification 或安全设计。

## 3. 当前架构事实

[Channels](../architecture/channels.md)规定 Channel 负责传输与 wire validation，Runtime 负责 Session queue、Turn identity、路由和 Agent-event Fanout。当前 Channel Runtime capabilities 已包含 Model Catalog、Abort、Session CRUD、History、Permission 和 Approval 查询。

[WebSocket Channel Extension Specification](../changes/archive/websocket-channel-extension/websocket-channel-extension-specification.md)规定 WebSocket Extension 同时拥有 HTTP server、WebSocket Upgrade、参考客户端和多 Session audience。它目前保留 Session、Catalog、Turn、Approval、Permission、Abort 和事件路由能力。

因此 REST 化不应让 HTTP handler 绕过 Runtime 或直接访问 Session Store。正确方向是把已有 capabilities 整理为 transport-neutral application ports，再由 REST 和 Channel adapter 分别调用。

[HTTP + SSE Channel 设计草稿](http-sse-channel-design-draft.md)讨论以 HTTP command + SSE observability 整体替换或重构 WebSocket。本调研范围不同：保留 WebSocket 作为 Chat 实时交互传输，只把查询/管理职责移至 REST；是否引入 SSE 不在当前建议内。

## 4. 分类标准

一个能力满足以下多数条件时，优先 REST：

- 请求后可以得到确定 snapshot；
- 适合资源寻址、分页、筛选或条件请求；
- 允许独立重试；
- 不依赖与当前 Chat Turn 的严格消息顺序；
- 管理页、设置页、CLI 或自动化脚本可能复用；
- 用户可以稍后重新查询；
- 不需要 token/text delta 级实时性。

满足以下多数条件时，保留 WebSocket：

- 需要服务端主动推送；
- 与当前 Chat/Turn 展示顺序直接相关；
- 是流式增量；
- 需要连接身份或 origin client 路由；
- 是当前交互的 request/closure 生命周期；
- terminal 必须及时主动交付；
- 高频轮询会显著损害体验或负载。

“是否叫 Event”不是分类依据。许多现有 WebSocket request/response 实际上是 query 或 command，不应因使用 WebSocket 就被视为实时事件。

## 5. 推荐能力矩阵

### 5.1 优先迁移到 REST

| 能力 | 建议理由 |
|---|---|
| Session list/get | 资源查询，可分页、缓存和复用 |
| Session History | 游标分页和 reload，本质是 snapshot query |
| Session rename/archive/delete/fork | 独立资源管理，适合标准错误和幂等语义 |
| Model/Provider/Agent catalog | 低频查询，管理和设置页面可复用 |
| Configuration read/update | 非 Chat 时序，需验证、审计和条件更新 |
| Permission mode read/update | 资源状态；变化通知可另走 WebSocket |
| Usage、诊断和日志摘要 | 查询型、分页型、权限敏感 |
| Artifact metadata/content | 按需读取，避免放入事件 payload |
| Active Subagent list/snapshot | 用于详情入口和断线恢复 |
| 完整 Tool Result 按需读取 | 适合 bounded preview + result reference |

候选资源形态仅用于说明：

```text
GET    /api/sessions
GET    /api/sessions/{sessionId}
GET    /api/sessions/{sessionId}/history?cursor=...
PATCH  /api/sessions/{sessionId}
POST   /api/sessions/{sessionId}/archive
GET    /api/catalog/models
GET    /api/configuration
PATCH  /api/configuration
GET    /api/sessions/{sessionId}/history
GET    /api/sessions/{sessionId}/runtime-state
```

正式设计应优先定义 capability 与 DTO，再决定 URL；不要从 URL 反推 Core API。

### 5.2 保留在 Chat WebSocket

| 能力 | 建议理由 |
|---|---|
| 用户消息 intake 与接受状态 | 与 origin client、Session audience 和 queue 相关 |
| `run_start/end` | 当前 Turn 实时生命周期 |
| `text_delta` | 流式输出 |
| thinking lifecycle | 流式展示，受策略控制 |
| Tool accepted/running/terminal | 与 Chat segment 顺序和 Host completion 相关 |
| Approval request/closed | 当前交互必须及时投递并关闭 |
| steering claim/binding | 当前 active Turn 的实时输入 |
| queued request terminal | 主动清除等待状态 |
| Subagent Level 1 状态变化 | 更新当前 task Tool Call card |
| Session/permission/catalog invalidation | 通知客户端重新读取 REST snapshot |

WebSocket 中应尽量发送结构化 delta 或 invalidation，不反复发送可以由 REST 获取的大型完整 snapshot。

### 5.3 需要单独决策的 command

不是所有写操作都天然属于 REST 或 WebSocket：

| Command | 初步建议 |
|---|---|
| 发送 Chat 消息 | WebSocket，保持 origin 和实时接受语义 |
| 回应当前 Approval | WebSocket，保持 interaction route 与 first-settlement |
| 当前 Turn steering | WebSocket，保持 active Turn 顺序 |
| Abort 当前 Turn | 可保留 WebSocket；若提供 REST，必须是幂等 request accepted，不代表已经停止 |
| Session rename/archive/delete | REST |
| Permission mode 更新 | REST；WebSocket 推送变化 |
| 配置更新 | REST |
| 打开 Subagent detail | 独立 Observation WebSocket |

REST command 返回 `202 Accepted` 时，只表示 Runtime 已接受请求。真实终态仍通过 WebSocket 或后续 REST snapshot 表达，不得把“请求接受”伪装成“操作已完成”。

## 6. Snapshot + Delta 模型

仅把查询迁移到 REST 不足以保证正确恢复。推荐每个需要实时更新的资源域使用：

```text
REST snapshot + cursor/version
               +
WebSocket delta/invalidation after cursor
```

示例：

```text
GET /api/sessions/{sessionId}/active-state
<- { snapshot, cursor: 120 }

WebSocket subscribe/resume { sessionId, afterCursor: 120 }
<- event { sequence: 121, ... }
```

必须解决 snapshot 与订阅之间的竞态。可选模式：

1. 先建立实时连接并取得基准 cursor，再读取 REST snapshot；
2. REST snapshot 返回 cursor，WebSocket 支持从 `afterCursor` 有界 replay；
3. 若无法 replay 或 cursor 已截断，明确返回 gap，客户端重新读取 snapshot。

不能使用客户端本地时间戳判断是否漏事件。Sequence/version 必须由事实 owner 分配，并定义作用域，例如每 Session、每 execution 或每资源集合。

## 7. 传输与领域模型边界

不建议创建彼此独立的：

```text
RestSessionState
WebSocketSessionState
CliSessionState
```

推荐依赖方向：

```text
Runtime / Application capability
  ├─ REST adapter -> HTTP DTO
  ├─ Chat WebSocket adapter -> realtime projection
  ├─ Observation adapter -> selected Session detail
  └─ CLI adapter -> terminal presentation
```

Application capability 应：

- 使用 canonical identity；
- 返回 immutable DTO 或快照；
- 不暴露 SessionManager、Registry、AbortController 或 mutable Map；
- 抛出/返回 bounded domain error，由 transport 映射；
- 独立于 HTTP status、WebSocket frame 和页面组件。

REST 与 WebSocket 可共享 schema 生成源或 DTO 定义，但不能共享 transport-only envelope。

## 8. WebSocket 事件收敛建议

拆分后，Chat WebSocket 消息可按以下类别收敛：

```text
chat
  user_message
  run_start
  text_delta
  run_end

tool
  tool_requested
  tool_accepted
  tool_terminal

interaction
  approval_requested
  approval_closed

state_change
  session_invalidated
  permission_changed
  catalog_invalidated
  subagent_state_changed

protocol
  hello
  error
  heartbeat
```

这不是建议把 wire protocol 压缩为一个无类型 `event` payload。每种公开消息仍需严格 schema、版本和关联字段。分类只用于减少查询 RPC 与实时事件混杂。

对于 `session_invalidated` 一类消息，客户端应将其视为“REST snapshot 可能过期”，而不是新的完整事实来源。若页面当前不关心该资源，可以延迟刷新。

## 9. Ephemeral Agent Session Observation 的位置

[临时单 Turn Agent Session 观察与保留设计调研](ephemeral-single-turn-agent-session-design-draft.md)提出：

- 主 Chat WebSocket 持续接收 Level 1；
- 用户打开 Subagent 或 Automation Session detail 时，建立独立 observation WebSocket；
- detail connection 第一版只绑定一个 ephemeral single-Turn Session；
- 详情关闭或 Session terminal 时释放 live observation；
- terminal detail 在固定 TTL 内保持只读，过期后清理；客户端仍可保留页面内缓存。

该模型与本调研一致：

- 当前 full WebSocket 继续提供查询/管理和 Level 1 状态；
- 主 WebSocket 更新 task card 或 Scheduled Run 状态；
- Observation WebSocket 只传当前打开 Session 的高频 detail；
- retained detail 的 Session 生命周期独立于普通 Chat Session archive。

## 10. 错误、幂等和并发

### 10.1 REST

正式设计应定义：

- stable error code 与 HTTP status 的映射；
- `requestId`/trace correlation；
- mutation 的 idempotency key 或自然幂等规则；
- `ETag`/version 或 `If-Match`，防止覆盖并发设置修改；
- 分页 cursor 的作用域与过期语义；
- request body、response 和上传大小上限；
- deadline、取消和 server shutdown 行为。

### 10.2 WebSocket

正式设计应定义：

- 每条消息的 Session/Turn/call/execution correlation；
- event sequence 或 gap detection；
- 慢客户端背压与有界队列；
- terminal 至多一次和 late-event policy；
- reconnect 后何时使用 replay，何时强制重新读取 REST；
- heartbeat 只证明连接活性，不改变业务 activity；
- connection close 对 pending interaction 和 observation 的影响。

### 10.3 双平面一致性

REST mutation 成功后，服务端可能同时产生 WebSocket delta。客户端必须按 resource version 去重，不能假定 HTTP response 和 WebSocket event 的到达顺序。

推荐：

```text
REST response: resourceVersion = 41
WebSocket event: resourceVersion = 41
```

客户端只应用比本地版本新的变化。对于不可版本化的一次性 terminal event，仍使用稳定 identity 和 at-most-once presentation。

## 11. 安全边界

REST 和 WebSocket 必须使用一致的 principal 与授权规则，但可以授予不同 capabilities：

- 读取 Session 不自动允许修改配置；
- 访问 caller Session 不自动允许读取所有 Subagent detail；
- observation connection 只读，不携带 cancel、steer 或 approval capability；
- 不在 URL query 中放 credential、原始 prompt、Tool input 或敏感 Session detail；
- REST 日志不得记录敏感 body；
- CORS、CSRF、Origin、TLS、认证与公网暴露需要独立正式设计；
- internal `AgentEvent.error`、stack、raw provider payload 不直接进入公共传输。

当前 WebSocket Extension 将认证、TLS 和公网强化留给部署边界。若引入 REST 管理 API，不能默认这一边界自动满足写操作的 CSRF、Origin 和权限需求。

## 12. 渐进迁移建议

### 阶段 A：分类与度量

1. 列出当前 WebSocket inbound/outbound message；
2. 标注 query、command、realtime event、interaction 和 protocol；
3. 统计频率、payload 大小、页面使用方和重连要求；
4. 不改变协议，仅形成迁移矩阵。

### 阶段 B：只读 REST

优先迁移低风险 query：

- Catalog；
- Session list/get；
- paginated History；
- Permission snapshot；
- active execution snapshot。

WebSocket 暂时保留旧 query 作为有期限 compatibility path；新客户端使用 REST。不得长期维护两套无退出条件的权威实现。

### 阶段 C：管理 REST

迁移 Session 管理、配置和权限修改，补齐：

- idempotency；
- concurrency/version；
- bounded errors；
- audit/diagnostics；
- WebSocket invalidation。

### 阶段 D：收敛 WebSocket

删除已迁移 query/management RPC，只保留 Chat 实时、interaction、必要 command、状态 delta 和 protocol control。

### 阶段 E：专用观察流

按实际 UX 需要加入 Subagent observation WebSocket；不把该流作为拆分 REST/Chat WebSocket 的前置条件。

## 13. 风险与待决项

| 问题 | 候选方向 |
|---|---|
| REST 与 WebSocket 形成双事实来源 | 两者只投影同一 application capability/Runtime owner |
| snapshot 与 delta 之间丢事件 | cursor/version + bounded replay 或明确 gap |
| 迁移期协议重复 | 明确 compatibility owner、截止条件和删除 Gate |
| REST mutation 与 event 到达乱序 | resource version 去重 |
| 把所有 command 搬到 REST 导致 Chat 时序破坏 | 按 interaction/Turn correlation 单独判断 |
| WebSocket 仍发送大型 snapshot | 改为 invalidation/reference，客户端按需 REST 查询 |
| 管理 API 扩大攻击面 | 独立认证、授权、CSRF/CORS/Origin 与审计设计 |
| SSE 与 WebSocket 重复 | 当前不引入 SSE；未来以可测需求决定 |
| transport DTO 污染 Core | application ports 与 adapter DTO 分层 |
| 多 Channel 行为分叉 | canonical capability 与状态语义保持 transport-neutral |

## 14. 验收建议

未来正式 Change 至少验证：

1. REST 与 WebSocket 对同一资源使用同一 canonical identity；
2. REST query 不绕过 Runtime/Application capability 直接访问 Store；
3. Chat 流式顺序、Approval、steering 和 terminal 行为不变；
4. snapshot/cursor 与 delta 无缺口，截断时明确要求重新同步；
5. REST mutation 与 WebSocket delta 乱序时客户端可去重；
6. 慢 WebSocket client 不阻塞 Runtime；
7. Session/History/Catalog 等新 REST 能被非 Chat 页面独立使用；
8. 迁移后的旧 WebSocket RPC 有明确删除条件；
9. REST、Chat WebSocket 和 Observation WebSocket 使用一致授权事实；
10. Shutdown 对 HTTP requests、Chat connections 和 observation connections 均有界收敛；
11. 错误响应不泄漏 stack、credential、文件路径或 Provider raw payload；
12. CLI 和其他 Channel 不因 Web transport 拆分而依赖 HTTP。

## 15. 后续决策门

该方向会改变公共协议、Extension 边界、Runtime capabilities 和安全面，属于 Architecture Slice。进入实现前需要：

1. 对当前 WebSocket message inventory 做事实审计；
2. 确定第一批 REST query 的范围；
3. 定义认证、授权、CSRF/CORS/Origin 和部署边界；
4. 完成 snapshot + delta 竞态与重连 Spike；
5. 形成 Accepted Plan、ADR/Specification；
6. 明确 compatibility 时限和旧 WebSocket RPC 删除 Gate。

## 16. 主流 AI Agent 对比

> Evidence cutoff: 2026-10-12
>
> 本节只采用官方文档、官方协议文档和官方 GitHub 仓库。闭源产品未公开的内部传输标记为未知，不根据 UI 行为推断后端实现。

### 16.1 总览

| 系统 | 状态/管理面 | 实时投递 | 恢复模型 | Subagent/后台执行观察 | 连接生命周期 |
|---|---|---|---|---|---|
| OpenAI Responses | REST 风格 Response/Conversation 资源 | SSE；另有 Responses WebSocket | GET snapshot；Conversation continuation；background stream sequence resume | Background Response 可 GET、续流、cancel；无通用 Subagent 资源 | 连接是 live delivery 边界，不是 Response 生命周期 |
| OpenAI Codex app-server | thread/turn/item RPC-like 方法 | stdio NDJSON 或 WebSocket text frame | thread read/list/resume；未承诺 notification cursor replay | Subagent activity 在通用 item/turn 通知中；可 list/wait/interrupt/close | 明确维护 connection 与 thread subscription；断连不删除 thread |
| Anthropic Claude Agent SDK | control RPC-like + transcript/session store | stdio NDJSON | transcript resume；无通用 event cursor replay | 父 Query 流携带 task/subagent event；Subagent transcript 可独立读取 | Query/process 是 live delivery 与 callback 边界 |
| GitHub Copilot SDK | JSON-RPC session CRUD/history | stdio/TCP JSON-RPC notification | persistent session resume；ephemeral delta 不 replay | 父 `session.event` 以 `agentId` 区分 Subagent | transport、persistent session、callback 是不同边界 |
| GitHub Coding Agent | 公开 Agent Tasks REST | 公开 push transport 未知 | Task status 可 GET；event replay 未公开 | Task list/get；公开资料未确认 completion push | 未知 |
| OpenCode | REST/OpenAPI；另有 ACP JSON-RPC | HTTP 主通道 SSE；PTY 才主要使用 WebSocket | child Session/history；新 stream 支持 sequence resume | Subagent 是 child Session，可读 children/messages 并按 Session 过滤事件 | SSE listener 是 live 边界，Session/history 独立 |
| LangGraph Platform | Thread/Run/State/History REST | SSE；新协议也支持 WebSocket | checkpoint、history、fork 与 stream cursor resume | Run 是一等后台资源；Subagent 按 namespace/handle 投影 | logical subscription、transport handle 和 Run 明确分离 |

### 16.2 OpenAI Responses 与 Agents SDK

Responses API 采用资源式 HTTP：

- create/retrieve/delete/cancel Response；
- Conversation 独立保存上下文；
- `stream=true` 通过 SSE 返回 `response.created`、delta 和 terminal；
- background Response 可使用 `sequence_number` 与 `starting_after` 续流。

官方证据：

- [Responses API reference](https://developers.openai.com/api/reference/resources/responses/methods/create)
- [Streaming responses](https://developers.openai.com/api/docs/guides/streaming-responses)
- [Background mode](https://developers.openai.com/api/docs/guides/background#streaming-a-background-response)
- [Conversation state](https://developers.openai.com/api/docs/guides/conversation-state)

这里需要区分三种语义：

1. `GET /responses/{id}` 是状态 snapshot；
2. Conversation/`previous_response_id` 是上下文 continuation；
3. background `starting_after` 才是事件 delivery resume。

Agents SDK 的 `run_streamed()` 是进程内 async iterator，`RunState` 可序列化 pause/resume，approval 通过 interruption state 表达。Nested agent/handoff 隶属外层 Run，并未形成独立远程 Subagent REST/订阅资源。

官方证据：

- [Agents SDK streaming](https://github.com/openai/openai-agents-python/blob/125efa029b4bfd84238bd2c4fd69c3406f802663/docs/streaming.md)
- [Agents SDK human in the loop](https://github.com/openai/openai-agents-python/blob/125efa029b4bfd84238bd2c4fd69c3406f802663/docs/human_in_the_loop.md)

对本项目的启示：

- REST snapshot 与 stream sequence 是不同能力；
- 不能把 reconnect 等同于 replay；
- Background execution 不应因观察连接关闭而消失。

### 16.3 OpenAI Codex app-server

Codex app-server 使用带 `method/id/params/result` 的双向 RPC-like 协议，但明确不是 JSON-RPC 2.0。它支持：

- thread start/read/resume/archive/delete；
- turn/item list；
- stdio NDJSON 和 WebSocket transport；
- server→client approval request；
- `turn/interrupt`；
- Subagent spawn/send/resume/wait/close/interrupt/list。

官方证据：

- [Codex app-server documentation](https://developers.openai.com/codex/app-server)
- [RPC protocol source](https://github.com/openai/codex/blob/a9b0815167c27ab13719dd12d13b63e02b70d221/codex-rs/app-server-protocol/src/rpc.rs)
- [Subagent protocol types](https://github.com/openai/codex/blob/a9b0815167c27ab13719dd12d13b63e02b70d221/codex-rs/app-server-protocol/src/protocol/v2/item.rs#L1130-L1141)
- [Connection/thread subscription ownership](https://github.com/openai/codex/blob/a9b0815167c27ab13719dd12d13b63e02b70d221/codex-rs/app-server/src/thread_state.rs#L320-L351)

Codex 是样本中“物理连接拥有实时 thread subscription，但不拥有 thread 生命周期”最明确的实现。断连移除 connection subscription，不删除 thread。恢复主要依靠 `thread/resume/read/list` hydration，公开协议未承诺所有 live notification 都能按 cursor replay。

对本项目的启示：

- connection close 作为 observer cleanup 边界有直接先例；
- execution/session 与 connection 必须分离；
- 缺少 event replay 时，需要 snapshot/history hydration。

### 16.4 Anthropic Claude Agent SDK

Claude Agent SDK 启动 CLI，并通过 stdin/stdout stream-json 通信：

- stdout NDJSON 承载实时消息；
- `control_request/control_response` 以 `request_id` 关联 Tool approval、interrupt 等控制；
- Session resume 重载 transcript，不恢复旧 process/socket/pending callback；
- Subagent message 使用 `parent_tool_use_id`，新版另有 `agent_id`；
- task lifecycle 出现在统一 Query 流中；
- Subagent transcript 可通过 session API 单独读取。

官方证据：

- [Agent SDK sessions](https://code.claude.com/docs/en/agent-sdk/sessions#resume-a-session)
- [Agent SDK subagents](https://code.claude.com/docs/en/agent-sdk/subagents#access-subagent-messages)
- [Python SDK control request implementation](https://github.com/anthropics/claude-agent-sdk-python/blob/f7529348747235da34af3ed202251228ff31db08/src/claude_agent_sdk/_internal/query.py#L577-L751)
- [Python SDK Subagent session access](https://github.com/anthropics/claude-agent-sdk-python/blob/f7529348747235da34af3ed202251228ff31db08/src/claude_agent_sdk/_internal/sessions.py#L1199-L1510)

对本项目的启示：

- Subagent detail 可以复用父执行统一流并按 identity 过滤；
- transcript persistence 可提供完成后回看，但这与当前 my-agent terminal cleanup 契约不同；
- live connection 与 persisted transcript 是两个恢复层次。

### 16.5 GitHub Copilot SDK、CLI 与 Coding Agent

Copilot SDK 使用 JSON-RPC over child stdio 或 TCP socket，公开方法包括：

- `session.create/resume/list/delete/getMetadata/getMessages/detach/abort`；
- `session.event` notification；
- `permission.requested` 与反向 permission response；
- persistent Session resume。

Ephemeral progress/delta 不会因 Session resume 而 replay；完整持久消息通过 `session.getMessages` 重新读取。Subagent 与父 Session 共用 `session.event`，通过 `agentId` 区分。

官方证据：

- [Copilot SDK session API](https://github.com/github/copilot-sdk/blob/6be623b01b194a61466385e3f708639ec98ce8ac/nodejs/src/client.ts#L5-L35)
- [Session persistence](https://github.com/github/copilot-sdk/blob/6be623b01b194a61466385e3f708639ec98ce8ac/docs/features/session-persistence.md)
- [Streaming and Subagent events](https://github.com/github/copilot-sdk/blob/6be623b01b194a61466385e3f708639ec98ce8ac/docs/features/streaming-events.md#L43-L64)
- [Copilot CLI ACP server](https://github.com/github/docs/blob/be38ec5d78e24172587e61b3c6ff40ace1865c71/content/copilot/reference/copilot-cli-reference/acp-server.md)

公开 Agent Tasks API 则是 REST，支持 create/list/get，并公开 queued、in_progress、completed、failed、waiting_for_user 等状态。公开资料没有确认 Coding Agent UI 使用的 SSE/WebSocket、completion webhook 或 event replay，因此这些部分保持未知。

官方证据：

- [Using Copilot coding agent through the API](https://github.com/github/docs/blob/be38ec5d78e24172587e61b3c6ff40ace1865c71/content/copilot/how-tos/use-copilot-agents/cloud-agent/use-cloud-agent-via-the-api.md)

对本项目的启示：

- 持久 History 与 ephemeral stream 分层是常见做法；
- 同一父流按 `agentId` 过滤是独立 observation connection 的替代方案；
- 对闭源 Web UI 的内部 push transport 不应做无证据推断。

### 16.6 OpenCode

OpenCode 同时提供：

- REST/OpenAPI server：Session CRUD、children、fork、abort、message、command；
- SSE：Agent/Session/Tool/Permission 实时事件；
- ACP：JSON-RPC 2.0 over NDJSON/stdio；
- WebSocket：主要用于 PTY，而不是 Agent Chat 主流。

新 Session event stream 通过 aggregate sequence 和 `after` 支持 history/live 衔接。Subagent 是带 `parentID` 的 child Session，可以查询 children、读取 child messages，并在普通 event stream 中按 Session ID 过滤。

官方证据：

- [OpenCode server documentation](https://github.com/anomalyco/opencode/blob/733b2c627e5aec39cb33cc22373bdce33053ef2c/packages/web/src/content/docs/server.mdx)
- [OpenCode ACP documentation](https://github.com/anomalyco/opencode/blob/733b2c627e5aec39cb33cc22373bdce33053ef2c/packages/web/src/content/docs/acp.mdx)
- [SSE connection lifecycle](https://github.com/anomalyco/opencode/blob/733b2c627e5aec39cb33cc22373bdce33053ef2c/packages/opencode/src/server/routes/instance/httpapi/handlers/event.ts#L25-L78)
- [Durable session event sequence](https://github.com/anomalyco/opencode/blob/733b2c627e5aec39cb33cc22373bdce33053ef2c/packages/core/src/event.ts#L541-L583)
- [Subagent task implementation](https://github.com/anomalyco/opencode/blob/733b2c627e5aec39cb33cc22373bdce33053ef2c/packages/opencode/src/tool/task.ts#L44-L60)

对本项目的启示：

- REST 状态面 + 单向实时 event stream 是成熟替代方案；
- child Session 使完成后 History 可查，但会扩大持久化和权限边界；
- sequence stream 是 snapshot/live 竞态的直接解法。

### 16.7 LangGraph Platform

LangGraph 把 Thread、State、History 和 Run 建模为 REST 资源。实时执行主要使用 SSE，新 thread stream 也支持 WebSocket：

- Run create/get/list/join/cancel/delete；
- `join_stream` 支持 `Last-Event-ID` 和 `cancel_on_disconnect`；
- Thread state 包含 checkpoint、tasks 和 interrupts；
- interrupt 通过 `input.requested` 与 `input.respond` 关联；
- Run 是独立后台资源，可通过 get/list/join/stream/cancel/webhook 观察；
- Subagent 主要通过 namespace/handle 投影。

官方证据：

- [LangGraph SDK thread/run client](https://github.com/langchain-ai/langgraph/blob/799c2f04fd3a56186e24e9fb8bbf3568e543cfbe/libs/sdk-py/langgraph_sdk/_async/threads.py)
- [Run stream and cancel-on-disconnect](https://github.com/langchain-ai/langgraph/blob/799c2f04fd3a56186e24e9fb8bbf3568e543cfbe/libs/sdk-py/langgraph_sdk/_async/runs.py#L1097-L1154)
- [WebSocket transport](https://github.com/langchain-ai/langgraphjs/blob/7789c52f9404bcc7581c5ade1b332d9654fd7214/libs/sdk/src/client/stream/transport/websocket.ts#L137-L203)
- [Subagent handles](https://github.com/langchain-ai/langgraphjs/blob/7789c52f9404bcc7581c5ade1b332d9654fd7214/libs/sdk/src/client/stream/handles/subagents.ts#L39-L80)
- [Time travel](https://github.com/langchain-ai/docs/blob/f6b65de6e7e2085db8ae284043de684897879260/src/oss/langgraph/use-time-travel.mdx)

LangGraph 明确区分 logical subscription、SSE/WS handle、shared transport 和 server-side Run。多个逻辑订阅可以共享物理流；默认断连不取消 Run。

对本项目的启示：

- subscription 不必与物理 connection 一对一；
- disconnect 与 cancel 应有独立语义；
- checkpoint resume、interrupt resume、stream cursor resume 和 time travel 必须分开命名。

### 16.8 跨系统结论

#### 状态面与实时面分离是主流方向

OpenAI Responses、GitHub Agent Tasks、OpenCode 和 LangGraph 都有明确的资源查询/管理接口；实时增量另用 SSE、WebSocket 或 RPC notification。Claude、Codex 和 Copilot 的本地 SDK 虽然不一定使用 REST，但同样把 persisted Session/Thread 与 live process/connection 分离。

因此，本草稿提出的“REST 状态/管理平面 + Chat 实时平面”有充分行业先例。

#### 实时传输没有唯一标准

- 云 HTTP API 常使用 SSE；
- 本地 CLI/SDK 常使用 stdio NDJSON 或 JSON-RPC；
- WebSocket 多用于双向低延迟控制、多逻辑流复用或浏览器 transport。

Chat WebSocket 是合理选择，但不是 Agent 行业唯一或默认标准。

#### Subagent 观察有三类常见模型

1. 父 Session/Run 的统一事件流，以 `agentId`、task ID 或 item ID 过滤；
2. Child Session 或 namespace，可独立查询 History 并复用统一 event infrastructure；
3. 一等后台 Run/Task，可 query、stream、cancel 或 webhook。

没有形成“每个 Subagent 必须独占一条 Observation WebSocket”的行业惯例。

#### 连接通常拥有订阅，不拥有执行

跨系统最一致的语义是：

```text
disconnect / unsubscribe
= 停止 live delivery
≠ cancel execution
≠ delete session/history
```

Codex、OpenCode 和 LangGraph 都有直接证据支持这一分离。只有显式 `cancel_on_disconnect` 一类 opt-in 才把执行与连接绑定。

#### Resume 必须拆分命名

至少存在：

1. Conversation continuation；
2. History reload；
3. execution-state/checkpoint resume；
4. event delivery cursor resume；
5. re-execution/time travel。

本项目不应使用一个模糊的 `resume` 同时表示以上语义。

### 16.9 对 my-agent 方案的修正判断

以下部分符合主流实践：

- REST 承载 Session、History、Catalog、Configuration 和 active execution snapshot；
- Chat WebSocket 承载实时 Turn、Tool、Approval、steering 和 delta；
- observation disconnect 不取消 Child；
- completion 同时具有 live terminal 和可重新查询的终态事实；
- snapshot + cursor 处理断线和 history/live 竞态。

以下部分属于 my-agent 的自定义选择：

- Chat WebSocket 与 Observation WebSocket 物理分离；
- 一个打开的 Subagent 模态窗口对应一条短生命周期 observation connection；
- Child terminal 后清理 transient Transcript，只允许客户端保留非持久 detail。

独立 Observation WebSocket 可以由 UX 和资源隔离需求合理化。观察地址直接使用既有 `sessionId`，不增加 execution-level subscription identity：

```text
Observation connection
  sessionId
  optional cursor
  detail level
  connection lease
```

第一版限制一个 observation connection 只绑定一个 Session，以获得简单的模态窗口生命周期。Session 内即使未来包含多个 Turn，也由 History/live event 的 `turnId` 区分，不增加 Turn/execution subscription。

当前 my-agent 与多数可恢复系统的主要差异是：Child Transcript 在 terminal 后删除。因此：

- 如果用户运行期间没有订阅，完成后无法恢复 Child detail；
- 如果用户订阅过，只能依赖页面内非持久缓存；
- REST 只能查询 active snapshot 或 Parent 中持久化的 bounded Tool Result；
- 若未来要求刷新后回看，必须单独接受 Child diagnostic retention 或持久 child execution resource，不能由 WebSocket replay 凭空恢复。

最终判断：

> REST 状态/管理平面与实时投递平面分离符合主流架构；独立按需 Observation 是合理的逻辑能力；是否使用第二条物理 WebSocket 应由 my-agent 的模态窗口生命周期、数据量、权限隔离和实现复杂度决定，而不是作为行业惯例预设。
