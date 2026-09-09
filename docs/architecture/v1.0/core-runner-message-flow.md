# In-turn 消息流设计文档

> 版本：v1.0
> 创建日期：2026-05-18
> 关联：
> - [runtime-design.md](./runtime-design.md)
> - [core-runner-design.md](./core-runner-design.md)
> - [adapters-channel-design.md](./adapters-channel-design.md)
> - [Current Config](../current/platform_config.md)

---

## 1. 概述与定位

当 channel（CLI / WebSocket）入站一条消息时，目标 session 可能处于三种状态：

1. **空闲**：没有活动 turn——消息触发新 turn；
2. **busy 且 follow-up 模式**：上一个 turn 还在执行——消息进入队列，等当前 turn 结束后再启动新 turn；
3. **busy 且 steer 模式**：上一个 turn 还在执行——消息进入当前 turn 的 steering inbox，由 runner 在 tool 执行间隙拉取，影响当前 turn 的后续 LLM 决策。

本文档定义这三类情况的统一处理路径，以及 RuntimeApp 与 AgentRunner 各自承担的职责。

### 1.1 术语

| 术语 | 定义 |
|---|---|
| **入站消息**（inbound message） | channel 通过 `onMessage` handler 推送给 RuntimeApp 的 `ChannelRunRequest` |
| **Turn**（一次对话轮次） | RuntimeApp 真正启动一次 `runTurn()` 调用、AgentRunner 跑完一次完整的执行循环 |
| **首条消息**（first message） | 触发一个 turn 启动的入站消息（也是 `RunParams.message`） |
| **Steering 消息** | turn 正在执行时进入 `steeringInboxBySession` 的入站消息；runner 在每轮 tool 执行后通过 `getSteeringMessages` reader 拉取并注入当前对话流 |
| **FollowUp 消息** | turn 正在执行时进入 `messageQueueBySession` 的入站消息；当前 turn 结束后启动**下一个**新 turn 时作为首条消息送给 LLM |
| **Steering 注入点** | runner 在每轮 tool 执行后调用 `getSteeringMessages` reader 的位置 |
| **Reader** | `PendingMessageReader = () => ChatMessage[] \| Promise<ChatMessage[]>`；runtime 实现，runner 调用 |

### 1.2 设计目标

- 配置一个开关（`runner.inTurnMessageMode`）即可在 steering / followup 两种 in-turn 语义间切换；该决策完全发生在 runtime 入站层，runner 不感知；
- Runner 不感知队列调度细节，runtime 不感知 runner 内部时序；通过 reader 抽象解耦；
- 同 session 串行保证消息历史一致性；steering / followup / 首条消息的处理路径都不破坏这一约束；
- "Soft steering" 优先——不取消在飞的 LLM 调用，不打断正在执行的 tool。硬 steering（基于 AbortSignal）属于未来设计。

---

## 2. 三类 in-turn 消息

### 2.1 首条消息

触发一个 turn 启动。"首条消息"是 `RunParams.message` 字段的值，直接进入第一次 LLM 调用。

来源：

- channel 入站消息 → `messageQueueBySession` → `scheduleNextQueuedTurn` 弹出 → `startQueuedTurn` 启动；
- 库消费者直接调用 `app.runTurn({ message })`。

### 2.2 Steering 消息

只在 `runner.inTurnMessageMode='steer'` 配置 + 存在活动 turn 时出现。入站消息进入 `steeringInboxBySession[sessionKey]`，由 runner 通过 `getSteeringMessages` reader 拉取。

注入时机：每轮 tool 执行后。

软语义约束：

- 不打断在飞的 LLM 流；
- 不打断正在执行的 tool；
- 最坏延迟 ≈ 当前 LLM 调用剩余时间 + 一组 tool 执行时长；
- 注入消息只能是 `role: 'user'`（注入 assistant / toolResult 会破坏 Anthropic API 的 tool_use ↔ tool_result 配对契约）。

### 2.3 FollowUp 消息

`runner.inTurnMessageMode='followup'` 配置下、当前 turn busy 时的入站消息。这种消息**不**进入 steering inbox，而是进入 `messageQueueBySession[sessionKey]`。当前 turn 结束后，runtime 自动从队头弹出并启动一个新 turn，followup 消息作为新 turn 的首条消息送 LLM。

效果上：

- LLM 在新 turn 看得到旧 turn 的全部历史（user / assistant / toolResult 都在 session 里）；
- 与"同 turn 多跑一轮"的语义等价，但 turn 边界变得明确——`turn_end` 在原 turn 结束时立即触发，新 turn 的 `turn_start` 在 followup 处理时触发。

这种"上移到入站层"的处理方式让 runner 不需要单独实现 followup 队列或外层重试循环。

---

## 3. 处理路径总览

### 3.1 完整数据流

```
Channel.onMessage(handler)
  │ ChannelRunRequest
  ▼
RuntimeApp.makeMessageHandler(channel)
  └─ handleInboundChannelMessage(channel, req)
       │
       ▼
  shouldRouteMessageToSteering(sessionKey)?
       │  = (runner.inTurnMessageMode === 'steer')
       │    AND (activeTurnIdBySession.has(sessionKey))
       │
       ├─ true ──▶ enqueueSteeringInput(sessionKey, message, routeContext)
       │           │
       │           └─ steeringInboxBySession.set(sessionKey, [...inbox, item])
       │                  return（不启动新 turn）
       │
       └─ false ─▶ enqueueQueuedTurn({ sessionKey, message, launchContext, routeContext })
                    │
                    └─ messageQueueBySession.set(sessionKey, [...queue, item])
                          ▼
                    scheduleNextQueuedTurn(sessionKey)
                       │
                       ├─ inFlightSessions.has(sessionKey)?
                       │   └─ true → return undefined（等当前 turn 结束后再续推）
                       │
                       └─ false → startQueuedTurn:
                                    ├─ turnId = randomUUID()
                                    ├─ routeContextByTurn.set(turnId, item.routeContext)
                                    └─ runTurn({ sessionKey, message, ..., turnId })
                                          │
                                          ▼
                                     runTurnInternal → AgentRunner.run({
                                          ...,
                                          getSteeringMessages: () => drainSteeringMessages(sessionKey)
                                     })
                                          │
                                          ▼
                                  AgentRunner 每轮 tool 后:
                                       getSteeringMessages reader → 注入 messages
```

### 3.2 turn 结束后的续推

```
runTurn() finally:
  ├─ inFlightSessions.delete(sessionKey)
  ├─ activeTurnIdBySession.delete(sessionKey)      ← steering 路由失效
  ├─ steeringInboxBySession.delete(sessionKey)     ← 残留 steering 输入丢弃
  └─ scheduleNextQueuedTurn(sessionKey)            ← 队列还有 → 启动下一个 turn
```

队列中的下一个 `QueuedChannelTurn` 就是 followup 消息（如果当前 turn busy 时来过入站）。

---

## 4. Runner 端：单一注入点

### 4.1 注入点

```
runAttempt 主体
  │
  │  while (hasMoreToolCalls):
  │    ├─ LLM 调用
  │    └─ tool use loop:
  │       ├─ 执行 tools
  │       ├─ tool result 追加
  │       ├─ Layer 1 裁剪
  │       ├─ 90% 阈值检查
  │       ├─ totalToolRounds++
  │       │
  │       └─◀ Steering 注入点 ─────┐
  │                                │
  │           const msgs = await readPendingMessages(params.getSteeringMessages);
  │           if (msgs.length > 0) appendInjectedMessages(...);
  │                                │
  │
  └─ return RunResult
```

Runner 只有这一个 in-turn 注入点。没有 followUp 注入点，没有外层 `while` 循环。

### 4.2 Reader

| Reader | 调用时机 | 谁实现 |
|---|---|---|
| `getSteeringMessages` | 每轮 tool 执行后 | RuntimeApp 提供 `() => drainSteeringMessages(sessionKey)` |

未提供 reader 时，`readPendingMessages` 直接返回 `[]`，注入点退化为一次空 await——library 模式不接 steering 时零运行时开销。

### 4.3 Reader 契约

```typescript
export type PendingMessageReader = () => ChatMessage[] | Promise<ChatMessage[]>;
```

- **返回类型必须是 `ChatMessage[]`**：每条消息有 `role: 'user' | 'assistant'` 与 `content`；
- **runner 内部做防御性过滤**：非法形态（无 role / 非 user|assistant role / 无 content）会被 `readPendingMessages` 静默丢弃；
- **应当是"消费即清空"语义**：runner 在注入点只调一次 reader，期望 reader 内部把已读输入从源头删除——避免重复消费。RuntimeApp 的 `drainSteeringMessages` 严格遵守这条；
- **可以是 async**：runner 用 `await` 等待结果。

---

## 5. Steering 详细设计

### 5.1 入站路由判定

```typescript
private shouldRouteMessageToSteering(sessionKey: string): boolean {
  return this.resources.resolvedConfig.runner.inTurnMessageMode === 'steer'
    && this.activeTurnIdBySession.has(sessionKey);
}
```

两个必要条件：

1. **配置开启**：`runner.inTurnMessageMode === 'steer'`，默认是 `'followup'`，必须显式配置；
2. **有活动 turn**：`activeTurnIdBySession.has(sessionKey)`——这个 Map 仅在 `runTurn()` 真正开始执行后才填，turn 结束时清除。

任一条件不满足，消息退回普通队列。**没有活动 turn 的消息默认进入普通队列**——避免消息因 reader 不存在而被静默丢弃。

### 5.2 inbox 累积

```typescript
private readonly steeringInboxBySession = new Map<string, PendingSteeringInput[]>();

private enqueueSteeringInput(
  sessionKey: string,
  message: string,
  routeContext?: MessageRouteContext,
): void {
  const inbox = this.steeringInboxBySession.get(sessionKey) ?? [];
  inbox.push({ message, routeContext });
  this.steeringInboxBySession.set(sessionKey, inbox);
}
```

`PendingSteeringInput` 类型：

```typescript
export type PendingSteeringInput = {
  message: string;
  routeContext?: MessageRouteContext;
};
```

`routeContext` 字段当前未被 runner 消费，但仍保留在 inbox 项里——未来若把 "steering 消息也能触发独立 interaction（如选项询问）" 落地，这个字段就是路由依据。

### 5.3 Runner 拉取：drainSteeringMessages

```typescript
private async drainSteeringMessages(sessionKey: string): Promise<ChatMessage[]> {
  const inbox = this.steeringInboxBySession.get(sessionKey);
  if (!inbox || inbox.length === 0) return [];

  this.steeringInboxBySession.delete(sessionKey);    // 读后即删

  return Promise.all(inbox.map(async (item) => {
    const builtUserPrompt = await this.resources.userPromptBuilder.build({ text: item.message });
    return { role: 'user' as const, content: builtUserPrompt.text } satisfies ChatMessage;
  }));
}
```

关键不变量：

- **读后即删**：reader 调用时整体 `delete`，避免同一条 steering 输入在多轮 tool 后被重复消费；
- **role 固定 user**：硬约束，不可配置；
- **走 `userPromptBuilder`**：与首条消息保持一致的预处理路径（template / 变量替换 / etc）；
- **批处理**：一次调用把 inbox 内所有积压消息全部产出，按入队顺序排列。

### 5.4 turn 结束清理

```typescript
// runTurn() finally
this.steeringInboxBySession.delete(params.sessionKey);
```

无条件清空——无论 turn 成功、失败、是否消费过 steering。这保证 steering 严格收口在"当前活动 turn 的生命周期"内：

- turn 失败时已积累的 steering 输入会丢失；
- 这是软 steering 的固有约束，channel 层不应假设入队即"已被记录"。

### 5.5 软 steering 的延迟特性

```
t0:  inbox 收到 steering message
t1:  当前 LLM 调用正在流式输出 ... 仍在进行（不打断）
t2:  LLM 调用结束，runner 检测到 tool_use blocks
t3:  开始执行一组 tools（例如 read_file + grep）... 仍在进行（不打断）
t4:  所有 tools 执行完成
t5:  tool results 追加 + Layer 1 裁剪 + 90% 检查
t6:  Steering 注入点：drainSteeringMessages → 把 t0 收到的消息加入 messages
t7:  下一轮 LLM 调用：LLM 看到 steering 消息
```

延迟范围：t6 - t0 ≈ 当前 LLM 调用剩余时间 + 一组 tool 执行时长。最坏可达数十秒（长 tool 调用）。

硬 steering（基于 AbortSignal + tool cancellation 协议）属于未来设计，本文档不涵盖。

---

## 6. FollowUp 详细设计

### 6.1 路径

```
inbound message（session busy, mode='followup'）
  │
  ▼
enqueueQueuedTurn → messageQueueBySession[sessionKey].push(item)
  │
  ▼  当前 turn 结束
runTurn() finally → scheduleNextQueuedTurn:
  │   inFlightSessions.has(sessionKey)? false（刚清除）
  │   queue 非空 → 弹出队头 → startQueuedTurn
  │
  ▼
startQueuedTurn:
  │   turnId = randomUUID()                  ← 新 turn 的 turnId
  │   routeContextByTurn.set(turnId, item.routeContext)
  │   runTurn({ sessionKey, message: item.message, turnId, ... })
  │
  ▼
新 turn 的 LLM 调用第一次就看到 followup 消息
```

### 6.2 同 session 串行保证 followup 语义

v1.0 设计选择："turn 结束后立刻启动下一个 turn，followup 是新 turn 的首条消息"。

这与"同 turn 内多跑一轮 LLM 调用"承接 followup 的方案在 LLM 可见层面几乎等价——新 turn `loadHistory` 时会看到旧 turn 的全部 user / assistant / toolResult 消息。区别只在 turn 边界：

| 维度 | 同 turn 多轮（备选） | v1.0（per-session 队列串行） |
|---|---|---|
| `turn_end` 触发时机 | 所有 followup 处理完才触发一次 | 原 turn 结束立即触发一次；新 turn 各自再触发 |
| `turnId` | 整段共享一个 turnId | 每个 turn 各自的 turnId |
| Hook payload | 所有 hook 看到同一 turnId | 每个 turn 各自的 turnId |
| 最大 LLM 调用数 | `maxLlmCalls` 跨多轮共享 | 每个 turn 独立计算 `maxLlmCalls` |
| 实现复杂度 | runner 内部双队列 + 外层重试 | runner 不感知，runtime 队列复用 |
| Channel 收到的事件 | 多个 followup 全在一个 `turn_start` / `turn_end` 内 | 每个 followup 都有自己的 `turn_start` / `turn_end` 边界 |

**v1.0 选择的取舍**：

- 优点：turn 边界明确；`maxLlmCalls` 不被无限累积；channel UI 容易分辨 "这是 followup 触发的新 turn" 而不是 "原 turn 还没完"；runner 实现简化（无外层循环 / 无 followup 注入点 / 无 mode 概念）；
- 代价：原 turn `turn_end` 与新 turn `turn_start` 之间有一小段时间窗口，channel 若想做"原 turn 还在继续"的展示需要自己缓冲。

---

## 7. inTurnMessageMode 配置

### 7.1 配置层级

```
runner.inTurnMessageMode         ← config（platform-config 的 RunnerConfig）
  > 内置默认 = 'followup'
```

`inTurnMessageMode` 只在 RuntimeApp 入站层（`shouldRouteMessageToSteering`）读取；既不传给 runner，也不被 `RunTurnParams` 覆盖。

### 7.2 'steer' vs 'followup'

| 模式 | 入站行为 | 适用场景 |
|---|---|---|
| `'followup'`（默认） | 入站消息总是进 `messageQueueBySession`，按 FIFO 串行 | 大多数 channel；可预测、不打断、turn 边界清晰 |
| `'steer'` | 有活动 turn 时入站消息进 `steeringInboxBySession`；无活动 turn 时进队列 | 需要快速影响 LLM 决策的场景（用户主动喊"停"或快速纠偏） |

### 7.3 Steering 入站判定的"两个必要条件"再说明

```
shouldRouteMessageToSteering = (config 是 'steer') AND (有活动 turn)
```

**当 config = 'steer' 但没活动 turn 时**：消息退回普通队列，按 FIFO 启动新 turn。这是有意设计——steering 必须能精准映射到一个正在执行的 turn，否则没有 reader 能拿到消息。

**当 config = 'followup'**：steering inbox 永远不会有内容，runner 端 reader 调用返回空，注入点退化为空 await。

---

## 8. 关键不变量

| 不变量 | 说明 |
|---|---|
| 同 sessionKey 内消息严格 FIFO | 由 `messageQueueBySession` + per-session in-flight gate 保证 |
| 同 sessionKey 内同时最多一个活动 turn | 由 `inFlightSessions` 保证 |
| Steering inbox 严格 turn 内 | turn 结束时 `delete`，无残留 |
| 注入消息只能是 `user` role | 硬约束；assistant / toolResult 会破坏 Anthropic API 序列契约 |
| Reader 调用与消费一一对应 | runner 每轮 tool 后调一次 `getSteeringMessages`，由 reader 内部保证读后即删 |
| Runner 没有 mode 概念 | `inTurnMessageMode` 只在 RuntimeApp 入站层读取；runner 只看到 reader 是否提供 |
| Steering 不在 tool 执行**期间**注入 | 仅在 tool 执行**之后**的注入点检查；这是软 steering 的固有约束 |

---

## 9. 已知未实现 / 规划项

| 项 | 状态 | 说明 |
|---|---|---|
| 硬 steering（AbortSignal + cancellation） | 规划中 | 打断在飞的 LLM 流和正在执行的 tool；需要 LLM 客户端、tool executor、hook 三处协议同步支持 |
| Tool 执行**前**检查 steering | 规划中 | 当前只在 tool 执行**后**检查；执行前再检查一次可缩短长耗时 tool 场景的延迟 |
| Steering 跨 turn 持久化 | 规划中 | 当前 turn 结束即清空 inbox；可考虑可选的"未消费 inbox 回退到普通队列"策略 |
| 按消息内容动态判断 steering / followup | 规划中 | 当前由 config 一刀切；若需要按消息内容（关键字 / 优先级标记 / LLM 判定）动态路由，可在 `handleInboundChannelMessage` 入口加分类逻辑 |
| FollowUp 消息批量合并 | 规划中 | 队列中连续多条 followup 是否合并为一次 LLM 调用而非启动多个 turn |
| 队列容量上限 + 过期 | 规划中 | `messageQueueBySession` 无大小限制；恶意 / 异常客户端可能持续灌入；可加 per-session 队列上限与 TTL |
| Steering 消息触发独立 interaction | 规划中 | inbox 已保留 `routeContext`；未来若 steering 消息想触发 select / approval 等交互可走这条路径 |

---

## 10. 测试覆盖

| 测试 | 验证点 |
|---|---|
| `queues busy-session channel messages and runs them serially` | followup 路径：第二条入站在第一条 busy 时进入队列；第一条完成后第二条自动启动；launchContext 参数透传 |
| `routes busy-session channel input to steering when steer mode is enabled` | steering 路径：`runner.inTurnMessageMode='steer'` 配置下，busy 期间入站走 steering inbox；runner 通过 `getSteeringMessages` reader 拉取，消息以 `{ role: 'user', content: text }` 形式呈现 |
| `routes queued websocket approvals to the queued turn origin client end-to-end` | followup 路径下，新启动的 queued turn 触发的 approval 按 queued turn 的 `originClientId` 路由（而非原 turn 的） |
| AgentRunner `injects steering messages between tool iterations` | steering reader 在每轮 tool 后被消费；注入消息进入 messages 与 session |

新增测试建议（规划）：

- steering inbox 在 turn 失败后仍被清空；
- steering inbox 在 turn 异常路径下不泄漏到下一 turn；
- followup 队列在 `close()` 期间被丢弃。

---

## 11. 总结

v1.0 把 in-turn 消息流拆成"runtime intake 路由 + runner 单注入点"两层：

1. **入站层（RuntimeApp）**：根据 `inTurnMessageMode` 与活动 turn 状态把入站消息分流到普通队列或 steering inbox；
2. **执行层（AgentRunner）**：在每轮 tool 执行后通过 `getSteeringMessages` reader 拉取 steering 消息，runtime 提供 reader 实现；
3. **配置层（platform-config）**：`runner.inTurnMessageMode` 决定入站层路由策略。

设计的核心收益：

- **FollowUp 语义被 per-session 串行队列自然兑现**——runner 不需要外层循环或 followup 注入点，turn 边界清晰；
- **Steering 路径职责单一**——只服务"想立即影响当前 turn"的场景，软语义约束明确；
- **Runner 端只有一个注入点**——没有 mode 概念、没有 reader 分发、没有外层循环，结构最简；
- **Reader 抽象解耦 runtime 与 runner**——runtime 完全控制消息何时进、runner 完全控制何时出，两者通过函数调用契约连接。
