# Subagent 身份与事件路由设计草稿

> Status: Non-authoritative design draft
> Authorization: 不授权实现，不修改当前 Subagent 稳定契约
> Scope: Subagent identity、事件关联、Runtime fanout、WebSocket audience 与 Child Transcript 边界
> Input: [Agent Session 管理对比调研](agent-session-management-comparison.md)、[新 Session 模型设计草稿](session-model-design-draft.md)

## 1. 决策边界

当前 Session 设计只讨论 Session 本身，不定义 Subagent 契约。Subagent 在该设计之外维持现有行为：

- 每个被接受的 Child 生成一个 `runId`、一个 Child `turnId` 和一个复合 `sessionKey`；
- Child 只有一个 Turn，继续复用完整 `AgentRunner` 事件流；
- Runtime 继续发出一对 `subagent_start` / `subagent_end`；
- WebSocket 继续解析复合 Child key 以找到 root audience；
- Child Transcript 继续临时创建并在结束后删除；
- Subagent 保持 blocking lifecycle，并继承 Parent Abort signal 与 generation。

本草稿只记录后续候选改进。任何字段删除、事件变更、路由收紧或 Transcript 策略调整都需要单独接受后才能实施。

## 2. 当前实现

### 2.1 身份

当前 Child lifecycle 携带：

```ts
interface CurrentSubagentIdentity {
  requestId: string;
  runId: string;
  sessionKey: string;
  turnId: string;
  parentSessionKey: string;
  parentTurnId: string;
  parentToolUseId: string;
  depth: number;
  subagentType: string;
}
```

一次 delegation 只调用一次 `AgentRunner.run()`，所以当前 `runId` 和 Child `turnId` 对同一执行节点保持一对一关系。`runId` 同时被编码进复合 Child `sessionKey`。

### 2.2 事件

Runtime lifecycle：

- `subagent_start`
- `subagent_end`，包含 `outcome`、`failure`、`usage` 和 `durationMs`

Child Runner：

- `run_start`、`llm_call`、`text_delta`
- `tool_use`、`tool_result`
- `tool_result_pruned`
- `compaction_start`、`compaction_end`
- `session_tail_sanitized`、`orphan_tool_results_repaired`
- `run_end` 或 `error`

`subagent_end` 是 Child 的统一 terminal。Setup/Resolution 在 Runner 启动前失败时不会出现 `run_start`；普通执行异常可能产生 `error` 而不产生 `run_end`。

### 2.3 路由

当前存在两个相关但不同的 Turn 路由面：

1. `routeContextByTurn` 为 Child `turnId` 复制 Parent route，服务交互与 origin client 定向。
2. Agent event fanout 通过 `activeRootGenerations` 按 `turnId` 选择 Channel binding；该表只登记 Root Turn。Child `turnId` 未命中时会回退当前全部 Channel binding。

WebSocket 收到 `subagent_start` / `subagent_end` 后，从复合 Child `sessionKey` 解析 root label，再选择 Session audience。

## 3. 其他 Agent 的实现对比

| 产品 | Child 容器 | 普通执行事件 | 生命周期与父子关联 |
|---|---|---|---|
| OpenAI Codex | 独立 Child Thread，可拥有 Turn | `threadId + turnId + itemId` | `parentThreadId`、sender/receiver thread、call ID |
| OpenCode | 独立 Child Session | `sessionID + messageID + partID/callID` | Session `parentID`，事件显式携带 `sessionID` |
| GitHub Copilot | Parent Session event stream | 普通 assistant/model/tool 事件携带 envelope `agentId` | `subagent.started/completed/failed`、`toolCallId`、parent task ID |
| Claude | Parent Session 下的 Subagent/Task 记录 | assistant/tool/task progress | `agent_id`、`parent_agent_id`、`tool_use_id`、task lifecycle |

共同模式：

1. Session/Thread 决定投递或存储范围。
2. Turn/Agent/Task/Tool Call ID 决定执行归属和事件配对。
3. 父子关系使用结构化字段，而不是要求客户端解析展示名称。
4. 未知执行目标不会静默扩大到所有 Session audience。

## 4. 候选目标模型

如果继续保持“每个 Subagent 只有一个 Turn”，最小候选身份是：

```ts
interface CandidateSubagentEventIdentity {
  sessionId: string;
  turnId: string;
  parentTurnId: string;
  parentToolUseId: string;
  depth: number;
  subagentType: string;
}
```

- `sessionId` 表示用户/root Session audience。
- Child `turnId` 同时表示该单 Turn Subagent execution，并关联全部 Runner 事件。
- `parentTurnId` 表示执行树，`parentToolUseId` 表示触发调用。
- 在没有多 Turn、resume 或 retry-across-turns 需求时，不新增 `executionId`。
- 移除复合 Child key 后，可以评估删除与 Child `turnId` 一对一的 `runId`。

如果未来接受多 Turn、可恢复或后台 Subagent，该假设失效，必须重新决定稳定 Agent/Task identity，不能直接沿用本模型。

## 5. 候选路由改进

1. 为 Root 和每个 Child 显式登记 `turnId -> root tree/channel snapshot`，与交互路由的生命周期一致。
2. 携带 `turnId` 的事件未命中路由时记录诊断并丢弃或按 late-event 规则处理，不回退全部 Channel。
3. Outbound event 显式携带 root `sessionId`，WebSocket 不再解析复合 Child key。
4. Child 路由必须在 `subagent_start` 前可见，并在 terminal fanout 被接收后清理。
5. `tool_use` 与 `tool_result` 增加 `toolCallId`，复用 Runner 已知的 canonical call ID。
6. 保留统一 `subagent_end.outcome`；当前无需再拆分 `subagent_completed` 和 `subagent_failed`。

## 6. 延后决策

以下问题会改变当前架构或公共事件契约，必须在接受本设计前逐项决定：

1. Child Transcript 是继续临时删除、作为 execution artifact 保存，还是成为可导航的 Child Session。
2. 是否支持后台或非阻塞 Subagent；若支持，需要 task progress、membership snapshot、重连和独立 Abort 语义。
3. 是否支持一个 Subagent 多 Turn、resume 或跨 Turn retry；若支持，需要独立于 `turnId` 的稳定 Agent/Task identity。
4. 未知或 late Child event 的丢弃、缓冲和诊断策略。
5. Root Session 删除时 execution artifact 的 restrict/cascade/orphan 策略。

## 7. 候选验收集合

仅当本草稿被提升为正式设计后，才使用以下验收项：

- 两个并发 Child 的全部事件按各自 `turnId` 区分，并只投递到所属 root Session audience。
- 嵌套 Child 使用结构化 `parentTurnId` 建树，不解析复合 Session 字符串。
- 未知 Child `turnId` 不会广播到无关 Channel 或 Session。
- `tool_use` 与 `tool_result` 可通过 `toolCallId` 精确配对。
- Setup、Resolution、执行错误、Abort 和 LLM-call limit 均只有一个 `subagent_end` terminal。
- Route 在 `subagent_start` 前登记，在 terminal delivery 后清理。
- 当前 blocking、单 Turn 行为在未接受后台或多 Turn设计时保持不变。