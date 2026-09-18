import { once } from 'node:events';

import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';

import { WS_MAX_PAYLOAD_BYTES } from '../../../core/media/constants.js';
import { WebSocketChannel } from './WebSocketChannel.js';

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
    channel = new WebSocketChannel({ port: 0 });
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
  const address = (channel as unknown as { server?: { address(): unknown } }).server?.address();
  if (!address || typeof address !== 'object' || !('port' in address)) {
    throw new Error('WebSocketChannel server address is not available');
  }

  const client = new WebSocket(`ws://127.0.0.1:${address.port}/ws`);
  await once(client, 'open');
  return client;
}

async function expectMessage(client: WebSocket, expected: Record<string, unknown>): Promise<void> {
  const [raw] = await once(client, 'message');
  expect(JSON.parse(raw.toString('utf-8'))).toEqual(expected);
}
