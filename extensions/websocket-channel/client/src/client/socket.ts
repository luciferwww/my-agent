import { readClientConfig } from '../client-config';

const RECONNECT_BASE_DELAY_MS = 750;
const RECONNECT_MAX_DELAY_MS = 12_000;

export function configuredWebSocketUrl(): string {
  return createWebSocketUrl(readClientConfig().webSocketPath);
}

export function createWebSocketUrl(
  webSocketPath: string,
  location: Pick<Location, 'protocol' | 'host'> = window.location,
): string {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${location.host}${webSocketPath}`;
}

export function reconnectDelay(attempt: number): number {
  const exponent = Math.min(Math.max(0, attempt), 4);
  return Math.min(RECONNECT_BASE_DELAY_MS * (2 ** exponent), RECONNECT_MAX_DELAY_MS);
}

export type ConnectionStatus =
  | 'disconnected'
  | 'connecting'
  | 'reconnecting'
  | 'connected';

export interface SocketClientCallbacks {
  readonly onStatusChange: (status: ConnectionStatus) => void;
  readonly onConnecting: (url: string, isRetry: boolean) => void;
  readonly onOpen: () => void;
  readonly onMessage: (data: unknown) => void;
  readonly onClose: (detail: string) => void;
  readonly onError: (detail: string) => void;
  readonly onReconnectScheduled: (delayMs: number) => void;
}

export interface SocketClientEnvironment {
  readonly createWebSocket: (url: string) => WebSocket;
  readonly setTimeout: typeof window.setTimeout;
  readonly clearTimeout: typeof window.clearTimeout;
  readonly addEventListener: Window['addEventListener'];
  readonly removeEventListener: Window['removeEventListener'];
}

function browserEnvironment(): SocketClientEnvironment {
  return {
    createWebSocket: url => new WebSocket(url),
    setTimeout: window.setTimeout.bind(window),
    clearTimeout: window.clearTimeout.bind(window),
    addEventListener: window.addEventListener.bind(window),
    removeEventListener: window.removeEventListener.bind(window),
  };
}

export class SocketClient {
  private socket: WebSocket | null = null;
  private reconnectTimer: number | null = null;
  private reconnectAttempt = 0;
  private shuttingDown = false;
  private started = false;
  private status: ConnectionStatus = 'disconnected';

  constructor(
    private readonly url: string,
    private readonly callbacks: SocketClientCallbacks,
    private readonly environment: SocketClientEnvironment = browserEnvironment(),
  ) {}

  start(): void {
    if (this.started) return;
    this.started = true;
    this.shuttingDown = false;
    this.environment.addEventListener('online', this.handleOnline);
    this.environment.addEventListener('pagehide', this.handlePageHide);
    this.connect(false);
  }

  markConnected(): void {
    if (!this.socket) return;
    this.reconnectAttempt = 0;
    this.setStatus('connected');
  }

  sendJson(payload: unknown): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      throw new Error('Socket is not open.');
    }
    this.socket.send(JSON.stringify(payload));
  }

  stop(): void {
    if (!this.started && this.shuttingDown) return;
    this.started = false;
    this.shuttingDown = true;
    this.environment.removeEventListener('online', this.handleOnline);
    this.environment.removeEventListener('pagehide', this.handlePageHide);
    this.cancelReconnect();
    const current = this.socket;
    this.socket = null;
    this.setStatus('disconnected');
    current?.close(1000, 'page closed');
  }

  private connect(isRetry: boolean): void {
    if (this.socket || this.status === 'connected' || this.shuttingDown) return;
    this.cancelReconnect();
    try {
      const socket = this.environment.createWebSocket(this.url);
      this.socket = socket;
      this.setStatus(isRetry ? 'reconnecting' : 'connecting');
      this.callbacks.onConnecting(this.url, isRetry);
      this.attachListeners(socket);
    } catch (error) {
      this.setStatus('disconnected');
      this.callbacks.onError(error instanceof Error ? error.message : String(error));
      this.scheduleReconnect();
    }
  }

  private attachListeners(socket: WebSocket): void {
    socket.addEventListener('open', () => {
      if (this.socket === socket) this.callbacks.onOpen();
    });
    socket.addEventListener('message', event => {
      if (this.socket === socket) this.callbacks.onMessage(event.data);
    });
    socket.addEventListener('close', event => {
      if (this.socket !== socket) return;
      const detail = event.wasClean
        ? `Socket closed (${event.code || 'no-code'})`
        : `Socket closed unexpectedly (${event.code || 'no-code'})`;
      this.socket = null;
      this.setStatus('disconnected');
      this.callbacks.onClose(detail);
      this.scheduleReconnect();
    });
    socket.addEventListener('error', () => {
      if (this.socket === socket) this.callbacks.onError('WebSocket transport error');
    });
  }

  private scheduleReconnect(): void {
    if (this.shuttingDown || this.reconnectTimer !== null) return;
    const delay = reconnectDelay(this.reconnectAttempt);
    this.reconnectAttempt += 1;
    this.setStatus('reconnecting');
    this.callbacks.onReconnectScheduled(delay);
    this.reconnectTimer = this.environment.setTimeout(() => {
      this.reconnectTimer = null;
      this.connect(true);
    }, delay);
  }

  private cancelReconnect(): void {
    if (this.reconnectTimer === null) return;
    this.environment.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  private setStatus(status: ConnectionStatus): void {
    if (this.status === status) return;
    this.status = status;
    this.callbacks.onStatusChange(status);
  }

  private readonly handleOnline = (): void => {
    if (this.socket || this.status === 'connected') return;
    this.cancelReconnect();
    this.connect(true);
  };

  private readonly handlePageHide = (): void => {
    this.stop();
  };
}
