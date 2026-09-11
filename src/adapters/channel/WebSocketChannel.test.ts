import { once } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import type {
  ApprovalInteractionRequest,
  ChannelRuntimeCapabilities,
  ModelCatalogSnapshot,
} from '../../core/channel/index.js';
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
    await expect(channel.start()).rejects.toThrow('WebSocketChannel.start: no message handler registered');
    await expect(channel.completion).resolves.toEqual(
      expect.objectContaining({ outcome: 'failed', phase: 'startup' }),
    );
  });

  it('reports listening readiness separately from terminal stop completion', async () => {
    channel = new WebSocketChannel({ port: 0 });
    channel.onMessage(async () => undefined);
    let completed = false;
    void channel.completion.then(() => {
      completed = true;
    });

    await channel.start();
    await Promise.resolve();
    expect(completed).toBe(false);

    await channel.stop();
    await expect(channel.completion).resolves.toEqual({ outcome: 'closed', reason: 'stopped' });
  });

  it('stops safely while start is still waiting for listening readiness', async () => {
    channel = new WebSocketChannel({ port: 0 });
    channel.onMessage(async () => undefined);

    const start = channel.start();
    await channel.stop();

    await expect(start).rejects.toThrow('server closed before readiness');
    await expect(channel.completion).resolves.toEqual({ outcome: 'closed', reason: 'stopped' });
  });

  it('binds hello and forwards run_turn with clientId', async () => {
    const modelId = ' model/vendor:v1?x=1\n\u0000 ';
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
      model_reference: { provider_id: 'test', model_id: modelId },
      request_override: { max_output_tokens: 2048 },
      maxLlmCalls: 7,
    }));

    await vi.waitFor(() => {
      expect(handler).toHaveBeenCalledWith({
        clientId: 'client-1',
        sessionKey: 'main',
        message: 'hello ws',
        modelReference: { providerId: 'test', modelId },
        requestOverride: { maxOutputTokens: 2048 },
        maxLlmCalls: 7,
      });
    });
  });

  it('preserves an empty string Model ID instead of treating it as missing', async () => {
    const handler = vi.fn(async () => undefined);
    channel = new WebSocketChannel({ port: 0 });
    channel.onMessage(handler);
    await channel.start();

    const client = await connectClient(channel);
    clients.push(client);
    client.send(JSON.stringify({ type: 'hello', clientId: 'empty-model-client' }));
    await expectMessage(client, { type: 'hello_ack', clientId: 'empty-model-client' });
    client.send(JSON.stringify({
      type: 'run_turn',
      sessionKey: 'main',
      message: 'empty model id',
      model_reference: { provider_id: 'test', model_id: '' },
    }));

    await vi.waitFor(() => expect(handler).toHaveBeenCalledWith({
      clientId: 'empty-model-client',
      sessionKey: 'main',
      message: 'empty model id',
      modelReference: { providerId: 'test', modelId: '' },
    }));
  });

  it.each([
    { model: 'legacy-model' },
    { maxTokens: 2048 },
  ])('rejects removed legacy run_turn fields: %j', async (legacyField) => {
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
      message: 'legacy',
      ...legacyField,
    }));

    await expectMessage(client, {
      type: 'channel_error',
      code: 'INVALID_MESSAGE',
      message: 'Legacy model/maxTokens fields are not supported; use model_reference/request_override.',
    });
    expect(handler).not.toHaveBeenCalled();
  });

  describe('model catalog protocol', () => {
    const unavailableCatalog: ModelCatalogSnapshot = {
      generation: 12,
      defaultSelection: {
        state: 'unavailable',
        reference: { providerId: 'copilot-relay', modelId: 'missing-model' },
        reason: 'model_rejected',
      },
      providers: [{
        providerId: 'copilot-relay',
        displayName: 'Copilot Relay',
        models: [{ modelId: 'gpt-5.6-sol', displayName: 'GPT 5.6 Sol' }],
      }],
    };

    it('returns a request-correlated snake_case Catalog after hello', async () => {
      channel = new WebSocketChannel({ port: 0 });
      channel.onMessage(async () => undefined);
      channel.bindRuntimeCapabilities(capabilities(() => unavailableCatalog));
      await channel.start();

      const client = await connectClient(channel);
      clients.push(client);
      client.send(JSON.stringify({ type: 'hello', clientId: 'catalog-client' }));
      await expectMessage(client, { type: 'hello_ack', clientId: 'catalog-client' });
      client.send(JSON.stringify({ type: 'get_model_catalog', request_id: 'catalog-1' }));

      await expectMessage(client, {
        type: 'model_catalog',
        request_id: 'catalog-1',
        catalog: {
          generation: 12,
          default_selection: {
            state: 'unavailable',
            reference: {
              provider_id: 'copilot-relay',
              model_id: 'missing-model',
            },
            reason: 'model_rejected',
          },
          providers: [{
            provider_id: 'copilot-relay',
            display_name: 'Copilot Relay',
            models: [{ model_id: 'gpt-5.6-sol', display_name: 'GPT 5.6 Sol' }],
          }],
        },
      });
    });

    it('unicasts a Catalog response only to the requesting client', async () => {
      channel = new WebSocketChannel({ port: 0 });
      channel.onMessage(async () => undefined);
      channel.bindRuntimeCapabilities(capabilities(() => unavailableCatalog));
      await channel.start();

      const requester = await connectClient(channel);
      const observer = await connectClient(channel);
      clients.push(requester, observer);
      requester.send(JSON.stringify({ type: 'hello', clientId: 'catalog-requester' }));
      observer.send(JSON.stringify({ type: 'hello', clientId: 'catalog-observer' }));
      await expectMessage(requester, { type: 'hello_ack', clientId: 'catalog-requester' });
      await expectMessage(observer, { type: 'hello_ack', clientId: 'catalog-observer' });

      const observerMessages = vi.fn();
      observer.on('message', observerMessages);
      requester.send(JSON.stringify({ type: 'get_model_catalog', request_id: 'private-catalog' }));
      const response = await nextMessage(requester);
      expect(response).toMatchObject({
        type: 'model_catalog',
        request_id: 'private-catalog',
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(observerMessages).not.toHaveBeenCalled();
    });

    it('observes the latest generation through one long-lived binding', async () => {
      let snapshot = unavailableCatalog;
      channel = new WebSocketChannel({ port: 0 });
      channel.onMessage(async () => undefined);
      channel.bindRuntimeCapabilities(capabilities(() => snapshot));
      await channel.start();

      const client = await connectClient(channel);
      clients.push(client);
      client.send(JSON.stringify({ type: 'hello', clientId: 'reload-client' }));
      await expectMessage(client, { type: 'hello_ack', clientId: 'reload-client' });
      client.send(JSON.stringify({ type: 'get_model_catalog', request_id: 'before' }));
      const before = await nextMessage(client);
      expect((before.catalog as { generation: number }).generation).toBe(12);

      snapshot = { ...unavailableCatalog, generation: 13 };
      client.send(JSON.stringify({ type: 'get_model_catalog', request_id: 'after' }));
      const after = await nextMessage(client);
      expect(after.request_id).toBe('after');
      expect((after.catalog as { generation: number }).generation).toBe(13);
    });

    it('rejects query before hello, blank request_id, and missing capability', async () => {
      channel = new WebSocketChannel({ port: 0 });
      channel.onMessage(async () => undefined);
      await channel.start();

      const client = await connectClient(channel);
      clients.push(client);
      client.send(JSON.stringify({ type: 'get_model_catalog', request_id: 'early' }));
      await expectMessage(client, {
        type: 'channel_error',
        code: 'SERVER_NOT_READY',
        message: 'hello must complete before business messages.',
      });

      client.send(JSON.stringify({ type: 'hello', clientId: 'catalog-client' }));
      await expectMessage(client, { type: 'hello_ack', clientId: 'catalog-client' });
      client.send(JSON.stringify({ type: 'get_model_catalog', request_id: ' ' }));
      await expectMessage(client, {
        type: 'channel_error',
        code: 'INVALID_MESSAGE',
        message: 'request_id must be a non-empty string.',
      });
      client.send(JSON.stringify({ type: 'get_model_catalog', request_id: 'unbound' }));
      await expectMessage(client, {
        type: 'channel_error',
        code: 'SERVER_NOT_READY',
        message: 'Runtime Model Catalog is not bound.',
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
    };
    expect(channel.interaction?.sendInteractionRequest(request)).toEqual({ status: 'accepted' });

    await expectMessage(client, {
      type: 'approval_requested',
      id: 'apr-1',
      toolName: 'write_file',
      input: { path: 'README.md' },
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

  it('returns unavailable when an approval origin cannot receive the request', async () => {
    channel = new WebSocketChannel({ port: 0, approval: true });
    channel.onMessage(async () => undefined);
    await channel.start();

    expect(channel.interaction?.sendInteractionRequest({
      id: 'apr-missing',
      kind: 'approval',
      toolName: 'write_file',
      input: {},
      sessionKey: 'main',
      turnId: 'turn-missing',
      originClientId: 'missing-client',
    })).toEqual({ status: 'unavailable', reason: 'delivery_failed' });
  });

  it('sends approval_closed for a non-user terminal outcome', async () => {
    channel = new WebSocketChannel({ port: 0, approval: true });
    channel.onMessage(async () => undefined);
    await channel.start();

    const client = await connectClient(channel);
    clients.push(client);
    client.send(JSON.stringify({ type: 'hello', clientId: 'client-close' }));
    await expectMessage(client, { type: 'hello_ack', clientId: 'client-close' });

    const request: ApprovalInteractionRequest = {
      id: 'apr-close',
      kind: 'approval',
      toolName: 'write_file',
      input: {},
      sessionKey: 'main',
      turnId: 'turn-close',
      originClientId: 'client-close',
    };
    expect(channel.interaction?.sendInteractionRequest(request)).toEqual({ status: 'accepted' });
    await expectMessage(client, {
      type: 'approval_requested',
      id: 'apr-close',
      toolName: 'write_file',
      input: {},
    });

    channel.interaction?.sendInteractionClosed(request, {
      outcome: 'aborted',
      reason: 'turn',
    });
    await expectMessage(client, {
      type: 'approval_closed',
      id: 'apr-close',
      outcome: 'aborted',
      reason: 'turn',
    });
  });

  it('keeps pending approval bound across same-client socket replacement', async () => {
    const interactionResponse = vi.fn();
    const interactionUnavailable = vi.fn();
    channel = new WebSocketChannel({ port: 0, approval: true });
    channel.onMessage(async () => undefined);
    channel.interaction?.onInteractionResponse(interactionResponse);
    channel.interaction?.onInteractionUnavailable(interactionUnavailable);
    await channel.start();

    const firstClient = await connectClient(channel);
    clients.push(firstClient);
    firstClient.send(JSON.stringify({ type: 'hello', clientId: 'client-replace' }));
    await expectMessage(firstClient, { type: 'hello_ack', clientId: 'client-replace' });

    const request: ApprovalInteractionRequest = {
      id: 'apr-replace',
      kind: 'approval',
      toolName: 'write_file',
      input: {},
      sessionKey: 'main',
      turnId: 'turn-replace',
      originClientId: 'client-replace',
    };
    channel.interaction?.sendInteractionRequest(request);
    await expectMessage(firstClient, {
      type: 'approval_requested',
      id: 'apr-replace',
      toolName: 'write_file',
      input: {},
    });

    const serverSocket = (channel as unknown as { clients: Map<string, WebSocket> })
      .clients.get('client-replace')!;
    const closeSpy = vi.spyOn(serverSocket, 'close').mockImplementation(() => undefined);
    const replacementClient = await connectClient(channel);
    clients.push(replacementClient);
    replacementClient.send(JSON.stringify({ type: 'hello', clientId: 'client-replace' }));
    await expectMessage(replacementClient, { type: 'hello_ack', clientId: 'client-replace' });

    firstClient.send(JSON.stringify({
      type: 'approval_resolve',
      id: 'apr-replace',
      decision: 'allow',
    }));
    await expectMessage(firstClient, {
      type: 'channel_error',
      code: 'INVALID_MESSAGE',
      message: 'This connection has been superseded.',
    });
    expect(interactionResponse).not.toHaveBeenCalled();

    const firstClosed = once(firstClient, 'close');
    closeSpy.mockRestore();
    serverSocket.close();
    await firstClosed;
    expect(interactionUnavailable).not.toHaveBeenCalled();

    replacementClient.send(JSON.stringify({
      type: 'approval_resolve',
      id: 'apr-replace',
      decision: 'deny',
    }));
    await vi.waitFor(() => {
      expect(interactionResponse).toHaveBeenCalledWith({
        id: 'apr-replace',
        kind: 'approval',
        outcome: 'submitted',
        decision: 'deny',
      });
    });
  });

  it('reports unavailable when the current approval origin disconnects', async () => {
    const interactionUnavailable = vi.fn();
    channel = new WebSocketChannel({ port: 0, approval: true });
    channel.onMessage(async () => undefined);
    channel.interaction?.onInteractionUnavailable(interactionUnavailable);
    await channel.start();

    const client = await connectClient(channel);
    clients.push(client);
    client.send(JSON.stringify({ type: 'hello', clientId: 'client-disconnect' }));
    await expectMessage(client, { type: 'hello_ack', clientId: 'client-disconnect' });

    channel.interaction?.sendInteractionRequest({
      id: 'apr-disconnect',
      kind: 'approval',
      toolName: 'write_file',
      input: {},
      sessionKey: 'main',
      turnId: 'turn-disconnect',
      originClientId: 'client-disconnect',
    });
    await expectMessage(client, {
      type: 'approval_requested',
      id: 'apr-disconnect',
      toolName: 'write_file',
      input: {},
    });

    client.close();
    await once(client, 'close');
    await vi.waitFor(() => {
      expect(interactionUnavailable).toHaveBeenCalledWith(
        'apr-disconnect',
        'origin_disconnected',
      );
    });
  });

  it('serializes resolution failure category and queued correlation', async () => {
    const handler = vi.fn(async () => undefined);
    channel = new WebSocketChannel({ port: 0 });
    channel.onMessage(handler);
    await channel.start();

    const client = await connectClient(channel);
    client.send(JSON.stringify({ type: 'hello', clientId: 'client-resolution' }));
    await expectMessage(client, { type: 'hello_ack', clientId: 'client-resolution' });
    client.send(JSON.stringify({ type: 'run_turn', sessionKey: 'main', message: 'hi' }));
    await vi.waitFor(() => expect(handler).toHaveBeenCalled());

    channel.send({
      type: 'error',
      requestId: 'request-resolution',
      sessionKey: 'main',
      turnId: 'resolution-turn',
      error: new Error('Provider is not registered.'),
      category: 'provider_unregistered',
      originMessageId: 'queued-message',
    });

    await expectMessage(client, {
      type: 'error',
      requestId: 'request-resolution',
      sessionKey: 'main',
      turnId: 'resolution-turn',
      error: 'Provider is not registered.',
      category: 'provider_unregistered',
      originMessageId: 'queued-message',
    });
  });

  it('routes queued request_end by origin message and serializes request ids as snake_case', async () => {
    const handler = vi.fn(async () => undefined);
    channel = new WebSocketChannel({ port: 0 });
    channel.onMessage(handler);
    await channel.start();

    const client = await connectClient(channel);
    client.send(JSON.stringify({ type: 'hello', clientId: 'client-request-end' }));
    await expectMessage(client, { type: 'hello_ack', clientId: 'client-request-end' });
    client.send(JSON.stringify({ type: 'run_turn', sessionKey: 'main', message: 'hi' }));
    await vi.waitFor(() => expect(handler).toHaveBeenCalled());

    channel.send({
      type: 'user_message',
      sessionKey: 'main',
      messageId: 'origin-queued',
      content: 'queued',
      originClientId: 'client-request-end',
      deliveryMode: 'queued',
      timestamp: 1,
    });
    await expectMessage(client, {
      type: 'user_message',
      sessionKey: 'main',
      messageId: 'origin-queued',
      content: 'queued',
      originClientId: 'client-request-end',
      deliveryMode: 'queued',
      timestamp: 1,
    });
    channel.send({
      type: 'request_end',
      requestId: 'request-queued',
      originMessageId: 'origin-queued',
      outcome: 'cancelled',
      reason: 'shutdown',
    });

    await expectMessage(client, {
      type: 'request_end',
      request_id: 'request-queued',
      origin_message_id: 'origin-queued',
      outcome: 'cancelled',
      reason: 'shutdown',
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
        requestId: 'request-1',
        runId: 'run-1',
        sessionKey: 'main:subagent:run-1:1',
        turnId: 'child-turn-1',
        depth: 1,
        subagentType: 'general-purpose',
        lifecycle: 'blocking',
        parentSessionKey: 'main',
        parentTurnId: 'parent-turn-1',
        parentToolUseId: 'tu-1',
      });

      await expectMessage(client, {
        type: 'subagent_start',
        requestId: 'request-1',
        runId: 'run-1',
        sessionKey: 'main:subagent:run-1:1',
        turnId: 'child-turn-1',
        depth: 1,
        subagentType: 'general-purpose',
        lifecycle: 'blocking',
        parentSessionKey: 'main',
        parentTurnId: 'parent-turn-1',
        parentToolUseId: 'tu-1',
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
        requestId: 'request-1',
        runId: 'run-1',
        sessionKey: 'main:subagent:run-1:1',
        turnId: 'child-turn-1',
        depth: 1,
        subagentType: 'general-purpose',
        lifecycle: 'blocking',
        parentSessionKey: 'main',
        parentTurnId: 'parent-turn-1',
        parentToolUseId: 'tu-1',
        outcome: 'ok',
        usage: { inputTokens: 10, outputTokens: 5 },
        durationMs: 123,
      });

      await expectMessage(client, {
        type: 'subagent_end',
        requestId: 'request-1',
        runId: 'run-1',
        sessionKey: 'main:subagent:run-1:1',
        turnId: 'child-turn-1',
        depth: 1,
        subagentType: 'general-purpose',
        lifecycle: 'blocking',
        parentSessionKey: 'main',
        parentTurnId: 'parent-turn-1',
        parentToolUseId: 'tu-1',
        outcome: 'ok',
        usage: { inputTokens: 10, outputTokens: 5 },
        durationMs: 123,
      });
    });
  });

  // ── Abort (core-abort-spec.md §13) ─────────────────────

  describe('abort_turn', () => {
    it('inbound abort_turn → capabilities.abort.abortTurn called with sessionKey', async () => {
      const abortTurn = vi.fn(() => ({ aborted: true, dropped: 0 }));
      const query = vi.fn(() => []);

      channel = new WebSocketChannel({ port: 0 });
      channel.onMessage(async () => undefined);
      channel.bindRuntimeCapabilities(capabilities(
        () => ({ generation: 1, defaultSelection: { state: 'unset' }, providers: [] }),
        { querySessionsNeedingAbort: query, abortTurn },
      ));
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
        requestId: 'request-aborted-1',
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
        requestId: 'request-aborted-1',
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
  const actual = await nextMessage(client);
  expect(actual).toEqual(expected);
}

async function nextMessage(client: WebSocket): Promise<Record<string, unknown>> {
  const [raw] = await once(client, 'message');
  return JSON.parse(raw.toString('utf-8')) as Record<string, unknown>;
}

function capabilities(
  getSnapshot: () => ModelCatalogSnapshot,
  abort: ChannelRuntimeCapabilities['abort'] = {
    querySessionsNeedingAbort: () => [],
    abortTurn: () => ({ aborted: false, dropped: 0 }),
  },
): ChannelRuntimeCapabilities {
  return {
    modelCatalog: { getSnapshot },
    abort,
  };
}