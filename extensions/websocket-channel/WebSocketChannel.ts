import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import {
  ChannelOperationError,
  type AgentEvent,
  type ApprovalClosedResult,
  type ApprovalDecision,
  type ApprovalRequest,
  type Channel,
  type ChannelCompletion,
  type ChannelInteractionAdapter,
  type ChannelOperationErrorCode,
  type ChannelRunRequest,
  type ChannelRuntimeCapabilities,
  type ExtensionLogger,
  type InboundContentBlock,
  type ModelCatalogSnapshot,
  SessionPermissionMode,
  SessionPermissionState,
  type TurnInteractionResponse,
} from 'my-agent/extension-api';
import { WebSocket, WebSocketServer, type RawData } from 'ws';

import type { WebSocketExtensionConfig } from './config.js';
import { WS_MAX_PAYLOAD_BYTES } from './websocket-constants.js';

const CLOSE_CODE_SUPERSEDED = 1000;
const CLOSE_CODE_MAX_CLIENTS = 1008;
const CLIENT_PATH_TOKEN = '__MY_AGENT_WEBSOCKET_PATH__';

type ChannelErrorCode =
  | 'INVALID_JSON'
  | 'INVALID_MESSAGE'
  | 'UNSUPPORTED_MESSAGE'
  | 'SERVER_NOT_READY'
  | ChannelOperationErrorCode;

type ClientMessage =
  | {
      type: 'hello';
      clientId: string;
    }
  | {
      type: 'run_turn';
      sessionId: string;
      message: string | InboundContentBlock[];
      modelReference?: ChannelRunRequest['modelReference'];
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
      // (§13.1).
      type: 'abort_turn';
      sessionId: string;
    }
  | {
      type: 'get_model_catalog';
      requestId: string;
    }
  | {
      type: 'create_session';
      requestId: string;
      permissionMode?: SessionPermissionMode;
    }
  | {
      type: 'get_session_permission_mode';
      sessionId: string;
    }
  | {
      type: 'set_session_permission_mode';
      sessionId: string;
      mode: SessionPermissionMode;
    }
  | {
      type: 'list_sessions';
      requestId: string;
      archived?: boolean;
    }
  | {
      type: 'get_session';
      requestId: string;
      sessionId: string;
    }
  | {
      type: 'rename_session';
      requestId: string;
      sessionId: string;
      title: string | null;
    }
  | {
      type: 'archive_session' | 'unarchive_session' | 'delete_session';
      requestId: string;
      sessionId: string;
    }
  | {
      type: 'fork_session';
      requestId: string;
      sessionId: string;
      entryId?: string;
    };

type OutboundMessage =
  | { type: 'hello_ack'; clientId: string }
  | {
      type: 'approval_requested';
      id: string;
      sessionId: string;
      turnId: string;
      toolName: string;
      input: Record<string, unknown>;
    }
  | {
      type: 'approval_closed';
      id: string;
      sessionId: string;
      turnId: string;
      outcome: ApprovalClosedResult['outcome'];
      reason: string;
    }
  | { type: 'channel_error'; code: ChannelErrorCode; message: string }
  | Record<string, unknown>;

export type BrowserLauncher = (url: string) => Promise<void>;

export interface WebSocketChannelOptions {
  readonly config: WebSocketExtensionConfig;
  readonly clientFilePath: string;
  readonly logger: ExtensionLogger;
  readonly browserLauncher?: BrowserLauncher;
}

interface PendingApprovalRoute {
  readonly clientId: string;
  readonly sessionId: string;
  readonly turnId: string;
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
  private readonly clientPath: string;
  private readonly maxClients?: number;
  private readonly logger: ExtensionLogger;
  private readonly clientFilePath: string;
  private readonly openBrowser: boolean;
  private readonly browserLauncher: BrowserLauncher;

  private server?: WebSocketServer;
  private httpServer?: HttpServer;
  private messageHandler?: (req: ChannelRunRequest) => Promise<void>;
  private interactionResponseHandler?: (response: TurnInteractionResponse) => void;
  private interactionUnavailableHandler?: (id: string, reason: 'origin_disconnected') => void;

  private readonly clients = new Map<string, WebSocket>();
  private readonly sessions = new Map<string, Set<string>>();
  private readonly clientSessions = new Map<string, Set<string>>();
  private readonly socketClientIds = new WeakMap<WebSocket, string>();
  private readonly pendingApprovals = new Map<string, PendingApprovalRoute>();

  /**
   * Channel activation 同步注入：bindRuntimeCapabilities 先于 start()。
   * 独立使用时能力可能未绑定，此时需要能力的协议请求返回 SERVER_NOT_READY。
   */
  private runtimeCapabilities?: ChannelRuntimeCapabilities;
  private unsubscribePermissionModeChanged?: () => void;

  private started = false;
  private stopRequested = false;
  private settleCompletion!: (result: ChannelCompletion) => void;
  private completionSettled = false;
  private readonly sessionByOriginMessageId = new Map<string, string>();

  constructor(private readonly options: WebSocketChannelOptions) {
    this.host = options.config.host;
    this.path = options.config.webSocketPath;
    this.clientPath = options.config.clientPath;
    this.maxClients = options.config.maxClients;
    this.logger = options.logger;
    this.clientFilePath = options.clientFilePath;
    this.openBrowser = options.config.openBrowser;
    this.browserLauncher = options.browserLauncher ?? launchBrowser;
    this.completion = new Promise<ChannelCompletion>((resolve) => {
      this.settleCompletion = (result) => {
        if (this.completionSettled) return;
        this.completionSettled = true;
        resolve(Object.freeze(result));
      };
    });

    if (options.config.approval) {
      this.interaction = this.makeInteractionAdapter();
    }
  }

  send(event: AgentEvent): void {
    if (event.type === 'user_message') {
      this.sessionByOriginMessageId.set(event.messageId, event.sessionId);
    } else if (event.type === 'run_start' && event.originMessageId) {
      this.sessionByOriginMessageId.delete(event.originMessageId);
    }
    // Subagent events carry the Child UUID, while clients subscribe to the caller Session.
    const requestAudience = event.type === 'request_end' && event.originMessageId
      ? this.sessionByOriginMessageId.get(event.originMessageId)
      : undefined;
    if (event.type === 'request_end' && event.originMessageId) {
      this.sessionByOriginMessageId.delete(event.originMessageId);
    }
    const eventSessionId = 'sessionId' in event ? event.sessionId : requestAudience;
    if (!eventSessionId) return;
    const audienceKey = event.type === 'subagent_start' || event.type === 'subagent_end'
      ? event.callerSessionId
      : eventSessionId;
    const sessionAudience = this.sessions.get(audienceKey);
    if (!sessionAudience || sessionAudience.size === 0) return;

    if (event.type !== 'text_delta') {
      this.logger.debug('broadcasting event to session audience', {
        channelId: this.id,
        eventType: event.type,
        sessionId: eventSessionId,
        audienceKey,
        audienceSize: sessionAudience.size,
      });
    }

    const payload = this.serializeEvent(event, eventSessionId);
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
    let clientHtml: string;
    try {
      clientHtml = await this.loadClientHtml();
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      this.settleCompletion({ outcome: 'failed', phase: 'startup', error: failure });
      throw failure;
    }
    if (this.stopRequested) {
      throw new Error('WebSocketChannel.start: server closed before readiness');
    }

    const httpServer = createServer((request, response) => {
      const requestPath = new URL(request.url ?? '/', 'http://localhost').pathname;
      if (
        requestPath !== this.clientPath
        || (request.method !== 'GET' && request.method !== 'HEAD')
      ) {
        response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
        response.end('Not found');
        return;
      }
      response.writeHead(200, {
        'cache-control': 'no-store',
        'content-type': 'text/html; charset=utf-8',
      });
      response.end(request.method === 'HEAD' ? undefined : clientHtml);
    });
    this.httpServer = httpServer;

    const server = new WebSocketServer({
      server: httpServer,
      path: this.path,
      maxPayload: WS_MAX_PAYLOAD_BYTES,
    });
    this.server = server;

    server.on('connection', (socket, request) => {
      if (this.maxClients !== undefined && this.server && this.server.clients.size > this.maxClients) {
        socket.close(CLOSE_CODE_MAX_CLIENTS, 'max clients reached');
        return;
      }

      this.logger.info('client connected', {
        channelId: this.id,
        path: new URL(request.url ?? '/', 'http://localhost').pathname,
        remoteAddress: request.socket.remoteAddress,
      });

      socket.on('message', (raw) => {
        void this.handleRawMessage(socket, raw);
      });
      socket.on('close', () => {
        this.handleSocketClose(socket);
      });
      socket.on('error', (error) => {
        this.logger.warn('socket error', {
          channelId: this.id,
          error: error.message,
        });
      });
    });
    server.on('error', (error) => {
      if (this.started) {
        this.settleCompletion({ outcome: 'failed', phase: 'runtime', error });
      }
    });
    httpServer.once('close', () => {
      this.settleCompletion({
        outcome: 'closed',
        reason: this.stopRequested ? 'stopped' : 'transport_closed',
      });
    });
    httpServer.on('error', (error) => {
      if (this.started) {
        this.settleCompletion({ outcome: 'failed', phase: 'runtime', error });
      }
    });

    try {
      await new Promise<void>((resolve, reject) => {
        httpServer.once('listening', resolve);
        httpServer.once('error', reject);
        httpServer.once('close', () => {
          reject(new Error('WebSocketChannel.start: server closed before readiness'));
        });
        httpServer.listen(this.options.config.port, this.host);
      });
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      if (this.server === server) {
        this.server = undefined;
        this.httpServer = undefined;
        await new Promise<void>((resolve) => {
          server.close(() => resolve());
        });
        if (httpServer.listening) {
          await new Promise<void>((resolve) => {
            httpServer.close(() => resolve());
          });
        }
      }
      this.settleCompletion({ outcome: 'failed', phase: 'startup', error: failure });
      throw failure;
    }

    this.started = true;
    this.unsubscribePermissionModeChanged =
      this.runtimeCapabilities?.sessions.onPermissionModeChanged((permission) => {
        this.broadcastPermissionMode(permission);
      });
    this.logger.info('websocket channel started', {
      channelId: this.id,
      host: this.host,
      path: this.path,
      port: this.listeningPort(),
    });
    if (this.openBrowser) {
      try {
        await this.browserLauncher(this.clientUrl());
      } catch {
        this.logger.warn('browser launch failed', { channelId: this.id });
      }
    }
  }

  async stop(): Promise<void> {
    if (this.stopRequested) return;
    this.stopRequested = true;
    this.unsubscribePermissionModeChanged?.();
    this.unsubscribePermissionModeChanged = undefined;
    if (!this.server || !this.httpServer) {
      this.settleCompletion({ outcome: 'closed', reason: 'stopped' });
      return;
    }

    const server = this.server;
    const httpServer = this.httpServer;
    this.server = undefined;
    this.httpServer = undefined;
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
      if (httpServer.listening) {
        await new Promise<void>((resolve, reject) => {
          httpServer.close((error) => {
            if (error) reject(error);
            else resolve();
          });
        });
      }
      this.settleCompletion({ outcome: 'closed', reason: 'stopped' });
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      this.settleCompletion({ outcome: 'failed', phase: 'shutdown', error: failure });
      throw failure;
    }

    this.clients.clear();
    this.sessions.clear();
    this.clientSessions.clear();
    this.logger.info('websocket channel stopped', { channelId: this.id });
  }

  private async loadClientHtml(): Promise<string> {
    const source = await readFile(this.clientFilePath, 'utf8');
    if (!source.includes(CLIENT_PATH_TOKEN)) {
      throw new Error('WebSocketChannel.start: client asset is missing its path token');
    }
    const scriptSafePath = JSON.stringify(this.path).replaceAll('<', '\\u003c');
    return source.replaceAll(CLIENT_PATH_TOKEN, scriptSafePath);
  }

  private listeningPort(): number {
    const address = this.httpServer?.address();
    if (address === null || typeof address === 'string' || address === undefined) {
      throw new Error('WebSocketChannel: HTTP listener address is unavailable');
    }
    return (address as AddressInfo).port;
  }

  private clientUrl(): string {
    return `${this.clientOrigin()}${this.clientPath}`;
  }

  private clientOrigin(): string {
    const host = this.host === '0.0.0.0' || this.host === '::'
      ? '127.0.0.1'
      : this.host;
    const urlHost = host.includes(':') ? `[${host}]` : host;
    return new URL(`http://${urlHost}:${this.listeningPort()}`).origin;
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
        case 'get_model_catalog':
          this.handleGetModelCatalog(socket, message);
          return;
        case 'create_session':
          await this.handleCreateSession(socket, message);
          return;
        case 'get_session_permission_mode':
        case 'set_session_permission_mode':
          await this.handlePermissionModeRequest(socket, message);
          return;
        case 'list_sessions':
        case 'get_session':
        case 'rename_session':
        case 'archive_session':
        case 'unarchive_session':
        case 'delete_session':
        case 'fork_session':
          await this.handleSessionRequest(socket, message);
          return;
      }
    } catch (error) {
      if (error instanceof ProtocolError) {
        this.sendChannelError(socket, error.code, error.message);
        return;
      }
      if (error instanceof ChannelOperationError) {
        this.sendChannelError(socket, error.code, error.message);
        return;
      }

      this.logger.warn('message handling failed', {
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
        if ('model_reference' in parsed) {
          throw new ProtocolError(
            'INVALID_MESSAGE',
            'snake_case fields are not supported; use modelReference.',
          );
        }
        if ('model' in parsed || 'maxTokens' in parsed || 'requestOverride' in parsed
          || 'request_override' in parsed) {
          throw new ProtocolError(
            'INVALID_MESSAGE',
            'Legacy model/output-token override fields are not supported; use modelReference.',
          );
        }
        return {
          type,
          sessionId: readNonEmptyString(parsed.sessionId, 'sessionId'),
          message: readRunTurnMessage(parsed.message),
          modelReference: readOptionalModelReference(parsed.modelReference),
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
          sessionId: readNonEmptyString(parsed.sessionId, 'sessionId'),
        };
      case 'get_model_catalog':
        return {
          type,
          requestId: readNonEmptyString(parsed.requestId, 'requestId'),
        };
      case 'create_session':
        assertOnlyKeys(parsed, ['type', 'requestId', 'permissionMode'], type);
        return {
          type,
          requestId: readNonEmptyString(parsed.requestId, 'requestId'),
          permissionMode: readOptionalPermissionMode(parsed.permissionMode, 'permissionMode'),
        };
      case 'get_session_permission_mode':
        assertOnlyKeys(parsed, ['type', 'sessionId'], type);
        return {
          type,
          sessionId: readNonEmptyString(parsed.sessionId, 'sessionId'),
        };
      case 'set_session_permission_mode':
        assertOnlyKeys(parsed, ['type', 'sessionId', 'mode'], type);
        return {
          type,
          sessionId: readNonEmptyString(parsed.sessionId, 'sessionId'),
          mode: readPermissionMode(parsed.mode, 'mode'),
        };
      case 'list_sessions':
        return {
          type,
          requestId: readNonEmptyString(parsed.requestId, 'requestId'),
          archived: readOptionalBoolean(parsed.archived, 'archived'),
        };
      case 'get_session':
      case 'archive_session':
      case 'unarchive_session':
      case 'delete_session':
        return {
          type,
          requestId: readNonEmptyString(parsed.requestId, 'requestId'),
          sessionId: readNonEmptyString(parsed.sessionId, 'sessionId'),
        };
      case 'rename_session':
        return {
          type,
          requestId: readNonEmptyString(parsed.requestId, 'requestId'),
          sessionId: readNonEmptyString(parsed.sessionId, 'sessionId'),
          title: readNullableString(parsed.title, 'title'),
        };
      case 'fork_session':
        return {
          type,
          requestId: readNonEmptyString(parsed.requestId, 'requestId'),
          sessionId: readNonEmptyString(parsed.sessionId, 'sessionId'),
          entryId: readOptionalNonEmptyString(parsed.entryId, 'entryId'),
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

    this.logger.info('client hello acknowledged', {
      channelId: this.id,
      clientId: message.clientId,
      replacedExistingConnection: Boolean(previousSocket && previousSocket !== socket),
    });

    // 同一 clientId 只允许一个逻辑活跃连接；旧连接的晚到 close 会在 handleSocketClose 中被忽略。
    if (previousSocket && previousSocket !== socket) {
      this.logger.info('closing superseded client connection', {
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

    this.registerSessionAudience(clientId, message.sessionId);
    this.logger.info('run_turn received', {
      channelId: this.id,
      clientId,
      sessionId: message.sessionId,
      hasModelOverride: message.modelReference !== undefined,
      hasMaxLlmCalls: message.maxLlmCalls !== undefined,
      messageLength: typeof message.message === 'string' ? message.message.length : undefined,
      blockCount: Array.isArray(message.message) ? message.message.length : undefined,
    });
    await handler({
      clientId,
      sessionId: message.sessionId,
      message: message.message,
      modelReference: message.modelReference,
      maxLlmCalls: message.maxLlmCalls,
    });
  }

  private handleApprovalResolve(
    socket: WebSocket,
    message: Extract<ClientMessage, { type: 'approval_resolve' }>,
  ): void {
    const clientId = this.requireBoundClientId(socket);
    if (this.pendingApprovals.get(message.id)?.clientId !== clientId) {
      throw new ProtocolError(
        'INVALID_MESSAGE',
        'Approval response does not belong to this client.',
      );
    }
    this.logger.info('approval response received', {
      channelId: this.id,
      clientId,
      approvalId: message.id,
      decision: message.decision,
    });
    this.dispatchApprovalSubmission(message.id, message.decision);
  }

  // ── Abort（core-abort-spec.md §13）────────────────────────────

  bindRuntimeCapabilities(capabilities: ChannelRuntimeCapabilities): void {
    this.runtimeCapabilities = capabilities;
    this.logger.debug('Runtime capabilities bound', { channelId: this.id });
  }

  private handleGetModelCatalog(
    socket: WebSocket,
    message: Extract<ClientMessage, { type: 'get_model_catalog' }>,
  ): void {
    this.requireBoundClientId(socket);
    if (!this.runtimeCapabilities) {
      throw new ProtocolError('SERVER_NOT_READY', 'Runtime Model Catalog is not bound.');
    }
    let snapshot: ModelCatalogSnapshot;
    try {
      snapshot = this.runtimeCapabilities.modelCatalog.getSnapshot();
    } catch {
      throw new ProtocolError('SERVER_NOT_READY', 'Runtime Model Catalog is not ready.');
    }
    this.sendJson(socket, {
      type: 'model_catalog',
      requestId: message.requestId,
      catalog: toWireModelCatalog(snapshot),
    });
  }

  private async handleCreateSession(
    socket: WebSocket,
    message: Extract<ClientMessage, { type: 'create_session' }>,
  ): Promise<void> {
    const clientId = this.requireBoundClientId(socket);
    const { sessionId, permission } = await this.invokeSessionOperation((capability) =>
      capability.createSession({
        ...(message.permissionMode === undefined ? {} : { permissionMode: message.permissionMode }),
        originClientId: clientId,
      }));
    this.registerSessionAudience(clientId, sessionId);
    this.sendJson(socket, {
      type: 'session_created',
      requestId: message.requestId,
      sessionId,
      permission,
    });
  }

  private async handlePermissionModeRequest(
    socket: WebSocket,
    message: Extract<
      ClientMessage,
      { type: 'get_session_permission_mode' | 'set_session_permission_mode' }
    >,
  ): Promise<void> {
    const clientId = this.requireBoundClientId(socket);
    const permission = message.type === 'get_session_permission_mode'
      ? await this.invokeSessionOperation((capability) =>
          capability.getPermissionMode(message.sessionId))
      : await this.invokeSessionOperation((capability) =>
          capability.setPermissionMode({
            sessionId: message.sessionId,
            mode: message.mode,
            originClientId: clientId,
          }));
    this.registerSessionAudience(clientId, message.sessionId);
    this.sendJson(socket, {
      type: 'session_permission_mode_changed',
      ...toWirePermissionMode(permission),
    });
  }

  private broadcastPermissionMode(permission: SessionPermissionState): void {
    const audience = this.sessions.get(permission.sessionId);
    if (!audience) return;
    for (const clientId of audience) {
      if (clientId === permission.changedByClientId) continue;
      const socket = this.clients.get(clientId);
      if (socket?.readyState === WebSocket.OPEN) {
        this.sendJson(socket, {
          type: 'session_permission_mode_changed',
          ...toWirePermissionMode(permission),
        });
      }
    }
  }

  private async handleSessionRequest(
    socket: WebSocket,
    message: Exclude<
      ClientMessage,
      { type: 'hello' | 'run_turn' | 'approval_resolve' | 'abort_turn' | 'get_model_catalog' | 'create_session' | 'get_session_permission_mode' | 'set_session_permission_mode' }
    >,
  ): Promise<void> {
    this.requireBoundClientId(socket);
    switch (message.type) {
      case 'list_sessions': {
        const sessions = await this.invokeSessionOperation((capability) =>
          capability.listSessions(message.archived === undefined
            ? undefined
            : { archived: message.archived }));
        this.sendJson(socket, { type: 'sessions_listed', requestId: message.requestId, sessions });
        return;
      }
      case 'get_session': {
        const session = await this.invokeSessionOperation((capability) =>
          capability.getSession(message.sessionId));
        this.sendJson(socket, { type: 'session_retrieved', requestId: message.requestId, session });
        return;
      }
      case 'rename_session': {
        const session = await this.invokeSessionOperation((capability) =>
          capability.renameSession(message.sessionId, message.title));
        this.sendJson(socket, { type: 'session_renamed', requestId: message.requestId, session });
        return;
      }
      case 'archive_session': {
        const session = await this.invokeSessionOperation((capability) =>
          capability.archiveSession(message.sessionId));
        this.sendJson(socket, { type: 'session_archived', requestId: message.requestId, session });
        return;
      }
      case 'unarchive_session': {
        const session = await this.invokeSessionOperation((capability) =>
          capability.unarchiveSession(message.sessionId));
        this.sendJson(socket, { type: 'session_unarchived', requestId: message.requestId, session });
        return;
      }
      case 'delete_session':
        await this.invokeSessionOperation((capability) =>
          capability.deleteSession(message.sessionId));
        this.sendJson(socket, {
          type: 'session_deleted',
          requestId: message.requestId,
          sessionId: message.sessionId,
        });
        return;
      case 'fork_session': {
        const session = await this.invokeSessionOperation((capability) =>
          capability.forkSession(message.sessionId, message.entryId));
        this.sendJson(socket, { type: 'session_forked', requestId: message.requestId, session });
        return;
      }
    }
  }

  private async invokeSessionOperation<T>(
    operation: (capability: ChannelRuntimeCapabilities['sessions']) => Promise<T> | T,
  ): Promise<T> {
    const capability = this.runtimeCapabilities?.sessions;
    if (!capability) {
      throw new ProtocolError('SERVER_NOT_READY', 'Runtime Session capability is not bound.');
    }
    try {
      return await operation(capability);
    } catch (error) {
      if (error instanceof ChannelOperationError) {
        throw new ProtocolError(error.code, error.message);
      }
      throw new ProtocolError('SERVER_NOT_READY', 'Runtime Session capability is not ready.');
    }
  }

  /**
  * inbound `abort_turn`：`sessionId` 已通过 parseMessage 校验非空。
  * v1 不做 sessionId ↔ 发送方 clientId 的 owner 关系校验（§0.3 D5：
  * 单信任域假设），任何已 hello 的客户端都能 abort 任何 Session；
   * 多客户端隔离由未来 auth 层处理。
   *
   * abort 完成通过 `run_end{result.stopReason:'aborted'}` 通道通知，
  * 无 inline ack；Runtime capabilities 未 bind 时静默丢弃并 warn（开发时不接
   * RuntimeApp 单跑本 channel 场景）。
   */
  private handleAbortTurn(
    socket: WebSocket,
    message: Extract<ClientMessage, { type: 'abort_turn' }>,
  ): void {
    const clientId = this.requireBoundClientId(socket);
    if (!this.runtimeCapabilities) {
      this.logger.warn('abort_turn received but Runtime capabilities not bound; ignoring', {
        channelId: this.id,
        clientId,
        sessionId: message.sessionId,
      });
      return;
    }
    const result = this.runtimeCapabilities.abort.abortTurn(message.sessionId);
    this.logger.info('abort_turn dispatched', {
      channelId: this.id,
      clientId,
      sessionId: message.sessionId,
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
      this.logger.debug('ignoring stale socket close', {
        channelId: this.id,
        clientId,
      });
      return;
    }

    this.clients.delete(clientId);

    for (const [approvalId, route] of this.pendingApprovals) {
      if (route.clientId !== clientId) continue;
      this.pendingApprovals.delete(approvalId);
      this.dispatchApprovalUnavailable(approvalId, 'origin_disconnected');
    }

    const sessionAudienceKeys = this.clientSessions.get(clientId);
    if (sessionAudienceKeys) {
      for (const sessionId of sessionAudienceKeys) {
        const clientIds = this.sessions.get(sessionId);
        if (!clientIds) continue;
        clientIds.delete(clientId);
        if (clientIds.size === 0) {
          this.sessions.delete(sessionId);
        }
      }
      this.clientSessions.delete(clientId);
    }

    this.logger.info('client disconnected', {
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
  private registerSessionAudience(clientId: string, sessionId: string): void {
    let clientIds = this.sessions.get(sessionId);
    if (!clientIds) {
      clientIds = new Set<string>();
      this.sessions.set(sessionId, clientIds);
    }
    clientIds.add(clientId);

    let sessionIds = this.clientSessions.get(clientId);
    if (!sessionIds) {
      sessionIds = new Set<string>();
      this.clientSessions.set(clientId, sessionIds);
    }
    // 反向索引用于断线时按 clientId 做 O(关联 session 数) 清理，而不是全表扫描 sessions。
    sessionIds.add(sessionId);

    this.logger.debug('session audience registered', {
      channelId: this.id,
      clientId,
      sessionId,
      sessionAudienceSize: clientIds.size,
      clientSessionCount: sessionIds.size,
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
        this.sendApprovalClosedMessage(request, result);
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
    this.pendingApprovals.delete(id);
    if (this.interactionResponseHandler) {
      this.logger.debug('routing approval submission through interaction adapter', {
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
    request: Pick<
      ApprovalRequest,
      'id' | 'sessionId' | 'turnId' | 'toolName' | 'input' | 'originClientId'
    >,
  ): { status: 'accepted' } | { status: 'unavailable'; reason: 'origin_missing' | 'delivery_failed' } {
    if (!request.originClientId) {
      this.logger.debug('skipping approval request without origin client', {
        channelId: this.id,
        approvalId: request.id,
        toolName: request.toolName,
      });
      return { status: 'unavailable', reason: 'origin_missing' };
    }
    const socket = this.clients.get(request.originClientId);
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      this.logger.warn('unable to deliver approval request to client', {
        channelId: this.id,
        approvalId: request.id,
        toolName: request.toolName,
        originClientId: request.originClientId,
      });
      return { status: 'unavailable', reason: 'delivery_failed' };
    }
    this.logger.info('delivering approval request to client', {
      channelId: this.id,
      approvalId: request.id,
      toolName: request.toolName,
      originClientId: request.originClientId,
    });
    this.pendingApprovals.set(request.id, {
      clientId: request.originClientId,
      sessionId: request.sessionId,
      turnId: request.turnId,
    });
    this.sendJson(socket, {
      type: 'approval_requested',
      id: request.id,
      sessionId: request.sessionId,
      turnId: request.turnId,
      toolName: request.toolName,
      input: request.input,
    });
    return { status: 'accepted' };
  }

  private sendApprovalClosedMessage(
    request: Pick<ApprovalRequest, 'id' | 'sessionId' | 'turnId' | 'originClientId'>,
    result: ApprovalClosedResult,
  ): void {
    this.pendingApprovals.delete(request.id);
    if (!request.originClientId) {
      this.logger.debug('skipping approval closure without origin client', {
        channelId: this.id,
        approvalId: request.id,
      });
      return;
    }
    const socket = this.clients.get(request.originClientId);
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      this.logger.warn('unable to deliver approval closure to client', {
        channelId: this.id,
        approvalId: request.id,
        originClientId: request.originClientId,
      });
      return;
    }
    this.logger.info('delivering approval closure to client', {
      channelId: this.id,
      approvalId: request.id,
      originClientId: request.originClientId,
    });
    this.sendJson(socket, {
      type: 'approval_closed',
      id: request.id,
      sessionId: request.sessionId,
      turnId: request.turnId,
      outcome: result.outcome,
      reason: result.outcome === 'approved'
        ? result.source
        : 'reason' in result
          ? result.reason
          : result.message,
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

  private serializeEvent(event: AgentEvent, eventSessionId: string): Record<string, unknown> {
    if (event.type === 'request_end') {
      return {
        ...event,
        sessionId: eventSessionId,
      };
    }
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

function toWireModelCatalog(snapshot: ModelCatalogSnapshot): Record<string, unknown> {
  const defaultSelection = snapshot.defaultSelection.state === 'unset'
    ? { state: 'unset' }
    : {
        state: snapshot.defaultSelection.state,
        reference: {
          providerId: snapshot.defaultSelection.reference.providerId,
          modelId: snapshot.defaultSelection.reference.modelId,
        },
        ...(snapshot.defaultSelection.state === 'unavailable'
          ? { reason: snapshot.defaultSelection.reason }
          : {}),
      };
  return {
    generation: snapshot.generation,
    defaultSelection,
    providers: snapshot.providers.map((provider) => ({
      providerId: provider.providerId,
      displayName: provider.displayName,
      models: provider.models.map((model) => ({
        modelId: model.modelId,
        displayName: model.displayName,
        ...(model.capabilities
          ? {
              capabilities: {
                ...(model.capabilities.toolUse !== undefined
                  ? { toolUse: model.capabilities.toolUse }
                  : {}),
                ...(model.capabilities.mediaKinds !== undefined
                  ? { mediaKinds: [...model.capabilities.mediaKinds] }
                  : {}),
              },
            }
          : {}),
      })),
    })),
  };
}

function toWirePermissionMode(
  permission: SessionPermissionState,
): Pick<SessionPermissionState, 'sessionId' | 'mode' | 'changedAt'> {
  return {
    sessionId: permission.sessionId,
    mode: permission.mode,
    changedAt: permission.changedAt,
  };
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
    throw new ProtocolError('INVALID_MESSAGE', 'modelReference must be an object.');
  }
  assertOnlyKeys(value, ['providerId', 'modelId'], 'modelReference');
  return {
    providerId: readNonEmptyString(value.providerId, 'modelReference.providerId'),
    modelId: readOpaqueModelId(value.modelId, 'modelReference.modelId'),
  };
}

function readOpaqueModelId(value: unknown, field: string): string {
  if (typeof value !== 'string') {
    throw new ProtocolError('INVALID_MESSAGE', `${field} must be a string.`);
  }
  return value;
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
    const mediaType = source.mediaType;
    if (
      mediaType !== 'image/png'
      && mediaType !== 'image/jpeg'
      && mediaType !== 'image/webp'
      && mediaType !== 'image/gif'
    ) {
      throw new ProtocolError('INVALID_MESSAGE', `message[${index}].source.mediaType unsupported at wire layer.`);
    }
    if (typeof source.data !== 'string' || source.data.length === 0) {
      throw new ProtocolError('INVALID_MESSAGE', `message[${index}].source.data must be a non-empty string.`);
    }
    return {
      type: 'image',
      source: { type: 'base64', mediaType, data: source.data },
    };
  }
  throw new ProtocolError('INVALID_MESSAGE', `message[${index}].type unsupported.`);
}

function readOptionalNonEmptyString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  return readNonEmptyString(value, field);
}

function readNullableString(value: unknown, field: string): string | null {
  if (value === null || typeof value === 'string') return value;
  throw new ProtocolError('INVALID_MESSAGE', `${field} must be a string or null.`);
}

function readOptionalBoolean(value: unknown, field: string): boolean | undefined {
  if (value === undefined || typeof value === 'boolean') return value;
  throw new ProtocolError('INVALID_MESSAGE', `${field} must be a boolean.`);
}

function readPermissionMode(value: unknown, field: string): SessionPermissionMode {
  if (value !== 'manual' && value !== 'allow_all') {
    throw new ProtocolError('INVALID_MESSAGE', `${field} must be manual or allow_all.`);
  }
  return value;
}

function readOptionalPermissionMode(
  value: unknown,
  field: string,
): SessionPermissionMode | undefined {
  return value === undefined ? undefined : readPermissionMode(value, field);
}

async function launchBrowser(url: string): Promise<void> {
  const command = process.platform === 'win32'
    ? 'rundll32.exe'
    : process.platform === 'darwin'
      ? 'open'
      : 'xdg-open';
  const args = process.platform === 'win32'
    ? ['url.dll,FileProtocolHandler', url]
    : [url];

  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
  });
}