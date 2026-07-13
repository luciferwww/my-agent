# Channel 层变更说明（v0.9 → v1.0）

> 版本：v1.0
> 创建日期：2026-05-18
> 标准设计文档：[adapters-channel-design.md](./adapters-channel-design.md)
> v0.9 文档：[../adapters-channel-design.md](../adapters-channel-design.md)

本文档描述 channel 层从 v0.9 升级到 v1.0 的所有变更。仅作为升级参考；canonical 设计请看同目录 [adapters-channel-design.md](./adapters-channel-design.md)。

---

## 1. 变更速览

| 维度 | v0.9 | v1.0 |
|---|---|---|
| `ChannelRunRequest` 配额字段 | `maxToolRounds?: number` | `maxLlmCalls?: number` |
| RuntimeApp 入站处理 | `makeMessageHandler` 内立即生成 turnId 并直接 `runTurn()` | `makeMessageHandler` 委派给 `handleInboundChannelMessage`，由 runtime 入站层决定入队 / 路由 steering / 启动 turn |
| turnId 生成时机 | channel 入站时立刻 `randomUUID()` | 队列调度阶段 `startQueuedTurn` 才生成 |
| 起源路由元数据 | `originChannelByTurn: Map<turnId, Channel>` + `originClientByTurn: Map<turnId, string>` 两个并行 Map | 合并为 `routeContextByTurn: Map<turnId, MessageRouteContext>`，`MessageRouteContext = { originChannel?, originClientId? }` |
| 同 sessionKey 并发消息 | 直接拒绝（`RUN_REJECTED`） | 进入 per-session 队列按 FIFO 串行执行；channel 入站不再因 session busy 报错 |
| Steering 入口 | 不存在 | 新增；`inTurnMessageMode='steer'` 且存在活动 turn 时入站消息走 steering 路径 |
| `wireApprovalRouting` 触发条件 | `channels.some(c => c.approval)` | `channels.some(c => c.interaction \|\| c.approval)`——包含 interaction adapter |
| `AgentEvent.compaction_start` payload | `tokensBefore: number` | `estimatedTokens: number`（更准确地反映"开始时只是估算值"） |
| WebSocket `run_turn` 消息 | `maxToolRounds?: number` | `maxLlmCalls?: number` |
| Channel 设计文档 §9 "对其它模块的改动" | 含完整迁移指导（runner / runtime / hooks 等） | 移出标准设计文档；已落地的内容在 v1.0 各模块的 standalone 设计文档中 |

---

## 2. 协议层变更（破坏性）

### 2.1 `ChannelRunRequest`

```diff
 export interface ChannelRunRequest {
   sessionKey: string;
   message: string;
   model?: string;
   maxTokens?: number;
-  maxToolRounds?: number;
+  maxLlmCalls?: number;
   clientId?: string;
 }
```

**影响**：

- 所有实现 `Channel` 的代码，若读取了 `req.maxToolRounds`，需要改成 `req.maxLlmCalls`；
- 配额语义改变：`maxToolRounds` 数的是"tool use 内层循环轮次"，`maxLlmCalls` 数的是"实际发起的 LLM 调用次数"（包括没有 tool use 的轮次）。从 v0.9 升级需要按"一次 LLM 调用 = 一次计数"重新校准上限值，否则可能比预期更早终止 turn。

### 2.2 WebSocket 协议

```diff
 // Client → Server
 {
   type: 'run_turn';
   sessionKey: string;
   message: string;
   model?: string;
   maxTokens?: number;
-  maxToolRounds?: number;
+  maxLlmCalls?: number;
 }
```

WebSocket transport 验证逻辑同步更新：

```diff
-`maxTokens` / `maxToolRounds` 若存在必须是正整数
+`maxTokens` / `maxLlmCalls` 若存在必须是正整数
```

**影响**：

- 已部署的 client 若主动发送 `maxToolRounds`，会被 v1.0 server 忽略（多余字段不报错，但也不生效）；
- 推荐 client 同步升级字段名。

### 2.3 `AgentEvent.compaction_start`

```diff
 | {
     type: 'compaction_start';
     sessionKey: string;
     turnId: string;
     trigger: 'preemptive' | 'overflow' | 'manual';
-    tokensBefore: number;
+    estimatedTokens: number;
   }
```

**影响**：

- 所有订阅 `compaction_start` 的代码（含 CLI / WebSocket channel 的渲染逻辑）需要改用 `estimatedTokens`；
- 字段语义未变——压缩开始时本来就只能给估算值，重命名让契约更精准。

---

## 3. RuntimeApp 内部接线变更

### 3.1 入站处理改为委派

v0.9：

```typescript
private makeMessageHandler(channel: Channel) {
  return async (req: ChannelRunRequest) => {
    const turnId = randomUUID();
    this.originChannelByTurn.set(turnId, channel);
    if (req.clientId) this.originClientByTurn.set(turnId, req.clientId);

    try {
      await this.runTurn({
        sessionKey: req.sessionKey,
        message: req.message,
        model: req.model,
        maxTokens: req.maxTokens,
        maxToolRounds: req.maxToolRounds,
        turnId,
      });
    } finally {
      this.originChannelByTurn.delete(turnId);
      this.originClientByTurn.delete(turnId);
    }
  };
}
```

v1.0：

```typescript
private makeMessageHandler(channel: Channel) {
  return async (req: ChannelRunRequest) => {
    await this.handleInboundChannelMessage(channel, req);
  };
}
```

`handleInboundChannelMessage` 由 runtime 入站层接管，决定入队还是路由 steering。turnId 生成、`routeContextByTurn` 登记、`runTurn` 调用全部下沉到 `startQueuedTurn`。

完整入站调度流程见 [runtime-design.md §8](./runtime-design.md)。

### 3.2 起源路由 Map 合并

v0.9：

```typescript
private originChannelByTurn = new Map<string, Channel>();
private originClientByTurn = new Map<string, string>();

// hook 读取
originClientId: this.originClientByTurn.get(turnId),
// onRequest 读取
const originChannel = this.originChannelByTurn.get(request.turnId);
```

v1.0：

```typescript
private routeContextByTurn = new Map<string, MessageRouteContext>();

// hook 读取
originClientId: this.routeContextByTurn.get(turnId)?.originClientId,
// onRequest 读取
const originChannel = this.routeContextByTurn.get(request.turnId)?.originChannel;
```

`MessageRouteContext` 定义在 `src/runtime/queue-types.ts`：

```typescript
export type MessageRouteContext = {
  originChannel?: Channel;
  originClientId?: string;
};
```

**影响**：

- 实现自定义 RuntimeApp 子类或测试时 mock 内部字段的代码需要改名；
- channel 实现本身不受影响——这些 Map 是 RuntimeApp 内部状态，channel 不直接访问。

### 3.3 wireApprovalRouting 触发条件扩展

v0.9：

```typescript
if (!this.channels.some((c) => c.approval)) return;
```

v1.0：

```typescript
if (!this.channels.some((c) => c.interaction || c.approval)) return;
```

**影响**：

- 仅实现 `ChannelInteractionAdapter` 而不实现 `ChannelApprovalAdapter` 的 channel，在 v0.9 下 hook 不会注册（导致 interaction 收不到请求），v1.0 会正确注册。

---

## 4. 行为变更（非破坏性但影响显著）

### 4.1 同 sessionKey 并发消息处理

v0.9：channel 入站后直接 `runTurn()`，若 session 已 busy 会立即抛 `RUN_REJECTED`，channel 需要自行处理这种错误。

v1.0：入站消息进入 per-session 队列（`messageQueueBySession`），按 FIFO 串行执行。channel 入站调用永远不会因 session busy 而失败。

**对 channel 实现的影响**：

- 之前需要处理 `RUN_REJECTED` 错误的 channel 代码可以删除——v1.0 路径不会抛此错误（仅当库消费者直接调用 `runTurn()` 时仍可能命中）；
- `channel.onMessage` 的 handler `await` 时间可能变长——队列中前序消息执行期间会一直 await。

### 4.2 Steering 路径

v1.0 新增：`inTurnMessageMode='steer'` 配置下，busy 期间的入站消息进入 `steeringInboxBySession` 而非普通队列。channel 本身不感知这一区别——`handleInboundChannelMessage` 内部分流。

**对 channel 实现的影响**：

- 无——channel 仍然只调用 `onMessage` handler，runtime 决定怎么处理；
- 若 channel 想在 UI 上区分"steering 已收到"和"turn 已启动"，目前没有反馈通道；这是未来扩展点。

### 4.3 turnId 生成时机

v0.9：channel 入站时立即生成 turnId，写入 `originChannelByTurn` / `originClientByTurn`。

v1.0：消息先入队，`startQueuedTurn` 弹出队头时才生成 turnId 并写入 `routeContextByTurn`。

**对 channel 实现的影响**：

- 无——channel 不直接读取 turnId；它在入站时也读不到（入站时还没生成）；
- 间接好处：channel 在排队期间断开（v1.0 队列未来加上 TTL 时）可以直接丢弃队列项，不留 dangling turnId。

---

## 5. 文档结构变更

### 5.1 删除 §9 "对其它模块的改动"

v0.9 channel-design.md §9 包含约 350 行 "RuntimeApp / AgentRunner / hooks 需要怎么改" 的迁移指导。v1.0 这部分内容拆分到各 standalone 设计文档：

- RuntimeApp 改动 → [runtime-design.md](./runtime-design.md)
- AgentRunner / hooks 改动 → [core-runner-design.md](./core-runner-design.md)
- AgentEvent 富化（`sessionKey` / `turnId`）→ runtime / runner / channel 三份各自描述
- 测试 helper / 测试断言迁移 → 不再保留为文档（属于 v0.9 升级期事项，已完成）

v1.0 channel-design.md 只保留 channel 视角看到的 RuntimeApp 公开 API（[§8](./adapters-channel-design.md#8-runtimeapp-接入面)），不再描述 RuntimeApp 内部实现。

### 5.2 删除 "Phase 1 / Phase 2" 框架

v0.9 用 "Phase 1（已实现）/ Phase 2（预留）" 描述能力边界。v1.0 改为：

- 已实现的内容直接以现在时态写入正文；
- 未实现的内容统一归到 §11 "已知未实现 / 规划项"。

具体映射：

| v0.9 段落 | v1.0 处理 |
|---|---|
| §1 "Phase 1 范围" / "不在 Phase 1 范围内" | 散入 §1 "概述与目标" / 引入 v1.0 的"不属于本层的职责" |
| §11 "Phase 2 预留" | 改名 §11 "已知未实现 / 规划项"，新增 `select` interaction、pending interactions 重投递两项 |

---

## 6. 升级 checklist

如果你在 v0.9 之上有自定义代码，按下列顺序检查：

1. **`ChannelRunRequest`**：将 `maxToolRounds` 改名为 `maxLlmCalls`，按新语义校准上限值（"LLM 调用数" vs "tool 轮次"）；
2. **WebSocket client**：同步把 `run_turn` 消息中的 `maxToolRounds` 改名 `maxLlmCalls`；
3. **`AgentEvent.compaction_start` 消费方**：把 `event.tokensBefore` 改成 `event.estimatedTokens`；
4. **`RUN_REJECTED` 错误处理**：channel 入站路径不再抛此错误，相关 fallback 代码可清理；
5. **自定义 RuntimeApp 子类 / mock**：`originChannelByTurn` + `originClientByTurn` → `routeContextByTurn`；
6. **新实现的 `ChannelInteractionAdapter`**：v0.9 在仅实现 interaction 不实现 approval 时 hook 不注册，v1.0 正常注册——若 channel 之前依赖这个 "未注册即跳过" 的行为做开关，需要显式拆掉。

---

## 7. 不变的部分

以下接口、行为在 v0.9 与 v1.0 之间保持一致，无需迁移：

- `Channel` / `ChannelInteractionAdapter` / `ChannelApprovalAdapter` 接口签名；
- `TurnInteractionManager` 公开 API（`request` / `resolve` / `onRequest` / `onExpire` / `close`）；
- `ApprovalRequest` / `ApprovalResult` / `ApprovalDecision` 类型；
- `TurnInteractionRequest` / `TurnInteractionResponse` 类型；
- WebSocket 出站消息形状（除 `compaction_start.estimatedTokens` 的字段名外）；
- `RuntimeApp.registerChannel` / `startChannels` / `stopChannels` 公开方法签名；
- CliChannel / WebSocketChannel 各自的 `send` 渲染规则与广播策略。
