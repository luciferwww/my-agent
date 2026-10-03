export type ApprovalResult =
  | { readonly outcome: 'approved' }
  | { readonly outcome: 'approved'; readonly source: 'session_allow_all' }
  | { readonly outcome: 'denied'; readonly reason: 'user' | 'user_cancelled' }
  | { readonly outcome: 'aborted'; readonly reason: 'turn' | 'shutdown' }
  | {
      readonly outcome: 'unavailable';
      readonly reason: 'origin_missing' | 'delivery_failed' | 'origin_disconnected';
    }
  | { readonly outcome: 'failed'; readonly message: string };

export interface CurrentCallApprovalCapability {
  request(
    request: {
      readonly callId: string;
      readonly toolName: string;
      readonly input: Readonly<Record<string, unknown>>;
      readonly sessionId: string;
      readonly turnId: string;
    },
    signal: AbortSignal,
  ): Promise<ApprovalResult>;
}

export type SessionPermissionMode = 'manual' | 'allow_all';

export interface SessionPermissionState {
  readonly sessionId: string;
  readonly mode: SessionPermissionMode;
  readonly changedAt: number;
  readonly changedByClientId?: string;
}
