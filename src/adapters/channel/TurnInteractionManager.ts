import { randomUUID } from 'node:crypto';
import { Logger } from '../../platform/logger/index.js';
import type {
  ApprovalDecision,
  ApprovalClosedResult,
  ApprovalDeliveryResult,
  ApprovalRequest,
  ApprovalRequestOptions,
  ApprovalResult,
} from './types.js';

const log = Logger.get('TurnInteractionManager');

type PendingEntry = {
  resolve: (result: ApprovalResult) => void;
  request: ApprovalRequest;
  signal: AbortSignal;
  abortHandler: () => void;
};

/**
 * 进程内 Promise bus，管理 turn 内阻塞式交互的 pending 生命周期。
 *
 * 当前实现仍以 approval 为唯一交互类型，但路由位置已经是 turn interaction 层。
 * `onRequest` / `onClose` 由 RuntimeApp 在初始化时注册一次（详见 channel-design.md §4.3）。
 * handler 内部按 `request.turnId` 查 `originChannelByTurn` 表定向路由给起源 channel，
 * 不在 channel 间广播。
 */
export class TurnInteractionManager {
  private pending = new Map<string, PendingEntry>();
  private requestHandler?: (request: ApprovalRequest) => ApprovalDeliveryResult;
  private closeHandler?: (request: ApprovalRequest, result: ApprovalClosedResult) => void;

  /**
  * 发起审批请求，返回 Promise，在决策、Turn 生命周期或 origin capability 终止后 resolve。
   * 调用方（before_tool_call hook）await 此方法阻塞等待。
   */
  request({ request: params, signal }: ApprovalRequestOptions): Promise<ApprovalResult> {
    const id = randomUUID();
    const request: ApprovalRequest = { ...params, id };

    log.info('interaction request created', {
      interactionId: id,
      toolName: request.toolName,
      sessionKey: request.sessionKey,
      turnId: request.turnId,
      originClientId: request.originClientId,
    });

    return new Promise<ApprovalResult>((resolve) => {
      const abortHandler = () => {
        const reason = signal.reason === 'shutdown' ? 'shutdown' : 'turn';
        this.settle(id, { outcome: 'aborted', reason });
      };

      this.pending.set(id, { resolve, request, signal, abortHandler });
      signal.addEventListener('abort', abortHandler, { once: true });
      log.debug('interaction request pending', {
        interactionId: id,
        pendingCount: this.pending.size,
      });

      if (signal.aborted) {
        abortHandler();
        return;
      }

      // 通知 channel 呈现审批 UI；初始不可达立即 fail closed。
      try {
        const delivery = this.requestHandler?.(request) ?? {
          status: 'unavailable' as const,
          reason: 'origin_missing' as const,
        };
        if (delivery.status === 'unavailable') {
          this.settle(id, { outcome: 'unavailable', reason: delivery.reason });
        }
      } catch (error) {
        this.settle(id, {
          outcome: 'failed',
          message: error instanceof Error ? error.message : String(error),
        });
      }
    });
  }

  /**
   * 提交决策（由 channel 在收到用户输入后调用）。
  * 若 id 不存在或已经结束，静默忽略。
   */
  resolve(id: string, decision: ApprovalDecision): void {
    this.settle(
      id,
      decision === 'allow'
        ? { outcome: 'approved' }
        : { outcome: 'denied', reason: 'user' },
    );
  }

  settle(id: string, result: ApprovalResult): boolean {
    const entry = this.pending.get(id);
    if (!entry) {
      log.warn('interaction settlement ignored for unknown id', {
        interactionId: id,
        outcome: result.outcome,
      });
      return false;
    }

    this.pending.delete(id);
    entry.signal.removeEventListener('abort', entry.abortHandler);
    log.info('interaction settled', {
      interactionId: id,
      outcome: result.outcome,
      toolName: entry.request.toolName,
      sessionKey: entry.request.sessionKey,
      turnId: entry.request.turnId,
      pendingCount: this.pending.size,
    });
    entry.resolve(result);
    if (result.outcome !== 'approved' && result.outcome !== 'denied') {
      try {
        this.closeHandler?.(entry.request, result);
      } catch (error) {
        log.error('interaction close handler failed', {
          interactionId: id,
          outcome: result.outcome,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return true;
  }

  /**
   * 注册审批请求通知回调。
   * 由 RuntimeApp 在初始化时注册一次；handler 内部按 request.turnId 路由给起源 channel。
   * 再次调用会替换前一个 handler。
   */
  onRequest(handler: (request: ApprovalRequest) => ApprovalDeliveryResult): void {
    this.requestHandler = handler;
    log.debug('interaction request handler registered');
  }

  /**
   * 注册未获得人工决策的交互终结回调。
   * 由 RuntimeApp 在初始化时注册一次；路由策略同 onRequest。
   */
  onClose(handler: (request: ApprovalRequest, result: ApprovalClosedResult) => void): void {
    this.closeHandler = handler;
    log.debug('interaction close handler registered');
  }

  /** 取消所有 pending 请求，用于关闭时的幂等兜底清理。 */
  close(): void {
    log.info('closing pending interactions', {
      pendingCount: this.pending.size,
    });
    for (const id of [...this.pending.keys()]) {
      this.settle(id, { outcome: 'aborted', reason: 'shutdown' });
    }
    this.requestHandler = undefined;
    this.closeHandler = undefined;
  }
}