import { randomUUID } from 'node:crypto';
import type {
  ApprovalDecision,
  ApprovalRequest,
  ApprovalResult,
} from './types.js';

const DEFAULT_TIMEOUT_MS = 120_000;

export interface ApprovalManagerConfig {
  /** 默认超时（毫秒），超时后按 deny 处理；默认 120_000 */
  defaultTimeoutMs?: number;
}

type PendingEntry = {
  resolve: (result: ApprovalResult) => void;
  timer: NodeJS.Timeout;
  request: ApprovalRequest;
};

/**
 * 进程内 Promise bus，解耦审批请求（来自 before_tool_call hook）与决策（来自任意 channel）。
 *
 * `onRequest` / `onExpire` 由 RuntimeApp 在初始化时注册一次（详见 channel-design.md §4.3）。
 * handler 内部按 `request.turnId` 查 `originChannelByTurn` 表定向路由给起源 channel，
 * 不在 channel 间广播。
 */
export class ApprovalManager {
  private readonly defaultTimeoutMs: number;
  private pending = new Map<string, PendingEntry>();
  private requestHandler?: (request: ApprovalRequest) => void;
  private expireHandler?: (request: ApprovalRequest) => void;

  constructor(config: ApprovalManagerConfig = {}) {
    this.defaultTimeoutMs = config.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /**
   * 发起审批请求，返回 Promise，在决策到达或超时后 resolve。
   * 调用方（before_tool_call hook）await 此方法阻塞等待。
   */
  request(params: Omit<ApprovalRequest, 'id'>): Promise<ApprovalResult> {
    const id = randomUUID();
    const request: ApprovalRequest = { ...params, id };
    const timeoutMs = params.timeoutMs ?? this.defaultTimeoutMs;

    return new Promise<ApprovalResult>((resolve) => {
      const timer = setTimeout(() => {
        const entry = this.pending.get(id);
        if (!entry) return;
        this.pending.delete(id);
        entry.resolve({ decision: 'deny', reason: 'timeout' });
        this.expireHandler?.(entry.request);
      }, timeoutMs);

      // Allow process to exit even if timer is still pending (Node-specific).
      timer.unref?.();

      this.pending.set(id, { resolve, timer, request });

      // 通知 channel 呈现审批 UI
      this.requestHandler?.(request);
    });
  }

  /**
   * 提交决策（由 channel 在收到用户输入后调用）。
   * 若 id 不存在或已过期，静默忽略。
   */
  resolve(id: string, decision: ApprovalDecision): void {
    const entry = this.pending.get(id);
    if (!entry) return;
    this.pending.delete(id);
    clearTimeout(entry.timer);
    entry.resolve(
      decision === 'allow'
        ? { decision: 'allow' }
        : { decision: 'deny', reason: 'user' },
    );
  }

  /**
   * 注册审批请求通知回调。
   * 由 RuntimeApp 在初始化时注册一次；handler 内部按 request.turnId 路由给起源 channel。
   * 再次调用会替换前一个 handler。
   */
  onRequest(handler: (request: ApprovalRequest) => void): void {
    this.requestHandler = handler;
  }

  /**
   * 注册超时通知回调。
   * 由 RuntimeApp 在初始化时注册一次；路由策略同 onRequest。
   */
  onExpire(handler: (request: ApprovalRequest) => void): void {
    this.expireHandler = handler;
  }

  /** 取消所有 pending 请求（按 deny+timeout 处理），用于关闭时清理 */
  close(): void {
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.resolve({ decision: 'deny', reason: 'timeout' });
    }
    this.pending.clear();
    this.requestHandler = undefined;
    this.expireHandler = undefined;
  }
}
