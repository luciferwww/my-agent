import { once } from 'node:events';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import {
  ChannelOperationError,
  type ExtensionLogger,
  type ApprovalInteractionRequest,
  type ChannelRuntimeCapabilities,
  type ModelCatalogSnapshot,
} from 'my-agent/extension-api';
import {
  WebSocketChannel,
  type BrowserLauncher,
  type WebSocketChannelOptions,
} from './WebSocketChannel.js';
import type { WebSocketExtensionConfig } from './config.js';

const CLIENT_FILE_PATH = fileURLToPath(new URL('./client/chat.html', import.meta.url));
const logger: ExtensionLogger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

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
    channel = createChannel({ port: 0 });
    await expect(channel.start()).rejects.toThrow('WebSocketChannel.start: no message handler registered');
    await expect(channel.completion).resolves.toEqual(
      expect.objectContaining({ outcome: 'failed', phase: 'startup' }),
    );
  });

  it('reports listening readiness separately from terminal stop completion', async () => {
    channel = createChannel({ port: 0 });
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

  it('rejects startup and cleans up when the configured port is occupied', async () => {
    const occupyingServer = createServer();
    occupyingServer.listen(0, '127.0.0.1');
    await once(occupyingServer, 'listening');
    const address = occupyingServer.address();
    if (!address || typeof address === 'string') {
      throw new Error('Occupied test listener address is unavailable');
    }

    try {
      channel = createChannel({ port: address.port });
      channel.onMessage(async () => undefined);

      await expect(channel.start()).rejects.toMatchObject({ code: 'EADDRINUSE' });
      await expect(channel.completion).resolves.toEqual(
        expect.objectContaining({ outcome: 'failed', phase: 'startup' }),
      );
      expect((channel as unknown as { server?: unknown }).server).toBeUndefined();
      expect((channel as unknown as { httpServer?: unknown }).httpServer).toBeUndefined();
    } finally {
      await new Promise<void>((resolve, reject) => {
        occupyingServer.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      });
    }
  });

  it('serves the packaged client and derives its WebSocket URL from the listener', async () => {
    channel = createChannel({ port: 0 });
    channel.onMessage(async () => undefined);
    await channel.start();

    const response = await fetch(clientUrl(channel));

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/html');
    const html = await response.text();
    expect(html).toContain("const DEFAULT_SOCKET_PATH = \"/ws\";");
    expect(html).not.toContain('__MY_AGENT_WEBSOCKET_PATH__');
    await expect(fetch(`${clientUrl(channel)}missing`)).resolves.toMatchObject({ status: 404 });
  });

  it('escapes the configured WebSocket path before embedding it in the client script', async () => {
    channel = createChannel({ port: 0, webSocketPath: '/</script><script>alert(1)</script>' });
    channel.onMessage(async () => undefined);
    await channel.start();

    const html = await (await fetch(clientUrl(channel))).text();

    expect(html).toContain('\\u003c/script>');
    expect(html).not.toContain('"/</script><script>alert(1)</script>"');
  });

  it('opens the browser only when explicitly enabled and contains launch failure', async () => {
    const browserLauncher = vi.fn<BrowserLauncher>().mockRejectedValue(new Error('launch failed'));
    channel = createChannel({ port: 0 }, browserLauncher);
    channel.onMessage(async () => undefined);
    await channel.start();
    expect(browserLauncher).not.toHaveBeenCalled();
    await channel.stop();

    channel = createChannel({ port: 0, openBrowser: true }, browserLauncher);
    channel.onMessage(async () => undefined);
    await expect(channel.start()).resolves.toBeUndefined();
    expect(browserLauncher).toHaveBeenCalledWith(clientUrl(channel));
    expect(logger.warn).toHaveBeenCalledWith('browser launch failed', {
      channelId: 'websocket',
    });
  });

  it('stops safely while start is still waiting for listening readiness', async () => {
    channel = createChannel({ port: 0 });
    channel.onMessage(async () => undefined);

    const start = channel.start();
    await channel.stop();

    await expect(start).rejects.toThrow('server closed before readiness');
    await expect(channel.completion).resolves.toEqual({ outcome: 'closed', reason: 'stopped' });
  });

  it('binds hello and forwards run_turn with clientId', async () => {
    const modelId = ' model/vendor:v1?x=1\n\u0000 ';
    const handler = vi.fn(async () => undefined);
    channel = createChannel({ port: 0 });
    channel.onMessage(handler);
    await channel.start();

    const client = await connectClient(channel);
    client.send(JSON.stringify({ type: 'hello', clientId: 'client-1' }));
    await expectMessage(client, { type: 'hello_ack', clientId: 'client-1' });

    client.send(JSON.stringify({
      type: 'run_turn',
      sessionId: 'main',
      message: 'hello ws',
      modelReference: { providerId: 'test', modelId },
      maxLlmCalls: 7,
    }));

    await vi.waitFor(() => {
      expect(handler).toHaveBeenCalledWith({
        clientId: 'client-1',
        sessionId: 'main',
        message: 'hello ws',
        modelReference: { providerId: 'test', modelId },
        maxLlmCalls: 7,
      });
    });
  });

  it('returns an attachment rejection to the originating client', async () => {
    channel = createChannel({ port: 0 });
    channel.onMessage(async () => {
      throw new ChannelOperationError(
        'ATTACHMENT_REJECTED',
        'Inbound message rejected because 1 attachment validation failure(s) occurred.',
      );
    });
    await channel.start();

    const client = await connectClient(channel);
    clients.push(client);
    client.send(JSON.stringify({ type: 'hello', clientId: 'client-1' }));
    await expectMessage(client, { type: 'hello_ack', clientId: 'client-1' });
    client.send(JSON.stringify({
      type: 'run_turn',
      sessionId: 'main',
      message: [
        { type: 'text', text: 'do not send without the image' },
        {
          type: 'image',
          source: { type: 'base64', mediaType: 'image/png', data: 'AAAA' },
        },
      ],
    }));

    await expectMessage(client, {
      type: 'channel_error',
      code: 'ATTACHMENT_REJECTED',
      message: 'Inbound message rejected because 1 attachment validation failure(s) occurred.',
    });
  });

  it('preserves an empty string Model ID instead of treating it as missing', async () => {
    const handler = vi.fn(async () => undefined);
    channel = createChannel({ port: 0 });
    channel.onMessage(handler);
    await channel.start();

    const client = await connectClient(channel);
    clients.push(client);
    client.send(JSON.stringify({ type: 'hello', clientId: 'empty-model-client' }));
    await expectMessage(client, { type: 'hello_ack', clientId: 'empty-model-client' });
    client.send(JSON.stringify({
      type: 'run_turn',
      sessionId: 'main',
      message: 'empty model id',
      modelReference: { providerId: 'test', modelId: '' },
    }));

    await vi.waitFor(() => expect(handler).toHaveBeenCalledWith({
      clientId: 'empty-model-client',
      sessionId: 'main',
      message: 'empty model id',
      modelReference: { providerId: 'test', modelId: '' },
    }));
  });

  it('accepts camelCase mediaType and converts it to the internal content-block shape', async () => {
    const handler = vi.fn(async () => undefined);
    channel = createChannel({ port: 0 });
    channel.onMessage(handler);
    await channel.start();

    const client = await connectClient(channel);
    clients.push(client);
    client.send(JSON.stringify({ type: 'hello', clientId: 'image-client' }));
    await expectMessage(client, { type: 'hello_ack', clientId: 'image-client' });
    client.send(JSON.stringify({
      type: 'run_turn',
      sessionId: 'main',
      message: [{
        type: 'image',
        source: { type: 'base64', mediaType: 'image/png', data: 'aGVsbG8=' },
      }],
    }));

    await vi.waitFor(() => expect(handler).toHaveBeenCalledWith({
      clientId: 'image-client',
      sessionId: 'main',
      message: [{
        type: 'image',
        source: { type: 'base64', mediaType: 'image/png', data: 'aGVsbG8=' },
      }],
    }));
  });

  it.each([
    { model: 'legacy-model' },
    { maxTokens: 2048 },
    { requestOverride: { maxOutputTokens: 2048 } },
  ])('rejects removed legacy run_turn fields: %j', async (legacyField) => {
    const handler = vi.fn(async () => undefined);
    channel = createChannel({ port: 0 });
    channel.onMessage(handler);
    await channel.start();

    const client = await connectClient(channel);
    client.send(JSON.stringify({ type: 'hello', clientId: 'client-1' }));
    await expectMessage(client, { type: 'hello_ack', clientId: 'client-1' });
    client.send(JSON.stringify({
      type: 'run_turn',
      sessionId: 'main',
      message: 'legacy',
      ...legacyField,
    }));

    await expectMessage(client, {
      type: 'channel_error',
      code: 'INVALID_MESSAGE',
      message: 'Legacy model/output-token override fields are not supported; use modelReference.',
    });
    expect(handler).not.toHaveBeenCalled();
  });

  it.each([
    [{
      model_reference: { provider_id: 'test', model_id: 'model' },
    }, 'snake_case fields are not supported; use modelReference.'],
    [{
      request_override: { max_output_tokens: 2048 },
    }, 'Legacy model/output-token override fields are not supported; use modelReference.'],
  ] as const)('rejects retired snake_case run_turn fields: %j', async (retiredField, message) => {
    const handler = vi.fn(async () => undefined);
    channel = createChannel({ port: 0 });
    channel.onMessage(handler);
    await channel.start();

    const client = await connectClient(channel);
    client.send(JSON.stringify({ type: 'hello', clientId: 'client-1' }));
    await expectMessage(client, { type: 'hello_ack', clientId: 'client-1' });
    client.send(JSON.stringify({
      type: 'run_turn',
      sessionId: 'main',
      message: 'retired',
      ...retiredField,
    }));

    await expectMessage(client, {
      type: 'channel_error',
      code: 'INVALID_MESSAGE',
      message,
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
        models: [
          { modelId: 'unknown', displayName: 'Unknown' },
          {
            modelId: 'gpt-5.6-sol',
            displayName: 'GPT 5.6 Sol',
            capabilities: { toolUse: false, mediaKinds: [] },
          },
        ],
      }],
    };

    it('returns a request-correlated camelCase Catalog after hello', async () => {
      channel = createChannel({ port: 0 });
      channel.onMessage(async () => undefined);
      channel.bindRuntimeCapabilities(capabilities(() => unavailableCatalog));
      await channel.start();

      const client = await connectClient(channel);
      clients.push(client);
      client.send(JSON.stringify({ type: 'hello', clientId: 'catalog-client' }));
      await expectMessage(client, { type: 'hello_ack', clientId: 'catalog-client' });
      client.send(JSON.stringify({ type: 'get_model_catalog', requestId: 'catalog-1' }));

      await expectMessage(client, {
        type: 'model_catalog',
        requestId: 'catalog-1',
        catalog: {
          generation: 12,
          defaultSelection: {
            state: 'unavailable',
            reference: {
              providerId: 'copilot-relay',
              modelId: 'missing-model',
            },
            reason: 'model_rejected',
          },
          providers: [{
            providerId: 'copilot-relay',
            displayName: 'Copilot Relay',
            models: [
              { modelId: 'unknown', displayName: 'Unknown' },
              {
                modelId: 'gpt-5.6-sol',
                displayName: 'GPT 5.6 Sol',
                capabilities: { toolUse: false, mediaKinds: [] },
              },
            ],
          }],
        },
      });
    });

    it('unicasts a Catalog response only to the requesting client', async () => {
      channel = createChannel({ port: 0 });
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
      requester.send(JSON.stringify({ type: 'get_model_catalog', requestId: 'private-catalog' }));
      const response = await nextMessage(requester);
      expect(response).toMatchObject({
        type: 'model_catalog',
        requestId: 'private-catalog',
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(observerMessages).not.toHaveBeenCalled();
    });

    it('observes the latest generation through one long-lived binding', async () => {
      let snapshot = unavailableCatalog;
      channel = createChannel({ port: 0 });
      channel.onMessage(async () => undefined);
      channel.bindRuntimeCapabilities(capabilities(() => snapshot));
      await channel.start();

      const client = await connectClient(channel);
      clients.push(client);
      client.send(JSON.stringify({ type: 'hello', clientId: 'reload-client' }));
      await expectMessage(client, { type: 'hello_ack', clientId: 'reload-client' });
      client.send(JSON.stringify({ type: 'get_model_catalog', requestId: 'before' }));
      const before = await nextMessage(client);
      expect((before.catalog as { generation: number }).generation).toBe(12);

      snapshot = { ...unavailableCatalog, generation: 13 };
      client.send(JSON.stringify({ type: 'get_model_catalog', requestId: 'after' }));
      const after = await nextMessage(client);
      expect(after.requestId).toBe('after');
      expect((after.catalog as { generation: number }).generation).toBe(13);
    });

    it('rejects query before hello, blank requestId, and missing capability', async () => {
      channel = createChannel({ port: 0 });
      channel.onMessage(async () => undefined);
      await channel.start();

      const client = await connectClient(channel);
      clients.push(client);
      client.send(JSON.stringify({ type: 'get_model_catalog', requestId: 'early' }));
      await expectMessage(client, {
        type: 'channel_error',
        code: 'SERVER_NOT_READY',
        message: 'hello must complete before business messages.',
      });

      client.send(JSON.stringify({ type: 'hello', clientId: 'catalog-client' }));
      await expectMessage(client, { type: 'hello_ack', clientId: 'catalog-client' });
      client.send(JSON.stringify({ type: 'get_model_catalog', requestId: ' ' }));
      await expectMessage(client, {
        type: 'channel_error',
        code: 'INVALID_MESSAGE',
        message: 'requestId must be a non-empty string.',
      });
      client.send(JSON.stringify({ type: 'get_model_catalog', requestId: 'unbound' }));
      await expectMessage(client, {
        type: 'channel_error',
        code: 'SERVER_NOT_READY',
        message: 'Runtime Model Catalog is not bound.',
      });
    });
  });

  describe('Session creation protocol', () => {
    it('returns a request-correlated server-issued sessionId after hello', async () => {
      const createSession = vi.fn(async () => ({
        sessionId: '123e4567-e89b-42d3-a456-426614174000',
        permission: {
          sessionId: '123e4567-e89b-42d3-a456-426614174000',
          mode: 'manual' as const,
          changedAt: 1,
        },
      }));
      channel = createChannel({ port: 0 });
      channel.onMessage(async () => undefined);
      channel.bindRuntimeCapabilities(capabilities(
        () => ({
          generation: 1,
          defaultSelection: { state: 'unset' },
          providers: [],
        }),
        undefined,
        sessionCapabilities({ createSession }),
      ));
      await channel.start();

      const client = await connectClient(channel);
      clients.push(client);
      client.send(JSON.stringify({ type: 'hello', clientId: 'session-client' }));
      await expectMessage(client, { type: 'hello_ack', clientId: 'session-client' });
      client.send(JSON.stringify({ type: 'create_session', requestId: 'create-1' }));

      await expectMessage(client, {
        type: 'session_created',
        requestId: 'create-1',
        sessionId: '123e4567-e89b-42d3-a456-426614174000',
        permission: {
          sessionId: '123e4567-e89b-42d3-a456-426614174000',
          mode: 'manual',
          changedAt: 1,
        },
      });
      expect(createSession).toHaveBeenCalledTimes(1);
    });

    it('supports create, first send, list, get, rename, and delete', async () => {
      const sessionId = '123e4567-e89b-42d3-a456-426614174000';
      const entry = { sessionId, createdAt: 1, updatedAt: 2, title: 'First message' };
      const renamed = { ...entry, updatedAt: 3, title: 'Renamed' };
      const sessionCapability = sessionCapabilities({
        createSession: vi.fn(async () => ({
          sessionId,
          permission: { sessionId, mode: 'manual' as const, changedAt: 1 },
        })),
        listSessions: vi.fn(async () => [entry]),
        getSession: vi.fn(async () => entry),
        renameSession: vi.fn(async () => renamed),
        deleteSession: vi.fn(async () => undefined),
      });

      const runPermissionProtocolTest = async () => {
        const sessionId = '123e4567-e89b-42d3-a456-426614174000';
        let changedHandler: ((state: {
          sessionId: string;
          mode: 'manual' | 'allow_all';
          changedAt: number;
          changedByClientId?: string;
        }) => void) | undefined;
        const unsubscribe = vi.fn();
        const createSession = vi.fn(async (input) => ({
          sessionId,
          permission: {
            sessionId,
            mode: input?.permissionMode ?? 'manual',
            changedAt: 1,
            changedByClientId: input?.originClientId,
          },
        }));
        const getPermissionMode = vi.fn(() => ({
          sessionId,
          mode: 'allow_all' as const,
          changedAt: 2,
        }));
        const setPermissionMode = vi.fn(({ mode, originClientId }) => ({
          sessionId,
          mode,
          changedAt: 3,
          changedByClientId: originClientId,
        }));
        const sessionCapability = sessionCapabilities({
          createSession,
          getPermissionMode,
          setPermissionMode,
          onPermissionModeChanged: (handler) => {
            changedHandler = handler;
            return unsubscribe;
          },
        });
        channel = createChannel({ port: 0 });
        channel.onMessage(async () => undefined);
        channel.bindRuntimeCapabilities(capabilities(undefined, undefined, sessionCapability));
        await channel.start();

        const client = await connectClient(channel);
        clients.push(client);
        client.send(JSON.stringify({ type: 'hello', clientId: 'permission-client' }));
        await expectMessage(client, { type: 'hello_ack', clientId: 'permission-client' });

        client.send(JSON.stringify({
          type: 'create_session',
          requestId: 'create-permission',
          permissionMode: 'allow_all',
        }));
        await expectMessage(client, {
          type: 'session_created',
          requestId: 'create-permission',
          sessionId,
          permission: {
            sessionId,
            mode: 'allow_all',
            changedAt: 1,
            changedByClientId: 'permission-client',
          },
        });
        expect(createSession).toHaveBeenCalledWith({
          permissionMode: 'allow_all',
          originClientId: 'permission-client',
        });

        client.send(JSON.stringify({
          type: 'get_session_permission_mode',
          sessionId,
        }));
        await expectMessage(client, {
          type: 'session_permission_mode_changed',
          sessionId,
          mode: 'allow_all',
          changedAt: 2,
        });

        client.send(JSON.stringify({
          type: 'set_session_permission_mode',
          sessionId,
          mode: 'manual',
        }));
        await expectMessage(client, {
          type: 'session_permission_mode_changed',
          sessionId,
          mode: 'manual',
          changedAt: 3,
        });
        expect(setPermissionMode).toHaveBeenCalledWith({
          sessionId,
          mode: 'manual',
          originClientId: 'permission-client',
        });

        changedHandler?.({ sessionId, mode: 'allow_all', changedAt: 4 });
        await expectMessage(client, {
          type: 'session_permission_mode_changed',
          sessionId,
          mode: 'allow_all',
          changedAt: 4,
        });

        await channel.stop();
        expect(unsubscribe).toHaveBeenCalledTimes(1);
      };

      const runStrictPermissionValidationTest = async () => {
        channel = createChannel({ port: 0 });
        channel.onMessage(async () => undefined);
        channel.bindRuntimeCapabilities(capabilities());
        await channel.start();
        const client = await connectClient(channel);
        clients.push(client);
        client.send(JSON.stringify({ type: 'hello', clientId: 'strict-permission-client' }));
        await expectMessage(client, {
          type: 'hello_ack',
          clientId: 'strict-permission-client',
        });

        client.send(JSON.stringify({
          type: 'set_session_permission_mode',
          sessionId: 'main',
          mode: 'always',
        }));
        await expectMessage(client, {
          type: 'channel_error',
          code: 'INVALID_MESSAGE',
          message: 'mode must be manual or allow_all.',
        });

        client.send(JSON.stringify({
          type: 'get_session_permission_mode',
          sessionId: 'main',
          mode: 'manual',
        }));
        await expectMessage(client, {
          type: 'channel_error',
          code: 'INVALID_MESSAGE',
          message: 'get_session_permission_mode.mode is not supported.',
        });
      };
      const handler = vi.fn(async () => undefined);
      channel = createChannel({ port: 0 });
      channel.onMessage(handler);
      channel.bindRuntimeCapabilities(capabilities(
        () => ({
          generation: 1,
          defaultSelection: { state: 'unset' },
          providers: [],
        }),
        undefined,
        sessionCapability,
      ));
      await channel.start();

      const client = await connectClient(channel);
      clients.push(client);
      client.send(JSON.stringify({ type: 'hello', clientId: 'session-flow-client' }));
      await expectMessage(client, { type: 'hello_ack', clientId: 'session-flow-client' });

      client.send(JSON.stringify({ type: 'create_session', requestId: 'create-1' }));
      await expectMessage(client, {
        type: 'session_created',
        requestId: 'create-1',
        sessionId,
        permission: { sessionId, mode: 'manual', changedAt: 1 },
      });
      client.send(JSON.stringify({ type: 'run_turn', sessionId, message: 'First message' }));
      await vi.waitFor(() => expect(handler).toHaveBeenCalledWith({
        clientId: 'session-flow-client',
        sessionId,
        message: 'First message',
      }));

      client.send(JSON.stringify({ type: 'list_sessions', requestId: 'list-1' }));
      await expectMessage(client, { type: 'sessions_listed', requestId: 'list-1', sessions: [entry] });
      client.send(JSON.stringify({ type: 'get_session', requestId: 'get-1', sessionId }));
      await expectMessage(client, { type: 'session_retrieved', requestId: 'get-1', session: entry });
      client.send(JSON.stringify({
        type: 'rename_session',
        requestId: 'rename-1',
        sessionId,
        title: 'Renamed',
      }));
      await expectMessage(client, {
        type: 'session_renamed',
        requestId: 'rename-1',
        session: renamed,
      });
      client.send(JSON.stringify({ type: 'delete_session', requestId: 'delete-1', sessionId }));
      await expectMessage(client, { type: 'session_deleted', requestId: 'delete-1', sessionId });

      expect(sessionCapability.renameSession).toHaveBeenCalledWith(sessionId, 'Renamed');
      expect(sessionCapability.deleteSession).toHaveBeenCalledWith(sessionId);
      await channel.stop();
      await runPermissionProtocolTest();
      await runStrictPermissionValidationTest();
    });

    it('supports archive, unarchive, and fork and preserves Session error codes', async () => {
      const sessionId = '123e4567-e89b-42d3-a456-426614174000';
      const forkId = '223e4567-e89b-42d3-a456-426614174000';
      const entry = { sessionId, createdAt: 1, updatedAt: 2, archivedAt: 3 };
      const unarchived = { sessionId, createdAt: 1, updatedAt: 4 };
      const forked = { sessionId: forkId, createdAt: 5, updatedAt: 5 };
      const sessionCapability = sessionCapabilities({
        archiveSession: vi.fn(async () => entry),
        unarchiveSession: vi.fn(async () => unarchived),
        forkSession: vi.fn(async () => forked),
        getSession: vi.fn(async () => {
          throw new ChannelOperationError('SESSION_NOT_FOUND', 'Session does not exist.');
        }),
      });
      channel = createChannel({ port: 0 });
      channel.onMessage(async () => undefined);
      channel.bindRuntimeCapabilities(capabilities(undefined, undefined, sessionCapability));
      await channel.start();

      const client = await connectClient(channel);
      clients.push(client);
      client.send(JSON.stringify({ type: 'hello', clientId: 'session-lifecycle-client' }));
      await expectMessage(client, {
        type: 'hello_ack',
        clientId: 'session-lifecycle-client',
      });

      client.send(JSON.stringify({ type: 'archive_session', requestId: 'archive-1', sessionId }));
      await expectMessage(client, {
        type: 'session_archived',
        requestId: 'archive-1',
        session: entry,
      });
      client.send(JSON.stringify({
        type: 'unarchive_session',
        requestId: 'unarchive-1',
        sessionId,
      }));
      await expectMessage(client, {
        type: 'session_unarchived',
        requestId: 'unarchive-1',
        session: unarchived,
      });
      client.send(JSON.stringify({
        type: 'fork_session',
        requestId: 'fork-1',
        sessionId,
        entryId: 'entry-1',
      }));
      await expectMessage(client, {
        type: 'session_forked',
        requestId: 'fork-1',
        session: forked,
      });
      expect(sessionCapability.forkSession).toHaveBeenCalledWith(sessionId, 'entry-1');

      client.send(JSON.stringify({ type: 'get_session', requestId: 'get-missing', sessionId }));
      await expectMessage(client, {
        type: 'channel_error',
        code: 'SESSION_NOT_FOUND',
        message: 'Session does not exist.',
      });
    });

    it('rejects a create request when the Session capability is not bound', async () => {
      channel = createChannel({ port: 0 });
      channel.onMessage(async () => undefined);
      await channel.start();

      const client = await connectClient(channel);
      clients.push(client);
      client.send(JSON.stringify({ type: 'hello', clientId: 'session-client' }));
      await expectMessage(client, { type: 'hello_ack', clientId: 'session-client' });
      client.send(JSON.stringify({ type: 'create_session', requestId: 'create-1' }));

      await expectMessage(client, {
        type: 'channel_error',
        code: 'SERVER_NOT_READY',
        message: 'Runtime Session capability is not bound.',
      });
    });
  });

  it('routes approval interactions to the origin client and forwards interaction responses', async () => {
    const interactionResponse = vi.fn();
    channel = createChannel({ port: 0, approval: true });
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
      sessionId: 'main',
      turnId: 'turn-1',
      originClientId: 'client-1',
    };
    expect(channel.interaction?.sendInteractionRequest(request)).toEqual({ status: 'accepted' });

    await expectMessage(client, {
      type: 'approval_requested',
      id: 'apr-1',
      sessionId: 'main',
      turnId: 'turn-1',
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

  it('rejects approval responses from a different connected client', async () => {
    const interactionResponse = vi.fn();
    channel = createChannel({ port: 0, approval: true });
    channel.onMessage(async () => undefined);
    channel.interaction?.onInteractionResponse(interactionResponse);
    await channel.start();

    const origin = await connectClient(channel);
    const foreign = await connectClient(channel);
    clients.push(origin, foreign);
    origin.send(JSON.stringify({ type: 'hello', clientId: 'approval-origin' }));
    foreign.send(JSON.stringify({ type: 'hello', clientId: 'approval-foreign' }));
    await expectMessage(origin, { type: 'hello_ack', clientId: 'approval-origin' });
    await expectMessage(foreign, { type: 'hello_ack', clientId: 'approval-foreign' });

    const request: ApprovalInteractionRequest = {
      id: 'apr-foreign',
      kind: 'approval',
      toolName: 'write_file',
      input: {},
      sessionId: 'main',
      turnId: 'turn-foreign',
      originClientId: 'approval-origin',
    };
    expect(channel.interaction?.sendInteractionRequest(request)).toEqual({ status: 'accepted' });
    await expectMessage(origin, {
      type: 'approval_requested',
      id: 'apr-foreign',
      sessionId: 'main',
      turnId: 'turn-foreign',
      toolName: 'write_file',
      input: {},
    });

    foreign.send(JSON.stringify({
      type: 'approval_resolve',
      id: 'apr-foreign',
      decision: 'allow',
    }));
    await expectMessage(foreign, {
      type: 'channel_error',
      code: 'INVALID_MESSAGE',
      message: 'Approval response does not belong to this client.',
    });
    expect(interactionResponse).not.toHaveBeenCalled();

    origin.send(JSON.stringify({
      type: 'approval_resolve',
      id: 'apr-foreign',
      decision: 'deny',
    }));
    await vi.waitFor(() => {
      expect(interactionResponse).toHaveBeenCalledWith({
        id: 'apr-foreign',
        kind: 'approval',
        outcome: 'submitted',
        decision: 'deny',
      });
    });
  });

  it('correlates concurrent approvals for one client across different sessions', async () => {
    const interactionResponse = vi.fn();
    channel = createChannel({ port: 0, approval: true });
    channel.onMessage(async () => undefined);
    channel.interaction?.onInteractionResponse(interactionResponse);
    await channel.start();

    const client = await connectClient(channel);
    clients.push(client);
    client.send(JSON.stringify({ type: 'hello', clientId: 'multi-session-client' }));
    await expectMessage(client, { type: 'hello_ack', clientId: 'multi-session-client' });

    const requests: ApprovalInteractionRequest[] = [
      {
        id: 'apr-session-a',
        kind: 'approval',
        toolName: 'write_file',
        input: { path: 'a.txt' },
        sessionId: 'session-a',
        turnId: 'turn-a',
        originClientId: 'multi-session-client',
      },
      {
        id: 'apr-session-b',
        kind: 'approval',
        toolName: 'write_file',
        input: { path: 'b.txt' },
        sessionId: 'session-b',
        turnId: 'turn-b',
        originClientId: 'multi-session-client',
      },
    ];

    for (const request of requests) {
      expect(channel.interaction?.sendInteractionRequest(request)).toEqual({ status: 'accepted' });
      await expectMessage(client, {
        type: 'approval_requested',
        id: request.id,
        sessionId: request.sessionId,
        turnId: request.turnId,
        toolName: request.toolName,
        input: request.input,
      });
    }

    client.send(JSON.stringify({
      type: 'approval_resolve',
      id: 'apr-session-b',
      decision: 'deny',
    }));
    client.send(JSON.stringify({
      type: 'approval_resolve',
      id: 'apr-session-a',
      decision: 'allow',
    }));

    await vi.waitFor(() => {
      expect(interactionResponse).toHaveBeenCalledTimes(2);
    });
    expect(interactionResponse).toHaveBeenNthCalledWith(1, {
      id: 'apr-session-b',
      kind: 'approval',
      outcome: 'submitted',
      decision: 'deny',
    });
    expect(interactionResponse).toHaveBeenNthCalledWith(2, {
      id: 'apr-session-a',
      kind: 'approval',
      outcome: 'submitted',
      decision: 'allow',
    });
  });

  it('returns unavailable when an approval origin cannot receive the request', async () => {
    channel = createChannel({ port: 0, approval: true });
    channel.onMessage(async () => undefined);
    await channel.start();

    expect(channel.interaction?.sendInteractionRequest({
      id: 'apr-missing',
      kind: 'approval',
      toolName: 'write_file',
      input: {},
      sessionId: 'main',
      turnId: 'turn-missing',
      originClientId: 'missing-client',
    })).toEqual({ status: 'unavailable', reason: 'delivery_failed' });
  });

  it('sends approval_closed for a non-user terminal outcome', async () => {
    channel = createChannel({ port: 0, approval: true });
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
      sessionId: 'main',
      turnId: 'turn-close',
      originClientId: 'client-close',
    };
    expect(channel.interaction?.sendInteractionRequest(request)).toEqual({ status: 'accepted' });
    await expectMessage(client, {
      type: 'approval_requested',
      id: 'apr-close',
      sessionId: 'main',
      turnId: 'turn-close',
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
      sessionId: 'main',
      turnId: 'turn-close',
      outcome: 'aborted',
      reason: 'turn',
    });

    channel.interaction?.sendInteractionClosed(request, {
      outcome: 'approved',
      source: 'session_allow_all',
    });
    await expectMessage(client, {
      type: 'approval_closed',
      id: 'apr-close',
      sessionId: 'main',
      turnId: 'turn-close',
      outcome: 'approved',
      reason: 'session_allow_all',
    });
  });

  it('keeps pending approval bound across same-client socket replacement', async () => {
    const interactionResponse = vi.fn();
    const interactionUnavailable = vi.fn();
    channel = createChannel({ port: 0, approval: true });
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
      sessionId: 'main',
      turnId: 'turn-replace',
      originClientId: 'client-replace',
    };
    channel.interaction?.sendInteractionRequest(request);
    await expectMessage(firstClient, {
      type: 'approval_requested',
      id: 'apr-replace',
      sessionId: 'main',
      turnId: 'turn-replace',
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
    channel = createChannel({ port: 0, approval: true });
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
      sessionId: 'main',
      turnId: 'turn-disconnect',
      originClientId: 'client-disconnect',
    });
    await expectMessage(client, {
      type: 'approval_requested',
      id: 'apr-disconnect',
      sessionId: 'main',
      turnId: 'turn-disconnect',
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
    channel = createChannel({ port: 0 });
    channel.onMessage(handler);
    await channel.start();

    const client = await connectClient(channel);
    client.send(JSON.stringify({ type: 'hello', clientId: 'client-resolution' }));
    await expectMessage(client, { type: 'hello_ack', clientId: 'client-resolution' });
    client.send(JSON.stringify({ type: 'run_turn', sessionId: 'main', message: 'hi' }));
    await vi.waitFor(() => expect(handler).toHaveBeenCalled());

    channel.send({
      type: 'error',
      requestId: 'request-resolution',
      sessionId: 'main',
      turnId: 'resolution-turn',
      error: new Error('Provider is not registered.'),
      category: 'provider_unregistered',
      originMessageId: 'queued-message',
    });

    await expectMessage(client, {
      type: 'error',
      requestId: 'request-resolution',
      sessionId: 'main',
      turnId: 'resolution-turn',
      error: 'Provider is not registered.',
      category: 'provider_unregistered',
      originMessageId: 'queued-message',
    });
  });

  it('routes queued request_end by origin message with camelCase fields', async () => {
    const handler = vi.fn(async () => undefined);
    channel = createChannel({ port: 0 });
    channel.onMessage(handler);
    await channel.start();

    const client = await connectClient(channel);
    client.send(JSON.stringify({ type: 'hello', clientId: 'client-request-end' }));
    await expectMessage(client, { type: 'hello_ack', clientId: 'client-request-end' });
    client.send(JSON.stringify({ type: 'run_turn', sessionId: 'main', message: 'hi' }));
    await vi.waitFor(() => expect(handler).toHaveBeenCalled());

    channel.send({
      type: 'user_message',
      sessionId: 'main',
      messageId: 'origin-queued',
      content: 'queued',
      originClientId: 'client-request-end',
      deliveryMode: 'queued',
      timestamp: 1,
    });
    await expectMessage(client, {
      type: 'user_message',
      sessionId: 'main',
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
      requestId: 'request-queued',
      sessionId: 'main',
      originMessageId: 'origin-queued',
      outcome: 'cancelled',
      reason: 'shutdown',
    });
  });

  // Subagent events carry the Child UUID; WebSocketChannel must
  // route them to the parent's audience so subscribers actually see them.
  describe('subagent event audience routing', () => {
    it('routes subagent_start to the caller Session audience', async () => {
      const handler = vi.fn(async () => undefined);
      channel = createChannel({ port: 0 });
      channel.onMessage(handler);
      await channel.start();

      const client = await connectClient(channel);
      client.send(JSON.stringify({ type: 'hello', clientId: 'client-1' }));
      await expectMessage(client, { type: 'hello_ack', clientId: 'client-1' });

      // Subscribe to 'main' by running a turn against it.
      client.send(JSON.stringify({ type: 'run_turn', sessionId: 'main', message: 'hi' }));
      await vi.waitFor(() => expect(handler).toHaveBeenCalled());

      channel.send({
        type: 'subagent_start',
        requestId: 'request-1',
        runId: 'run-1',
        sessionId: '5cb8b687-f263-4355-9d09-7749064e3319',
        turnId: 'child-turn-1',
        depth: 1,
        subagentType: 'general-purpose',
        lifecycle: 'blocking',
        callerSessionId: 'main',
        parentTurnId: 'parent-turn-1',
        parentToolUseId: 'tu-1',
      });

      await expectMessage(client, {
        type: 'subagent_start',
        requestId: 'request-1',
        runId: 'run-1',
        sessionId: '5cb8b687-f263-4355-9d09-7749064e3319',
        turnId: 'child-turn-1',
        depth: 1,
        subagentType: 'general-purpose',
        lifecycle: 'blocking',
        callerSessionId: 'main',
        parentTurnId: 'parent-turn-1',
        parentToolUseId: 'tu-1',
      });
    });

    it('broadcasts user_message to every client on the session (including origin)', async () => {
      // channel-multi-client-user-message-spec §7: multi-client visibility
      const handler = vi.fn(async () => undefined);
      channel = createChannel({ port: 0 });
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
      clientA.send(JSON.stringify({ type: 'run_turn', sessionId: 'main', message: 'first' }));
      clientB.send(JSON.stringify({ type: 'run_turn', sessionId: 'main', message: 'second' }));
      await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(2));

      const timestamp = Date.now();
      channel.send({
        type: 'user_message',
        sessionId: 'main',
        messageId: 'msg-abc',
        content: 'hello everyone',
        attachmentSummaries: [{ type: 'image', mime: 'image/png', bytes: 1024 }],
        originClientId: 'client-A',
        deliveryMode: 'queued',
        timestamp,
      });

      const expected = {
        type: 'user_message',
        sessionId: 'main',
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

    it('routes subagent_end to the caller Session audience', async () => {
      const handler = vi.fn(async () => undefined);
      channel = createChannel({ port: 0 });
      channel.onMessage(handler);
      await channel.start();

      const client = await connectClient(channel);
      client.send(JSON.stringify({ type: 'hello', clientId: 'client-1' }));
      await expectMessage(client, { type: 'hello_ack', clientId: 'client-1' });

      client.send(JSON.stringify({ type: 'run_turn', sessionId: 'main', message: 'hi' }));
      await vi.waitFor(() => expect(handler).toHaveBeenCalled());

      channel.send({
        type: 'subagent_end',
        requestId: 'request-1',
        runId: 'run-1',
        sessionId: '5cb8b687-f263-4355-9d09-7749064e3319',
        turnId: 'child-turn-1',
        depth: 1,
        subagentType: 'general-purpose',
        lifecycle: 'blocking',
        callerSessionId: 'main',
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
        sessionId: '5cb8b687-f263-4355-9d09-7749064e3319',
        turnId: 'child-turn-1',
        depth: 1,
        subagentType: 'general-purpose',
        lifecycle: 'blocking',
        callerSessionId: 'main',
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
    it('inbound abort_turn → capabilities.abort.abortTurn called with sessionId', async () => {
      const abortTurn = vi.fn(() => ({ aborted: true, dropped: 0 }));
      const query = vi.fn(() => []);

      channel = createChannel({ port: 0 });
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

      client.send(JSON.stringify({ type: 'abort_turn', sessionId: 'main' }));

      await vi.waitFor(() => {
        expect(abortTurn).toHaveBeenCalledTimes(1);
        expect(abortTurn).toHaveBeenCalledWith('main');
      });
    });

    it("run_end{stopReason:'aborted'} is fanned out to subscribed WS clients", async () => {
      // Proves the client-facing signal used to detect abort completion
      // (spec §13: no inline ack — client observes via run_end).
      const handler = vi.fn(async () => undefined);
      channel = createChannel({ port: 0 });
      channel.onMessage(handler);
      await channel.start();

      const client = await connectClient(channel);
      clients.push(client);
      client.send(JSON.stringify({ type: 'hello', clientId: 'client-observer' }));
      await expectMessage(client, { type: 'hello_ack', clientId: 'client-observer' });

      // Subscribe to the session audience so send() will fan to this client.
      client.send(JSON.stringify({ type: 'run_turn', sessionId: 'main', message: 'anything' }));
      await vi.waitFor(() => expect(handler).toHaveBeenCalled());

      channel.send({
        type: 'run_end',
        requestId: 'request-aborted-1',
        sessionId: 'main',
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
        sessionId: 'main',
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
  const address = channelAddress(channel);
  const client = new WebSocket(`ws://127.0.0.1:${address.port}/ws`);
  await once(client, 'open');
  return client;
}

function channelAddress(channel: WebSocketChannel): { port: number } {
  const address = (channel as unknown as { httpServer?: { address(): unknown } }).httpServer?.address();
  if (!address || typeof address !== 'object' || !('port' in address)) {
    throw new Error('WebSocketChannel server address is not available');
  }
  return address as { port: number };
}

function clientUrl(channel: WebSocketChannel): string {
  const address = (channel as unknown as { httpServer?: { address(): unknown } }).httpServer?.address();
  if (!address || typeof address !== 'object' || !('port' in address)) {
    throw new Error('WebSocketChannel HTTP address is not available');
  }
  return `http://127.0.0.1:${address.port}/`;
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
  getSnapshot: () => ModelCatalogSnapshot = () => ({
    generation: 1,
    defaultSelection: { state: 'unset' },
    providers: [],
  }),
  abort: ChannelRuntimeCapabilities['abort'] = {
    querySessionsNeedingAbort: () => [],
    abortTurn: () => ({ aborted: false, dropped: 0 }),
  },
  sessions: ChannelRuntimeCapabilities['sessions'] = sessionCapabilities(),
): ChannelRuntimeCapabilities {
  return {
    modelCatalog: { getSnapshot },
    abort,
    sessions,
  };
}

function sessionCapabilities(
  overrides: Partial<ChannelRuntimeCapabilities['sessions']> = {},
): ChannelRuntimeCapabilities['sessions'] {
  const sessionId = '123e4567-e89b-42d3-a456-426614174000';
  const entry = { sessionId, createdAt: 1, updatedAt: 1 };
  return {
    createSession: async () => ({
      sessionId,
      permission: { sessionId, mode: 'manual', changedAt: 1 },
    }),
    listSessions: async () => [],
    getSession: async () => entry,
    renameSession: async (_sessionId, title) => ({
      ...entry,
      ...(title === null ? {} : { title }),
    }),
    archiveSession: async () => ({ ...entry, archivedAt: 2 }),
    unarchiveSession: async () => entry,
    deleteSession: async () => undefined,
    forkSession: async () => ({ ...entry, sessionId: '223e4567-e89b-42d3-a456-426614174000' }),
    getPermissionMode: (requestedSessionId) => ({
      sessionId: requestedSessionId,
      mode: 'manual',
      changedAt: 1,
    }),
    setPermissionMode: ({ sessionId: requestedSessionId, mode, originClientId }) => ({
      sessionId: requestedSessionId,
      mode,
      changedAt: 2,
      ...(originClientId ? { changedByClientId: originClientId } : {}),
    }),
    onPermissionModeChanged: () => () => undefined,
    ...overrides,
  };
}

function createChannel(
  config: Partial<WebSocketExtensionConfig> = {},
  browserLauncher?: BrowserLauncher,
): WebSocketChannel {
  const completeConfig: WebSocketExtensionConfig = {
    host: '127.0.0.1',
    port: 0,
    webSocketPath: '/ws',
    clientPath: '/',
    approval: false,
    openBrowser: false,
    ...config,
  };
  const options: WebSocketChannelOptions = {
    config: completeConfig,
    clientFilePath: CLIENT_FILE_PATH,
    logger,
    ...(browserLauncher === undefined ? {} : { browserLauncher }),
  };
  return new WebSocketChannel(options);
}