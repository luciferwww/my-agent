import { once } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import type { ApprovalInteractionRequest } from './types.js';
import { WebSocketChannel } from './WebSocketChannel.js';

describe('WebSocketChannel', () => {
  let channel: WebSocketChannel | undefined;
  const clients: WebSocket[] = [];

  afterEach(async () => {
    for (const client of clients.splice(0)) {
      client.close();
    }
    await channel?.stop();
    channel = undefined;
  });

  it('requires an onMessage handler before start', async () => {
    channel = new WebSocketChannel({ port: 0 });
    await expect(channel.start()).rejects.toThrow(
      'WebSocketChannel.start: no message handler registered (call registerChannel first)',
    );
  });

  it('binds hello and forwards run_turn with clientId', async () => {
    const handler = vi.fn(async () => undefined);
    channel = new WebSocketChannel({ port: 0 });
    channel.onMessage(handler);
    await channel.start();

    const client = await connectClient(channel);
    client.send(JSON.stringify({ type: 'hello', clientId: 'client-1' }));
    await expectMessage(client, { type: 'hello_ack', clientId: 'client-1' });

    client.send(JSON.stringify({
      type: 'run_turn',
      sessionKey: 'main',
      message: 'hello ws',
      maxLlmCalls: 7,
    }));

    await vi.waitFor(() => {
      expect(handler).toHaveBeenCalledWith({
        clientId: 'client-1',
        sessionKey: 'main',
        message: 'hello ws',
        model: undefined,
        maxTokens: undefined,
        maxLlmCalls: 7,
      });
    });
  });

  it('routes approval interactions to the origin client and forwards interaction responses', async () => {
    const interactionResponse = vi.fn();
    channel = new WebSocketChannel({ port: 0, approval: true });
    channel.onMessage(async () => undefined);
    channel.interaction?.onInteractionResponse(interactionResponse);
    await channel.start();

    const client = await connectClient(channel);
    client.send(JSON.stringify({ type: 'hello', clientId: 'client-1' }));
    await expectMessage(client, { type: 'hello_ack', clientId: 'client-1' });

    const request: ApprovalInteractionRequest = {
      id: 'apr-1',
      kind: 'approval',
      toolName: 'write_file',
      input: { path: 'README.md' },
      sessionKey: 'main',
      turnId: 'turn-1',
      originClientId: 'client-1',
      timeoutMs: 5000,
    };
    channel.interaction?.sendInteractionRequest(request);

    await expectMessage(client, {
      type: 'approval_requested',
      id: 'apr-1',
      toolName: 'write_file',
      input: { path: 'README.md' },
      timeoutMs: 5000,
    });

    client.send(JSON.stringify({ type: 'approval_resolve', id: 'apr-1', decision: 'allow' }));

    await vi.waitFor(() => {
      expect(interactionResponse).toHaveBeenCalledWith({
        id: 'apr-1',
        kind: 'approval',
        outcome: 'submitted',
        decision: 'allow',
      });
    });
  });
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
  const actual = JSON.parse(raw.toString('utf-8')) as Record<string, unknown>;
  expect(actual).toEqual(expected);
}