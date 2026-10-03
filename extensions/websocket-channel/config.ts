export interface WebSocketExtensionConfig {
  readonly host: string;
  readonly port: number;
  readonly webSocketPath: string;
  readonly clientPath: string;
  readonly maxClients?: number;
  readonly approval: boolean;
  readonly openBrowser: boolean;
}

const URL_PATH_PATTERN = /^\/(?!\/)(?:[A-Za-z0-9._~!$&'()*+,;=:@/-]|%[0-9A-Fa-f]{2})*$/u;

export function readWebSocketExtensionConfig(
  value: Readonly<Record<string, unknown>>,
): WebSocketExtensionConfig {
  const host = value['host'];
  const port = value['port'];
  const webSocketPath = value['webSocketPath'];
  const clientPath = value['clientPath'];
  const maxClients = value['maxClients'];
  const approval = value['approval'];
  const openBrowser = value['openBrowser'];

  if (typeof host !== 'string' || host.length === 0) invalidConfig();
  if (!Number.isInteger(port) || (port as number) < 0 || (port as number) > 65_535) {
    invalidConfig();
  }
  if (typeof webSocketPath !== 'string' || !URL_PATH_PATTERN.test(webSocketPath)) invalidConfig();
  if (typeof clientPath !== 'string' || !URL_PATH_PATTERN.test(clientPath)) invalidConfig();
  if (webSocketPath === clientPath) invalidConfig();
  if (
    maxClients !== undefined
    && (!Number.isSafeInteger(maxClients) || (maxClients as number) < 1)
  ) {
    invalidConfig();
  }
  if (typeof approval !== 'boolean' || typeof openBrowser !== 'boolean') invalidConfig();

  return Object.freeze({
    host,
    port: port as number,
    webSocketPath,
    clientPath,
    ...(maxClients === undefined ? {} : { maxClients: maxClients as number }),
    approval,
    openBrowser,
  });
}

function invalidConfig(): never {
  throw new Error('WebSocket Extension configuration is invalid.');
}
