import type { AgentEvent } from '../../core/runner/types.js';

// ── 入站消息 ──────────────────────────────────────────────────

/** Channel 发给 RuntimeApp 的运行请求 */
export interface ChannelRunRequest {
  sessionKey: string;
  message: string;
  model?: string;
  maxTokens?: number;
  maxToolRounds?: number;
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
