# Channel 层设计文档

> 状态：设计中，待确认
> 范围：Phase 1（CliChannel + WebSocketChannel + ApprovalManager）
> 参考：OpenClaw channel plugin 架构（extensions/slack、extensions/bluebubbles、src/channels/plugins/types.adapters.ts）

---

## 1. 背景与目标

### 问题

`RuntimeApp` 目前只有单一的进程内调用接口（`runTurn()`），`onEvent` 回调也只支持单个消费者。无法支持：

- CLI、WebSocket、HTTP 等多种 I/O 方式
- 审批（tool approval）——hook 里需要等待外部决策，但没有机制把决策传回
- 多客户端同时连接（如 WebSocket 广播）

### 目标

建立轻量 channel 层，以**非侵入式**的方式支持：

- 统一的 I/O 适配接口（`Channel`），不同接入方式各自实现
- `ApprovalManager`——进程内 Promise bus，解耦审批请求与决策来源
- Phase 1 提供 CLI 和 WebSocket 两种实现

### 设计原则

| 原则 | 说明 |
|------|------|
| channel 只负责 I/O | 业务逻辑留在 RuntimeApp / AgentRunner，channel 不感知 agent 内部 |
| 统一 WS 协议 | CLI 和 WS 都使用相同的消息结构，channel 差异只在传输层 |
| 接口尽量薄 | 不复制 OpenClaw 的 13 种 adapter，只抽象 my-agent 实际需要的边界 |
| 可选 approval | 不实现 `approval` 的 channel 仍能正常工作，只是没有审批能力 |

### 不在 Phase 1 范围内

- HTTP channel（可基于 WS 协议包装）
- 外部平台 channel（Slack、Discord 等）
- channel 鉴权 / 多租户
- 多 RuntimeApp 实例管理

---

## 2. 核心概念

### 2.1 架构结构

```
┌──────────────────────────────────────────────────────────────────┐
│                          RuntimeApp                               │
│                                                                   │
│  ┌──────────────────┐       ┌─────────────────────────────────┐  │
│  │   AgentRunner    │       │       ApprovalManager           │  │
│  │                  │─hook─▶│       (Promise bus)             │  │
│  │  AgentEvent ─────┼──┐    │  pending: Map<id, Promise>      │  │
│  └──────────────────┘  │    └────────────────┬────────────────┘  │
│                        │                     │ ApprovalRequest   │
│  ┌─────────────────────▼─────────────────────▼────────────────┐  │
│  │  originClientByTurn: Map<turnId, clientId>                  │  │
│  │                                                             │  │
│  │  send(event, sessionKey) ──▶ channel.send(event, sk)        │  │
│  │  onMessage ◀── channel.onMessage(handler)                   │  │
│  └──────────────────────────────┬──────────────────────────────┘  │
└─────────────────────────────────┼────────────────────────────────┘
                                  │  Channel 接口
                    ┌─────────────┴──────────────────┐
                    │                                 │
       ┌────────────▼───────────┐    ┌───────────────▼──────────────────────┐
       │      CliChannel        │    │         WebSocketChannel              │
       │                        │    │                                       │
       │  send(e, sk)           │    │  sessions: Map<sk, Set<clientId>>     │
       │    sk 忽略，直接输出    │    │  clients:  Map<clientId, WebSocket>   │
       │                        │    │                                       │
       │  onMessage             │    │  send(e, sk)                          │
       │    readline 逐行读取   │    │    按 sessions[sk] 广播               │
       │                        │    │                                       │
       │  ┌──────────────────┐  │    │  approval → 按 originClientId 定向    │
       │  │  stdin / stdout  │  │    │                                       │
       │  └──────────────────┘  │    │  ┌──────────┐  ┌──────────┐          │
       └────────────────────────┘    │  │ client 1 │  │ client 2 │  ...     │
                                     │  │ sk = "A" │  │ sk = "A" │          │
                                     │  └──────────┘  └──────────┘          │
                                     └──────────────────────────────────────┘
```

### 2.2 三个核心组件

| 组件 | 职责 | 类比 OpenClaw |
|------|------|---------------|
| `Channel` | I/O 适配接口（收发消息 + 生命周期） | `ChannelGatewayAdapter` + `ChannelOutboundAdapter` |
| `ChannelApprovalAdapter` | 审批交互能力（推送请求、接收决策） | `ChannelApprovalAdapter` |
| `ApprovalManager` | 进程内 Promise bus，连接 hook 与 channel | `ExecApprovalManager` |

### 2.3 跨模块数据流

Channel 层与 RuntimeApp / AgentRunner / hook 系统的交互按三条数据流分开：

**① 入站数据流（client → agent）**
```
WebSocket client / CLI input
        │ run_turn 消息
        ▼
   Channel.onMessage(handler)
        │ ChannelRunRequest { sessionKey, message, clientId? }
        ▼
   RuntimeApp.registerChannel 内的 handler:
        ├─ turnId = randomUUID()
        ├─ originClientByTurn.set(turnId, clientId)        ← Channel 层私有路由表
        └─ runTurn({ sessionKey, message, turnId })
                │ RunTurnParams（不含 clientId）
                ▼
        AgentRunner.run({ ...params, turnId, sessionKey })
                │
                ▼
        SessionManager.resolveSession(sessionKey)
        Tool 执行 / LLM 调用
```

**② 出站数据流（agent → client）**
```
AgentRunner 触发 AgentEvent
        │
        ▼
   RuntimeApp.runTurn 内订阅器:
        ├─ 闭包捕获当前 sessionKey
        └─ 遍历所有 channels
                │ channel.send(event, sessionKey)
                ▼
   Channel.send 实现:
        ├─ CliChannel: 忽略 sessionKey，写 stdout
        └─ WebSocketChannel:
                ├─ 查 sessions[sessionKey] = Set<clientId>
                └─ 广播 JSON 给该集合内所有连接
        │
        ▼
   WebSocket clients / CLI 终端
```

**③ Approval 数据流（hook ↔ channel）**
```
AgentRunner 调用 tool 前
        │ before_tool_call hook
        ▼
   Hook payload: { toolName, input, turnId, sessionKey }
        │
        ▼
   RuntimeApp 注册的 hook handler:
        ├─ originClientId = originClientByTurn.get(turnId)
        └─ approvalManager.request({ toolName, input, sessionKey, originClientId })
                │ 阻塞等待 Promise
                │
                ├─ 生成 ApprovalRequest { id }
                └─ 触发 onRequest 回调
                        │
                        ▼
                Channel.approval.sendApprovalRequest(req)
                        │
                        ├─ CliChannel: readline 显示 Allow? (y/n)
                        └─ WebSocketChannel:
                                按 originClientId 定向发 approval_requested

   ┌─ 正常路径 ─────────────────────────────────────────────────┐
   │ 用户做出决策                                                │
   │      │                                                      │
   │      ▼                                                      │
   │ Channel.approval.onApprovalDecision(id, decision)           │
   │      │                                                      │
   │      ▼                                                      │
   │ ApprovalManager.resolve(id, decision)                       │
   │      │                                                      │
   │      ▼                                                      │
   │ Promise resolve → ApprovalResult { decision, reason:'user' }│
   └────────────────────────────────────────────────────────────┘

   ┌─ 超时路径 ─────────────────────────────────────────────────┐
   │ ApprovalManager 内部 timer 触发 expire(id)                  │
   │      │                                                      │
   │      ├─ Promise resolve → ApprovalResult                    │
   │      │       { decision:'deny', reason:'timeout' }          │
   │      └─ 触发 onExpire 回调                                  │
   │                │                                            │
   │                ▼                                            │
   │       Channel.approval.sendApprovalExpired(req)             │
   │       → 通知 client 关闭审批 UI                             │
   └────────────────────────────────────────────────────────────┘
        │
        ▼
   Hook handler 根据 ApprovalResult 返回:
        - allow → AgentRunner 继续执行 tool
        - deny  → AgentRunner 跳过 tool，reason 写入对话
```

**关键不变量**

| 不变量 | 说明 |
|--------|------|
| `clientId` 不进 `RunTurnParams` | channel↔RuntimeApp 路由信息，AgentRunner 不感知 |
| `turnId` 流贯三条数据流 | 入站生成 → hook payload → approval routing 反查 originClient |
| `sessionKey` 是事件路由的 key | 出站事件按 sessionKey 找 client 集合 |
| `originClientId` 仅 approval 路径使用 | 普通 AgentEvent 走广播，approval 走定向 |

---

## 3. 类型定义（`src/channel/types.ts`）

```typescript
import type { AgentEvent } from '../agent-runner/types.js';

// ── 入站消息 ──────────────────────────────────────────────────

/** Channel 发给 RuntimeApp 的运行请求 */
export interface ChannelRunRequest {
  sessionKey: string;
  message: string;
  model?: string;
  maxTokens?: number;
  maxToolRounds?: number;
  /** 发起本次请求的连接标识符，由 channel 内部分配，用于将 approval 路由回原始客户端 */
  clientId?: string;
}

// ── 审批 ──────────────────────────────────────────────────────

export interface ApprovalRequest {
  id: string;
  toolName: string;
  input: Record<string, unknown>;
  sessionKey: string;
  /** 发起本次 run 的客户端标识符；WebSocketChannel 用此字段定向路由，CliChannel 忽略 */
  originClientId?: string;
  timeoutMs?: number;
}

export type ApprovalDecision = 'allow' | 'deny';

/** 审批结果。拒绝时携带原因以便上层区分用户行为与超时。 */
export type ApprovalResult =
  | { decision: 'allow' }
  | { decision: 'deny'; reason: 'user' | 'timeout' };

// ── Channel 接口 ───────────────────────────────────────────────

/**
 * channel 适配器接口。
 *
 * 实现此接口即可将任意 I/O 方式接入 RuntimeApp。
 * approval 为可选能力：不实现则该 channel 无审批交互。
 */
export interface Channel {
  /** 唯一标识符，用于日志 */
  id: string;

  /**
   * RuntimeApp 推送 agent 事件流给 channel。
   * sessionKey 用于多 session 场景下的路由：channel 将 event 发给订阅了该 session 的客户端。
   * 单客户端实现（如 CliChannel）可忽略 sessionKey。
   */
  send(event: AgentEvent, sessionKey: string): void;

  /** channel 注册入站消息处理器（由 RuntimeApp 在 registerChannel 时调用） */
  onMessage(handler: (req: ChannelRunRequest) => Promise<void>): void;

  /** 启动 channel（建立连接、开始监听） */
  start(): Promise<void>;

  /** 停止 channel（断开连接、释放资源） */
  stop(): Promise<void>;

  /** 审批交互能力（可选） */
  approval?: ChannelApprovalAdapter;
}

/**
 * 审批交互适配器。
 *
 * RuntimeApp 检测到 channel.approval 存在时自动接入 ApprovalManager。
 * 不实现此接口的 channel 不具备审批能力，
 * ApprovalManager 将在超时后按默认策略处理。
 */
export interface ChannelApprovalAdapter {
  /** RuntimeApp 推送审批请求给 channel（channel 负责呈现给用户） */
  sendApprovalRequest(request: ApprovalRequest): void;

  /** RuntimeApp 推送超时通知给 channel（channel 负责关闭审批 UI） */
  sendApprovalExpired(request: ApprovalRequest): void;

  /** channel 注册审批决策处理器（由 RuntimeApp 在 registerChannel 时调用） */
  onApprovalDecision(
    handler: (id: string, decision: ApprovalDecision) => void,
  ): void;
}
```

---

## 4. ApprovalManager（`src/channel/ApprovalManager.ts`）

进程内 Promise bus，解耦审批请求（来自 `before_tool_call` hook）与决策（来自任意 channel）。

### 4.1 公开 API

```typescript
export interface ApprovalManagerConfig {
  /** 默认超时（毫秒），超时后按 deny 处理；默认 120_000 */
  defaultTimeoutMs?: number;
}

export class ApprovalManager {
  constructor(config?: ApprovalManagerConfig);

  /**
   * 发起审批请求，返回 Promise，在决策到达或超时后 resolve。
   * 调用方（before_tool_call hook）await 此方法阻塞等待。
   * 返回 ApprovalResult：allow 或 deny（携带 'user' / 'timeout' 原因）。
   */
  request(params: Omit<ApprovalRequest, 'id'>): Promise<ApprovalResult>;

  /**
   * 提交决策（由 channel 在收到用户输入后调用）。
   * 若 id 不存在或已过期，静默忽略。
   */
  resolve(id: string, decision: ApprovalDecision): void;

  /**
   * 注册审批请求通知回调（由 RuntimeApp 在 registerChannel 时调用）。
   * 每次 request() 内部生成 ApprovalRequest 后触发，用于通知 channel 呈现审批 UI。
   */
  onRequest(handler: (request: ApprovalRequest) => void): void;

  /**
   * 注册超时通知回调（由 RuntimeApp 在 registerChannel 时调用）。
   * 请求超时后触发，用于通知 channel 关闭审批 UI。
   */
  onExpire(handler: (request: ApprovalRequest) => void): void;

  /** 取消所有 pending 请求（按 deny 处理），用于关闭时清理 */
  close(): void;
}
```

### 4.2 内部结构

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

### 4.3 与 hook 和 channel 的连接

三者由 RuntimeApp 在 `registerChannel()` 时串联，`ApprovalManager` 本身不感知 hook 或 channel：

```
  hook                    ApprovalManager              channel.approval
   │                            │                             │
   │──request(toolName,...)────▶│                             │
   │                            ├─ 生成 ApprovalRequest(id)   │
   │                            ├─ 存入 pending Map           │
   │                            ├─ 启动超时计时器             │
   │                            │──onRequest 回调────────────▶│
   │  (await，阻塞)             │                sendApprovalRequest()
   │                            │                → 呈现审批 UI
   │                            │                             │
   │        ┌── 正常路径 ────────┼─────────────────────────── ┤
   │        │                   │              用户做出决策    │
   │        │                   │◀──onApprovalDecision────────│
   │        │                   ├─ clearTimeout               │
   │        │                   ├─ pending Map resolve        │
   │◀───────┘ ApprovalResult    │                             │
   │  { decision, reason:'user'}│                             │
   │                            │                             │
   │        ┌── 超时路径 ────────┤                             │
   │        │                   ├─ expire()                   │
   │        │                   ├─ resolve({deny,'timeout'})  │
   │◀───────┘ ApprovalResult    │──onExpire 回调─────────────▶│
   │ {decision:'deny',          │                sendApprovalExpired()
   │  reason:'timeout'}         │                → 关闭审批 UI
```

**RuntimeApp.registerChannel 内部（伪代码）：**

```typescript
private originClientByTurn = new Map<string, string>();

private wireApproval(channel: Channel): void {
  if (!channel.approval) return;

  // hook → ApprovalManager（before_tool_call hook 注册一次即可）
  if (!this.approvalHookRegistered) {
    this.agentRunner.on('before_tool_call', async ({ toolName, input, turnId, sessionKey }) => {
      const result = await this.approvalManager.request({
        toolName,
        input,
        sessionKey,
        originClientId: this.originClientByTurn.get(turnId),
      });
      if (result.decision === 'allow') return { action: 'allow' };
      return {
        action: 'deny',
        reason: result.reason === 'timeout' ? 'Denied by timeout' : 'Denied by user',
      };
    });
    this.approvalHookRegistered = true;
  }

  // ApprovalManager → channel（推送请求）
  this.approvalManager.onRequest((request) => {
    channel.approval!.sendApprovalRequest(request);
  });

  // ApprovalManager → channel（超时通知）
  this.approvalManager.onExpire((request) => {
    channel.approval!.sendApprovalExpired(request);
  });

  // channel → ApprovalManager（传回决策）
  channel.approval.onApprovalDecision((id, decision) => {
    this.approvalManager.resolve(id, decision);
  });
}
```

`originClientByTurn` 由 channel 的消息处理器在 turn 入口注册、结束后清除。**粒度按 turn 而非 session**，避免多 client 共享同一 session 时的映射覆盖问题。注意 `clientId` 不进入 `RunTurnParams`——它是 channel↔RuntimeApp 的路由信息，不污染 library API：

```typescript
// RuntimeApp.runTurn（library API，不感知 clientId）
async runTurn(params: RunTurnParams): Promise<RunResult> {
  const turnId = params.turnId ?? randomUUID();
  return await this.agentRunner.run({ ...params, turnId });
}

// channel 消息处理器（注册 originClient 后再调 runTurn）
channel.onMessage(async (req) => {
  const turnId = randomUUID();
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
    this.originClientByTurn.delete(turnId);
  }
});
```

---

## 5. CliChannel（`src/channel/CliChannel.ts`）

### 5.1 配置与结构

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
  readonly approval?: ChannelApprovalAdapter;

  constructor(config?: CliChannelConfig);

  send(event: AgentEvent, sessionKey: string): void;   // sessionKey 忽略，单客户端直接输出
  onMessage(handler: (req: ChannelRunRequest) => Promise<void>): void;
  start(): Promise<void>;
  stop(): Promise<void>;
}
```

### 5.2 send 实现（对齐 `chat.ts` 的 `makeAgentEventHandler`）

| AgentEvent | CLI 输出 |
|------------|----------|
| `text_delta` | `process.stdout.write(event.text)` |
| `tool_use` | `dim("[tool: name]\n")` |
| `tool_result` | `dim("[tool result] preview…\n")` 或 `red("[tool error]…")` |
| `compaction_start` | `yellow("[compacting… trigger=X]\n")` |
| `compaction_end` | `yellow("[compacted: X → Y tokens]\n")` |
| `run_end` | 换行（如果正在流式输出） |

### 5.3 onMessage 实现

readline 逐行读取。`/exit`、`/clear` 等命令由调用方在 handler 外处理，不属于 channel 内部职责。普通输入构造 `ChannelRunRequest` 推给 handler，等待 handler 完成后再发下一个 prompt。

### 5.4 approval（可选）

`config.approval = true` 时构造 `ChannelApprovalAdapter`：
- `sendApprovalRequest`：打印工具名称和参数，在 readline 中显示 `Allow? (y/n)`
- `onApprovalDecision`：读取用户输入，`y` 映射为 `'allow'`，其他映射为 `'deny'`

---

## 6. WebSocketChannel（`src/channel/WebSocketChannel.ts`）

### 6.1 WS 消息协议

所有消息均为 JSON，`type` 字段使用 snake_case，与 `AgentEvent` 保持一致。

**Client → Server（入站）：**

```typescript
/** 发起 turn */
{ type: 'run_turn'; sessionKey: string; message: string; model?: string; maxTokens?: number }

/** 提交审批决策 */
{ type: 'approval_resolve'; id: string; decision: 'allow' | 'deny' }
```

**Server → Client（出站）：**

```typescript
/** 直接转发 AgentEvent（type 字段与 AgentEvent 完全一致） */
{ type: 'text_delta';  text: string }
{ type: 'tool_use';    name: string; input: Record<string, unknown> }
{ type: 'tool_result'; name: string; result: { content: string; isError?: boolean } }
{ type: 'run_end';     result: RunResult }
{ type: 'error';       error: string }

/** 审批请求（由 ApprovalManager 触发） */
{ type: 'approval_requested'; id: string; toolName: string; input: Record<string, unknown>; timeoutMs?: number }

/** 审批超时（由 ApprovalManager 超时后触发，通知 client 关闭审批 UI） */
{ type: 'approval_expired'; id: string }
```

### 6.2 广播行为

| 消息 | 广播策略 |
|------|----------|
| `text_delta` / `tool_use` / `tool_result` / `run_end` | 广播给同 session 的所有已连接客户端 |
| `error` | 广播给同 session 的所有已连接客户端 |
| `approval_requested` | 定向发送给发起本次 run 的客户端（按 `originClientId` 路由） |
| `approval_expired` | 定向发送给发起本次 run 的客户端（同 `originClientId`） |
| `approval_resolve`（入站） | 单次有效，Manager 自动忽略重复提交 |

### 6.3 配置

```typescript
export interface WebSocketChannelConfig {
  port: number;
  host?: string;        // 默认 '127.0.0.1'
  path?: string;        // 默认 '/ws'
  maxClients?: number;  // 默认不限
  /** 启用审批交互；启用时接受客户端的 approval_resolve 消息 */
  approval?: boolean;   // 默认 false
}

export class WebSocketChannel implements Channel {
  readonly id = 'websocket';
  readonly approval?: ChannelApprovalAdapter;

  constructor(config: WebSocketChannelConfig);

  send(event: AgentEvent, sessionKey: string): void;
  onMessage(handler: (req: ChannelRunRequest) => Promise<void>): void;
  start(): Promise<void>;
  stop(): Promise<void>;
}
```

每个 WebSocket 连接建立时，服务端分配一个 UUID 作为 `clientId`，存入连接映射表。WebSocketChannel 内部维护两张映射表：

- `Map<sessionKey, Set<clientId>>`：session 到客户端集合，`send(event, sessionKey)` 按此广播
- `Map<clientId, WebSocket>`：clientId 到连接，用于 approval 定向发送

客户端发送 `run_turn` 时，`clientId` 写入 `ChannelRunRequest`，同时将该 clientId 注册进 sessionKey 对应的集合。连接断开时从两张表中移除。

---

## 7. RuntimeApp 接入点

### 7.1 新增方法

```typescript
class RuntimeApp {
  /**
   * 注册 channel，绑定消息处理器与 approval（如有）。
   * 须在 create() 后、startChannels() 前调用。
   * 支持注册多个 channel（如 CLI + WS 同时运行）。
   */
  registerChannel(channel: Channel): void;

  /**
   * 依次调用所有已注册 channel 的 start()。
   * 通常在所有 registerChannel() 调用之后执行。
   */
  startChannels(): Promise<void>;

  /**
   * 依次调用所有已注册 channel 的 stop()，并关闭 ApprovalManager。
   * close() 内部自动调用，也可单独调用。
   */
  stopChannels(): Promise<void>;
}
```

### 7.2 使用示例

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

### 7.3 与 runTurn() 的关系

`runTurn()` 保持不变，仍可直接调用（库模式）。`registerChannel()` 只是在 channel 收到消息时自动调用 `runTurn()`，两者不冲突。

---

## 8. 文件结构

```
src/channel/
  types.ts              # Channel / ChannelApprovalAdapter /
                        # ChannelRunRequest / ApprovalRequest / ApprovalDecision
  ApprovalManager.ts    # Promise bus
  CliChannel.ts         # readline 实现
  WebSocketChannel.ts   # ws server 实现
  index.ts              # 导出
```

---

## 9. 对其它模块的改动

本设计需要在现有模块做以下修改。未列出的模块保持不变。

### 9.1 `src/agent-runner/hooks/types.ts`

`BeforeToolCallPayload` 新增两个字段，让 hook 能感知当前 turn 的身份与所属 session：

```diff
 export interface BeforeToolCallPayload {
   toolName: string;
   input: Record<string, unknown>;
+  /** 本次 turn 的唯一 id，由 RuntimeApp.runTurn 生成 */
+  turnId: string;
+  /** 本次 turn 所属 session */
+  sessionKey: string;
 }
```

`AfterToolCallPayload` 也建议同步增加 `turnId` 和 `sessionKey`，保持对称（便于日志关联），但 Phase 1 非必需。

### 9.2 `src/agent-runner/AgentRunner.ts`

- `RunParams` 新增 `turnId: string` 字段（**非可选**——RuntimeApp 保证始终传入）
- 触发 `before_tool_call` hook 时从 `RunParams` 读取 `turnId` 和 `sessionKey` 注入 payload
- 暴露事件注册 API `on(hookName, handler)`（若目前未暴露）

### 9.3 `src/runtime/RuntimeApp.ts`

新增：
- 内部字段：`approvalManager: ApprovalManager`、`channels: Channel[]`、`originClientByTurn: Map<string, string>`、`approvalHookRegistered: boolean`
- 公开方法：`registerChannel(channel)`、`startChannels()`、`stopChannels()`
- 私有方法：`wireApproval(channel)`
- `runTurn` 入口：若 `params.turnId` 未提供则生成 UUID，透传 `turnId` 给 `AgentRunner.run`
- `registerChannel` 内部的 `channel.onMessage` 处理器负责将 `req.clientId` 注册到 `originClientByTurn`，turn 结束后清除（clientId 不进入 `runTurn` 参数）
- `close()` 内部调用 `stopChannels()` 并 `approvalManager.close()`

`close()` 本身是否已存在：若已存在则在其中补调 `stopChannels()`；若不存在则本次新增。

### 9.4 `src/runtime/types.ts`

`RunTurnParams` 新增**可选** `turnId?: string`（调用方可指定用于日志关联；不指定则由 RuntimeApp 生成）：

```diff
 export interface RunTurnParams {
   sessionKey: string;
   message: string;
   model?: string;
   maxTokens?: number;
   maxToolRounds?: number;
+  /** 可选 turn 标识；不提供则由 RuntimeApp 自动生成 UUID */
+  turnId?: string;
 }
```

**不新增 `clientId`**——它是 channel↔RuntimeApp 的路由元数据，只存在于 `ChannelRunRequest`，不污染 library API。（与 openclaw 有意差异化：openclaw 的 `RunEmbeddedPiAgentParams` 直接携带 `messageChannel` / `messageProvider` / `messageTo` / `senderId` 等真实的外部平台寻址字段，agent 层会据此决定输出格式、注入 hook context，并在构造 approval 请求时复用为 `turnSource*` 字段；my-agent 的 `clientId` 只是进程内 WebSocket 连接句柄，没有跨边界寻址语义，应由 channel 层内部路由表管理，不进入 library API）

`RunTurnResult` 不做变动。

### 9.5 AgentEvent 分发给 channel 的机制

`RuntimeApp.runTurn` 需要在运行期间把 `AgentEvent` 流转发到所有已注册 channel。实现方式：

- `RuntimeApp` 维护 `channels: Channel[]`
- `runTurn` 内订阅 `agentRunner` 事件流（或通过现有的 `onEvent` 钩子转发），**闭包捕获当前 sessionKey**
- 每个 event 触发时，遍历 `channels` 调用 `channel.send(event, sessionKey)`

`AgentEvent` 本身不携带 sessionKey，sessionKey 来自 `RunTurnParams`。

### 9.6 现有 `onEvent` 单消费者回调

`RuntimeApp` 原有 `onEvent?: (event) => void` 单消费者回调：
- **保留**作为库模式调用 `runTurn` 的直接回调
- channel 分发逻辑并行于此回调运行（registerChannel 的 channel 通过 `channel.send` 接收，不占用 `onEvent` 插槽）

### 9.7 `scripts/chat.ts`

作为临时测试脚本**废弃**。CLI 交互能力由 `CliChannel` 提供。

---

## 10. 设计决策记录

| 问题 | 决策 | 依据 |
|------|------|------|
| 为什么 `clientId` 不进入 `RunTurnParams`？ | `clientId` 是 channel↔RuntimeApp 的路由元数据，library 调用方（直接调用 `runTurn`）不应感知 transport 概念 | 与 openclaw 有意差异化：openclaw 的 `RunEmbeddedPiAgentParams` 直接携带 `messageChannel` / `messageTo` 等真实平台寻址字段（agent 层据此决定格式、注入 hook context，并复用为 approval 请求的 `turnSource*` 字段路由回原平台）；my-agent 的 `clientId` 只是进程内 WS 连接句柄，没有跨边界语义，由 channel 层内部的 `originClientByTurn` 管理更合适，不污染 library API |
| 为什么 `turnId` 在 `RunTurnParams` 中可选、在 `RunParams` 中必填？ | 对 library 调用方可选（可让 RuntimeApp 生成），但 AgentRunner 需要稳定的 turnId 写入 hook payload，不允许缺失 | 外层友好、内层严格是常见边界设计：RuntimeApp 负责补全默认值 |
| `request()` 为什么返回 `ApprovalResult` 而非 `ApprovalDecision`？ | hook 需要区分"用户主动拒绝"与"超时"以生成不同的 deny reason，单一的 `'allow'/'deny'` 无法表达 | 用显式字段 `reason: 'user' \| 'timeout'` 比用 `null` 暗示超时更易读；ApprovalManager 判断时机，hook 只做文案映射，职责清晰 |
| 为什么按 turn 而非 session 跟踪 originClient？ | 多个 client 可以共享同一 session，若按 session 跟踪会出现并发覆盖与误删 | turn 是一次交互的天然边界，`Map<turnId, clientId>` 在并发场景下互不干扰。（openclaw 通过 `runId` 关联 agent 运行与 gateway 审批调用，但没有 client 路由表这种结构——它的路由靠把 messaging 字段直接传给 gateway 实现，与本设计机制不同） |
| 为什么 `BeforeToolCallPayload` 加 `turnId` 而非 `originClientId`？ | hook 的职责是工具拦截，不应感知 channel/client 概念 | `turnId` 是 agent 运行的通用上下文，channel 层通过 turnId 反查 originClient，保持 hook 与 channel 解耦 |
| 超时为什么用推送 `approval_expired` 而非拉取 `waitDecision`？ | my-agent WS 协议是全推送模型，拉取需要额外一次交互且存在竞态窗口（超时发生在 client 发送订阅请求之前） | 推送与现有协议风格一致，client 状态机更简单：收到 `approval_requested` 展示 UI，收到 `approval_expired` 或 `approval_resolve` 关闭 UI |
| `send` 为什么携带 `sessionKey`？ | `Channel` 实例共享于所有 session，`send` 需要 sessionKey 才能将 event 路由给正确的 client 集合 | 路由上下文由调用方传入而非存储于 channel 实例，`send` 保持无状态；CliChannel 单客户端可忽略此参数 |
| 为什么不直接在 hook 里 await readline？ | hook 不感知 I/O，channel 层负责适配 | 未来换 WS channel 时 hook 不用改 |
| 为什么用进程内 Promise bus 而非 WS RPC？ | my-agent 是 library，不应内置 WS Server 作为必须依赖 | OpenClaw 的 WS Gateway 是多进程平台服务，my-agent 场景不同 |
| approval 为什么是可选的？ | 没有审批需求的场景（纯 CLI 脚本）不应承担额外复杂度 | 与 hook 系统的可选注册保持一致 |
| 为什么不用 `ChannelPlugin` 命名？ | my-agent 没有 plugin 系统，"Plugin" 来自 OpenClaw 术语，引入会造成误导 | 保持命名与项目自身概念体系一致 |
| 为什么不把 transport 和 lifecycle 分成两个接口？ | `Channel` 实现者天然需要同时处理两者，分拆只增加嵌套层数，无实际收益 | 参考 OpenClaw 最简实现（bluebubbles）：三个方法就是一个完整 channel |
| `approval_requested` 为什么定向发送而非广播？ | 审批决策权归发起操作的客户端，其他客户端没有上下文也没有权限干预 | 广播会让任意客户端能 deny 他人发起的操作，是安全与 UX 的双重问题 |
| WS 消息 type 为什么全用 snake_case？ | `AgentEvent` 已用 snake_case，出站消息直接转发 AgentEvent，保持一致 | 避免混用两种风格造成客户端解析困难 |

---

## 11. Phase 2 预留

| 项目 | 说明 |
|------|------|
| `HttpChannel` | REST + SSE 实现，或对 WS 协议的 HTTP 长轮询包装 |
| Channel 鉴权 | WS 连接时的 token 验证，多租户隔离 |
| 外部平台 Channel | Slack / Discord 等，届时再评估是否需要增加 adapter 种类 |
| `approval_always_allow` | 白名单机制，特定 tool 自动放行，不打扰用户 |
| 多 RuntimeApp 路由 | 单个 WS Server 管理多个 agent 实例，按 sessionKey 路由 |
| 客户端指定 turnId | WS `run_turn` 消息支持可选 `idempotencyKey`，作为 turnId 实现幂等重试（对齐 OpenClaw） |
| 迟到 client 加入 turn | `Map<turnId, Set<clientId>>`，支持其它 client 中途订阅进行中的 turn 的事件流 |
| approval 重连恢复 | client 重连后通过 `waitDecision(id)` 补订未决审批（OpenClaw 有 15s grace period） |
