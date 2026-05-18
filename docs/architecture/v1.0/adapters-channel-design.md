# Channel 层设计文档

> 版本：v1.0
> 创建日期：2026-05-18
> 关联：
> - [runtime-design.md](./runtime-design.md)
> - [core-runner-design.md](./core-runner-design.md)
> - [core-runner-message-flow.md](./core-runner-message-flow.md)
> - [../adapters-websocket-channel-design.md](../adapters-websocket-channel-design.md)（WebSocket transport 细节）
> - [../core-runner-hooks-design.md](../core-runner-hooks-design.md)

---

## 1. 概述与目标

Channel 层是 my-agent 的 I/O 适配层，把"agent 内部运行"和"外部输入输出"（终端、WebSocket 客户端、未来的 HTTP / IDE 等）之间的边界统一起来。

它解决的问题：

- `RuntimeApp` 自身只暴露进程内的 `runTurn()` 接口，无法支持 CLI、WebSocket、HTTP 等多种 I/O；
- tool approval 需要 hook 等待外部决策，但纯 hook 机制没有把决策传回的通道；
- 单 session 多 client 场景（如多个 WebSocket 连接订阅同一 session）需要明确的广播 / 定向路由策略。

Channel 层做的事情：

- 定义统一 I/O 适配接口 `Channel`；
- 提供 `TurnInteractionManager`——进程内 Promise bus，把 runner 端的 `before_tool_call` hook 与 channel 端的 interaction / approval adapter 桥接起来；
- 提供两个内置实现：`CliChannel`（readline）与 `WebSocketChannel`（ws server）。

不属于本层的职责：

- 入站消息的队列调度、per-session 串行——属于 `runtime`（详见 [runtime-design.md §8](./runtime-design.md)）；
- in-turn steering / followup 消息的路由策略——属于 `runtime` + `core/runner`（详见 [core-runner-message-flow.md](./core-runner-message-flow.md)）；
- channel 鉴权、多租户、外部平台接入（Slack / Discord 等）。

---

## 2. 设计原则

| 原则 | 说明 |
|---|---|
| channel 只负责 I/O | 业务逻辑留在 RuntimeApp / AgentRunner，channel 不感知 agent 内部 |
| 接口尽量薄 | 只抽象 my-agent 实际需要的边界，不复制多余的 adapter 种类 |
| 统一消息形状 | CLI 与 WebSocket 共享同一份 `ChannelRunRequest` 结构，channel 差异只在传输层 |
| 可选 interaction / approval | 不实现 `interaction` / `approval` 的 channel 仍能正常工作，只是没有审批能力 |
| 起源路由，不广播 | approval / interaction 严格按 turnId 反查起源 channel 与 client，不在 channel 间广播 |
| 事件自描述 | `AgentEvent` 自带 `sessionKey` / `turnId`，channel 直接读取自路由，不依赖外部上下文 |

---

## 3. 架构总览

### 3.1 组件分工

```
┌──────────────────────────────────────────────────────────────────────┐
│                           RuntimeApp                                  │
│                                                                       │
│  ┌──────────────────┐       ┌─────────────────────────────────────┐  │
│  │   AgentRunner    │       │       TurnInteractionManager         │  │
│  │                  │─hook─▶│         (Promise bus)                │  │
│  │  AgentEvent ─────┼──┐    │  pending: Map<id, PendingEntry>      │  │
│  └──────────────────┘  │    └─────────────────┬───────────────────┘  │
│                        │                      │ Interaction request  │
│  ┌─────────────────────▼──────────────────────▼─────────────────┐    │
│  │  routeContextByTurn: Map<turnId, MessageRouteContext>          │    │
│  │                                                                │    │
│  │  fanout(event) ─▶ for each channel: channel.send(event)        │    │
│  │  onMessage ◀── channel.onMessage(handler)                      │    │
│  └────────────────────────────┬───────────────────────────────────┘    │
└───────────────────────────────┼───────────────────────────────────────┘
                                │  Channel 接口
                  ┌─────────────┴────────────────┐
                  │                              │
       ┌──────────▼──────────┐    ┌─────────────▼──────────────────┐
       │     CliChannel      │    │       WebSocketChannel          │
       │                     │    │                                 │
       │  send(event):       │    │  sessions: Map<sk,Set<clientId>>│
       │    渲染到 stdout    │    │  clients : Map<clientId, WS>    │
       │  onMessage:         │    │  send(event):                   │
       │    readline 逐行    │    │    按 sessions[sk] 广播         │
       │                     │    │  approval / interaction:        │
       │  approval (可选):   │    │    按 originClientId 定向       │
       │    阻塞式 y/n        │    │                                 │
       └─────────────────────┘    └─────────────────────────────────┘
```

| 组件 | 职责 |
|---|---|
| `Channel` | I/O 适配接口（收发消息 + 生命周期 + 可选的 interaction / approval 能力） |
| `ChannelInteractionAdapter` | 通用 turn 交互能力（请求、过期、响应） |
| `ChannelApprovalAdapter` | 审批专用兼容接口 |
| `TurnInteractionManager` | 进程内 Promise bus，连接 `before_tool_call` hook 与 channel adapter |

### 3.2 跨模块数据流

Channel 层与 `RuntimeApp` / `AgentRunner` / hook 系统的交互分三条独立的数据流。

#### ① 入站数据流（client → agent）

```
WebSocket client / CLI input
   │ hello(clientId) 绑定逻辑客户端身份（仅 WS）
   │ run_turn 消息
   ▼
Channel.onMessage(handler)
   │ ChannelRunRequest { sessionKey, message, clientId?, model?, maxTokens?, maxLlmCalls? }
   ▼
RuntimeApp.makeMessageHandler 内的 handler:
   └─ handleInboundChannelMessage(channel, req)
        ├─ 命中 steering → 追加进 steeringInboxBySession（不启动 turn）
        └─ 普通入站 → enqueueQueuedTurn → scheduleNextQueuedTurn
                          ↓
                  startQueuedTurn:
                    ├─ turnId = randomUUID()
                    ├─ routeContextByTurn.set(turnId, { originChannel, originClientId })
                    └─ runTurn({...})
                          ↓
                    runTurnInternal → AgentRunner.run({ turnId, sessionKey, ... })
```

要点：

- **turnId 在 `startQueuedTurn` 才生成**——排队阶段不占用 turn 级资源；
- **clientId 不进 `RunTurnParams`**——封装在 `MessageRouteContext` 里，library API 不感知 transport 概念；
- **入站统一过 runtime intake**——channel 永远不会绕过队列直接启动 turn。

runtime 侧入站调度的完整流程详见 [runtime-design.md §8](./runtime-design.md)。

#### ② 出站数据流（agent → client）

```
AgentRunner 触发 AgentEvent（自带 sessionKey + turnId）
   │
   ▼
RuntimeApp.create() 时注入的 fanout 闭包:
   ├─ 遍历 channels[] 调 channel.send(event)
   └─ userObserver?.(event)    ← RuntimeAppOptions.onAgentEvent
   ▼
Channel.send 实现:
   ├─ CliChannel: 单客户端，忽略 sessionKey，渲染到 stdout
   └─ WebSocketChannel:
        ├─ 查 sessions[event.sessionKey] = Set<clientId>
        └─ 广播 JSON 给该集合内所有连接
```

要点：

- **事件自描述**：每个 AgentEvent 自带 `sessionKey` / `turnId`，channel 直接读取自路由，无需查表；
- **fanout 闭包共享 `channels[]` 引用**：`registerChannel` 后注册的新 channel 也能即时收到事件；
- **`channel.send` 抛错被吞为 warning log**：单个 channel 故障不中断事件分发。

#### ③ Approval / Interaction 数据流（hook ↔ channel）

```
AgentRunner 调用 tool 前
   │ before_tool_call hook
   ▼
Hook payload: { toolName, input, turnId, sessionKey }
   │
   ▼
RuntimeApp 注册的 hook handler:
   ├─ originClientId = routeContextByTurn.get(turnId)?.originClientId
   └─ turnInteractionManager.request({ toolName, input, sessionKey, turnId, originClientId })
        │ 阻塞等待 Promise
        ├─ 生成 id，写入 pending Map
        └─ 触发 onRequest 回调
              ▼
        RuntimeApp.onRequest handler:
              ├─ originChannel = routeContextByTurn.get(turnId)?.originChannel
              ├─ if (originChannel.interaction) → sendInteractionRequest(kind='approval')
              └─ else if (originChannel.approval) → sendApprovalRequest

   ┌─ 正常路径 ────────────────────────────────────────┐
   │ 用户做出决策                                       │
   │      ▼                                             │
   │ Channel.interaction?.onInteractionResponse        │
   │  或 Channel.approval?.onApprovalDecision           │
   │      ▼                                             │
   │ TurnInteractionManager.resolve(id, decision)       │
   │      ▼                                             │
   │ Promise resolve → ApprovalResult                   │
   │   { decision: 'allow' \| 'deny', reason:'user' }   │
   └────────────────────────────────────────────────────┘

   ┌─ 超时路径 ────────────────────────────────────────┐
   │ TurnInteractionManager 内部 timer 触发 expire(id)  │
   │      ├─ Promise resolve → { decision:'deny',       │
   │      │                      reason:'timeout' }     │
   │      └─ 触发 onExpire 回调                         │
   │              ▼                                     │
   │      RuntimeApp.onExpire handler:                  │
   │           按起源 channel 调 sendInteractionExpired │
   │           / sendApprovalExpired → 通知 client      │
   │           关闭审批 UI                              │
   └────────────────────────────────────────────────────┘
   ▼
Hook handler 根据 ApprovalResult 返回:
   - allow → AgentRunner 继续执行 tool
   - deny  → AgentRunner 跳过 tool，reason 写入对话
```

### 3.3 关键不变量

| 不变量 | 说明 |
|---|---|
| `clientId` 不进 `RunTurnParams` | channel↔RuntimeApp 路由信息，AgentRunner 不感知 |
| `turnId` 流贯三条数据流 | startQueuedTurn 生成 → hook payload → approval 反查 routeContext |
| `sessionKey` 是事件路由的 key | 出站事件按 sessionKey 找 client 集合 |
| `originClientId` 仅 interaction / approval 路径使用 | 普通 AgentEvent 走广播，interaction 走定向 |
| `routeContext` 只挂在 turn 上 | 不挂在 session 上——同 session 多 client 时每个 turn 独立 |

---

## 4. 类型定义

位置：`src/adapters/channel/types.ts`。

### 4.1 入站消息

```typescript
import type { AgentEvent } from '../../core/runner/types.js';

/** Channel 发给 RuntimeApp 的运行请求 */
export interface ChannelRunRequest {
  sessionKey: string;
  message: string;
  model?: string;
  maxTokens?: number;
  maxLlmCalls?: number;
  /** 发起本次请求的逻辑客户端标识；WebSocketChannel 从握手消息中读取并透传 */
  clientId?: string;
}
```

`ChannelRunRequest` 是 channel 与 RuntimeApp 之间唯一的入站契约。`maxLlmCalls` / `maxTokens` / `model` 可选——若 channel 不显式覆盖，由 RuntimeApp 使用 resolved config 默认值。

### 4.2 通用 turn 交互

```typescript
export type TurnInteractionKind = 'approval' | 'select';

export interface TurnInteractionOption {
  value: string;
  label: string;
  description?: string;
  disabled?: boolean;
}

interface TurnInteractionRequestBase<K extends TurnInteractionKind> {
  id: string;
  kind: K;
  sessionKey: string;
  /** 发起本次 turn 的 turnId，由 RuntimeApp 路由到起源 channel */
  turnId: string;
  /** WebSocketChannel 用此字段定向路由，CliChannel 可忽略 */
  originClientId?: string;
  timeoutMs?: number;
}

export interface ApprovalInteractionRequest
  extends TurnInteractionRequestBase<'approval'> {
  toolName: string;
  input: Record<string, unknown>;
}

export interface SelectInteractionRequest
  extends TurnInteractionRequestBase<'select'> {
  title?: string;
  message?: string;
  options: TurnInteractionOption[];
  initialValue?: string;
}

export type TurnInteractionRequest =
  | ApprovalInteractionRequest
  | SelectInteractionRequest;

export type TurnInteractionOutcome =
  | 'submitted'
  | 'cancelled'
  | 'expired'
  | 'aborted';

interface TurnInteractionResponseBase<K extends TurnInteractionKind> {
  id: string;
  kind: K;
  outcome: TurnInteractionOutcome;
}

export type ApprovalInteractionResponse =
  | (TurnInteractionResponseBase<'approval'> & { outcome: 'submitted'; decision: ApprovalDecision })
  | (TurnInteractionResponseBase<'approval'> & { outcome: 'cancelled' | 'expired' | 'aborted' });

export type SelectInteractionResponse =
  | (TurnInteractionResponseBase<'select'> & { outcome: 'submitted'; value: string })
  | (TurnInteractionResponseBase<'select'> & { outcome: 'cancelled' | 'expired' | 'aborted' });

export type TurnInteractionResponse =
  | ApprovalInteractionResponse
  | SelectInteractionResponse;
```

设计要点：

- `kind` discriminator 让未来扩展新的交互形态（如 `'input'`、`'confirm'`）只需新增 variant，不破坏现有处理；
- `outcome` 区分用户提交、主动取消、超时、abort 四种结束方式——比单一 boolean 更能表达失败原因；
- `select` 已在类型层定义但当前没有任何 channel 实现真正消费，留作未来扩展。

### 4.3 审批兼容接口

```typescript
export interface ApprovalRequest {
  id: string;
  toolName: string;
  input: Record<string, unknown>;
  sessionKey: string;
  turnId: string;
  originClientId?: string;
  timeoutMs?: number;
}

export type ApprovalDecision = 'allow' | 'deny';

/** 审批结果。拒绝时携带原因以便上层区分用户行为与超时 */
export type ApprovalResult =
  | { decision: 'allow' }
  | { decision: 'deny'; reason: 'user' | 'timeout' };
```

`ApprovalRequest` / `ApprovalResult` 是早期专用的审批 API。`ChannelInteractionAdapter` 出现后，`approval` 形式上可看作 `interaction` 的特例（`kind='approval'`）。两套 API 并存：

- 老 channel 实现 `ChannelApprovalAdapter` 仍能跑；
- 新 channel 优先实现 `ChannelInteractionAdapter`；
- 若 channel 同时实现两者，RuntimeApp 路由优先走 `interaction`。

### 4.4 Channel 接口

```typescript
/**
 * channel 适配器接口。
 *
 * 实现此接口即可将任意 I/O 方式接入 RuntimeApp。
 * `interaction` 与 `approval` 都是可选能力。
 */
export interface Channel {
  /** 唯一标识符，用于日志 */
  id: string;

  /**
   * RuntimeApp 推送 agent 事件流给 channel。
   * `event.sessionKey` 携带路由上下文：channel 将 event 发给当前登记为该 session 广播受众的客户端。
   * 单客户端实现（如 CliChannel）可忽略 sessionKey。
   */
  send(event: AgentEvent): void;

  /** channel 注册入站消息处理器（由 RuntimeApp 在 registerChannel 时调用） */
  onMessage(handler: (req: ChannelRunRequest) => Promise<void>): void;

  /** 启动 channel（建立连接、开始监听） */
  start(): Promise<void>;

  /** 停止 channel（断开连接、释放资源） */
  stop(): Promise<void>;

  /** 通用 turn 交互能力（可选） */
  interaction?: ChannelInteractionAdapter;

  /** 审批交互能力（可选，兼容接口） */
  approval?: ChannelApprovalAdapter;
}

export interface ChannelInteractionAdapter {
  /** RuntimeApp 推送交互请求给 channel（channel 负责呈现给用户） */
  sendInteractionRequest(request: TurnInteractionRequest): void;

  /** RuntimeApp 推送交互结束/过期通知给 channel（channel 负责关闭对应 UI） */
  sendInteractionExpired(request: TurnInteractionRequest): void;

  /** channel 注册交互响应处理器（由 RuntimeApp 在 registerChannel 时调用） */
  onInteractionResponse(handler: (response: TurnInteractionResponse) => void): void;
}

export interface ChannelApprovalAdapter {
  /** RuntimeApp 推送审批请求给 channel */
  sendApprovalRequest(request: ApprovalRequest): void;

  /** RuntimeApp 推送超时通知给 channel */
  sendApprovalExpired(request: ApprovalRequest): void;

  /** channel 注册审批决策处理器 */
  onApprovalDecision(handler: (id: string, decision: ApprovalDecision) => void): void;
}
```

---

## 5. TurnInteractionManager

位置：`src/adapters/channel/TurnInteractionManager.ts`。进程内 Promise bus，统一管理 turn 内阻塞式交互。当前实现仍只落地 approval，但 RuntimeApp 与 channel 层的路由边界已经提升到更一般的 interaction 语义。

### 5.1 公开 API

```typescript
export interface TurnInteractionManagerConfig {
  /** 默认超时（毫秒），超时后按 deny 处理；默认 120_000 */
  defaultTimeoutMs?: number;
}

export class TurnInteractionManager {
  constructor(config?: TurnInteractionManagerConfig);

  /** Hook 调用：阻塞等待 channel 决策；超时按 deny 处理 */
  request(params: Omit<ApprovalRequest, 'id'>): Promise<ApprovalResult>;

  /** Channel 决策：唤醒等待中的 request Promise */
  resolve(id: string, decision: ApprovalDecision): void;

  /** RuntimeApp 注册：request 创建时回调（RuntimeApp 在此把请求转发给起源 channel） */
  onRequest(handler: (request: ApprovalRequest) => void): void;

  /** RuntimeApp 注册：request 超时时回调（RuntimeApp 在此通知起源 channel 关闭 UI） */
  onExpire(handler: (request: ApprovalRequest) => void): void;

  /** 关闭：拒绝所有 pending 请求 */
  close(): void;
}
```

### 5.2 内部结构

```typescript
type PendingEntry = {
  resolve: (result: ApprovalResult) => void;
  timer: NodeJS.Timeout;
  request: ApprovalRequest;
};

private pending = new Map<string, PendingEntry>();
private requestHandler?: (request: ApprovalRequest) => void;
private expireHandler?: (request: ApprovalRequest) => void;
```

`request()` 流程：

1. 生成 `id`（UUID）；
2. 创建 timer（按 `timeoutMs` 或默认 `defaultTimeoutMs`）；
3. 写入 `pending`；
4. 同步触发 `requestHandler` 让 RuntimeApp 路由请求；
5. 返回 Promise，等 `resolve` 或 timer 触发。

### 5.3 与 hook 和 channel 的连接

三者由 RuntimeApp 串联。完整接线伪代码：

```typescript
// 启动时一次性接线（wireApprovalRouting）
this.agentRunner.on('before_tool_call', async ({ toolName, input, turnId, sessionKey }) => {
  const result = await this.turnInteractionManager.request({
    toolName,
    input,
    sessionKey,
    turnId,
    originClientId: this.routeContextByTurn.get(turnId)?.originClientId,
  });
  return result.decision === 'allow'
    ? { action: 'allow' }
    : { action: 'deny', reason: result.reason === 'timeout' ? 'Denied by timeout' : 'Denied by user' };
});

this.turnInteractionManager.onRequest((request) => {
  const originChannel = this.routeContextByTurn.get(request.turnId)?.originChannel;
  if (!originChannel) return;
  if (originChannel.interaction) {
    originChannel.interaction.sendInteractionRequest({ ...request, kind: 'approval' });
    return;
  }
  originChannel.approval?.sendApprovalRequest(request);
});

this.turnInteractionManager.onExpire((request) => {
  const originChannel = this.routeContextByTurn.get(request.turnId)?.originChannel;
  if (!originChannel) return;
  if (originChannel.interaction) {
    originChannel.interaction.sendInteractionExpired({ ...request, kind: 'approval' });
    return;
  }
  originChannel.approval?.sendApprovalExpired(request);
});

// registerChannel 时按 channel 绑定响应回执
registerChannel(channel: Channel): void {
  this.channels.push(channel);
  channel.onMessage(this.makeMessageHandler(channel));
  channel.interaction?.onInteractionResponse((response) => {
    this.handleInteractionResponse(response);
  });
  channel.approval?.onApprovalDecision((id, decision) => {
    this.turnInteractionManager.resolve(id, decision);
  });
}
```

### 5.4 关键路由规则

| 规则 | 说明 |
|---|---|
| 起源路由，不广播 | `onRequest` / `onExpire` 按 turnId 查 `routeContextByTurn` 找 originChannel，只通知它 |
| interaction 优先于 approval | 若 channel 同时实现两者，路由走 `interaction` |
| 起源不可达不主动 deny | `onRequest` / `onExpire` 查不到 originChannel 时直接 return，让 TurnInteractionManager 走超时收口（便于诊断） |
| 库模式自动放行 | `wireApprovalRouting` 启动时若 `channels.some(c => c.interaction \|\| c.approval)` 为 false，**根本不注册 hook**，所有 tool 调用直通 |
| `routeContext` 按 turn 而非 session 跟踪 | 多个 client 共享同一 session 时，每个 turn 仍是独立交互边界，不会并发覆盖 |

---

## 6. CliChannel

位置：`src/adapters/channel/CliChannel.ts`。

### 6.1 配置与结构

```typescript
export interface CliChannelConfig {
  input?: NodeJS.ReadableStream;    // 默认 process.stdin
  output?: NodeJS.WritableStream;   // 默认 process.stdout
  prompt?: string;                  // 默认 '> '
  /** 启用审批交互；启用时收到审批请求会阻塞 readline 等待 y/n */
  approval?: boolean;               // 默认 false
}

export class CliChannel implements Channel {
  readonly id = 'cli';
  readonly interaction?: ChannelInteractionAdapter;
  readonly approval?: ChannelApprovalAdapter;

  constructor(config?: CliChannelConfig);

  send(event: AgentEvent): void;
  onMessage(handler: (req: ChannelRunRequest) => Promise<void>): void;
  start(): Promise<void>;
  stop(): Promise<void>;
}
```

### 6.2 send 实现

| AgentEvent | CLI 输出 |
|---|---|
| `text_delta` | `process.stdout.write(event.text)` |
| `tool_use` | `dim("[tool: name]\n")` |
| `tool_result` | `[tool result]` / `[tool error]` 标签 + 多行预览（见 §6.2.1） |
| `compaction_start` | `yellow("[compacting… trigger=X]\n")` |
| `compaction_end` | `yellow("[compacted: X → Y tokens]\n")` |
| `error` | 仅 `breakStream()`，**不打印**——避免与 §6.3 的 catch 输出重复 |
| `run_end` | 换行（如果正在流式输出） |

未列出的事件类型（`run_start` / `llm_call` / `tool_result_pruned`）默认忽略，不输出到 CLI。

**关于 `error` 的处理**：AgentRunner 在错误时既 emit 又 throw，让 channel 自由选择呈现路径。CliChannel 选择**只在 catch 路径打印**，避免双行；WebSocketChannel 等其他实现可以选择推送 `error` 事件给 client。

#### 6.2.1 tool_result 预览渲染

这是 CliChannel 的渲染选择，**不是 Channel 层通用行为**。其他 channel 实现各自决定如何呈现 tool result——例如 WebSocketChannel 直接转发完整 `result.content` 给前端，由前端按需折叠 / 分页 / 高亮。

CliChannel 做截断的原因是终端约束：长输出会刷屏挤掉 prompt 和后续 LLM 文本。LLM 仍通过 tool executor 收到完整内容，截断只影响 CLI 显示。

**预算**：

- 总行数 ≤ 16 行（10 head + 6 tail）；
- 单行字符上限 200，超出末尾追加 `…`；
- 10:6 偏向 head 的设计：CLI 工具输出（`list_dir` / `read_file` / 命令回显）通常前部信息密度高，tail 主要保留错误堆栈和 summary。

**预处理**：

1. 去掉尾部空行；
2. 连续空行（含纯空白行）折叠为 1 行——保留段落分隔感，避免空行吃掉行预算；
3. 非空行原样保留（不 trim 缩进）。

**输出格式**：

- 总行数 ≤ 16 → 全显示；
- 超过 → head + `... [N lines omitted]` + tail；
- 单行结果（含截断后）→ 内联 `[tool result] xxx`；
- 多行结果 → 标签独占一行，正文各行缩进 2 空格。

**实现位置**：`formatToolResultPreview()` / `collapseEmptyLines()` / `truncateLine()` 都是模块级纯函数，便于单元测试。

### 6.3 onMessage 实现

readline 逐行读取。`/exit`、`/clear` 等命令由调用方在 handler 外处理，不属于 channel 内部职责。普通输入构造 `ChannelRunRequest` 推给 handler，等待 handler 完成后再发下一个 prompt。

**handler 抛错的处理**：handler 调用（即 RuntimeApp 的入站处理链路）若抛出错误，CliChannel 在 readline 循环内 try/catch 捕获，以 `red("[error] ...\n")` 输出（与 §6.2 表格里的 `error` 事件输出风格一致），然后继续下一轮 prompt 不退出。

注意这与 AgentEvent 中的 `error` 是两条互补路径：

- AgentEvent `error` 是 runner 内部 emit 的可恢复事件流；
- handler 抛错是同步异常。

**stop() 与 readline 中断**：

- 内部维护 `stopped: boolean` 标记；
- `stop()` 设置 `stopped = true`，调用 `rl.close()`；
- 正在 `rl.question()` 阻塞时，`rl.close()` 会让该 Promise reject（`ERR_USE_AFTER_CLOSE`），循环捕获后退出；
- `start()` 主循环每轮读 prompt 前先检查 `stopped`，已停止则直接 return；
- 多次调用 `stop()` 幂等。

### 6.4 interaction / approval（可选）

`config.approval = true` 时同时构造：

- `ChannelInteractionAdapter`：统一接收交互请求与过期通知；
- `ChannelApprovalAdapter`：保留作为兼容接口。

但 CliChannel 目前真正支持的交互种类仍只有 `approval`：

- `sendInteractionRequest` / `sendApprovalRequest` 最终都落成同一个 readline `y/n` prompt；
- `sendInteractionExpired` / `sendApprovalExpired` 都会把该 approval 标记为超时；
- 用户提交后优先走 `interactionResponseHandler`；若未配置再兼容回退到 `approvalDecisionHandler`。

---

## 7. WebSocketChannel

位置：`src/adapters/channel/WebSocketChannel.ts`。本节只列协议总览与 channel 内部关键结构；transport 层细节（连接建立 / 重连 / 多 client 时序图）见 [adapters-websocket-channel-design.md](../adapters-websocket-channel-design.md)。

### 7.1 WS 消息协议

所有消息均为 JSON，`type` 字段使用 snake_case，与 `AgentEvent` 保持一致。

**Client → Server（入站）**：

```typescript
/** 连接建立后的第一条协议消息，用于绑定逻辑客户端身份 */
{ type: 'hello'; clientId: string }

/** 发起 turn */
{
  type: 'run_turn';
  sessionKey: string;
  message: string;
  model?: string;
  maxTokens?: number;
  maxLlmCalls?: number;
}

/** 提交审批决策 */
{ type: 'approval_resolve'; id: string; decision: 'allow' | 'deny' }
```

**Server → Client（出站）**：

```typescript
/** 握手确认；表示当前连接已绑定逻辑 clientId */
{ type: 'hello_ack'; clientId: string }

/** 直接转发 AgentEvent（type 字段与 AgentEvent 完全一致，事件自带 sessionKey + turnId） */
{ type: 'text_delta'; sessionKey; turnId; text }
{ type: 'tool_use'; sessionKey; turnId; name; input }
{ type: 'tool_result'; sessionKey; turnId; name; result }
{ type: 'llm_call'; sessionKey; turnId; round }
{ type: 'run_end'; sessionKey; turnId; result }
{ type: 'error'; sessionKey; turnId; error }
{ type: 'tool_result_pruned'; sessionKey; turnId; toolUseId; originalChars; prunedChars }
{ type: 'compaction_start'; sessionKey; turnId; trigger; estimatedTokens }
{ type: 'compaction_end'; sessionKey; turnId; tokensBefore; tokensAfter; droppedMessages }

/** 审批请求（由 TurnInteractionManager 触发） */
{ type: 'approval_requested'; id; toolName; input; timeoutMs? }

/** 审批超时（由 TurnInteractionManager 超时后触发，通知 client 关闭审批 UI） */
{ type: 'approval_expired'; id }
```

### 7.2 广播 vs 定向

| 消息 | 路由策略 |
|---|---|
| `text_delta` / `tool_use` / `tool_result` / `llm_call` / `run_end` | 广播给同 session 的所有已连接客户端 |
| `tool_result_pruned` / `compaction_*` | 同上 |
| `error` | 广播给同 session 的所有已连接客户端 |
| `approval_requested` | 起源 channel 是 WebSocketChannel 时才会收到此请求；channel 内部按 `originClientId` 定向给该 client |
| `approval_expired` | 同上，定向发给 `originClientId` |
| `approval_resolve`（入站） | 单次有效，TurnInteractionManager 自动忽略重复提交 |

### 7.3 配置

```typescript
export interface WebSocketChannelConfig {
  port: number;
  host?: string;        // 默认 '127.0.0.1'
  path?: string;        // 默认 '/ws'
  maxClients?: number;  // 默认不限
  /** 启用审批交互；内部同时打开 interaction/approval 双轨兼容 */
  approval?: boolean;   // 默认 false
}

export class WebSocketChannel implements Channel {
  readonly id = 'websocket';
  readonly interaction?: ChannelInteractionAdapter;
  readonly approval?: ChannelApprovalAdapter;

  constructor(config: WebSocketChannelConfig);

  send(event: AgentEvent): void;
  onMessage(handler: (req: ChannelRunRequest) => Promise<void>): void;
  start(): Promise<void>;
  stop(): Promise<void>;
}
```

### 7.4 内部状态

客户端首次启动时自行生成并持久化 `clientId`，建连后通过 `hello` 消息提交。`clientId` 直接作为 my-agent 内部使用的逻辑客户端标识。

WebSocketChannel 不引入独立的 `connectionId` 设计概念；当前活跃连接直接由 websocket 对象引用承载，连接自身绑定的 `clientId` 通过 socket 关联上下文维护。channel 内部维护两张核心映射表：

- `Map<sessionKey, Set<clientId>>`：session 到客户端集合，`send(event)` 按 `event.sessionKey` 广播；
- `Map<clientId, WebSocket>`：clientId 到连接，用于 approval 定向发送。

客户端完成 `hello(clientId)` 后，该逻辑客户端与当前 websocket 连接绑定。之后客户端发送 `run_turn` 时，channel 将该 `clientId` 写入 `ChannelRunRequest`，同时把该 clientId 注册进 sessionKey 对应的集合。

**重复连接**：若同一 `clientId` 后续重新连接，服务端采用"后连覆盖前连"策略，将逻辑客户端重新绑定到新连接，并立即主动关闭旧连接。

**断线清理**：连接断开时，WebSocketChannel 会立即清理自身维护的 transport 路由状态。若未来上层补上按 `clientId` 管理的 pending interactions 重投递钩子，可在新的 `hello(clientId)` 成功后再次下发交互；这属于上层交互管理，不属于 websocket transport 恢复。

关键时序图见 [adapters-websocket-channel-design.md](../adapters-websocket-channel-design.md)。

---

## 8. RuntimeApp 接入面

本节只列 channel 视角看到的 RuntimeApp 公开 API；RuntimeApp 内部的入站调度、队列、生命周期管理见 [runtime-design.md](./runtime-design.md)。

### 8.1 公开方法

```typescript
class RuntimeApp {
  /**
   * 注册 channel；可多次调用注册多个 channel。
   * 必须在 startChannels() 前调用。
   */
  registerChannel(channel: Channel): void;

  /**
   * 启动所有已注册 channel；先调内部 wireApprovalRouting() 再并行 channel.start()。
   */
  startChannels(): Promise<void>;

  /**
   * 停止所有 channel；幂等。close() 内部会自动调用。
   */
  stopChannels(): Promise<void>;
}
```

`startChannels()` 用 `Promise.all` 并行启动——`CliChannel.start()` 是阻塞的（readline 循环），不能让它阻塞其它 channel 的启动。

### 8.2 使用示例

```typescript
// CLI 模式
const app = await RuntimeApp.create({ workspaceDir });
const cli = new CliChannel({ prompt: '> ' });
app.registerChannel(cli);
await app.startChannels();   // 进入 readline 循环，阻塞直到 stop()

// WebSocket 模式
const app = await RuntimeApp.create({ workspaceDir });
const ws = new WebSocketChannel({ port: 3000 });
app.registerChannel(ws);
await app.startChannels();   // 启动 WS Server，非阻塞

// 带审批的 CLI
const cli = new CliChannel({ approval: true });
app.registerChannel(cli);
await app.startChannels();

// CLI + WS 同时（调试场景）
app.registerChannel(new CliChannel());
app.registerChannel(new WebSocketChannel({ port: 3000 }));
await app.startChannels();
```

### 8.3 与 runTurn() 的关系

`runTurn()` 仍可直接调用（库模式）。`registerChannel()` 只是在 channel 收到消息时，RuntimeApp 内部的入站调度层最终也会调到 `runTurn()`，两者不冲突。

直接调用 `runTurn()` 的库消费者：

- **不会**经过入站队列调度——`runTurn()` 是同步入口；
- **没有** `routeContext`——approval 路由会因起源不可达而走超时；
- 需要自己处理 per-session 并发（同 sessionKey 重入会抛 `RUN_REJECTED`）。

如果库消费者想用 channel 的入站调度但不暴露 I/O，可以实现一个最小的内存 channel（用 EventEmitter 替代 readline / WS）。

---

## 9. 文件结构

```
src/adapters/channel/
├── types.ts                  # Channel / ChannelInteractionAdapter / ChannelApprovalAdapter
│                             # TurnInteractionRequest/Response / ApprovalRequest/Result
├── TurnInteractionManager.ts # Promise bus
├── CliChannel.ts             # readline 实现
├── WebSocketChannel.ts       # ws server 实现
└── index.ts                  # 导出
```

---

## 10. 设计决策记录

| 问题 | 决策 | 依据 |
|---|---|---|
| `AgentEvent` 怎么从 runner 转发到多个 channel？ | 富化 `AgentEvent` 让每个事件自带 `sessionKey` / `turnId`；RuntimeApp 在 bootstrap 时给 `AgentRunnerConfig.onEvent` 注入 fanout 闭包，闭包共享 `channels[]` 引用，遍历调 `channel.send(event)` | 单一事件入口避免多机制并行；事件自描述对 telemetry/log 也更友好；`channels[]` 共享引用使 registerChannel 时机宽松；多 session 并发时事件携带自身路由信息，无需闭包查表 |
| 多 channel 同时启用交互能力时怎么避免广播？ | RuntimeApp 维护 `routeContextByTurn: Map<turnId, MessageRouteContext>` 路由表；`onRequest` / `onExpire` 在 RuntimeApp 启动时注册一次，handler 内按 turnId 查表只通知起源 channel | "谁发起的 turn 谁处理交互"符合直觉与安全；复杂度集中在 RuntimeApp 路由层 |
| 库模式（无 channel 直调 runTurn）触发 tool 时怎么处理 approval？ | RuntimeApp 启动时若 `channels.some(c => c.interaction \|\| c.approval)` 为 false 则**根本不注册 hook**，所有 tool 调用直通 | 没有可呈现 UI 的 channel 就没有人能做决策，等待超时只会拖慢库消费者；不注册 hook 等价于"无审批机制"，行为最直观 |
| 为什么 `clientId` 不进入 `RunTurnParams`？ | `clientId` 是 channel↔RuntimeApp 的路由元数据，library 调用方（直接调用 `runTurn`）不应感知 transport 概念 | `clientId` 封装在 `MessageRouteContext` 里由 RuntimeApp 内部管理；library API 保持干净。在 WebSocketChannel 中，这个值可特化为客户端自声明并持久化的逻辑客户端标识 |
| 为什么 `turnId` 在 `RunTurnParams` 中可选、在 `RunParams` 中必填？ | 对 library 调用方可选（可让 RuntimeApp 生成），但 AgentRunner 需要稳定的 turnId 写入 hook payload，不允许缺失 | 外层友好、内层严格的常见边界设计 |
| `request()` 为什么仍返回 `ApprovalResult` 而非 `ApprovalDecision`？ | hook 需要区分"用户主动拒绝"与"超时"以生成不同的 deny reason，单一的 `'allow'/'deny'` 无法表达 | 用显式字段 `reason: 'user' \| 'timeout'` 比用 `null` 暗示超时更易读；TurnInteractionManager 判断时机，hook 只做文案映射，职责清晰 |
| 为什么按 turn 而非 session 跟踪起源路由？ | 多个 client 可以共享同一 session，若按 session 跟踪会出现并发覆盖与误删 | turn 是一次交互的天然边界，`Map<turnId, MessageRouteContext>` 在并发场景下互不干扰 |
| 为什么 `BeforeToolCallPayload` 加 `turnId` 而非 `originClientId`？ | hook 的职责是工具拦截，不应感知 channel/client 概念 | `turnId` 是 agent 运行的通用上下文，channel 层通过 turnId 反查 originClient，保持 hook 与 channel 解耦 |
| 超时为什么用推送 `approval_expired` 而非拉取 `waitDecision`？ | my-agent WS 协议是全推送模型，拉取需要额外一次交互且存在竞态窗口 | 推送与现有协议风格一致，client 状态机更简单：收到 `approval_requested` 展示 UI，收到 `approval_expired` 或 `approval_resolve` 关闭 UI |
| `send` 为什么不再携带显式 `sessionKey` 参数？ | 事件自带 `sessionKey`，无需额外参数 | `AgentEvent` 富化后路由信息内嵌在事件中，channel 直接读取 |
| 为什么不直接在 hook 里 await readline？ | hook 不感知 I/O，channel 层负责适配 | 未来换 WS channel 时 hook 不用改 |
| 为什么用进程内 Promise bus 而非 WS RPC？ | my-agent 是 library，不应内置 WS Server 作为必须依赖 | WS Server 只是其中一种 channel；CliChannel 不需要它 |
| approval 为什么是可选的？ | 没有审批需求的场景（纯 CLI 脚本）不应承担额外复杂度 | 与 hook 系统的可选注册保持一致 |
| 为什么不把 transport 和 lifecycle 分成两个接口？ | `Channel` 实现者天然需要同时处理两者，分拆只增加嵌套层数，无实际收益 | 三个方法（`send` / `onMessage` / `start`+`stop`）就是一个完整 channel |
| `approval_requested` 为什么定向发送而非广播？ | 审批决策权归发起操作的客户端，其他客户端没有上下文也没有权限干预 | 广播会让任意客户端能 deny 他人发起的操作，是安全与 UX 的双重问题 |
| WS 消息 type 为什么全用 snake_case？ | `AgentEvent` 已用 snake_case，出站消息直接转发 AgentEvent，保持一致 | 避免混用两种风格造成客户端解析困难 |

---

## 11. 已知未实现 / 规划项

| 项 | 状态 | 说明 |
|---|---|---|
| `HttpChannel` | 规划中 | REST + SSE 实现，或对 WS 协议的 HTTP 长轮询包装 |
| Channel 鉴权 / 多租户 | 规划中 | WS 连接时的 token 验证、连接级 ACL |
| 外部平台 Channel | 规划中 | Slack / Discord 等，届时再评估是否需要增加 adapter 种类 |
| `approval_always_allow` | 规划中 | 白名单机制，特定 tool 自动放行不打扰用户 |
| 多 RuntimeApp 路由 | 规划中 | 单个 WS Server 管理多个 agent 实例，按 sessionKey 路由 |
| 客户端指定 turnId | 规划中 | WS `run_turn` 消息支持可选 `idempotencyKey`，作为 turnId 实现幂等重试 |
| 迟到 client 加入 turn | 规划中 | `Map<turnId, Set<clientId>>`，支持其它 client 中途订阅进行中的 turn 的事件流 |
| 事件补发 / replay buffer | 规划中 | client 重连后按消息序号补发断线期间遗漏的事件流 |
| `select` interaction 实现 | 规划中 | 类型已定义，但 CliChannel / WebSocketChannel 都尚未真正消费；落地需要 channel 各自的 UI 协议 |
| Pending interactions 重投递 | 规划中 | client 重连（同 `clientId` 重新 hello）后，把当时仍 pending 的 interaction 重新下发；属于上层交互管理，不属于 transport 恢复 |
