import { randomUUID } from 'node:crypto';
import type {
  ApprovalDecision,
  ApprovalClosedResult,
  ApprovalDeliveryResult,
  ApprovalRequest,
  ApprovalRequestOptions,
  ApprovalResult,
} from '../../core/channel/index.js';

interface TurnInteractionLogger {
  debug(message: string, context?: Record<string, unknown>): void;
  info(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  error(message: string, context?: Record<string, unknown>): void;
}

type PendingEntry = {
  resolve: (result: ApprovalResult) => void;
  request: ApprovalRequest;
  signal: AbortSignal;
  abortHandler: () => void;
};

/** Manages the lifecycle of blocking interactions within a Turn. */
export class TurnInteractionManager {
  private pending = new Map<string, PendingEntry>();
  private requestHandler?: (request: ApprovalRequest) => ApprovalDeliveryResult;
  private closeHandler?: (request: ApprovalRequest, result: ApprovalClosedResult) => void;

  constructor(private readonly log: TurnInteractionLogger) {}

  request({ request: params, signal }: ApprovalRequestOptions): Promise<ApprovalResult> {
    const id = randomUUID();
    const request: ApprovalRequest = { ...params, id };

    this.log.info('interaction request created', {
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
      this.log.debug('interaction request pending', {
        interactionId: id,
        pendingCount: this.pending.size,
      });

      if (signal.aborted) {
        abortHandler();
        return;
      }

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
      this.log.warn('interaction settlement ignored for unknown id', {
        interactionId: id,
        outcome: result.outcome,
      });
      return false;
    }

    this.pending.delete(id);
    entry.signal.removeEventListener('abort', entry.abortHandler);
    this.log.info('interaction settled', {
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
        this.log.error('interaction close handler failed', {
          interactionId: id,
          outcome: result.outcome,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return true;
  }

  onRequest(handler: (request: ApprovalRequest) => ApprovalDeliveryResult): void {
    this.requestHandler = handler;
    this.log.debug('interaction request handler registered');
  }

  onClose(handler: (request: ApprovalRequest, result: ApprovalClosedResult) => void): void {
    this.closeHandler = handler;
    this.log.debug('interaction close handler registered');
  }

  close(): void {
    this.log.info('closing pending interactions', {
      pendingCount: this.pending.size,
    });
    for (const id of [...this.pending.keys()]) {
      this.settle(id, { outcome: 'aborted', reason: 'shutdown' });
    }
    this.requestHandler = undefined;
    this.closeHandler = undefined;
  }
}