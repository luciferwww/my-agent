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

  // PR-7: subagent_* events carry the child sessionKey; WebSocketChannel must
  // route them to the parent's audience so subscribers actually see them.
  describe('subagent event audience routing', () => {
    it('routes subagent_start to the parent sessionKey audience', async () => {
      const handler = vi.fn(async () => undefined);
      channel = new WebSocketChannel({ port: 0 });
      channel.onMessage(handler);
      await channel.start();

      const client = await connectClient(channel);
      client.send(JSON.stringify({ type: 'hello', clientId: 'client-1' }));
      await expectMessage(client, { type: 'hello_ack', clientId: 'client-1' });

      // Subscribe to 'main' by running a turn against it.
      client.send(JSON.stringify({ type: 'run_turn', sessionKey: 'main', message: 'hi' }));
      await vi.waitFor(() => expect(handler).toHaveBeenCalled());

      channel.send({
        type: 'subagent_start',
        runId: 'run-1',
        sessionKey: 'main:subagent:run-1:1',
        turnId: 'child-turn-1',
        depth: 1,
        subagentType: 'general-purpose',
        lifecycle: 'blocking',
        trigger: {
          source: 'llm-tool',
          parentSessionKey: 'main',
          parentTurnId: 'parent-turn-1',
          parentToolUseId: 'tu-1',
        },
      });

      await expectMessage(client, {
        type: 'subagent_start',
        runId: 'run-1',
        sessionKey: 'main:subagent:run-1:1',
        turnId: 'child-turn-1',
        depth: 1,
        subagentType: 'general-purpose',
        lifecycle: 'blocking',
        trigger: {
          source: 'llm-tool',
          parentSessionKey: 'main',
          parentTurnId: 'parent-turn-1',
          parentToolUseId: 'tu-1',
        },
      });
    });

    it('broadcasts user_message to every client on the session (including origin)', async () => {
      // channel-multi-client-user-message-spec §7: multi-client visibility
      const handler = vi.fn(async () => undefined);
      channel = new WebSocketChannel({ port: 0 });
      channel.onMessage(handler);
      await channel.start();

      const clientA = await connectClient(channel);
      clients.push(clientA);
      clientA.send(JSON.stringify({ type: 'hello', clientId: 'client-A' }));
      await expectMessage(clientA, { type: 'hello_ack', clientId: 'client-A' });

      const clientB = await connectClient(channel);
      clients.push(clientB);
      clientB.send(JSON.stringify({ type: 'hello', clientId: 'client-B' }));
      await expectMessage(clientB, { type: 'hello_ack', clientId: 'client-B' });

      // Both subscribe to 'main' via run_turn
      clientA.send(JSON.stringify({ type: 'run_turn', sessionKey: 'main', message: 'first' }));
      clientB.send(JSON.stringify({ type: 'run_turn', sessionKey: 'main', message: 'second' }));
      await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(2));

      const timestamp = Date.now();
      channel.send({
        type: 'user_message',
        sessionKey: 'main',
        messageId: 'msg-abc',
        content: 'hello everyone',
        attachmentSummaries: [{ type: 'image', mime: 'image/png', bytes: 1024 }],
        originClientId: 'client-A',
        deliveryMode: 'queued',
        timestamp,
      });

      const expected = {
        type: 'user_message',
        sessionKey: 'main',
        messageId: 'msg-abc',
        content: 'hello everyone',
        attachmentSummaries: [{ type: 'image', mime: 'image/png', bytes: 1024 }],
        originClientId: 'client-A',
        deliveryMode: 'queued',
        timestamp,
      };

      await expectMessage(clientA, expected);
      await expectMessage(clientB, expected);
    });

    it('routes subagent_end to the parent sessionKey audience', async () => {
      const handler = vi.fn(async () => undefined);
      channel = new WebSocketChannel({ port: 0 });
      channel.onMessage(handler);
      await channel.start();

      const client = await connectClient(channel);
      client.send(JSON.stringify({ type: 'hello', clientId: 'client-1' }));
      await expectMessage(client, { type: 'hello_ack', clientId: 'client-1' });

      client.send(JSON.stringify({ type: 'run_turn', sessionKey: 'main', message: 'hi' }));
      await vi.waitFor(() => expect(handler).toHaveBeenCalled());

      channel.send({
        type: 'subagent_end',
        runId: 'run-1',
        sessionKey: 'main:subagent:run-1:1',
        turnId: 'child-turn-1',
        depth: 1,
        subagentType: 'general-purpose',
        lifecycle: 'blocking',
        trigger: {
          source: 'llm-tool',
          parentSessionKey: 'main',
          parentTurnId: 'parent-turn-1',
          parentToolUseId: 'tu-1',
        },
        outcome: 'ok',
        usage: { inputTokens: 10, outputTokens: 5 },
        durationMs: 123,
      });

      await expectMessage(client, {
        type: 'subagent_end',
        runId: 'run-1',
        sessionKey: 'main:subagent:run-1:1',
        turnId: 'child-turn-1',
        depth: 1,
        subagentType: 'general-purpose',
        lifecycle: 'blocking',
        trigger: {
          source: 'llm-tool',
          parentSessionKey: 'main',
          parentTurnId: 'parent-turn-1',
          parentToolUseId: 'tu-1',
        },
        outcome: 'ok',
        usage: { inputTokens: 10, outputTokens: 5 },
        durationMs: 123,
      });
    });
  });

  // ── Abort (core-abort-spec.md §13) ─────────────────────

  describe('abort_turn', () => {
    it('inbound abort_turn → abortHooks.abortTurn called with sessionKey', async () => {
      const abortTurn = vi.fn(() => ({ aborted: true, dropped: 0 }));
      const query = vi.fn(() => []);

      channel = new WebSocketChannel({ port: 0 });
      channel.onMessage(async () => undefined);
      channel.bindAbortHooks({
        querySessionsNeedingAbort: query,
        abortTurn,
      });
      await channel.start();

      const client = await connectClient(channel);
      clients.push(client);
      client.send(JSON.stringify({ type: 'hello', clientId: 'client-abort' }));
      await expectMessage(client, { type: 'hello_ack', clientId: 'client-abort' });

      client.send(JSON.stringify({ type: 'abort_turn', sessionKey: 'main' }));

      await vi.waitFor(() => {
        expect(abortTurn).toHaveBeenCalledTimes(1);
        expect(abortTurn).toHaveBeenCalledWith('main');
      });
    });

    it("run_end{stopReason:'aborted'} is fanned out to subscribed WS clients", async () => {
      // Proves the client-facing signal used to detect abort completion
      // (spec §13: no inline ack — client observes via run_end).
      const handler = vi.fn(async () => undefined);
      channel = new WebSocketChannel({ port: 0 });
      channel.onMessage(handler);
      await channel.start();

      const client = await connectClient(channel);
      clients.push(client);
      client.send(JSON.stringify({ type: 'hello', clientId: 'client-observer' }));
      await expectMessage(client, { type: 'hello_ack', clientId: 'client-observer' });

      // Subscribe to the session audience so send() will fan to this client.
      client.send(JSON.stringify({ type: 'run_turn', sessionKey: 'main', message: 'anything' }));
      await vi.waitFor(() => expect(handler).toHaveBeenCalled());

      channel.send({
        type: 'run_end',
        sessionKey: 'main',
        turnId: 'turn-aborted-1',
        result: {
          text: 'partial reply',
          content: [{ type: 'text', text: 'partial reply' }],
          stopReason: 'aborted',
          usage: { inputTokens: 12, outputTokens: 3 },
          toolRounds: 0,
        },
      });

      await expectMessage(client, {
        type: 'run_end',
        sessionKey: 'main',
        turnId: 'turn-aborted-1',
        result: {
          text: 'partial reply',
          content: [{ type: 'text', text: 'partial reply' }],
          stopReason: 'aborted',
          usage: { inputTokens: 12, outputTokens: 3 },
          toolRounds: 0,
        },
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