import type { AgentEvent } from '../../core/runner/types.js';
import { Logger } from '../../platform/logger/index.js';
import type {
  ApprovalDecision,
  ApprovalRequest,
  Channel,
  ChannelApprovalAdapter,
  ChannelInteractionAdapter,
  ChannelRunRequest,
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
      message: string;
      model?: string;
      maxTokens?: number;
      maxLlmCalls?: number;
    }
  | {
      type: 'approval_resolve';
      id: string;
      decision: ApprovalDecision;
    };

type OutboundMessage =
  | { type: 'hello_ack'; clientId: string }
  | { type: 'approval_requested'; id: string; toolName: string; input: Record<string, unknown>; timeoutMs?: number }
  | { type: 'approval_expired'; id: string }
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
  readonly interaction?: ChannelInteractionAdapter;
  readonly approval?: ChannelApprovalAdapter;

  private readonly host: string;
  private readonly path: string;
  private readonly maxClients?: number;

  private server?: WebSocketServer;
  private messageHandler?: (req: ChannelRunRequest) => Promise<void>;
  private approvalDecisionHandler?: (id: string, decision: ApprovalDecision) => void;
  private interactionResponseHandler?: (response: TurnInteractionResponse) => void;

  private readonly clients = new Map<string, WebSocket>();
  private readonly sessions = new Map<string, Set<string>>();
  private readonly clientSessions = new Map<string, Set<string>>();
  private readonly socketClientIds = new WeakMap<WebSocket, string>();

  private started = false;

  constructor(private readonly config: WebSocketChannelConfig) {
    this.host = config.host ?? DEFAULT_HOST;
    this.path = config.path ?? DEFAULT_PATH;
    this.maxClients = config.maxClients;

    if (config.approval) {
      this.interaction = this.makeInteractionAdapter();
      this.approval = this.makeApprovalAdapter();
    }
  }

  send(event: AgentEvent): void {
    const sessionAudience = this.sessions.get(event.sessionKey);
    if (!sessionAudience || sessionAudience.size === 0) return;

    if (event.type !== 'text_delta') {
      log.debug('broadcasting event to session audience', {
        channelId: this.id,
        eventType: event.type,
        sessionKey: event.sessionKey,
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
      throw new Error('WebSocketChannel.start: no message handler registered (call registerChannel first)');
    }

    this.server = new WebSocketServer({
      host: this.host,
      path: this.path,
      port: this.config.port,
    });

    this.server.on('connection', (socket, request) => {
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

    await new Promise<void>((resolve, reject) => {
      if (!this.server) {
        reject(new Error('WebSocket server not initialized'));
        return;
      }
      this.server.once('listening', resolve);
      this.server.once('error', reject);
    });

    this.started = true;
    log.info('websocket channel started', {
      channelId: this.id,
      host: this.host,
      path: this.path,
      port: this.config.port,
    });
  }

  async stop(): Promise<void> {
    if (!this.server) return;

    const server = this.server;
    this.server = undefined;
    this.started = false;

    for (const socket of server.clients) {
      socket.close(1001, 'server stopping');
    }

    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });

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
        return {
          type,
          sessionKey: readNonEmptyString(parsed.sessionKey, 'sessionKey'),
          message: readNonEmptyString(parsed.message, 'message'),
          model: readOptionalString(parsed.model, 'model'),
          maxTokens: readOptionalPositiveInteger(parsed.maxTokens, 'maxTokens'),
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
      hasModelOverride: Boolean(message.model),
      hasMaxTokens: message.maxTokens !== undefined,
      hasMaxLlmCalls: message.maxLlmCalls !== undefined,
      messageLength: message.message.length,
    });
    await handler({
      clientId,
      sessionKey: message.sessionKey,
      message: message.message,
      model: message.model,
      maxTokens: message.maxTokens,
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

  private makeApprovalAdapter(): ChannelApprovalAdapter {
    return {
      sendApprovalRequest: (request) => {
        this.sendApprovalRequestMessage(request);
      },
      sendApprovalExpired: (request) => {
        this.sendApprovalExpiredMessage(request.id, request.originClientId);
      },
      onApprovalDecision: (handler) => {
        this.approvalDecisionHandler = handler;
      },
    };
  }

  private makeInteractionAdapter(): ChannelInteractionAdapter {
    return {
      sendInteractionRequest: (request) => {
        if (request.kind !== 'approval') {
          throw new Error(`WebSocketChannel does not support interaction kind: ${request.kind}`);
        }
        this.sendApprovalRequestMessage(request);
      },
      sendInteractionExpired: (request) => {
        if (request.kind !== 'approval') {
          throw new Error(`WebSocketChannel does not support interaction kind: ${request.kind}`);
        }
        this.sendApprovalExpiredMessage(request.id, request.originClientId);
      },
      onInteractionResponse: (handler) => {
        this.interactionResponseHandler = handler;
      },
    };
  }

  private dispatchApprovalSubmission(id: string, decision: ApprovalDecision): void {
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

    if (this.approvalDecisionHandler) {
      log.debug('routing approval submission through approval adapter', {
        channelId: this.id,
        approvalId: id,
        decision,
      });
      this.approvalDecisionHandler(id, decision);
      return;
    }

    throw new ProtocolError('UNSUPPORTED_MESSAGE', 'Approval is not enabled for this channel.');
  }

  private sendApprovalRequestMessage(
    request: Pick<ApprovalRequest, 'id' | 'toolName' | 'input' | 'originClientId' | 'timeoutMs'>,
  ): void {
    if (!request.originClientId) {
      log.debug('skipping approval request without origin client', {
        channelId: this.id,
        approvalId: request.id,
        toolName: request.toolName,
      });
      return;
    }
    const socket = this.clients.get(request.originClientId);
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      log.warn('unable to deliver approval request to client', {
        channelId: this.id,
        approvalId: request.id,
        toolName: request.toolName,
        originClientId: request.originClientId,
      });
      return;
    }
    log.info('delivering approval request to client', {
      channelId: this.id,
      approvalId: request.id,
      toolName: request.toolName,
      originClientId: request.originClientId,
      timeoutMs: request.timeoutMs,
    });
    this.sendJson(socket, {
      type: 'approval_requested',
      id: request.id,
      toolName: request.toolName,
      input: request.input,
      timeoutMs: request.timeoutMs,
    });
  }

  private sendApprovalExpiredMessage(id: string, originClientId?: string): void {
    if (!originClientId) {
      log.debug('skipping approval expiry notification without origin client', {
        channelId: this.id,
        approvalId: id,
      });
      return;
    }
    const socket = this.clients.get(originClientId);
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      log.warn('unable to deliver approval expiry to client', {
        channelId: this.id,
        approvalId: id,
        originClientId,
      });
      return;
    }
    log.info('delivering approval expiry to client', {
      channelId: this.id,
      approvalId: id,
      originClientId,
    });
    this.sendJson(socket, {
      type: 'approval_expired',
      id,
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

function readOptionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') {
    throw new ProtocolError('INVALID_MESSAGE', `${field} must be a string.`);
  }
  return value;
}

function readOptionalPositiveInteger(value: unknown, field: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new ProtocolError('INVALID_MESSAGE', `${field} must be a positive integer.`);
  }
  return value;
}