export interface ClientConfig {
  readonly webSocketPath: string;
}

export function readClientConfig(): ClientConfig {
  const element = document.querySelector('#my-agent-client-config');
  if (!element) {
    throw new Error('WebSocket Client configuration is missing');
  }

  const value: unknown = JSON.parse(element.textContent ?? '');
  if (!isRecord(value) || !isAbsolutePath(value.webSocketPath)) {
    throw new Error('WebSocket Client configuration is invalid');
  }
  return Object.freeze({ webSocketPath: value.webSocketPath });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isAbsolutePath(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith('/') && !value.startsWith('//');
}
