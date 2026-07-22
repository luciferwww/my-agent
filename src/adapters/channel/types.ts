import type { AgentEvent } from '../../core/runner/types.js';

// ── 入站消息 ──────────────────────────────────────────────────

/**
 * Wire-level inbound content block.
 *
 * 与内部 `ChatContentBlock` 的关键区别：image 不带 `dimensions`（runtime 会重新 sniff）。
 * Channel 仅做 shape check，不做 MIME/字节量校验——交给 media 层。
 */
export type InboundContentBlock =
  | { type: 'text'; text: string }
  | {
      type: 'image';
      source: {
        type: 'base64';
        media_type: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';
        data: string;
      };
    };

/** Channel 发给 RuntimeApp 的运行请求 */
export interface ChannelRunRequest {
  sessionKey: string;
  message: string | InboundContentBlock[];
  model?: string;
  maxTokens?: number;
  maxLlmCalls?: number;
  /** 发起本次请求的逻辑客户端标识；由具体 channel 提供，用于将交互请求路由回原始客户端 */
  clientId?: string;
}

// ── 通用 turn 交互 ────────────────────────────────────────────

export type TurnInteractionKind =
  | 'approval'
  | 'select';

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
  /** 发起本次 turn 的 turnId，由 RuntimeApp 根据此字段路由到起源 channel */
  turnId: string;
  /** 发起本次 run 的客户端标识符；WebSocketChannel 用此字段定向路由，CliChannel 可忽略 */
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
  | (TurnInteractionResponseBase<'approval'> & {
      outcome: 'submitted';
      decision: ApprovalDecision;
    })
  | (TurnInteractionResponseBase<'approval'> & {
      outcome: 'cancelled' | 'expired' | 'aborted';
    });

export type SelectInteractionResponse =
  | (TurnInteractionResponseBase<'select'> & {
      outcome: 'submitted';
      value: string;
    })
  | (TurnInteractionResponseBase<'select'> & {
      outcome: 'cancelled' | 'expired' | 'aborted';
    });

export type TurnInteractionResponse =
  | ApprovalInteractionResponse
  | SelectInteractionResponse;

// ── 审批（兼容 Phase 1 现有 API）──────────────────────────────

export interface ApprovalRequest {
  id: string;
  toolName: string;
  input: Record<string, unknown>;
  sessionKey: string;
  /** 发起本次 turn 的 turnId，由 RuntimeApp 根据此字段路由到起源 channel */
  turnId: string;
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
 * Runtime → Channel 注入的 abort 交互能力。
 *
 * 让 channel 想自主触发 abort（如 CLI 的 Ctrl+C、Web 的 Stop 按钮）时不需要
 * 反向 import `RuntimeApp`。Runtime 在 `registerChannel` 时通过 optional
 * `bindAbortHooks?(...)` 注入这一组回调。详见 core-abort-spec.md §12。
 */
export interface AbortHookBindings {
  /**
   * 返回当前需要 abort 的 sessionKey 列表 —— 包含：
   *  (i) 有 active turn 的 session（`activeAborts` 命中）
   *  (ii) 有 queued/followup messages 的 session（`messageQueueBySession` 非空）
   * 两者 union、去重。为空时 CLI 可安全地仅提示退出，不需要调 abortTurn。
   */
  querySessionsNeedingAbort(): string[];
  /** 触发 abort + drop queue；返回精确数字供 channel 渲染（不依赖 event）。 */
  abortTurn(sessionKey: string): { aborted: boolean; dropped: number };
}

/**
 * channel 适配器接口。
 *
 * 实现此接口即可将任意 I/O 方式接入 RuntimeApp。
 * `interaction` 是面向 Phase 2 的通用交互能力；`approval` 保留为 Phase 1 兼容接口。
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

  /** 通用 turn 交互能力（可选，Phase 2 预留） */
  interaction?: ChannelInteractionAdapter;

  /** 审批交互能力（可选） */
  approval?: ChannelApprovalAdapter;

  /**
   * 可选：channel 想自主触发 abort（如 CLI 的 Ctrl+C、Web 的 Stop 按钮）时，
   * Runtime 通过此方法注入 `AbortHookBindings`。channel 不需要 import `RuntimeApp`。
   * 详见 core-abort-spec.md §12。
   *
   * **时序**：`registerChannel` 同步调用；channel 随后在其 `start()` 里安装 SIGINT
   * handler（或类似触发源）。所以任何 abort 触发时 hooks 必已 bound，无 race。
   */
  bindAbortHooks?(hooks: AbortHookBindings): void;
}

/**
 * 通用 turn 交互适配器。
 *
 * `approval` 可以视为其一个特例：Phase 1 沿用老接口，后续新交互优先走这里。
 */
export interface ChannelInteractionAdapter {
  /** RuntimeApp 推送交互请求给 channel（channel 负责呈现给用户） */
  sendInteractionRequest(request: TurnInteractionRequest): void;

  /** RuntimeApp 推送交互结束/过期通知给 channel（channel 负责关闭对应 UI） */
  sendInteractionExpired(request: TurnInteractionRequest): void;

  /** channel 注册交互响应处理器（由 RuntimeApp 在 registerChannel 时调用） */
  onInteractionResponse(
    handler: (response: TurnInteractionResponse) => void,
  ): void;
}

/**
 * 审批交互适配器。
 *
 * RuntimeApp 检测到 channel.approval 存在时自动接入 TurnInteractionManager。
 * 不实现此接口的 channel 不具备审批能力，
 * TurnInteractionManager 将在超时后按默认策略处理。
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
