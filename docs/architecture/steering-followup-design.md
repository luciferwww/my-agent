# Steering / FollowUp 设计文档

> 创建日期：2026-05-15  
> 关联文档：
> - [core-runner-design.md](./core-runner-design.md)
> - [platform-config-design.md](./platform-config-design.md)

---

## 1. 背景

当 Agent 正在执行一个 turn（可能处于 LLM 调用中，也可能处于工具执行中）时，用户可能会追加新消息。

这类“turn 内新消息”需要明确策略：

- 立即影响当前执行流（Steering）
- 排队等待当前 turn 结束（FollowUp）

如果不统一策略，系统行为会变得难以预测，且不利于调试。

---

## 2. 目标

- 支持通过配置开关统一指定 turn 内新消息默认处理方式。
- 保留 AgentRunner 的职责边界：Runtime 决策，Runner 执行。
- 后续可扩展到智能判定（按紧急性自动切换），但第一阶段先落地“显式模式”。

---

## 3. 术语

### 3.1 Steering

- 定义：turn 未结束时，将新消息尽快注入当前执行流。
- 注入时机：内层每轮 LLM/tool 完成后、下一次 LLM 调用前（无 tool_use 的轮次也会检查）。
- 适用场景：改方向、紧急补充。

**重要：本设计的 steering 是“软 steering”。**

- 不取消正在进行的 LLM 流式调用。
- 不取消正在执行的工具。
- 注入延迟 ≈ 当前 LLM 调用剩余时间 +（若本轮有工具）一组 tool 执行时长。
  最坏情况下用户输入“停下”也要等十几秒到数十秒才被 LLM 看到。
- 注入消息只能是 `role: 'user'`（注入 `assistant` 会破坏 tool_use/tool_result 配对与
  Anthropic API 的消息序列契约，不在本阶段支持范围内）。

“硬 steering”（基于 AbortSignal 取消 in-flight LLM 调用、配合工具的 cancellation 协议
真正中断当前操作）属于后续阶段，见 §9。

### 3.2 FollowUp

- 定义：新消息进入 followUp 队列，**在当前 turn 内、内层 tool-use 循环退出后**注入并触发外层再走一轮。
- 注入时机：内层循环**自然退出后**（非 maxToolRounds 截断）、外层循环结束判定前。
- 适用场景：非紧急补充、普通追问。
- 注入消息只能是 `role: 'user'`（同 §3.1）。

> **语义说明：followUp 不结束当前 turn 也不起新 turn**，
> 而是在同一 turn 内多跑一轮 LLM 调用。Channel 只在所有 followUp 处理完才看到一次 `turn_end`。
>
> 选择“同 turn 多轮”而非“起新 turn”的原因：
> - 实现简单：不需要 channel/runtime 协调新 turn 起停。
> - 成本可控：`maxFollowUpRounds` 集中保护单 turn 总成本。
> - 代价：单 turn 持续时间可被拉长；turn_end 触发时机延后。

---

## 4. 配置设计

### 4.1 新增配置项（Runtime 解析）

建议在 runner 配置分区增加：

```json
{
  "runner": {
    "inTurnMessageMode": "followup"
  }
}
```

取值：

- `steer`
- `followup`

默认值建议：`followup`（更保守，不改变现有行为预期）。

### 4.2 运行时参数透传

Runtime 解析配置后，将模式透传到 `RunParams`：

```ts
inTurnMessageMode?: "steer" | "followup";
```

Runner 不解析配置文件，只消费该参数。

### 4.3 优先级

建议优先级（高到低）：

1. 本次请求显式覆盖（如果后续支持命令级覆盖）
2. 会话级覆盖（如果后续支持）
3. `runner.inTurnMessageMode`（config）
4. 默认值 `followup`

---

## 5. 判定规则

### 5.1 基线规则（第一阶段）

- turn 内收到新消息时：
  - `inTurnMessageMode = "steer"` -> 进入 steering 队列
  - `inTurnMessageMode = "followup"` -> 进入 followUp 队列

即第一阶段不做语义分类，完全由配置决定。

### 5.2 可选扩展（第二阶段）

引入 `"auto"` 模式：

- 紧急词或中断意图（如“停下”“不要继续”） -> steering
- 其余 -> followup

该能力依赖稳定的意图识别，建议后置。

---

## 6. 执行流程（与两层循环对齐）

```text
pendingMessages = 启动时一次性抢 steering 队列   ← ① 覆盖“消息到达和 loop 启动之间”的窗口

外层 while (followUp rounds)
  hasMoreToolCalls = true
  truncated = false

  内层 while (hasMoreToolCalls || pendingMessages.length > 0)   ← ② 条件自带兜底
    1) 若 pendingMessages 非空 -> 注入 messages, pendingMessages = []
    2) 调用 LLM
    3) 若 stop_reason 是 error/aborted -> 直接结束 turn
    4) 若有 tool_use:
         a) toolRounds 达上限？-> truncated = true -> 跳出内层
         b) 否则执行工具，结果 push 到 messages
       否则:
         hasMoreToolCalls = false
    5) pendingMessages = 检查 steering 队列                      ← ③ 每轮无条件检查

  内层退出后：
    若 truncated（messages 末尾是悬挂 tool_use）：
      -> 第一阶段：直接结束 turn；不消费 followUp 队列，
         pending 消息保留到下一个 turn 处理（见 §9）。
    否则:
      followUp = 检查 followUp 队列
      若 followUp 非空 -> pendingMessages = followUp; followUpRounds++; 继续外层
      否则 -> 退出
```

关键点：

- **steering 检查时机：内层每轮 LLM/tool 完成后无条件检查**，与 tool_use 是否存在无关。
  这样无 tool_use 的 turn（LLM 直接返回 text）也能在下一轮 LLM 调用前注入 steering。
- **内层循环退出条件 `hasMoreToolCalls || pendingMessages.length > 0`**：
  - 有 tool_use → 继续走 tool 执行
  - 无 tool_use 但有 steering → 继续走 steering 注入 + 下一轮 LLM
  - 都没有 → 自然退出
- **pre-loop 抢一次 steering**：覆盖“用户消息到达”与“loop 启动”之间可能积压的 steering。
- Steering 不打断“当前正在执行中的单个工具调用”或正在进行的 LLM 调用，
  而是在本轮 tool/LLM 完成后生效（详见 §3.1 软 steering 性质）。
- FollowUp 永远不插入内层循环，只在内层结束后生效。
- **maxToolRounds 截断退出是唯一的特殊路径**：messages 末尾停留在悬挂 tool_use，
  直接结束 turn，避免发出违反 Anthropic API 契约的消息序列。
- **mode 锁定时机**：mode 在 turn 开始时从 RunParams 读出后即锁定，turn 内不再变化。
  turn 中途到达的消息一律按“该 turn 锁定的 mode”分流到 steering / followUp 队列。

---

## 7. 职责边界

- Runtime：
  - 解析配置
  - 维护 steering / followUp 队列
  - 决定新消息入哪个队列
  - 通过 RunParams 上的 reader 回调把队列暴露给 Runner
- AgentRunner：
  - 在既定注入点调用 reader 消费消息
  - 不持有队列状态
  - 不做配置解析
  - 不做消息语义判定

---

## 8. 实施建议

1. 先在配置类型中加入 `runner.inTurnMessageMode`。
2. Runtime 在启动时解析并向 `RunParams` 透传。
3. 在 Runner 的循环中补齐（对齐 §6 流程）：
   - 外层 while 之前：pre-loop 抢一次 `getSteeringMessages()`
   - 内层 while 末尾：无条件 `getSteeringMessages()`（与 tool_use 分支并列，不嵌套在内）
   - 内层 while 条件：`hasMoreToolCalls || pendingMessages.length > 0`
   - 内层退出后：仅在非 truncated 时 `getFollowUpMessages()`；truncated 直接结束 turn
4. 新增测试（覆盖 §6 核心路径）：
   - pre-loop 抢：turn 启动时队列已有消息 → 第一次 LLM 调用前注入
   - 无 tool_use turn 的 steering：LLM 返回纯 text + steering 非空 → 内层不退出、再调一次 LLM
   - `maxToolRounds` 截断后 pending 保留：truncated 路径不消费 followUp
   - `maxFollowUpRounds` 上限退出
   - `steer` 模式下 turn 内消息本轮生效；`followup` 模式下下一轮生效
5. **Channel ↔ Runner 的 in-turn 消息通路**（user-facing 闭环必备）：
   - `Channel` 接口加“in-turn 消息”事件
   - `RuntimeApp` 维护 per-turn 的 pending 队列（按 turnId 索引）
   - `runTurnInternal` 把 reader 闭包绑到这个队列上传给 Runner
   - Channel 收到消息时按当前 turn 锁定的 mode 入对应队列

   目前 Runner 层的 reader 接口是空架子，没有任何 channel 真正往里塞消息；
   完成本项后整个 steering / followUp 链路才算端到端打通。

---

## 9. 后续阶段

第一阶段（本设计落地）的已知限制与未覆盖能力，留待后续阶段处理：

| 能力 | 触发场景 | 实现方向 |
|------|---------|---------|
| 硬 steering（cancellation） | 用户输入“停下”需要立即生效，不等当前 LLM/tool 跑完 | AbortSignal 贯穿 LLM 调用与工具执行；工具协议加 cancellation |
| maxToolRounds 截断后的 pending 消息处理 | 截断退出时第一阶段直接结束 turn，pending 队列内容暂时保留在内存，下个 turn 才会被消费；崩溃即丢失 | 队列持久化 / 跨 turn 转移机制 |
| `auto` 模式 | 按消息语义自动判定 steer / followup（见 §5.2） | 稳定的意图识别 |
| 会话级 / 命令级 mode 覆盖 | 单 session 或单条消息临时切换注入策略 | 见 §4.3 优先级表 |
| 队列粒度 / 多消息批量到达策略 | 短时间内多条消息合并/排序/去重规则 | 单独细化 |

---

## 10. 为什么要单独文档

建议保留本独立文档，原因：

- Steering / FollowUp 涉及并发时序、队列策略和用户体验，复杂度高于普通 Runner 参数。
- 主文档（core-runner-design）应保持“主流程概览”，细节下沉可降低阅读成本。
- 后续扩展（auto 判定、按渠道策略、命令级覆盖）可在此文档持续演进，避免主文档膨胀。
