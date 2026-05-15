# OpenClaw FollowUp 与 Turn 超时处理分析

> 创建日期：2026-05-15
> 目的：分析 openclaw 中 followup 消息队列、turn 超时、后台 drain、并发控制、积压防御等机制，为 my-agent 的 steering/followup 设计提供参考。
>
> 关联文档：
> - [steering-followup-design.md](./architecture/steering-followup-design.md)

---

## 1. 核心概念澄清

OpenClaw 的关键设计：**followup 队列本身就是异步的，从一开始就不依赖于当前 turn**。

- 当前 turn **不消费** followup 队列
- followup 总是作为**新 turn** 启动（在后台 drain 中）
- 超时只是触发 drain 启动的众多事件之一（正常完成也会触发）

这个设计与 my-agent 当前的"同 turn 内多轮 followup"（外层 while 循环内处理）有本质区别。

### 概念分离

| 概念 | OpenClaw 定义 |
|-----|------|
| **Session** | 长期存在的容器（持久化，跨多个 turn） |
| **Turn** | 在 Session 上短期运行的单元 |
| **关系** | 一个 Session 可以有多个**串行**的 Turn |

这种分离让"后台 drain 启动新 Turn"成为可能。

---

## 2. Turn 超时后的完整流程

### 阶段 1：Turn 进行期间，用户继续发消息

```
[前台]                                  [后台 followup 队列]

Turn 1: 开始运行
"查询股票并整理表格"
  ↓ (LLM 调用、工具调用...)            FOLLOWUP_QUEUES.set(sessionKey, [])

[用户在 Turn 1 进行期间发消息]          enqueueFollowupRun(sessionKey, "发送到邮箱")
                                          → 队列: [msg1]
                                          → kickFollowupDrainIfIdle()
                                          → 但 Turn 1 还在运行，drain 不能启动
                                            (同一 session 不能并发两个 turn)
```

**关键点**：消息已经入队，**等待 Turn 1 结束**才能启动 drain。

### 阶段 2：Turn 1 超时

```
Promise.race([turnPromise, timeoutTimer])
  ↓ (timer 先完成)
超时触发 → onTimeout() 回调
  ↓
cleanupTimedOutTurn():
  1. abortController.abort()
  2. runtime.cancel({ reason: "turn-timeout" })
  3. persistent 模式 → session 保留
     oneshot 模式   → session 关闭
  ↓
抛出 AcpRuntimeError("ACP_TURN_FAILED")
  ↓
被 agent-runner.ts catch
  ↓
finalizeWithFollowup() ← 关键
  → scheduleFollowupDrain()  ✨ 启动后台 drain
```

**关键代码**：

```typescript
// agent-runner.ts
catch (error) {
  // 即使 turn 失败，也继续处理 followup 队列
  return finalizeWithFollowup(undefined, queueKey, runFollowupTurn);
}

// agent-runner-helpers.ts
export const finalizeWithFollowup = (value, queueKey, runFollowupTurn) => {
  scheduleFollowupDrain(queueKey, runFollowupTurn);  // ← 启动 drain
  return value;
};
```

### 阶段 3：后台 drain 处理残留消息

```typescript
scheduleFollowupDrain(sessionKey, runFollowupTurn):
  void (async () => {
    while (queue.items.length > 0) {
      await waitForQueueDebounce(queue);   // 1 秒防抖
      const item = queue.items[0];         // "发送到邮箱"

      await runFollowupTurn(item):         // ✨ 启动新的 Turn
        ├─ 使用 item.run.sessionKey       ← 复用原 session
        ├─ 调用 runEmbeddedPiAgent({
        │    sessionKey: item.run.sessionKey,
        │    sessionId: item.run.sessionId,
        │    prompt: item.prompt,
        │    timeoutMs: item.run.timeoutMs   ← 新的 timeout
        │  })
        ├─ 加载 session 历史（含 Turn 1 的所有消息）
        ├─ LLM 看到完整上下文
        ├─ 执行完整 LLM 循环
        └─ 完成后写回 session、路由回复

      queue.items.shift();
    }
  })();
```

### 时序图

```
时间轴 →

Turn 1 ============超时X========

用户发消息1                   ↓ enqueueFollowupRun
                            队列: [msg1]

                            ↓ 超时事件
                            cleanupTimedOutTurn:
                              - abort + cancel
                              - persistent: session 保留
                              - oneshot:   session 关闭

                            ↓ finalizeWithFollowup
                            scheduleFollowupDrain

                                  Turn 2 ============== (后台)
                                  处理 msg1
                                  完成 → 回复用户
```

---

## 3. Session 复用：不是新 session

虽然名字叫"新 turn"，但**仍然在原 session 上运行**：

```typescript
// FollowupRun 数据结构
type FollowupRun = {
  prompt: string;
  run: {
    sessionId: string;     // ← 同一个 session
    sessionKey: string;    // ← 同一个 sessionKey
    timeoutMs: number;     // ← 但是新的 timeout 计时
    // ...
  };
};
```

入队时就已经把 sessionKey 从原 turn 上下文复制下来。

### 关键含义

| 项目 | 实际情况 |
|-----|---------|
| **Session** | 同一个（复用原 sessionKey/sessionId） |
| **历史上下文** | LLM 能看到 Turn 1 超时前的所有消息 |
| **Turn** | 新启动的 turn（独立 turn handle、timeout） |
| **位置** | 后台异步（不阻塞调用者） |

### 为什么这样设计

- **LLM 看到完整上下文**：能知道"用户之前问了股票表格"，所以"发送到邮箱"指的是什么
- **不阻塞**：后台运行，用户可以继续发新消息（进入队列）
- **独立 timeout**：每个 followup 一个 turn，timeout 不会"传染"

---

## 4. 后台 Turn 期间的新消息：进入队列，不并发

### 原因：一个 session 同时只能有一个 turn

OpenClaw 的设计：

- 每个 session 有一个 "active turn" 状态机
- 后台 `runFollowupTurn()` 启动后，session 又进入 "有 active turn" 状态
- 新消息到达时，路由层检查 session 状态：
  - **有 active turn** → 入队（无论是前台还是后台 turn）
  - **无 active turn** → 启动新 turn

### 完整时序

```
T0: Turn 1 (前台) 运行中，session 状态 = ACTIVE
    ↓
    用户发 msg1 "发送到邮箱" → 入队

T1: Turn 1 超时
    session 状态 → IDLE
    scheduleFollowupDrain() 启动

T2: Drain 从队列取出 msg1
    runFollowupTurn(msg1) → 启动 Turn 2 (后台)
    session 状态 → ACTIVE (再次)

T3: 用户发 msg2 "顺便分析下走势"
    检测到 session ACTIVE
    → 入队（不能启动新 turn）
    队列: [msg2]

T4: Turn 2 完成（或超时）
    session 状态 → IDLE
    Drain 继续检查队列

T5: Drain 取出 msg2 → 启动 Turn 3
    ...
```

### 代码层面

```typescript
// drain.ts 大致逻辑
void (async () => {
  while (queue.items.length > 0) {
    await waitForQueueDebounce(queue);
    const item = queue.items.shift();

    // ↓ 这里阻塞等待 Turn 完成
    await runFollowupTurn(item);
    //    └─ 内部 runEmbeddedPiAgent(...) 完整跑完 LLM 循环
    //    └─ 期间 session 状态 = ACTIVE
    //    └─ 新消息会被 enqueueFollowupRun() 加入 queue.items

    // Turn 完成后回到 while，检查队列是否还有消息
  }
})();
```

**关键**：`while` 循环 + `await runFollowupTurn()` 是**串行**的，一次只处理一个，新消息只能等当前 turn 结束。

### 设计含义

OpenClaw 的设计实际上是：

1. **Session 维度上永远只有一个 turn 在跑**（串行执行）
2. **Drain 是这个串行执行的调度器**（队列驱动）
3. **从用户视角看**：发消息要么进入当前 turn 后续处理，要么入队等待，**永远不会并发**

这避免了：

- 上下文不一致（两个 turn 同时写 session 历史）
- LLM 看到部分上下文（一个 turn 还没完，另一个就开始）
- 工具结果路由错乱（不知道结果该给哪个 turn）

**结论**：openclaw 用"后台 drain"实现的并不是"并发处理"，而是"前台不阻塞 + 后台串行执行"——这是一个聪明的设计。

---

## 5. 积压防御：三层机制

如果用户输入多了，followup 消息会积压。OpenClaw 通过以下机制防御：

### 5.1 队列容量上限（cap）

```typescript
// state.ts
const DEFAULT_QUEUE_CAP = 20;  // 默认最多 20 条
```

可在配置中调整：

```json
{
  "messages": {
    "queue": {
      "cap": 20
    }
  }
}
```

### 5.2 Drop 策略（队列满时）

```typescript
type QueueDropPolicy = "old" | "new" | "summarize";

const DEFAULT_QUEUE_DROP = "summarize";  // 默认摘要
```

| 策略 | 行为 | 适用场景 |
|-----|------|---------|
| `old` | 丢弃最早的消息 | 优先保留最新意图 |
| `new` | 拒绝新消息入队 | 优先保护已排队工作 |
| `summarize` | **生成摘要替代** | 兼顾两者，推荐 |

#### summarize 策略详解

```
队列已满 (20 条):
  [msg1, msg2, ..., msg20]

用户发 msg21:
  → 触发 summarize
  → 将 msg1~msg5 合并为 summaryLine "用户在 X 时间问了 5 个关于股票的问题"
  → 队列变为: [summary, msg6, ..., msg20, msg21]
  → droppedCount += 5
```

Drain 处理时，summary 会作为一条普通 followup 注入：

```
"以下是被合并的多条用户消息的摘要：用户在 X 时间..."
```

### 5.3 Collect 模式：加速消费

除 drop 策略外，OpenClaw 还有 **collect 模式** 加速队列消费：

```json
{
  "messages": {
    "queue": {
      "mode": "collect",
      "debounceMs": 1000
    }
  }
}
```

**collect 模式行为**：

- Drain 不是一次处理一条
- 而是把队列中**所有等待中的消息合并成一个 prompt**
- 一次 LLM turn 就处理完所有积压
- 大大减少 turn 数和总耗时

```
队列: [msg1, msg2, msg3, msg4]

普通 followup 模式: 串行 4 个 turn
collect 模式: 合并为一个 prompt:
  "用户在过去发了以下消息：
   1. msg1
   2. msg2
   3. msg3
   4. msg4
   请综合处理。"
  → 一个 turn 搞定
```

### 5.4 消息去重

```typescript
// enqueue.ts
type FollowupRun = {
  messageId?: string;  // 用于去重，5 分钟 TTL
};
```

- 如果用户在 5 分钟内发了相同 messageId 的消息
- 会被去重，不进队列
- 防止用户因没收到回复而疯狂重发导致积压

### 5.5 用户体验视角

**正常场景**：

- 用户 1 分钟内发 5 条消息
- 进入队列 → drain 串行处理 → 用户依次收到 5 个回复

**积压场景（用户疯狂发消息）**：

- 用户 1 分钟内发 30 条消息
- 前 20 条入队 → 后 10 条触发 summarize
- 系统可能合并发出"以下是合并的回复"
- 或拒绝新消息（drop=new 时）

---

## 6. 与 my-agent 的核心区别

| 维度 | my-agent (当前) | openclaw |
|-----|---------------|---------|
| **followup 处理位置** | 当前 turn 的外层 while 循环（同步） | 独立的后台 drain（异步） |
| **消息入队后** | 等待当前 turn 的下一个外层迭代 | 立即可被独立的 drain 处理 |
| **同时性** | 一个 turn 内连续处理 | 一个 drain 处理多个 turn，串行执行 |
| **超时后** | followup 消息丢失（同 turn 中断） | drain 启动，依次处理为新 turn |
| **timeout 粒度** | 整个 turn 一个 timeout | 每个 followup 一个独立 turn + timeout |
| **Session/Turn 关系** | 基本绑定（一次 run() 一个 turn） | 分离（一个 session 可有多个串行 turn） |
| **队列容量保护** | 无 | cap + drop 策略 |
| **去重** | 无 | messageId TTL 去重 |
| **批量处理** | 无 | collect 模式合并 prompt |

---

## 7. 对 my-agent 设计的启示

如果要支持 openclaw 风格的 followup（异步、跨 turn、防积压），需要：

### 7.1 架构变化

1. **解耦 followup 与当前 turn** —— 不在当前 AgentRunner 中处理
2. **Runtime 层维护持久化队列** —— per session
3. **Drain 独立启动新 turn** —— 每次 followup 一个新 turn
4. **明确 Session/Turn 概念分离** —— Session 是容器，Turn 是 Session 上的运行单元
5. **Steering 仍是同 turn 内处理** —— 与 followup 性质不同

### 7.2 配置项扩展

```typescript
type FollowupQueueConfig = {
  cap: number;                       // 容量上限
  drop: 'old' | 'new' | 'summarize'; // 溢出策略
  debounceMs: number;                // 防抖窗口
  dedupTTL: number;                  // 去重 TTL
  mode: 'serial' | 'collect';        // 串行 vs 合并
};
```

### 7.3 Runtime 层接口

```typescript
class FollowupQueue {
  enqueue(msg) {
    if (this.items.length >= cap) {
      this.applyDropPolicy();
    }
    if (this.isDuplicate(msg)) return;
    this.items.push(msg);
  }

  applyDropPolicy() {
    switch (this.drop) {
      case 'old':       this.items.shift(); break;
      case 'new':       throw new QueueFullError();
      case 'summarize': this.summarizeOldest(5);
    }
  }
}
```

### 7.4 分阶段建议

| 阶段 | 目标 | 复杂度 |
|-----|------|------|
| **Phase 1（已完成）** | 配置驱动的 inTurnMessageMode + 同 turn 处理 | 低 |
| **Phase 2** | per-session 队列 + 串行 drain | 中 |
| **Phase 3** | Session/Turn 分离 + 后台 drain + 持久化 | 高 |
| **Phase 4** | drop 策略 + 去重 + collect 模式 | 中 |
| **Phase 5** | Approval 模式（需要 host 层拦截） | 高 |

---

## 8. 关键代码引用

### OpenClaw 源码位置

| 文件 | 用途 |
|-----|------|
| `src/auto-reply/reply/queue/drain.ts` | 核心 drain 实现 |
| `src/auto-reply/reply/queue/enqueue.ts` | 入队逻辑 + 去重 |
| `src/auto-reply/reply/queue/state.ts` | 队列状态定义 + 默认值 |
| `src/auto-reply/reply/queue/types.ts` | FollowupRun / QueueMode 类型 |
| `src/auto-reply/reply/followup-runner.ts` | Followup 执行器（启动新 turn） |
| `src/auto-reply/reply/agent-runner.ts` | turn 错误捕获 + finalizeWithFollowup |
| `src/auto-reply/reply/agent-runner-helpers.ts` | finalizeWithFollowup 实现 |
| `src/acp/control-plane/manager.core.ts` | turn 超时监控（awaitTurnWithTimeout） |
| `src/agents/timeout.ts` | timeout 配置解析 |
| `src/agents/bash-tools.exec-approval-followup.ts` | Approval followup 机制 |

### 关键常量

```typescript
// 超时相关
const ACP_TURN_TIMEOUT_GRACE_MS = 1_000;           // 超时宽限期
const ACP_TURN_TIMEOUT_CLEANUP_GRACE_MS = 2_000;  // 清理宽限期
const DEFAULT_AGENT_TIMEOUT_SECONDS = 48 * 60 * 60; // 48 小时

// 队列相关
const DEFAULT_QUEUE_CAP = 20;
const DEFAULT_QUEUE_DROP = "summarize";
const DEFAULT_QUEUE_DEBOUNCE_MS = 1000;
const DEDUP_TTL_MS = 5 * 60 * 1000;  // 5 分钟
```

---

## 9. 总结

OpenClaw 的核心设计思想：

1. **异步队列优先**：followup 不在当前 turn 内处理，而是入队等待
2. **串行执行保证一致性**：一个 session 同时只有一个 turn
3. **Session/Turn 分离**：Session 是长期容器，Turn 是短期运行单元
4. **三层防积压**：cap + drop 策略 + 去重 + collect 模式
5. **超时不丢消息**：persistent 会话超时后 drain 继续处理残留
6. **Host 层拦截 Approval**：对 LLM 透明，通过 followup 机制返回结果

这套机制让 openclaw 能够：

- 处理长时间运行的 turn 而不阻塞用户输入
- 在用户疯狂发消息时保持可控的延迟和资源消耗
- 优雅地处理超时、取消、批准等异步事件
- 保证 LLM 看到的上下文始终一致

对 my-agent 而言，是否采用类似设计取决于：

- **使用场景**：单次问答 vs 长时间任务
- **用户交互模式**：单人对话 vs 多消息聊天
- **复杂度容忍度**：Phase 2-5 引入显著架构变化
