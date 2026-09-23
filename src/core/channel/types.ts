import type { ApprovalResult } from '../approval/index.js';
import type {
  SessionPermissionMode,
  SessionPermissionState,
} from '../approval/index.js';
import type { ModelReference } from '../model-resolution/index.js';
import type { AgentEvent } from '../runner/types.js';

export type { ApprovalResult } from '../approval/index.js';

export type InboundContentBlock =
  | { type: 'text'; text: string }
  | {
      type: 'image';
      source: {
        type: 'base64';
        mediaType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';
        data: string;
      };
    };

export interface ChannelRunRequest {
  sessionId: string;
  message: string | InboundContentBlock[];
  modelReference?: ModelReference;
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
  sessionId: string;
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
  sessionId: string;
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
  | { outcome: 'approved'; source: 'session_allow_all' }
>;

export type ApprovalDeliveryResult =
  | { status: 'accepted' }
  | { status: 'unavailable'; reason: 'origin_missing' | 'delivery_failed' };

export interface ModelCatalogEntry {
  readonly modelId: string;
  readonly displayName: string;
  readonly capabilities?: {
    readonly toolUse?: boolean;
    readonly mediaKinds?: readonly string[];
  };
}

export interface ProviderCatalogEntry {
  readonly providerId: string;
  readonly displayName: string;
  readonly models: readonly ModelCatalogEntry[];
}

export type DefaultModelSelection =
  | Readonly<{ state: 'unset' }>
  | Readonly<{ state: 'available'; reference: ModelReference }>
  | Readonly<{
      state: 'unavailable';
      reference: ModelReference;
      reason: 'provider_unregistered' | 'model_rejected';
    }>;

export interface ModelCatalogSnapshot {
  readonly generation: number;
  readonly defaultSelection: DefaultModelSelection;
  readonly providers: readonly ProviderCatalogEntry[];
}

export interface ModelCatalogQuery {
  getSnapshot(): ModelCatalogSnapshot;
}

export interface TurnAbortCapability {
  querySessionsNeedingAbort(): string[];
  abortTurn(sessionId: string): { aborted: boolean; dropped: number };
}

/** Channel 只通过此能力申请服务端 Session ID；创建本身不会写入持久化 Session。 */
export interface SessionCapabilityEntry {
  readonly sessionId: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly title?: string;
  readonly archivedAt?: number;
  readonly forkedFromSessionId?: string;
}

export interface SessionCapability {
  createSession(input?: {
    permissionMode?: SessionPermissionMode;
    originClientId?: string;
  }): Promise<{ sessionId: string; permission: SessionPermissionState }>;
  listSessions(input?: { archived?: boolean }): Promise<SessionCapabilityEntry[]>;
  getSession(sessionId: string): Promise<SessionCapabilityEntry>;
  renameSession(sessionId: string, title: string | null): Promise<SessionCapabilityEntry>;
  archiveSession(sessionId: string): Promise<SessionCapabilityEntry>;
  unarchiveSession(sessionId: string): Promise<SessionCapabilityEntry>;
  deleteSession(sessionId: string): Promise<void>;
  forkSession(sessionId: string, entryId?: string): Promise<SessionCapabilityEntry>;
  getPermissionMode(sessionId: string): SessionPermissionState;
  setPermissionMode(input: {
    sessionId: string;
    mode: SessionPermissionMode;
    originClientId?: string;
  }): SessionPermissionState;
  onPermissionModeChanged(
    handler: (state: SessionPermissionState) => void,
  ): () => void;
}

export interface ChannelRuntimeCapabilities {
  readonly modelCatalog: ModelCatalogQuery;
  readonly abort: TurnAbortCapability;
  readonly sessions: SessionCapability;
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
  send(event: AgentEvent): void | Promise<void>;
  onMessage(handler: (request: ChannelRunRequest) => Promise<void>): void;
  start(): Promise<void>;
  stop(): Promise<void>;
  readonly interaction?: ChannelInteractionTransport;
  bindRuntimeCapabilities?(capabilities: ChannelRuntimeCapabilities): void;
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
  send(event: AgentEvent): void | Promise<void>;
  readonly interaction?: ChannelRuntimeInteraction;
}

export interface ChannelProjection {
  readonly bindings: readonly ChannelRuntimeBinding[];
  resolve(id: string): ChannelRuntimeBinding | undefined;
}

export interface ChannelCompletionObserver {
  waitForChannelCompletion(id: string): Promise<ChannelCompletion>;
}

export interface ChannelRuntimeHost {
  onMessage(binding: ChannelRuntimeBinding, request: ChannelRunRequest): Promise<void>;
  onInteractionResponse(response: TurnInteractionResponse): void;
  onInteractionUnavailable(id: string, reason: 'origin_disconnected'): void;
  readonly capabilities: ChannelRuntimeCapabilities;
}
