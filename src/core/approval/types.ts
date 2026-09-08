export type ApprovalResult =
  | { readonly outcome: 'approved' }
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
      readonly sessionKey: string;
      readonly turnId: string;
    },
    signal: AbortSignal,
  ): Promise<ApprovalResult>;
}
