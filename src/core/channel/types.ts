import type { ApprovalResult } from '../approval/index.js';
import type { ModelReference, ModelRequestOverride } from '../model-resolution/index.js';
import type { AgentEvent } from '../runner/types.js';

export type { ApprovalResult } from '../approval/index.js';

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

export interface ChannelRunRequest {
  sessionKey: string;
  message: string | InboundContentBlock[];
  modelReference?: ModelReference;
  requestOverride?: ModelRequestOverride;
  maxLlmCalls?: number;
  clientId?: string;
}

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
  turnId: string;
  originClientId?: string;
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

export type TurnInteractionRequest = ApprovalInteractionRequest | SelectInteractionRequest;
export type TurnInteractionOutcome = 'submitted' | 'cancelled' | 'aborted';

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
      outcome: 'cancelled' | 'aborted';
    });

export type SelectInteractionResponse =
  | (TurnInteractionResponseBase<'select'> & {
      outcome: 'submitted';
      value: string;
    })
  | (TurnInteractionResponseBase<'select'> & {
      outcome: 'cancelled' | 'aborted';
    });

export type TurnInteractionResponse = ApprovalInteractionResponse | SelectInteractionResponse;

export interface ApprovalRequest {
  id: string;
  toolName: string;
  input: Record<string, unknown>;
  sessionKey: string;
  turnId: string;
  originClientId?: string;
}

export type ApprovalDecision = 'allow' | 'deny';

export interface ApprovalRequestOptions {
  request: Omit<ApprovalRequest, 'id'>;
  signal: AbortSignal;
}

export type ApprovalClosedResult = Extract<
  ApprovalResult,
  { outcome: 'aborted' | 'unavailable' | 'failed' }
>;

export type ApprovalDeliveryResult =
  | { status: 'accepted' }
  | { status: 'unavailable'; reason: 'origin_missing' | 'delivery_failed' };

export interface AbortHookBindings {
  querySessionsNeedingAbort(): string[];
  abortTurn(sessionKey: string): { aborted: boolean; dropped: number };
}

export interface ChannelInteractionTransport {
  sendInteractionRequest(request: TurnInteractionRequest): ApprovalDeliveryResult;
  sendInteractionClosed(request: TurnInteractionRequest, result: ApprovalClosedResult): void;
  onInteractionResponse(handler: (response: TurnInteractionResponse) => void): void;
  onInteractionUnavailable(
    handler: (id: string, reason: 'origin_disconnected') => void,
  ): void;
}

export type ChannelCompletion =
  | {
      readonly outcome: 'closed';
      readonly reason: 'input_closed' | 'transport_closed' | 'stopped';
    }
  | {
      readonly outcome: 'failed';
      readonly phase: 'startup' | 'runtime' | 'shutdown';
      readonly error: Error;
    };

export interface ChannelInstance {
  readonly id: string;
  readonly completion: Promise<ChannelCompletion>;
  send(event: AgentEvent): void;
  onMessage(handler: (request: ChannelRunRequest) => Promise<void>): void;
  start(): Promise<void>;
  stop(): Promise<void>;
  readonly interaction?: ChannelInteractionTransport;
  bindAbortHooks?(hooks: AbortHookBindings): void;
}

/** Existing adapter-facing name; this is the same core-owned contract. */
export type Channel = ChannelInstance;
export type ChannelInteractionAdapter = ChannelInteractionTransport;

export interface ChannelContribution {
  readonly id: string;
  create(): ChannelInstance;
}

export interface ChannelRuntimeInteraction {
  sendInteractionRequest(request: TurnInteractionRequest): ApprovalDeliveryResult;
  sendInteractionClosed(request: TurnInteractionRequest, result: ApprovalClosedResult): void;
}

export interface ChannelRuntimeBinding {
  readonly id: string;
  send(event: AgentEvent): void;
  readonly interaction?: ChannelRuntimeInteraction;
}

export interface ChannelProjection {
  readonly bindings: readonly ChannelRuntimeBinding[];
  resolve(id: string): ChannelRuntimeBinding | undefined;
}

export interface ChannelLifecycleReport {
  readonly completed: readonly string[];
  readonly failed: readonly { readonly channelId: string; readonly message: string }[];
}

export interface ChannelShutdownHandoff {
  runtimeConverged(): Promise<ChannelLifecycleReport>;
}

export interface ChannelCompletionObserver {
  waitForChannelCompletion(id: string): Promise<ChannelCompletion>;
}

export interface ChannelRuntimeHost {
  onMessage(binding: ChannelRuntimeBinding, request: ChannelRunRequest): Promise<void>;
  onInteractionResponse(response: TurnInteractionResponse): void;
  onInteractionUnavailable(id: string, reason: 'origin_disconnected'): void;
  readonly abortHooks: AbortHookBindings;
}
