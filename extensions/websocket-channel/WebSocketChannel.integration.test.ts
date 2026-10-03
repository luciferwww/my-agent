import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';

import {
  type ExtensionLogger,
} from 'my-agent/extension-api';
import { WebSocketChannel } from './WebSocketChannel.js';
import type { WebSocketExtensionConfig } from './config.js';
import { WS_MAX_PAYLOAD_BYTES } from './websocket-constants.js';

const CLIENT_FILE_PATH = fileURLToPath(new URL('./client/chat.html', import.meta.url));
const logger: ExtensionLogger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

describe('WebSocketChannel payload integration', () => {
  let channel: WebSocketChannel | undefined;
  let client: WebSocket | undefined;

  afterEach(async () => {
    client?.close();
    await channel?.stop();
  });

  it('accepts a frame above 10 MiB and below the configured WebSocket limit', async () => {
    const message = 'x'.repeat(10 * 1024 * 1024 + 1);
    const frame = JSON.stringify({
      type: 'run_turn',
      sessionId: 'payload-limit',
      message,
    });
    expect(Buffer.byteLength(frame)).toBeGreaterThan(10 * 1024 * 1024);
    expect(Buffer.byteLength(frame)).toBeLessThan(WS_MAX_PAYLOAD_BYTES);

    const handler = vi.fn(async () => undefined);
    channel = createChannel({ port: 0 });
    channel.onMessage(handler);
    await channel.start();

    client = await connectClient(channel);
    client.send(JSON.stringify({ type: 'hello', clientId: 'payload-client' }));
    await expectMessage(client, { type: 'hello_ack', clientId: 'payload-client' });
    client.send(frame);

    await vi.waitFor(() => {
      expect(handler).toHaveBeenCalledWith({
        clientId: 'payload-client',
        sessionId: 'payload-limit',
        message,
      });
    }, { timeout: 5_000 });
    expect(client.readyState).toBe(WebSocket.OPEN);
  }, 10_000);
});

async function connectClient(channel: WebSocketChannel): Promise<WebSocket> {
  const address = (channel as unknown as { httpServer?: { address(): unknown } }).httpServer?.address();
  if (!address || typeof address !== 'object' || !('port' in address)) {
    throw new Error('WebSocketChannel server address is not available');
  }

  const client = new WebSocket(`ws://127.0.0.1:${address.port}/ws`);
  await once(client, 'open');
  return client;
}

function createChannel(config: Partial<WebSocketExtensionConfig> = {}): WebSocketChannel {
  return new WebSocketChannel({
    config: {
      host: '127.0.0.1',
      port: 0,
      webSocketPath: '/ws',
      clientPath: '/',
      approval: false,
      openBrowser: false,
      ...config,
    },
    clientFilePath: CLIENT_FILE_PATH,
    logger,
  });
}

async function expectMessage(client: WebSocket, expected: Record<string, unknown>): Promise<void> {
  const [raw] = await once(client, 'message');
  expect(JSON.parse(raw.toString('utf-8'))).toEqual(expected);
}
