# Channel 层设计文档

> 状态：设计中，待确认
> 范围：Phase 1（CliChannel + WebSocketChannel + ApprovalManager）
> 参考：OpenClaw channel plugin 架构（extensions/slack、extensions/bluebubbles、src/channels/plugins/types.adapters.ts）
> 细化：WebSocket transport 细节见 [adapters-websocket-channel-design.md](./adapters-websocket-channel-design.md)

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
  │ hello(clientId) 绑定逻辑客户端身份
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

## 3. 类型定义（`src/adapters/channel/types.ts`）

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
  /** 发起本次请求的逻辑客户端标识；WebSocketChannel 从客户端握手消息中读取并透传 */
  clientId?: string;
}

// ── 审批 ──────────────────────────────────────────────────────

export interface ApprovalRequest {
  id: string;
  toolName: string;
  input: Record<string, unknown>;
  sessionKey: string;
  /** 发起本次 turn 的 turnId，由 RuntimeApp 根据此字段路由到起源 channel */
  turnId: string;
  /** 发起本次 run 的逻辑客户端标识符；WebSocketChannel 用此字段定向路由，CliChannel 忽略 */
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
   * `event.sessionKey` 携带路由上下文：channel 将 event 发给订阅了该 session 的客户端。
   * 单客户端实现（如 CliChannel）可忽略 sessionKey。
   */
  send(event: AgentEvent): void;

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

## 4. ApprovalManager（`src/adapters/channel/ApprovalManager.ts`）

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
   * 注册审批请求通知回调。
   * **由 RuntimeApp 在初始化时注册一次**，handler 内部按 `request.turnId` 查 `originChannelByTurn`
   * 表定向路由给起源 channel，不在 channel 间广播。再次调用会替换前一个 handler。
   */
  onRequest(handler: (request: ApprovalRequest) => void): void;

  /**
   * 注册超时通知回调。
   * **由 RuntimeApp 在初始化时注册一次**，路由策略同 onRequest。
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

三者由 RuntimeApp 串联：**hook 注册一次、`onRequest`/`onExpire` 注册一次**，按 `turnId` 路由给起源 channel。`registerChannel` 只负责把 channel 加入 `channels[]` 并绑定 `onMessage` / `onApprovalDecision`，不再绑定 `onRequest` / `onExpire`。

```
  hook                    ApprovalManager              起源 channel.approval
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

**关键设计：approval 按 turn 起源路由（不广播）**

| 设计要素 | 说明 |
|----------|------|
| 路由表 | RuntimeApp 维护 `originChannelByTurn: Map<turnId, Channel>` 和 `originClientByTurn: Map<turnId, clientId>` |
| 路由时机 | channel.onMessage 入口写入 turnId→channel 映射，turn 结束（finally）清除 |
| 路由依据 | ApprovalRequest 携带 turnId；RuntimeApp 在 onRequest handler 内查表找 originChannel |
| 安全性 | 只有起源 channel 的 approval adapter 能呈现审批 UI 与 deny 操作，避免任意 channel 干预他人 turn |
| 库模式自动放行 | RuntimeApp 启动时检测：若 `channels.some(c => c.approval)` 为 false，**根本不注册 hook**，所有 tool 调用直通 |
| 起源 channel 不可达 | 例如 WS client 在 approval 等待期断线：channel.approval.sendApprovalRequest 是 fire-and-forget，channel 内部静默忽略找不到的 client，最终走 ApprovalManager 超时按 deny 处理 |

**RuntimeApp 内部接线（伪代码）：**

```typescript
private originChannelByTurn = new Map<string, Channel>();
private originClientByTurn  = new Map<string, string>();
private approvalRoutingWired = false;

/** 启动时调用一次（在 startChannels 之前），仅在至少一个 channel 提供 approval 能力时接线 hook */
private wireApprovalRouting(): void {
  if (this.approvalRoutingWired) return;
  if (!this.channels.some((c) => c.approval)) return;  // 库模式或纯只读 channel：不注册 hook
  this.approvalRoutingWired = true;

  // ① hook → ApprovalManager（注册一次）
  this.agentRunner.on('before_tool_call', async ({ toolName, input, turnId, sessionKey }) => {
    const result = await this.approvalManager.request({
      toolName,
      input,
      sessionKey,
      turnId,
      originClientId: this.originClientByTurn.get(turnId),
    });
    return result.decision === 'allow'
      ? { action: 'allow' }
      : {
          action: 'deny',
          reason: result.reason === 'timeout' ? 'Denied by timeout' : 'Denied by user',
        };
  });

  // ② ApprovalManager → 起源 channel（注册一次，按 turnId 定向路由）
  this.approvalManager.onRequest((request) => {
    const originChannel = this.originChannelByTurn.get(request.turnId);
    if (!originChannel?.approval) {
      // 起源 channel 已注销 / 不支持 approval / 该 turn 由 library 直接发起。
      // 不主动 deny，让 ApprovalManager 走超时路径，便于诊断。
      return;
    }
    originChannel.approval.sendApprovalRequest(request);
  });

  this.approvalManager.onExpire((request) => {
    const originChannel = this.originChannelByTurn.get(request.turnId);
    originChannel?.approval?.sendApprovalExpired(request);
  });
}

/** registerChannel 只做加入数组与绑定 onMessage / onApprovalDecision */
registerChannel(channel: Channel): void {
  this.channels.push(channel);
  channel.onMessage(this.makeMessageHandler(channel));
  channel.approval?.onApprovalDecision((id, decision) => {
    this.approvalManager.resolve(id, decision);
  });
}

/** 每个 channel 一份消息处理器，闭包绑定 channel 自身用于路由表登记 */
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

`originChannelByTurn` / `originClientByTurn` 都按 turn 而非 session 跟踪——多个 client 共享同一 session 时，每个 turn 是独立的交互边界，不会出现并发覆盖。`clientId` 不进入 `RunTurnParams`，是 channel↔RuntimeApp 的内部路由信息，不污染 library API。

---

## 5. CliChannel（`src/adapters/channel/CliChannel.ts`）

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

  send(event: AgentEvent): void;   // event.sessionKey 忽略，单客户端直接输出
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
| `tool_result` | `[tool result]` / `[tool error]` 标签 + 多行预览（见 §5.2.1） |
| `compaction_start` | `yellow("[compacting… trigger=X]\n")` |
| `compaction_end` | `yellow("[compacted: X → Y tokens]\n")` |
| `error` | 仅 `breakStream()`，**不打印**——避免与 §5.3 的 catch 输出重复（runner 触发 error event 后会立刻 throw） |
| `run_end` | 换行（如果正在流式输出） |

未列出的事件类型（`run_start`/`llm_call`/`tool_result_pruned`）默认忽略，不输出到 CLI。

> **关于 `error` 的处理：** AgentRunner 的设计是"既 emit 又 throw"，让 channel 自由选择呈现路径。CliChannel 选择**只在 catch 路径打印**，避免双行；WebSocketChannel 等其他实现可以选择推送 `error` 事件给 client（catch 可能不在同一进程边界内）。

### 5.2.1 tool_result 预览渲染（CliChannel 专属）

**这是 CliChannel 的渲染选择，不是 Channel 层通用行为。** 其他 channel 实现各自决定如何呈现 tool result——例如 WebSocketChannel 直接转发完整 `result.content` 给前端，由前端按需折叠 / 分页 / 高亮。

CliChannel 做截断的原因是终端约束：长输出会刷屏挤掉 prompt 和后续 LLM 文本。LLM 仍通过 tool executor 收到完整内容，截断只影响 CLI 显示。

**预算：**
- 总行数 ≤ 16 行（10 head + 6 tail）
- 单行字符上限 200，超出末尾追加 `…`
- 10:6 偏向 head 的设计：CLI 工具输出（`list_dir` / `read_file` / 命令回显）通常前部信息密度高，tail 主要保留错误堆栈和 summary

**预处理：**
1. 去掉尾部空行
2. 连续空行（含纯空白行）折叠为 1 行——保留段落分隔感，避免空行吃掉行预算
3. 非空行原样保留（不 trim 缩进）

**输出格式：**
- 总行数 ≤ 16 → 全显示
- 超过 → head + `... [N lines omitted]` + tail
- 单行结果（含截断后）→ 内联 `[tool result] xxx`
- 多行结果 → 标签独占一行，正文各行缩进 2 空格

**实现位置：** `formatToolResultPreview()` / `collapseEmptyLines()` / `truncateLine()` 都是模块级纯函数，便于单元测试。

### 5.3 onMessage 实现

readline 逐行读取。`/exit`、`/clear` 等命令由调用方在 handler 外处理，不属于 channel 内部职责。普通输入构造 `ChannelRunRequest` 推给 handler，等待 handler 完成后再发下一个 prompt。

**handler 抛错的处理**：handler 调用（`runTurn`）若抛出错误，CliChannel 在 readline 循环内 try/catch 捕获，以 `red("[error] ...\n")` 输出（与 §5.2 表格里的 `error` 事件输出风格一致），然后继续下一轮 prompt 不退出。注意这与 AgentEvent 中的 `error` 是两条互补路径——AgentEvent 是 runner 内部 emit 的可恢复事件流，handler 抛错是同步异常。

**stop() 与 readline 中断**：
- 内部维护 `stopped: boolean` 标记
- `stop()` 设置 `stopped = true`，调用 `rl.close()`
- 正在 `rl.question()` 阻塞时，`rl.close()` 会让该 Promise reject（`ERR_USE_AFTER_CLOSE`），循环捕获后退出
- `start()` 主循环每轮读 prompt 前先检查 `stopped`，已停止则直接 return
- 多次调用 `stop()` 幂等

### 5.4 approval（可选）

`config.approval = true` 时构造 `ChannelApprovalAdapter`：
- `sendApprovalRequest`：打印工具名称和参数，在 readline 中显示 `Allow? (y/n)`
- `onApprovalDecision`：读取用户输入，`y` 映射为 `'allow'`，其他映射为 `'deny'`

---

## 6. WebSocketChannel（`src/adapters/channel/WebSocketChannel.ts`）

### 6.1 WS 消息协议

所有消息均为 JSON，`type` 字段使用 snake_case，与 `AgentEvent` 保持一致。

**Client → Server（入站）：**

```typescript
/** 连接建立后的第一条协议消息，用于绑定逻辑客户端身份 */
{ type: 'hello'; clientId: string }

/** 发起 turn */
{ type: 'run_turn'; sessionKey: string; message: string; model?: string; maxTokens?: number }

/** 提交审批决策 */
{ type: 'approval_resolve'; id: string; decision: 'allow' | 'deny' }
```

**Server → Client（出站）：**

```typescript
/** 握手确认；表示当前连接已绑定逻辑 clientId */
{ type: 'hello_ack'; clientId: string }

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
| `approval_requested` | 起源 channel 是 WebSocketChannel 才会收到此请求；channel 内部按 `originClientId` 定向给该 client。其他 channel 不收到（由 RuntimeApp 按 turnId 路由过滤） |
| `approval_expired` | 同上，定向发给 `originClientId`（同 `approval_requested` 路由路径） |
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

  send(event: AgentEvent): void;
  onMessage(handler: (req: ChannelRunRequest) => Promise<void>): void;
  start(): Promise<void>;
  stop(): Promise<void>;
}
```

客户端首次启动时自行生成并持久化 `clientId`，建连后通过 `hello` 消息提交。`clientId` 直接作为 my-agent 内部使用的逻辑客户端标识。WebSocketChannel 不再引入独立的 `connectionId` 设计概念；当前活跃连接直接由 websocket 对象引用承载，连接自身绑定的 `clientId` 通过 socket 关联上下文维护。WebSocketChannel 内部维护两张核心映射表：

- `Map<sessionKey, Set<clientId>>`：session 到客户端集合，`send(event, sessionKey)` 按此广播
- `Map<clientId, WebSocket>`：clientId 到连接，用于 approval 定向发送

客户端完成 `hello(clientId)` 后，该逻辑客户端与当前 websocket 连接绑定。之后客户端发送 `run_turn` 时，channel 将该 `clientId` 写入 `ChannelRunRequest`，同时把该 clientId 注册进 sessionKey 对应的集合。若同一 `clientId` 后续重新连接，服务端采用“后连覆盖前连”策略，将逻辑客户端重新绑定到新连接，并立即主动关闭旧连接。连接断开时，`WebSocketChannel` 会立即清理自身维护的 transport 路由状态。若上层仍有按 `clientId` 管理的未过期 pending interactions，可在新的 `hello(clientId)` 成功后触发自动重投递；这属于上层交互管理，不属于 websocket transport 恢复。

关键时序可参考 [adapters-websocket-channel-design.md](./adapters-websocket-channel-design.md) 中的 `hello(clientId)` 接管图、`run_turn` 广播路径图、断线清理图和 pending interactions 重投递图。

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
src/adapters/channel/
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

### 9.1 `src/core/runner/hooks/types.ts`

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

### 9.2 `src/core/runner/AgentRunner.ts` 与 `types.ts`

- `RunParams` 新增 `turnId: string` 字段（**非可选**——RuntimeApp 保证始终传入）
- 触发 `before_tool_call` hook 时从 `RunParams` 读取 `turnId` 和 `sessionKey` 注入 payload
- 暴露事件注册 API `on(hookName, handler)`（若目前未暴露）
- **`AgentEvent` 类型富化：每个事件变体单独声明 `sessionKey: string` 和 `turnId: string` 字段**（不引入公共基类型抽象，因为不是所有未来事件都必然需要这两个字段——具体类型自己决定）。`AgentRunner` 在 emit 前从 `RunParams` 读取这两个字段并自动注入：

  ```typescript
  // 改前
  export type AgentEvent =
    | { type: 'run_start' }
    | { type: 'text_delta'; text: string }
    | ...;

  // 改后：每个变体自己列出 sessionKey/turnId
  export type AgentEvent =
    | { type: 'run_start'; sessionKey: string; turnId: string }
    | { type: 'text_delta'; sessionKey: string; turnId: string; text: string }
    | { type: 'tool_use'; sessionKey: string; turnId: string; name: string; input: Record<string, unknown> }
    | { type: 'tool_result'; sessionKey: string; turnId: string; name: string; result: ToolResult }
    | { type: 'llm_call'; sessionKey: string; turnId: string; round: number }
    | { type: 'run_end'; sessionKey: string; turnId: string; result: RunResult }
    | { type: 'error'; sessionKey: string; turnId: string; error: Error }
    | { type: 'tool_result_pruned'; sessionKey: string; turnId: string; toolUseId: string; originalChars: number; prunedChars: number }
    | { type: 'compaction_start'; sessionKey: string; turnId: string; trigger: 'preemptive' | 'overflow' | 'manual'; tokensBefore: number }
    | { type: 'compaction_end'; sessionKey: string; turnId: string; tokensBefore: number; tokensAfter: number; droppedMessages: number };
  ```

  `AgentRunner` 内部跟踪 `currentParams: RunParams | null`（`run()` 入口设置，`finally` 清理），emit 用一个**私有的**分发式 Omit 类型作为输入，避免每个 emit 调用点手写 sessionKey/turnId：

  ```typescript
  // AgentRunner 内部，私有，不 export
  type AgentEventInput = AgentEvent extends infer E
    ? E extends AgentEvent
      ? Omit<E, 'sessionKey' | 'turnId'>
      : never
    : never;

  private emit(event: AgentEventInput): void {
    if (!this.onEvent || !this.currentParams) return;
    this.onEvent({
      ...event,
      sessionKey: this.currentParams.sessionKey,
      turnId: this.currentParams.turnId,
    } as AgentEvent);
  }
  ```

  **注意：** 不要为 AgentEvent 引入公共基类型抽象（如把 `sessionKey`/`turnId` 提取到一个 `Base` 接口再交叉/继承）。每个变体自描述自己的字段，外部看到的就是平铺的 discriminated union。`AgentEventInput` 仅作为 `AgentRunner.emit` 的输入便利类型，**保持 private，不导出**。

  `AgentRunner.run()` 签名**保持不变**，仍是单参数。`AgentRunnerConfig.onEvent` 是统一的事件入口，由 RuntimeApp 在 bootstrap 时注入 fanout 闭包，handler 内按 `event.sessionKey` 自路由（详见 §9.6）。

#### 测试 helper

为减少 `turnId` 字段在测试中的样板代码，提供：

```typescript
// src/core/runner/test-helpers.ts
export function makeRunParams(overrides: Partial<RunParams> = {}): RunParams {
  return {
    sessionKey: 'main',
    message: '',
    model: 'test',
    systemPrompt: '',
    turnId: randomUUID(),
    ...overrides,
  };
}
```

#### AgentEvent 形状变更对测试的影响

事件富化后，所有 emit 出来的 AgentEvent 都多了 `sessionKey` 和 `turnId` 字段。已有测试中**严格匹配**事件对象的断言会失败，例如：

```typescript
// 改前（会失败）
expect(event).toEqual({ type: 'text_delta', text: 'hi' });

// 改后两种迁移方案任选其一：
// 方案 A：改用 partial matching
expect(event).toMatchObject({ type: 'text_delta', text: 'hi' });
// 方案 B：补上新字段
expect(event).toEqual({ type: 'text_delta', text: 'hi', sessionKey: 'main', turnId: expect.any(String) });
```

推荐方案 A。需要扫描所有 `expect(...).toEqual({ type: '...' })` 形态的 AgentEvent 断言批量替换。

### 9.3 `src/runtime/RuntimeApp.ts`

新增：
- 内部字段：`approvalManager: ApprovalManager`、`channels: Channel[]`、`originChannelByTurn: Map<string, Channel>`、`originClientByTurn: Map<string, string>`、`approvalRoutingWired: boolean`、`inFlightSessions: Set<string>`
- 公开方法：`registerChannel(channel)`、`startChannels()`、`stopChannels()`
- 私有方法：`wireApprovalRouting()`（启动时调用一次；详见 §4.3）、`makeMessageHandler(channel)`
- `startChannels` 入口先调 `wireApprovalRouting()` 再依次 `channel.start()`
- `runTurn` 入口：若 `params.turnId` 未提供则生成 UUID，透传 `turnId` 给 `AgentRunner.run`
- `registerChannel` 只把 channel 加入 `channels[]`，绑定 `onMessage` / `onApprovalDecision`，**不再** 注册 `onRequest` / `onExpire`（这两个由 `wireApprovalRouting` 一次性注册）
- `close()` 内部调用 `stopChannels()` 并 `approvalManager.close()`

`close()` 本身是否已存在：若已存在则在其中补调 `stopChannels()`；若不存在则本次新增。

**并发控制变更：`assertCanRun` → per-session in-flight 检查**

现有 `assertCanRun()` 检查 `phase !== 'ready'`，在多 channel/多 client 场景下会让任意"runtime 正在跑某个 turn"阻塞所有其他 session。改为：

```typescript
private inFlightSessions = new Set<string>();

private assertCanRunForSession(sessionKey: string): void {
  if (this.state.phase === 'closing' || this.state.phase === 'closed' || this.state.phase === 'failed') {
    throw createRuntimeError({
      scope: 'run', severity: 'recoverable', code: 'RUN_REJECTED',
      message: `Cannot run when runtime phase is ${this.state.phase}.`,
    });
  }
  if (this.inFlightSessions.has(sessionKey)) {
    throw createRuntimeError({
      scope: 'run', severity: 'recoverable', code: 'RUN_REJECTED',
      message: `Session ${sessionKey} already has a turn in flight.`,
    });
  }
}

async runTurn(params: RunTurnParams): Promise<RunTurnResult> {
  this.assertCanRunForSession(params.sessionKey);
  this.inFlightSessions.add(params.sessionKey);
  try {
    return await this.runTurnInternal(params);
  } finally {
    this.inFlightSessions.delete(params.sessionKey);
  }
}
```

**`phase` 字段语义变更**：仍是 runtime 整体生命周期标记（`starting`/`ready`/`closing`/`closed`/`failed`），但**不再**因为某个 session 的 turn 在跑而切到 `running`。`activeRunCount` 字段保留作为 metric，但不再作为 gate。

**为什么这样设计：**
- 同 session 串行：消息历史并发 append 会乱
- 跨 session 并发：每个 session 有独立的消息历史和压缩状态，互不干扰
- WebSocket 多 client 场景下，按 session key 隔离的 in-flight 检查是天然的并发控制粒度

### 9.4 `src/runtime/types.ts`

**两处改动：**

(a) `RunTurnParams` 新增**可选** `turnId?: string`（调用方可指定用于日志关联；不指定则由 RuntimeApp 生成）：

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

(b) `RuntimeAppOptions` 新增**可选** `onAgentEvent?: (event: AgentEvent) => void`（库消费者订阅 AgentEvent 流的官方入口，详见 §9.6、§9.7）：

```diff
 export interface RuntimeAppOptions {
   workspaceDir: string;
   agentId?: string;
   envOverrides?: DeepPartial<AgentDefaults>;
   cliOverrides?: DeepPartial<AgentDefaults>;
   dependencies?: Partial<RuntimeDependencies>;
   onEvent?: (event: RuntimeEvent) => void;
+  /** 可选的 AgentEvent 观察者（telemetry/调试日志用）。RuntimeApp 在 fanout 闭包末尾调用此回调，与 channel.send 并行触发 */
+  onAgentEvent?: (event: AgentEvent) => void;
 }
```

**不新增 `clientId`**——它是 channel↔RuntimeApp 的路由元数据，只存在于 `ChannelRunRequest`，不污染 library API。（与 openclaw 有意差异化：openclaw 的 `RunEmbeddedPiAgentParams` 直接携带 `messageChannel` / `messageProvider` / `messageTo` / `senderId` 等真实的外部平台寻址字段，agent 层会据此决定输出格式、注入 hook context，并在构造 approval 请求时复用为 `turnSource*` 字段；my-agent 的 `clientId` 只表示“由具体 channel 定义的客户端路由标识”，其具体来源与生命周期由各 channel 自己决定，例如 WebSocketChannel 可将其实现为客户端自声明并持久化的逻辑客户端标识）

`RunTurnResult` 不做变动。

### 9.5 `src/runtime/bootstrap.ts`

`createAgentRunner` 调用处增加一行，把 `RuntimeAppOptions.onAgentEvent` 透传给 runner 的构造参数：

```diff
 const agentRunner = deps.createAgentRunner({
   llmClient,
   sessionManager,
   toolExecutor: toolBundle.executor,
+  onEvent: options.onAgentEvent,
 });
```

`bootstrapRuntime` 自身的签名不变（`onAgentEvent` 已在 `RuntimeAppOptions` 中），无需新增参数。RuntimeApp 在 `create()` 内构造 fanout 闭包后，把它作为 `onAgentEvent` 字段填入 options 再调 `bootstrapRuntime`，整条链路自然贯通（详见 §9.6）。

### 9.6 AgentEvent 分发给 channel 的机制

**统一入口：`AgentRunnerConfig.onEvent`** —— RuntimeApp 在 bootstrap 时注入一个 fanout 闭包，runner 触发事件时该闭包遍历 `channels[]` 调 `channel.send(event)`。事件自身携带 `sessionKey`/`turnId`，channel 按需读取。

**实现方式：**

```typescript
// RuntimeApp.create
static async create(options: RuntimeAppOptions): Promise<RuntimeApp> {
  // 与未来的 RuntimeApp 实例共享的可变数组：registerChannel 后注册的新 channel 实时可见
  const channels: Channel[] = [];
  const userObserver = options.onAgentEvent;  // 可选的库消费者观察者

  const fanout = (event: AgentEvent) => {
    for (const channel of channels) {
      channel.send(event);  // event 自带 sessionKey/turnId，channel 自路由
    }
    userObserver?.(event);
  };

  const { resources, state } = await bootstrapRuntime({
    ...options,
    onAgentEvent: fanout,   // 透传给 deps.createAgentRunner({ ..., onEvent: fanout })
  });

  return new RuntimeApp(resources, state, channels, options.onEvent);
}

registerChannel(channel: Channel): void {
  this.channels.push(channel);  // bootstrap 闭包共享此数组引用，新 channel 即时收到事件
  // ...其他绑定见 §4.3
}
```

**关键性质：**

- **统一入口**：runner 只有一个 `onEvent` 槽，事件从一处分发，避免多机制并行
- **事件自描述**：每个 AgentEvent 自带 `sessionKey`/`turnId`，channel/telemetry 直接读取，无需外部上下文
- **多 session 并发安全**：每个事件独立携带路由信息，handler 不依赖闭包/状态查表
- **registerChannel 时机宽松**：`channels[]` 共享引用，runTurn 进行中注册的新 channel 也能收到后续事件
- **bootstrap 与 RuntimeApp 实例的循环依赖**：通过共享可变数组解决——bootstrap 时数组为空，RuntimeApp 实例化后通过 `registerChannel` 填充
- **现有 `chat.ts` 模式仍兼容**：库消费者可通过 `dependencies.createAgentRunner` 覆盖来自定义 onEvent，但更推荐使用 `RuntimeAppOptions.onAgentEvent` 选项

### 9.7 三类回调入口

需要区分三类回调，避免混淆：

| 名称 | 类型 | 何时设置 | 用途 |
|------|------|----------|------|
| `RuntimeAppOptions.onEvent` | `(event: RuntimeEvent) => void` | `RuntimeApp.create()` 时 | 接收 runtime 生命周期事件（`app_start`/`turn_start`/`turn_end`/`shutdown_*` 等），与 channel 层无关 |
| `RuntimeAppOptions.onAgentEvent` | `(event: AgentEvent) => void` | `RuntimeApp.create()` 时 | **新增**——库消费者订阅 AgentEvent 流（如 telemetry、调试日志）。RuntimeApp 把它包进 fanout 闭包，与 channel.send 并行触发 |
| `AgentRunnerConfig.onEvent` | `(event: AgentEvent) => void` | `bootstrap` 创建 runner 时 | **RuntimeApp 内部使用**：bootstrap 注入的 fanout 闭包就走这条路。库消费者**一般不直接覆盖**，要订阅 AgentEvent 请用 `RuntimeAppOptions.onAgentEvent`；如需完全替换（例如 chat.ts 那种全自定义），仍可通过 `dependencies.createAgentRunner` 覆盖 |

**`AgentRunner.run` 签名保持单参数**——事件路由信息内嵌在 AgentEvent 自身（`sessionKey`/`turnId` 字段），不需要 per-call onEvent 参数。

### 9.8 `scripts/chat.ts`

作为临时测试脚本**废弃**。CLI 交互能力由 `CliChannel` 提供。

### 9.9 改动总览（实现 checklist）

| 维度 | 文件 | 改动 |
|------|------|------|
| 类型 | `src/core/runner/hooks/types.ts` | `BeforeToolCallPayload` 加 `turnId` + `sessionKey`（§9.1） |
| 类型 | `src/core/runner/types.ts` | `RunParams` 加 `turnId`（必填）；`AgentEvent` 每个变体单独声明 `sessionKey` + `turnId`（不引入公共基类型）（§9.2） |
| 类型 | `src/runtime/types.ts` | `RunTurnParams` 加 `turnId?`；`RuntimeAppOptions` 加 `onAgentEvent?`（§9.4） |
| 行为 | `src/core/runner/AgentRunner.ts` | `emit()` 注入路由字段；hook payload 注入 `turnId`/`sessionKey`；暴露 `on()` 注册 API（§9.2） |
| 行为 | `src/runtime/bootstrap.ts` | `createAgentRunner` 调用补 `onEvent: options.onAgentEvent`（§9.5） |
| 行为 | `src/runtime/RuntimeApp.ts` | 全面重构（channels 数组、approval 路由、in-flight gate、create/close）（§9.3） |
| 新增 | `src/core/runner/test-helpers.ts` | `makeRunParams()` helper（§9.2） |
| 测试 | `src/core/runner/*.test.ts` | runner.run 调用补 `turnId`；AgentEvent 断言用 `toMatchObject`（§9.2） |
| 删除 | `scripts/chat.ts` | 废弃（§9.8） |

**非破坏性原则确认：**
- ✅ `AgentRunner.run()` 签名不变（仍是单参数）
- ✅ `RuntimeAppOptions.onEvent` 不变（仍是 RuntimeEvent，与 channel 层无关）
- ✅ `dependencies.createAgentRunner` 覆盖机制不变
- ⚠️ `AgentEvent` 形状变化（加 2 字段）—— 影响所有严格匹配的测试
- ⚠️ `RunParams.turnId` 必填 —— 影响所有 `runner.run({...})` 调用

---

## 10. 设计决策记录

| 问题 | 决策 | 依据 |
|------|------|------|
| `AgentEvent` 怎么从 runner 转发到多个 channel？ | 富化 `AgentEvent` 类型让每个事件自带 `sessionKey`/`turnId`；RuntimeApp 在 bootstrap 时给 `AgentRunnerConfig.onEvent` 注入 fanout 闭包，闭包共享 `channels[]` 引用，遍历调 `channel.send(event)` | 单一事件入口避免多机制并行（per-call + 构造时）造成处理代码分散；事件自描述对 telemetry/log 也更友好；`channels[]` 数组共享引用使 registerChannel 时机宽松；多 session 并发时事件携带自身路由信息，无需闭包/查表 |
| `AgentEvent` 是否要保留 per-call onEvent 选项？ | 不保留，统一走 `AgentRunnerConfig.onEvent` | per-call onEvent 与构造时 onEvent 并存会让事件处理代码分散到两处，调试与重构成本高；事件富化方案下，单入口已能完全表达路由意图，没有 per-call 的必要 |
| 多 channel 同时启用 approval 时怎么避免广播？ | RuntimeApp 维护 `originChannelByTurn: Map<turnId, Channel>` 路由表；`onRequest` / `onExpire` 在 RuntimeApp 启动时**注册一次**，handler 内按 turnId 查表只通知起源 channel | "谁发起的 turn 谁解决 approval"符合直觉与安全：避免任意 channel deny 他人发起的操作；ApprovalManager 保持单 handler API，复杂度集中在 RuntimeApp 路由层；若起源 channel 已注销则不主动 deny，让 ApprovalManager 走超时按 deny 处理，便于诊断 |
| 库模式（无 channel 直调 runTurn）触发 tool 时怎么处理 approval？ | RuntimeApp 启动时若 `channels.some(c => c.approval)` 为 false 则**根本不注册 hook**，所有 tool 调用直通 | 没有可呈现 UI 的 channel 就没有人能做决策，等待超时只会拖慢库消费者；不注册 hook 等价于"无审批机制"，行为最直观；与 hook 系统的可选注册保持一致 |
| 跨 session 是否允许并发 turn？ | 允许；以 `inFlightSessions: Set<string>` 做 per-session 串行，不再用全局 phase 阻塞 | 同 session 串行是消息历史一致性的硬约束；跨 session 的状态完全隔离（独立的会话历史与压缩状态），没有理由互斥；WebSocket 多 client 多 session 场景需要并发能力，全局 phase gate 会让任意 turn 阻塞所有其他用户 |
| 为什么 `clientId` 不进入 `RunTurnParams`？ | `clientId` 是 channel↔RuntimeApp 的路由元数据，library 调用方（直接调用 `runTurn`）不应感知 transport 概念 | 与 openclaw 有意差异化：openclaw 的 `RunEmbeddedPiAgentParams` 直接携带 `messageChannel` / `messageTo` 等真实平台寻址字段（agent 层据此决定格式、注入 hook context，并复用为 approval 请求的 `turnSource*` 字段路由回原平台）；my-agent 的 `clientId` 只表达“当前 channel 用来标识客户端的内部路由值”，由 `originClientByTurn` 等映射管理更合适，不污染 library API；在 WebSocketChannel 中，这个值可进一步特化为客户端自声明并持久化的逻辑客户端标识 |
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
| 事件补发 / replay buffer | client 重连后按消息序号补发断线期间遗漏的事件流 |
