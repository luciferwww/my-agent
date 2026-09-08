import type { AgentEvent } from '../../core/runner/types.js';
import { isSubagentSessionKey, parseSubagentSessionKey } from '../../core/subagent/index.js';
import { Logger } from '../../platform/logger/index.js';
import { WS_MAX_PAYLOAD_BYTES } from '../../core/media/constants.js';
import type {
  AbortHookBindings,
  ApprovalClosedResult,
  ApprovalDecision,
  ApprovalRequest,
  Channel,
  ChannelCompletion,
  ChannelInteractionAdapter,
  ChannelRunRequest,
  InboundContentBlock,
  TurnInteractionResponse,
} from './types.js';
import { WebSocket, WebSocketServer, type RawData } from 'ws';

const log = Logger.get('WebSocketChannel');

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PATH = '/ws';
const CLOSE_CODE_SUPERSEDED = 1000;
const CLOSE_CODE_MAX_CLIENTS = 1008;

type ChannelErrorCode =
  | 'INVALID_JSON'
  | 'INVALID_MESSAGE'
  | 'UNSUPPORTED_MESSAGE'
  | 'SERVER_NOT_READY';

type ClientMessage =
  | {
      type: 'hello';
      clientId: string;
    }
  | {
      type: 'run_turn';
      sessionKey: string;
      message: string | InboundContentBlock[];
      modelReference?: ChannelRunRequest['modelReference'];
      requestOverride?: ChannelRunRequest['requestOverride'];
      maxLlmCalls?: number;
    }
  | {
      type: 'approval_resolve';
      id: string;
      decision: ApprovalDecision;
    }
  | {
      // core-abort-spec.md §13: single-direction inbound abort. No ack;
      // clients observe completion via `run_end{stopReason:'aborted'}`
      // (§13.1). v1 has no auth check—WS server is a single trust domain.
      type: 'abort_turn';
      sessionKey: string;
    };

type OutboundMessage =
  | { type: 'hello_ack'; clientId: string }
  | { type: 'approval_requested'; id: string; toolName: string; input: Record<string, unknown> }
  | { type: 'approval_closed'; id: string; outcome: ApprovalClosedResult['outcome']; reason: string }
  | { type: 'channel_error'; code: ChannelErrorCode; message: string }
  | Record<string, unknown>;

export interface WebSocketChannelConfig {
  port: number;
  host?: string;
  path?: string;
  maxClients?: number;
  approval?: boolean;
}

class ProtocolError extends Error {
  constructor(readonly code: ChannelErrorCode, message: string) {
    super(message);
    this.name = 'ProtocolError';
  }
}

export class WebSocketChannel implements Channel {
  readonly id = 'websocket';
  readonly completion: Promise<ChannelCompletion>;
  readonly interaction?: ChannelInteractionAdapter;

  private readonly host: string;
  private readonly path: string;
  private readonly maxClients?: number;

  private server?: WebSocketServer;
  private messageHandler?: (req: ChannelRunRequest) => Promise<void>;
  private interactionResponseHandler?: (response: TurnInteractionResponse) => void;
  private interactionUnavailableHandler?: (id: string, reason: 'origin_disconnected') => void;

  private readonly clients = new Map<string, WebSocket>();
  private readonly sessions = new Map<string, Set<string>>();
  private readonly clientSessions = new Map<string, Set<string>>();
  private readonly socketClientIds = new WeakMap<WebSocket, string>();
  private readonly pendingApprovalClientIds = new Map<string, string>();

  /**
    * Channel activation 同步注入（core-abort-spec.md §12 时序保证）：
    * bindAbortHooks 先于 start()。inbound `abort_turn` 到达时必已绑定，
   * 未绑定时静默丢弃（单玩 channel 不接 Runtime 的开发可能性）。
   */
  private abortHooks?: AbortHookBindings;

  private started = false;
  private stopRequested = false;
  private settleCompletion!: (result: ChannelCompletion) => void;
  private completionSettled = false;

  constructor(private readonly config: WebSocketChannelConfig) {
    this.host = config.host ?? DEFAULT_HOST;
    this.path = config.path ?? DEFAULT_PATH;
    this.maxClients = config.maxClients;
    this.completion = new Promise<ChannelCompletion>((resolve) => {
      this.settleCompletion = (result) => {
        if (this.completionSettled) return;
        this.completionSettled = true;
        resolve(Object.freeze(result));
      };
    });

    if (config.approval) {
      this.interaction = this.makeInteractionAdapter();
    }
  }

  send(event: AgentEvent): void {
    // Subagent events carry the CHILD sessionKey (e.g. "main:subagent:abc:1"),
    // but WebSocket clients subscribe to the parent's sessionKey. Re-derive
    // the root label so events reach the right audience.
    const audienceKey =
      (event.type === 'subagent_start' || event.type === 'subagent_end') &&
      isSubagentSessionKey(event.sessionKey)
        ? parseSubagentSessionKey(event.sessionKey).rootLabel
        : event.sessionKey;
    const sessionAudience = this.sessions.get(audienceKey);
    if (!sessionAudience || sessionAudience.size === 0) return;

    if (event.type !== 'text_delta') {
      log.debug('broadcasting event to session audience', {
        channelId: this.id,
        eventType: event.type,
        sessionKey: event.sessionKey,
        audienceKey,
        audienceSize: sessionAudience.size,
      });
    }

    const payload = this.serializeEvent(event);
    for (const clientId of sessionAudience) {
      const socket = this.clients.get(clientId);
      if (!socket || socket.readyState !== WebSocket.OPEN) continue;
      this.sendJson(socket, payload);
    }
  }

  onMessage(handler: (req: ChannelRunRequest) => Promise<void>): void {
    this.messageHandler = handler;
  }

  async start(): Promise<void> {
    if (this.started) return;
    if (!this.messageHandler) {
      const error = new Error('WebSocketChannel.start: no message handler registered');
      this.settleCompletion({ outcome: 'failed', phase: 'startup', error });
      throw error;
    }

    this.stopRequested = false;

    const server = new WebSocketServer({
      host: this.host,
      path: this.path,
      port: this.config.port,
      maxPayload: WS_MAX_PAYLOAD_BYTES,
    });
    this.server = server;

    server.on('connection', (socket, request) => {
      if (this.maxClients !== undefined && this.server && this.server.clients.size > this.maxClients) {
        socket.close(CLOSE_CODE_MAX_CLIENTS, 'max clients reached');
        return;
      }

      log.info('client connected', {
        channelId: this.id,
        path: request.url,
        remoteAddress: request.socket.remoteAddress,
      });

      socket.on('message', (raw) => {
        void this.handleRawMessage(socket, raw);
      });
      socket.on('close', () => {
        this.handleSocketClose(socket);
      });
      socket.on('error', (error) => {
        log.warn('socket error', {
          channelId: this.id,
          error: error.message,
        });
      });
    });
    server.once('close', () => {
      this.settleCompletion({
        outcome: 'closed',
        reason: this.stopRequested ? 'stopped' : 'transport_closed',
      });
    });
    server.on('error', (error) => {
      if (this.started) {
        this.settleCompletion({ outcome: 'failed', phase: 'runtime', error });
      }
    });

    try {
      await new Promise<void>((resolve, reject) => {
        server.once('listening', resolve);
        server.once('error', reject);
        server.once('close', () => {
          reject(new Error('WebSocketChannel.start: server closed before readiness'));
        });
      });
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      this.settleCompletion({ outcome: 'failed', phase: 'startup', error: failure });
      throw failure;
    }

    this.started = true;
    log.info('websocket channel started', {
      channelId: this.id,
      host: this.host,
      path: this.path,
      port: this.config.port,
    });
  }

  async stop(): Promise<void> {
    if (this.stopRequested) return;
    this.stopRequested = true;
    if (!this.server) {
      this.settleCompletion({ outcome: 'closed', reason: 'stopped' });
      return;
    }

    const server = this.server;
    this.server = undefined;
    this.started = false;

    for (const socket of server.clients) {
      socket.close(1001, 'server stopping');
    }

    try {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
      this.settleCompletion({ outcome: 'closed', reason: 'stopped' });
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      this.settleCompletion({ outcome: 'failed', phase: 'shutdown', error: failure });
      throw failure;
    }

    this.clients.clear();
    this.sessions.clear();
    this.clientSessions.clear();
    log.info('websocket channel stopped', { channelId: this.id });
  }

  private async handleRawMessage(socket: WebSocket, raw: RawData): Promise<void> {
    try {
      const message = this.parseMessage(raw);
      switch (message.type) {
        case 'hello':
          this.handleHello(socket, message);
          return;
        case 'run_turn':
          await this.handleRunTurn(socket, message);
          return;
        case 'approval_resolve':
          this.handleApprovalResolve(socket, message);
          return;
        case 'abort_turn':
          this.handleAbortTurn(socket, message);
          return;
      }
    } catch (error) {
      if (error instanceof ProtocolError) {
        this.sendChannelError(socket, error.code, error.message);
        return;
      }

      log.warn('message handling failed', {
        channelId: this.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private parseMessage(raw: RawData): ClientMessage {
    const text = this.decodeRawMessage(raw);

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new ProtocolError('INVALID_JSON', 'Message is not valid JSON.');
    }

    if (!isRecord(parsed)) {
      throw new ProtocolError('INVALID_MESSAGE', 'Message must be a JSON object.');
    }

    const type = readNonEmptyString(parsed.type, 'type');
    switch (type) {
      case 'hello':
        return {
          type,
          clientId: readNonEmptyString(parsed.clientId, 'clientId'),
        };
      case 'run_turn':
        if ('model' in parsed || 'maxTokens' in parsed) {
          throw new ProtocolError(
            'INVALID_MESSAGE',
            'Legacy model/maxTokens fields are not supported; use model_reference/request_override.',
          );
        }
        return {
          type,
          sessionKey: readNonEmptyString(parsed.sessionKey, 'sessionKey'),
          message: readRunTurnMessage(parsed.message),
          modelReference: readOptionalModelReference(parsed.model_reference),
          requestOverride: readOptionalRequestOverride(parsed.request_override),
          maxLlmCalls: readOptionalPositiveInteger(parsed.maxLlmCalls, 'maxLlmCalls'),
        };
      case 'approval_resolve': {
        const decision = parsed.decision;
        if (decision !== 'allow' && decision !== 'deny') {
          throw new ProtocolError('INVALID_MESSAGE', 'decision must be allow or deny.');
        }
        return {
          type,
          id: readNonEmptyString(parsed.id, 'id'),
          decision,
        };
      }
      case 'abort_turn':
        return {
          type,
          sessionKey: readNonEmptyString(parsed.sessionKey, 'sessionKey'),
        };
      default:
        throw new ProtocolError('UNSUPPORTED_MESSAGE', `Unsupported message type: ${type}`);
    }
  }

  private handleHello(socket: WebSocket, message: Extract<ClientMessage, { type: 'hello' }>): void {
    const currentClientId = this.socketClientIds.get(socket);
    if (currentClientId && currentClientId !== message.clientId) {
      throw new ProtocolError('INVALID_MESSAGE', 'A socket cannot switch clientId after hello.');
    }

    const previousSocket = this.clients.get(message.clientId);
    this.clients.set(message.clientId, socket);
    this.socketClientIds.set(socket, message.clientId);

    log.info('client hello acknowledged', {
      channelId: this.id,
      clientId: message.clientId,
      replacedExistingConnection: Boolean(previousSocket && previousSocket !== socket),
    });

    // 同一 clientId 只允许一个逻辑活跃连接；旧连接的晚到 close 会在 handleSocketClose 中被忽略。
    if (previousSocket && previousSocket !== socket) {
      log.info('closing superseded client connection', {
        channelId: this.id,
        clientId: message.clientId,
      });
      previousSocket.close(CLOSE_CODE_SUPERSEDED, 'superseded by newer connection');
    }

    this.sendJson(socket, {
      type: 'hello_ack',
      clientId: message.clientId,
    });
  }

  private async handleRunTurn(
    socket: WebSocket,
    message: Extract<ClientMessage, { type: 'run_turn' }>,
  ): Promise<void> {
    const clientId = this.requireBoundClientId(socket);
    const handler = this.messageHandler;
    if (!handler) {
      throw new ProtocolError('SERVER_NOT_READY', 'Message handler is not ready.');
    }

    this.registerSessionAudience(clientId, message.sessionKey);
    log.info('run_turn received', {
      channelId: this.id,
      clientId,
      sessionKey: message.sessionKey,
      hasModelOverride: message.modelReference !== undefined,
      hasMaxOutputTokens: message.requestOverride?.maxOutputTokens !== undefined,
      hasMaxLlmCalls: message.maxLlmCalls !== undefined,
      messageLength: typeof message.message === 'string' ? message.message.length : undefined,
      blockCount: Array.isArray(message.message) ? message.message.length : undefined,
    });
    await handler({
      clientId,
      sessionKey: message.sessionKey,
      message: message.message,
      modelReference: message.modelReference,
      requestOverride: message.requestOverride,
      maxLlmCalls: message.maxLlmCalls,
    });
  }

  private handleApprovalResolve(
    socket: WebSocket,
    message: Extract<ClientMessage, { type: 'approval_resolve' }>,
  ): void {
    const clientId = this.requireBoundClientId(socket);
    log.info('approval response received', {
      channelId: this.id,
      clientId,
      approvalId: message.id,
      decision: message.decision,
    });
    this.dispatchApprovalSubmission(message.id, message.decision);
  }

  // ── Abort（core-abort-spec.md §13）────────────────────────────

  bindAbortHooks(hooks: AbortHookBindings): void {
    this.abortHooks = hooks;
    log.debug('abort hooks bound', { channelId: this.id });
  }

  /**
   * inbound `abort_turn`：`sessionKey` 已通过 parseMessage 校验非空。
   * v1 不做 sessionKey ↔ 发送方 clientId 的 owner 关系校验（§0.3 D5：
   * 单信任域假设），任何已 hello 的客户端都能 abort 任何 sessionKey；
   * 多客户端隔离由未来 auth 层处理。
   *
   * abort 完成通过 `run_end{result.stopReason:'aborted'}` 通道通知，
   * 无 inline ack；abortHooks 未 bind 时静默丢弃并 warn（开发时不接
   * RuntimeApp 单跑本 channel 场景）。
   */
  private handleAbortTurn(
    socket: WebSocket,
    message: Extract<ClientMessage, { type: 'abort_turn' }>,
  ): void {
    const clientId = this.requireBoundClientId(socket);
    if (!this.abortHooks) {
      log.warn('abort_turn received but abortHooks not bound; ignoring', {
        channelId: this.id,
        clientId,
        sessionKey: message.sessionKey,
      });
      return;
    }
    const result = this.abortHooks.abortTurn(message.sessionKey);
    log.info('abort_turn dispatched', {
      channelId: this.id,
      clientId,
      sessionKey: message.sessionKey,
      aborted: result.aborted,
      dropped: result.dropped,
    });
  }

  private handleSocketClose(socket: WebSocket): void {
    const clientId = this.socketClientIds.get(socket);
    if (!clientId) return;

    this.socketClientIds.delete(socket);
    // 新连接接管后，旧连接的 close 仍可能晚到；这类 stale close 不得清掉当前活跃状态。
    if (this.clients.get(clientId) !== socket) {
      log.debug('ignoring stale socket close', {
        channelId: this.id,
        clientId,
      });
      return;
    }

    this.clients.delete(clientId);

    for (const [approvalId, pendingClientId] of this.pendingApprovalClientIds) {
      if (pendingClientId !== clientId) continue;
      this.pendingApprovalClientIds.delete(approvalId);
      this.dispatchApprovalUnavailable(approvalId, 'origin_disconnected');
    }

    const sessionAudienceKeys = this.clientSessions.get(clientId);
    if (sessionAudienceKeys) {
      for (const sessionKey of sessionAudienceKeys) {
        const clientIds = this.sessions.get(sessionKey);
        if (!clientIds) continue;
        clientIds.delete(clientId);
        if (clientIds.size === 0) {
          this.sessions.delete(sessionKey);
        }
      }
      this.clientSessions.delete(clientId);
    }

    log.info('client disconnected', {
      channelId: this.id,
      clientId,
    });
  }

  private requireBoundClientId(socket: WebSocket): string {
    const clientId = this.socketClientIds.get(socket);
    if (!clientId) {
      throw new ProtocolError('SERVER_NOT_READY', 'hello must complete before business messages.');
    }
    if (this.clients.get(clientId) !== socket) {
      throw new ProtocolError('INVALID_MESSAGE', 'This connection has been superseded.');
    }
    return clientId;
  }

  // 当前这张表只表示“谁应该继续收到该 session 的 AgentEvent 广播”，不表示共享 UI 或自动共享历史。
  private registerSessionAudience(clientId: string, sessionKey: string): void {
    let clientIds = this.sessions.get(sessionKey);
    if (!clientIds) {
      clientIds = new Set<string>();
      this.sessions.set(sessionKey, clientIds);
    }
    clientIds.add(clientId);

    let sessionKeys = this.clientSessions.get(clientId);
    if (!sessionKeys) {
      sessionKeys = new Set<string>();
      this.clientSessions.set(clientId, sessionKeys);
    }
    // 反向索引用于断线时按 clientId 做 O(关联 session 数) 清理，而不是全表扫描 sessions。
    sessionKeys.add(sessionKey);

    log.debug('session audience registered', {
      channelId: this.id,
      clientId,
      sessionKey,
      sessionAudienceSize: clientIds.size,
      clientSessionCount: sessionKeys.size,
    });
  }

  private makeInteractionAdapter(): ChannelInteractionAdapter {
    return {
      sendInteractionRequest: (request) => {
        if (request.kind !== 'approval') {
          throw new Error(`WebSocketChannel does not support interaction kind: ${request.kind}`);
        }
        return this.sendApprovalRequestMessage(request);
      },
      sendInteractionClosed: (request, result) => {
        if (request.kind !== 'approval') {
          throw new Error(`WebSocketChannel does not support interaction kind: ${request.kind}`);
        }
        this.sendApprovalClosedMessage(request.id, request.originClientId, result);
      },
      onInteractionResponse: (handler) => {
        this.interactionResponseHandler = handler;
      },
      onInteractionUnavailable: (handler) => {
        this.interactionUnavailableHandler = handler;
      },
    };
  }

  private dispatchApprovalSubmission(id: string, decision: ApprovalDecision): void {
    this.pendingApprovalClientIds.delete(id);
    if (this.interactionResponseHandler) {
      log.debug('routing approval submission through interaction adapter', {
        channelId: this.id,
        approvalId: id,
        decision,
      });
      this.interactionResponseHandler({
        id,
        kind: 'approval',
        outcome: 'submitted',
        decision,
      });
      return;
    }

    throw new ProtocolError('UNSUPPORTED_MESSAGE', 'Approval is not enabled for this channel.');
  }

  private dispatchApprovalUnavailable(
    id: string,
    reason: 'origin_disconnected',
  ): void {
    if (this.interactionUnavailableHandler) {
      this.interactionUnavailableHandler(id, reason);
    }
  }

  private sendApprovalRequestMessage(
    request: Pick<ApprovalRequest, 'id' | 'toolName' | 'input' | 'originClientId'>,
  ): { status: 'accepted' } | { status: 'unavailable'; reason: 'origin_missing' | 'delivery_failed' } {
    if (!request.originClientId) {
      log.debug('skipping approval request without origin client', {
        channelId: this.id,
        approvalId: request.id,
        toolName: request.toolName,
      });
      return { status: 'unavailable', reason: 'origin_missing' };
    }
    const socket = this.clients.get(request.originClientId);
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      log.warn('unable to deliver approval request to client', {
        channelId: this.id,
        approvalId: request.id,
        toolName: request.toolName,
        originClientId: request.originClientId,
      });
      return { status: 'unavailable', reason: 'delivery_failed' };
    }
    log.info('delivering approval request to client', {
      channelId: this.id,
      approvalId: request.id,
      toolName: request.toolName,
      originClientId: request.originClientId,
    });
    this.pendingApprovalClientIds.set(request.id, request.originClientId);
    this.sendJson(socket, {
      type: 'approval_requested',
      id: request.id,
      toolName: request.toolName,
      input: request.input,
    });
    return { status: 'accepted' };
  }

  private sendApprovalClosedMessage(
    id: string,
    originClientId: string | undefined,
    result: ApprovalClosedResult,
  ): void {
    this.pendingApprovalClientIds.delete(id);
    if (!originClientId) {
      log.debug('skipping approval closure without origin client', {
        channelId: this.id,
        approvalId: id,
      });
      return;
    }
    const socket = this.clients.get(originClientId);
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      log.warn('unable to deliver approval closure to client', {
        channelId: this.id,
        approvalId: id,
        originClientId,
      });
      return;
    }
    log.info('delivering approval closure to client', {
      channelId: this.id,
      approvalId: id,
      originClientId,
    });
    this.sendJson(socket, {
      type: 'approval_closed',
      id,
      outcome: result.outcome,
      reason: 'reason' in result ? result.reason : 'failed',
    });
  }

  private sendChannelError(socket: WebSocket, code: ChannelErrorCode, message: string): void {
    this.sendJson(socket, {
      type: 'channel_error',
      code,
      message,
    });
  }

  private sendJson(socket: WebSocket, payload: OutboundMessage): void {
    if (socket.readyState !== WebSocket.OPEN) return;
    socket.send(JSON.stringify(payload));
  }

  private serializeEvent(event: AgentEvent): Record<string, unknown> {
    if (event.type === 'error') {
      // Error 对象直接 JSON.stringify 会退化成空对象，这里显式降成 message 以匹配协议文档。
      return {
        ...event,
        error: event.error.message,
      };
    }
    return event as unknown as Record<string, unknown>;
  }

  private decodeRawMessage(raw: RawData): string {
    if (typeof raw === 'string') return raw;
    if (raw instanceof ArrayBuffer) return Buffer.from(raw).toString('utf-8');
    if (Array.isArray(raw)) return Buffer.concat(raw).toString('utf-8');
    return raw.toString('utf-8');
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new ProtocolError('INVALID_MESSAGE', `${field} must be a non-empty string.`);
  }
  return value;
}

function readOptionalModelReference(
  value: unknown,
): ChannelRunRequest['modelReference'] | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    throw new ProtocolError('INVALID_MESSAGE', 'model_reference must be an object.');
  }
  assertOnlyKeys(value, ['provider_id', 'model_id'], 'model_reference');
  const providerId = value.provider_id === undefined
    ? undefined
    : readNonEmptyString(value.provider_id, 'model_reference.provider_id');
  return {
    ...(providerId === undefined ? {} : { providerId }),
    modelId: readNonEmptyString(value.model_id, 'model_reference.model_id'),
  };
}

function readOptionalRequestOverride(
  value: unknown,
): ChannelRunRequest['requestOverride'] | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    throw new ProtocolError('INVALID_MESSAGE', 'request_override must be an object.');
  }
  assertOnlyKeys(value, ['max_output_tokens'], 'request_override');
  return {
    maxOutputTokens: readOptionalPositiveInteger(
      value.max_output_tokens,
      'request_override.max_output_tokens',
    ),
  };
}

function assertOnlyKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  field: string,
): void {
  const allowedKeys = new Set(allowed);
  const unknown = Object.keys(value).find((key) => !allowedKeys.has(key));
  if (unknown) {
    throw new ProtocolError('INVALID_MESSAGE', `${field}.${unknown} is not supported.`);
  }
}

function readOptionalPositiveInteger(value: unknown, field: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new ProtocolError('INVALID_MESSAGE', `${field} must be a positive integer.`);
  }
  return value;
}

/**
 * Wire-level shape check for `run_turn.message`. Accepts either a non-empty string
 * or an array of `InboundContentBlock`. Channel layer does NOT validate business
 * rules (MIME, byte budgets, etc.) — those belong to the media pipeline.
 */
function readRunTurnMessage(value: unknown): string | InboundContentBlock[] {
  if (typeof value === 'string') {
    if (value.trim().length === 0) {
      throw new ProtocolError('INVALID_MESSAGE', 'message must be a non-empty string or content-block array.');
    }
    return value;
  }
  if (!Array.isArray(value) || value.length === 0) {
    throw new ProtocolError('INVALID_MESSAGE', 'message must be a non-empty string or content-block array.');
  }
  const blocks: InboundContentBlock[] = [];
  for (let i = 0; i < value.length; i++) {
    blocks.push(parseInboundContentBlock(value[i], i));
  }
  return blocks;
}

function parseInboundContentBlock(value: unknown, index: number): InboundContentBlock {
  if (!isRecord(value)) {
    throw new ProtocolError('INVALID_MESSAGE', `message[${index}] must be an object.`);
  }
  const type = value.type;
  if (type === 'text') {
    if (typeof value.text !== 'string') {
      throw new ProtocolError('INVALID_MESSAGE', `message[${index}].text must be a string.`);
    }
    return { type: 'text', text: value.text };
  }
  if (type === 'image') {
    const source = value.source;
    if (!isRecord(source) || source.type !== 'base64') {
      throw new ProtocolError('INVALID_MESSAGE', `message[${index}].source must be {type:'base64',...}.`);
    }
    const mediaType = source.media_type;
    if (
      mediaType !== 'image/png'
      && mediaType !== 'image/jpeg'
      && mediaType !== 'image/webp'
      && mediaType !== 'image/gif'
    ) {
      throw new ProtocolError('INVALID_MESSAGE', `message[${index}].source.media_type unsupported at wire layer.`);
    }
    if (typeof source.data !== 'string' || source.data.length === 0) {
      throw new ProtocolError('INVALID_MESSAGE', `message[${index}].source.data must be a non-empty string.`);
    }
    return {
      type: 'image',
      source: { type: 'base64', media_type: mediaType, data: source.data },
    };
  }
  throw new ProtocolError('INVALID_MESSAGE', `message[${index}].type unsupported.`);
}