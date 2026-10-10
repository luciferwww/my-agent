import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import {
  ChannelOperationError,
  type ExtensionLogger,
  type ApprovalInteractionRequest,
  type ApprovalClosedResult,
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
const CLIENT_VARIANT_FILE_PATH = fileURLToPath(new URL('./client/chat2.html', import.meta.url));
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

  it.each([CLIENT_FILE_PATH, CLIENT_VARIANT_FILE_PATH])('keeps bundled chat scripts valid and pending independent of History: %s', async (path) => {
    const source = await readFile(path, 'utf8');
    const script = source.match(/<script>([\s\S]*?)<\/script>/)?.[1];
    expect(script).toBeDefined();
    expect(() => new Function(script!)).not.toThrow();
    expect(source).toContain('pendingApprovals: new Map()');
    expect(source).toContain("type: 'get_session_approvals', requestId");
    expect(source).toContain('window.setInterval(refresh, 10000)');
    expect(source).toContain('hasSessionApprovals(session.sessionId)');
    expect(source).not.toContain('Refresh Sessions');
    expect(source).not.toContain('origin_disconnected');
  });

  it.each([CLIENT_FILE_PATH, CLIENT_VARIANT_FILE_PATH])('smokes pending recovery, exact closure identity and snapshot reconciliation: %s', async (path) => {
    const source = await readFile(path, 'utf8');
    const capture = vi.fn();
    const browser = {
      location: { protocol: 'http:', host: 'localhost' }, innerWidth: 1200,
      clearTimeout: vi.fn(), clearInterval: vi.fn(),
      setTimeout: vi.fn((_callback: () => void, _delay: number) => 1),
      setInterval: vi.fn((_callback: () => void, _delay: number) => 2),
    };
    new Function('Vue', 'window', '__MY_AGENT_WEBSOCKET_PATH__',
      source.match(/<script>([\s\S]*?)<\/script>/)![1])({
      createApp: (options: unknown) => { capture(options); return { mount: () => undefined }; },
      nextTick: () => undefined,
    }, browser, '/ws');
    const options = capture.mock.calls[0][0];
    const chat = options.data();
    for (const [name, method] of Object.entries(options.methods)) {
      chat[name] = (method as Function).bind(chat);
    }
    for (const [name, computed] of Object.entries(options.computed)) {
      Object.defineProperty(chat, name, typeof computed === 'function'
        ? { get: computed.bind(chat) }
        : {
            get: (computed as { get: Function }).get.bind(chat),
            set: (computed as { set: Function }).set.bind(chat),
          });
    }
    chat.pushEvent = vi.fn();
    chat.scrollChatToBottom = vi.fn();
    chat.form.sessionId = 'main';
    const request = approvalRequest();
    const receive = (message: Record<string, unknown>) => chat.handleServerMessage(JSON.stringify(message));
    receive({ type: 'approval_requested', ...request });
    expect(chat.pendingApprovalCount).toBe(1);
    expect(chat.displayedChatItems[0].segments[0].approval.id).toBe(request.id);
    chat.form.sessionId = 'other';
    expect(chat.pendingApprovalCount).toBe(0);
    expect(chat.hasSessionApprovals('main')).toBe(true);
    chat.form.sessionId = 'main';
    const state = chat.ensureSessionState('main');
    state.historyItems = [{
      kind: 'turn', turnId: request.turnId, segments: [
        { type: 'tool_call', callId: request.callId, status: 'requested' },
      ],
    }];
    chat.syncApprovalCards();
    expect(chat.displayedChatItems).toHaveLength(1);
    expect(state.historyItems[0].segments[0].approval.status).toBe('pending');
    receive({ type: 'approval_closed', ...request, callId: 'wrong', outcome: 'denied', reason: 'user' });
    expect(chat.pendingApprovalCount).toBe(1);
    receive({ type: 'approval_closed', ...request, outcome: 'approved', reason: 'user' });
    expect(chat.pendingApprovalCount).toBe(0);
    expect(state.historyItems[0].segments[0].approval.status).toBe('approved');
    receive({ type: 'session_approvals', requestId: 'stale', approvals: [request] });
    expect(chat.pendingApprovalCount).toBe(0);
    chat.pendingApprovalsRequestId = 'fresh';
    receive({ type: 'session_approvals', requestId: 'fresh', approvals: [request] });
    expect(chat.pendingApprovalCount).toBe(1);
    state.historyItems[0].segments[0].status = 'success';
    chat.syncApprovalCards();
    expect(state.historyItems[0].segments[0].approval.status).not.toBe('pending');
    chat.pendingApprovalsRequestId = 'failure';
    receive({ type: 'session_approvals_error', requestId: 'failure', code: 'SERVER_NOT_READY', message: 'not ready' });
    expect(chat.pendingApprovalCount).toBe(1);
    chat.pendingApprovalsRequestId = 'empty';
    receive({ type: 'session_approvals', requestId: 'empty', approvals: [] });
    expect(chat.pendingApprovalCount).toBe(0);
    chat.connectionStatus = 'connected';
    chat.sendJson = vi.fn();
    chat.sessionActionMenu = { sessionId: 'main' };
    chat.startSessionRefresh();
    expect(chat.sendJson.mock.calls.map(([message]: [{ type: string }]) => message.type))
      .toEqual(['list_sessions', 'get_session_approvals']);
    chat.requestSessionList();
    chat.requestPendingApprovals();
    expect(chat.sendJson).toHaveBeenCalledTimes(2);
    expect(chat.sessionActionMenu.sessionId).toBe('main');
    for (const [timeout] of browser.setTimeout.mock.calls) timeout();
    expect(chat.pendingSessionsRequestId).toBeNull();
    expect(chat.pendingApprovalsRequestId).toBeNull();
    browser.setInterval.mock.calls[0][0]();
    expect(chat.sendJson).toHaveBeenCalledTimes(4);
    chat.stopSessionRefresh();
    expect(chat.refreshTimer).toBeNull();
    expect(browser.clearInterval).toHaveBeenCalledWith(2);
    const otherState = chat.ensureSessionState('other');
    chat.appendChatItem({ kind: 'system', text: 'Turn aborted' }, 'main');
    chat.appendChatItem({ kind: 'error', text: 'Runtime failed' }, 'main');
    chat.appendChatItem({ kind: 'system', text: 'Other Session notice' }, 'other');
    chat.appendChatItem({ kind: 'user', text: 'Try again' }, 'main');
    expect(state.chatItems.map((item: { kind: string }) => item.kind)).toEqual(['user']);
    expect(otherState.chatItems).toHaveLength(1);
    expect(state.historyItems).toHaveLength(1);
    chat.appendChatItem({ kind: 'system', text: 'Compaction finished' }, 'main');
    chat.appendTextToTurn('new-turn', 'New content', 'main');
    expect(state.chatItems.map((item: { kind: string }) => item.kind)).toEqual(['user', 'turn']);
    chat.appendChatItem({ kind: 'system', text: 'Configured model call limit reached' }, 'main');
    chat.handleAgentEvent({ type: 'run_start', sessionId: 'main', turnId: 'next-turn' });
    expect(state.chatItems.some((item: { kind: string }) => item.kind === 'system')).toBe(false);

    state.chatItems = [];
    state.turnMap = {};
    state.historyItems = [];
    const localUser = chat.appendChatItem({
      kind: 'user', turnId: request.turnId, text: 'List directories', attachments: [],
    }, 'main');
    chat.appendTextToTurn(request.turnId, 'Checking directories.', 'main');
    chat.handleAgentEvent({
      type: 'tool_call_requested', sessionId: 'main', turnId: request.turnId,
      callId: request.callId, name: request.toolName, input: request.input,
    });
    receive({ type: 'approval_requested', ...request });
    const realtimeTurn = state.turnMap[request.turnId];
    const liveTool = realtimeTurn.segments[1];
    const records = [
      { entryId: 'persisted-user', role: 'user', turnId: request.turnId,
        timestamp: '2026-10-10T08:00:00Z', content: [{ type: 'text', text: 'List directories' }] },
      { entryId: 'persisted-call', role: 'assistant', turnId: request.turnId,
        timestamp: '2026-10-10T08:00:01Z', content: [
          { type: 'text', text: 'Checking directories.' },
          { type: 'tool_use', id: request.callId, name: request.toolName, input: request.input },
        ] },
    ];
    for (let index = 0; index < 3; index++) {
      chat.form.sessionId = 'other';
      chat.form.sessionId = 'main';
      state.pendingHistoryRequest = { terminalTurnIds: [] };
      chat.mergeHistoryPage('main', { items: records, hasMore: false });
      expect(chat.displayedChatItems).toHaveLength(2);
      expect(chat.displayedChatItems[0]).toBe(localUser);
      expect(chat.displayedChatItems[1].id).toBe(realtimeTurn.id);
      expect(chat.displayedChatItems[1].segments[1]).toBe(liveTool);
      expect(chat.displayedChatItems[1].segments[1].approval.status).toBe('pending');
    }
    receive({ type: 'approval_closed', ...request, outcome: 'approved', reason: 'user' });
    chat.handleAgentEvent({
      type: 'tool_result', sessionId: 'main', turnId: request.turnId, callId: request.callId,
      result: { status: 'success', content: [{ type: 'text', text: 'Done' }] },
    });
    expect(chat.displayedChatItems[1].segments[1].status).toBe('success');
    chat.appendTextToTurn(request.turnId, 'Directories listed.', 'main');
    expect(chat.displayedChatItems.flatMap((item: { segments?: { text?: string }[] }) =>
      item.segments ?? []).map((segment: { text?: string }) => segment.text))
      .toContain('Directories listed.');
    expect(chat.displayedChatItems.flatMap((item: { segments?: { callId?: string }[] }) =>
      item.segments ?? []).filter((segment: { callId?: string }) => segment.callId === request.callId))
      .toHaveLength(1);
    expect(state.chatItems).toHaveLength(2);
    expect(state.historyItems).toHaveLength(2);
    const remainingText = realtimeTurn.segments[2];
    remainingText.text += ' More details.';
    expect(chat.displayedChatItems.flatMap((item: { segments?: { text?: string }[] }) =>
      item.segments ?? []).filter((segment: { text?: string }) =>
      segment.text === 'Directories listed. More details.')).toHaveLength(1);
    const completedRecords = [
      records[0],
      { ...records[1], content: [...records[1].content, {
        type: 'tool_use', id: 'other-call', name: 'other_tool', input: {},
      }] },
      { entryId: 'persisted-result', role: 'toolResult', turnId: request.turnId,
        content: [{ type: 'tool_result', tool_use_id: request.callId, status: 'success', content: 'Done' }] },
      { entryId: 'persisted-reply', role: 'assistant', turnId: request.turnId,
        content: [{ type: 'text', text: 'Directories listed. More details.' }] },
    ];
    liveTool.status = 'running';
    state.pendingHistoryRequest = { terminalTurnIds: [] };
    chat.mergeHistoryPage('main', { items: completedRecords, hasMore: false });
    const displayedSegments = chat.displayedChatItems.flatMap(
      (item: { segments?: { callId?: string; status?: string }[] }) => item.segments ?? [],
    );
    expect(displayedSegments.find((segment: { callId?: string }) => segment.callId === request.callId).status)
      .toBe('success');
    expect(displayedSegments.filter((segment: { callId?: string }) => segment.callId === 'other-call'))
      .toHaveLength(1);
    expect(new Set(chat.displayedChatItems.map((item: { id: number | string }) => item.id)).size)
      .toBe(chat.displayedChatItems.length);
    state.pendingHistoryRequest = { terminalTurnIds: [request.turnId] };
    chat.mergeHistoryPage('main', { items: completedRecords, hasMore: false });
    expect(state.chatItems).toEqual([]);
    expect(chat.displayedChatItems[0].id).toBe(localUser.id);
    expect(chat.pendingApprovalCount).toBe(0);
    state.activeTurnId = null;
    chat.dispatchRunTurn({ message: 'Start a Turn', reasoning: {} });
    expect(state.isSending).toBe(true);
    expect(chat.canSend).toBe(false);
    expect(chat.isWaitingForReply).toBe(false);
    chat.handleAgentEvent({
      type: 'user_message', sessionId: 'main', originClientId: chat.form.clientId,
      messageId: 'accepted-message', content: 'Start a Turn',
    });
    expect(state.isSending).toBe(false);
    expect(chat.isWaitingForReply).toBe(false);
    chat.handleAgentEvent({ type: 'run_start', sessionId: 'main', turnId: 'observed-turn' });
    expect(chat.isWaitingForReply).toBe(true);
    chat.handleAgentEvent({
      type: 'run_end', sessionId: 'main', turnId: 'old-turn', result: { stopReason: 'end_turn' },
    });
    expect(state.activeTurnId).toBe('observed-turn');
    chat.handleAgentEvent({ type: 'request_end', sessionId: 'main', requestId: 'old-request' });
    expect(chat.isWaitingForReply).toBe(true);
    chat.handleAgentEvent({ type: 'error', sessionId: 'main', turnId: 'old-turn', error: 'Old error' });
    expect(chat.isWaitingForReply).toBe(true);
    chat.handleAgentEvent({
      type: 'run_end', sessionId: 'main', turnId: 'observed-turn', result: { stopReason: 'end_turn' },
    });
    expect(chat.isWaitingForReply).toBe(false);
    chat.handleAgentEvent({ type: 'run_start', sessionId: 'other', turnId: 'other-running-turn' });
    expect(chat.isWaitingForReply).toBe(false);
    chat.form.sessionId = 'other';
    expect(chat.isWaitingForReply).toBe(true);
    chat.form.sessionId = 'main';
    chat.appendTextToTurn('missed-start-turn', 'Content only', 'main');
    expect(chat.isWaitingForReply).toBe(false);
    chat.sendJson = () => { throw new Error('Socket is not open.'); };
    expect(() => chat.dispatchRunTurn({ message: 'Fail', reasoning: {} })).toThrow('Socket is not open.');
    expect(state.isSending).toBe(false);
    expect(state.chatItems.at(-1).kind).toBe('error');
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
    expect(html).toContain('const socket = new WebSocket(DEFAULT_SOCKET_URL);');
    expect(html).toContain('this.scheduleReconnect();');
    expect(html).toContain('this.connect();');
    expect(html).not.toContain('WebSocket URL');
    expect(html).not.toContain('>Disconnect</button>');
    expect(html).toContain("anchor.target = '_blank';");
    expect(html).toContain("anchor.rel = 'noopener noreferrer';");
    expect(html).toContain('aria-label="Thinking options"');
    expect(html).toContain('aria-label="Reasoning effort options"');
    expect(html).toContain("@click=\"toggleReasoningPicker('thinking')\"");
    expect(html).toContain("@click=\"toggleReasoningPicker('effort')\"");
    expect(html).toContain('reasoning: turn.reasoning');
    const variantResponse = await fetch(`${clientUrl(channel)}chat2.html`);
    expect(variantResponse.status).toBe(200);
    expect(variantResponse.headers.get('content-type')).toContain('text/html');
    const variantHtml = await variantResponse.text();
    expect(variantHtml).toContain('<title>my-agent · Command Center</title>');
    expect(variantHtml).toContain("const DEFAULT_SOCKET_PATH = \"/ws\";");
    expect(variantHtml).not.toContain('__MY_AGENT_WEBSOCKET_PATH__');
    expect(variantHtml).toContain('updatePermissionPickerPlacement()');
    expect(variantHtml).toContain("'placement-top': permissionPickerPlacement === 'top'");
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
      reasoning: { thinking: 'on', effort: 'high' },
    }));

    await vi.waitFor(() => {
      expect(handler).toHaveBeenCalledWith({
        clientId: 'client-1',
        sessionId: 'main',
        message: 'hello ws',
        modelReference: { providerId: 'test', modelId },
        reasoning: { thinking: 'on', effort: 'high' },
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

  it('rejects message-level maxLlmCalls', async () => {
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
      message: 'policy override',
      maxLlmCalls: 2,
    }));

    await expectMessage(client, {
      type: 'channel_error',
      code: 'INVALID_MESSAGE',
      message: 'maxLlmCalls is execution policy and is not accepted on run_turn.',
    });
    expect(handler).not.toHaveBeenCalled();
  });

  it.each([
    [null, 'reasoning must be an object.'],
    [{ effrot: 'high' }, 'reasoning.effrot is not supported.'],
    [{ thinking: true }, 'reasoning.thinking must be on or off.'],
    [{ effort: 'ultra' }, 'reasoning.effort is not supported.'],
    [{ thinking: 'on', effort: 'none' }, 'reasoning on conflicts with effort none.'],
    [{ thinking: 'off', effort: 'high' }, 'reasoning off conflicts with the effort.'],
  ])('rejects invalid reasoning policy %j', async (reasoning, message) => {
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
      message: 'invalid reasoning',
      reasoning,
    }));

    await expectMessage(client, {
      type: 'channel_error',
      code: 'INVALID_MESSAGE',
      message,
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
            capabilities: {
              toolUse: false,
              mediaKinds: [],
              reasoning: {
                thinking: ['on', 'off'],
                efforts: ['low', 'high'],
              },
            },
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
                capabilities: {
                  toolUse: false,
                  mediaKinds: [],
                  reasoning: {
                    thinking: ['on', 'off'],
                    efforts: ['low', 'high'],
                  },
                },
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
    it('returns correlated Session history and History operation errors', async () => {
      const sessionId = '123e4567-e89b-42d3-a456-426614174000';
      const page = {
        sessionId,
        items: [{
          entryId: 'entry-1',
          turnId: 'turn-1',
          timestamp: '2026-09-27T00:00:00.000Z',
          role: 'user' as const,
          reasoning: { thinking: 'on' as const, effort: 'high' as const },
          content: [{
            type: 'image' as const,
            source: {
              type: 'base64' as const,
              media_type: 'image/png',
              data: 'aGVsbG8=',
            },
            dimensions: { width: 32, height: 24 },
          }],
        }],
        nextCursor: null,
        hasMore: false,
      };
      const getHistory = vi.fn().mockResolvedValueOnce(page).mockRejectedValueOnce(
        new ChannelOperationError(
          'SESSION_HISTORY_CURSOR_INVALID',
          'The history cursor is not on the active branch.',
        ),
      );
      channel = createChannel({ port: 0 });
      channel.onMessage(async () => undefined);
      channel.bindRuntimeCapabilities(capabilities(
        undefined,
        undefined,
        sessionCapabilities({ getHistory }),
      ));
      await channel.start();

      const client = await connectClient(channel);
      clients.push(client);
      client.send(JSON.stringify({ type: 'hello', clientId: 'history-client' }));
      await expectMessage(client, { type: 'hello_ack', clientId: 'history-client' });

      client.send(JSON.stringify({
        type: 'get_session_history',
        requestId: 'history-1',
        sessionId,
        limit: 50,
      }));
      await expectMessage(client, {
        type: 'session_history',
        requestId: 'history-1',
        ...page,
      });
      expect(getHistory).toHaveBeenCalledWith({ sessionId, limit: 50 });

      client.send(JSON.stringify({
        type: 'get_session_history',
        requestId: 'history-2',
        sessionId,
        beforeEntryId: 'missing',
      }));
      await expectMessage(client, {
        type: 'session_history_error',
        requestId: 'history-2',
        sessionId,
        code: 'SESSION_HISTORY_CURSOR_INVALID',
        message: 'The history cursor is not on the active branch.',
      });

      client.send(JSON.stringify({
        type: 'get_session_history',
        requestId: 'history-3',
        sessionId,
        limit: 101,
      }));
      await expectMessage(client, {
        type: 'channel_error',
        code: 'INVALID_MESSAGE',
        message: 'limit must be no greater than 100.',
      });
    });

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
      callId: 'call-1',
      toolName: 'write_file',
      input: { path: 'README.md' },
      sessionId: 'main',
      turnId: 'turn-1',
      originClientId: 'client-1',
      originChannelId: 'websocket',
    };
    subscribe(channel, 'client-1', 'main');
    expect(channel.interaction?.sendInteractionRequest(request)).toEqual({ status: 'accepted' });

    await expectMessage(client, {
      type: 'approval_requested',
      id: 'apr-1',
      originClientId: 'client-1',
      originChannelId: 'websocket',
      callId: 'call-1',
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

  it('allows another connected client to decide and closes all bound clients', async () => {
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
    subscribe(channel, 'approval-origin', 'main');

    const request: ApprovalInteractionRequest = {
      id: 'apr-foreign',
      kind: 'approval',
      callId: 'call-foreign',
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
      originClientId: 'approval-origin',
      callId: 'call-foreign',
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
    await vi.waitFor(() => expect(interactionResponse).toHaveBeenCalledWith({
      id: request.id, kind: 'approval', outcome: 'submitted', decision: 'allow',
    }));
    const originClosed = nextMessage(origin);
    const foreignClosed = nextMessage(foreign);
    channel.interaction.sendInteractionClosed(request, { outcome: 'approved' });
    for (const message of await Promise.all([originClosed, foreignClosed])) {
      expect(message).toEqual({
        type: 'approval_closed', id: request.id, sessionId: 'main',
        turnId: request.turnId, callId: request.callId, outcome: 'approved', reason: 'user',
      });
    }
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
    subscribe(channel, 'multi-session-client', 'session-a', 'session-b');

    const requests: ApprovalInteractionRequest[] = [
      {
        id: 'apr-session-a',
        callId: 'call-session-a',
        kind: 'approval',
        toolName: 'write_file',
        input: { path: 'a.txt' },
        sessionId: 'session-a',
        turnId: 'turn-a',
        originClientId: 'multi-session-client',
      },
      {
        id: 'apr-session-b',
        callId: 'call-session-b',
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
        originClientId: request.originClientId,
        callId: request.callId,
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

  it('accepts pending delivery without connected or origin clients and restricts Origin Channel', async () => {
    channel = createChannel({ port: 0, approval: true });
    channel.onMessage(async () => undefined);
    await channel.start();

    const request: ApprovalInteractionRequest = {
      id: 'apr-missing',
      kind: 'approval',
      callId: 'call-missing',
      toolName: 'write_file',
      input: {},
      sessionId: 'main',
      turnId: 'turn-missing',
      originClientId: 'missing-client',
    };
    expect(channel.interaction.sendInteractionRequest(request)).toEqual({ status: 'accepted' });
    expect(channel.interaction.sendInteractionRequest({ ...request, originClientId: undefined })).toEqual({ status: 'accepted' });
    expect(channel.interaction.sendInteractionRequest({ ...request, originChannelId: 'cli' })).toEqual({ status: 'unavailable', reason: 'delivery_failed' });
    await channel.stop();
    expect(channel.interaction.sendInteractionRequest(request)).toEqual({ status: 'unavailable', reason: 'delivery_failed' });
  });

  it('sends approval_closed for a non-user terminal outcome', async () => {
    channel = createChannel({ port: 0, approval: true });
    channel.onMessage(async () => undefined);
    await channel.start();

    const client = await connectClient(channel);
    clients.push(client);
    client.send(JSON.stringify({ type: 'hello', clientId: 'client-close' }));
    await expectMessage(client, { type: 'hello_ack', clientId: 'client-close' });
    subscribe(channel, 'client-close', 'main');

    const request: ApprovalInteractionRequest = {
      id: 'apr-close',
      kind: 'approval',
      callId: 'call-close',
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
      originClientId: 'client-close',
      callId: 'call-close',
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
      callId: 'call-close',
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
      callId: 'call-close',
      sessionId: 'main',
      turnId: 'turn-close',
      outcome: 'approved',
      reason: 'session_allow_all',
    });
  });

  it('keeps pending approval bound across same-client socket replacement', async () => {
    const interactionResponse = vi.fn();
    channel = createChannel({ port: 0, approval: true });
    channel.onMessage(async () => undefined);
    channel.interaction?.onInteractionResponse(interactionResponse);
    await channel.start();

    const firstClient = await connectClient(channel);
    clients.push(firstClient);
    firstClient.send(JSON.stringify({ type: 'hello', clientId: 'client-replace' }));
    await expectMessage(firstClient, { type: 'hello_ack', clientId: 'client-replace' });
    subscribe(channel, 'client-replace', 'main');

    const request: ApprovalInteractionRequest = {
      id: 'apr-replace',
      kind: 'approval',
      callId: 'call-replace',
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
      originClientId: 'client-replace',
      callId: 'call-replace',
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

  it('queries all acceptable pending requests or validates only the supplied Session', async () => {
    channel = createChannel({ approval: true });
    channel.onMessage(async () => undefined);
    const requests = [
      approvalRequest({ id: 'local', originChannelId: 'websocket', originClientId: 'disconnected' }),
      approvalRequest({ id: 'global', sessionId: 'other-session' }),
      approvalRequest({ id: 'foreign', originChannelId: 'cli' }),
    ];
    const getPending = vi.fn((sessionId?: string) => requests.filter(
      request => sessionId === undefined || request.sessionId === sessionId,
    ));
    const getSession = vi.fn(async (sessionId: string) => ({ sessionId, createdAt: 1, updatedAt: 1 }));
    channel.bindRuntimeCapabilities({
      ...capabilities(undefined, undefined, sessionCapabilities({ getSession })),
      approvals: { getPending },
    });
    await channel.start();
    const client = await connectClient(channel);
    clients.push(client);
    client.send(JSON.stringify({ type: 'hello', clientId: 'query-client' }));
    await expectMessage(client, { type: 'hello_ack', clientId: 'query-client' });
    client.send(JSON.stringify({ type: 'get_session_approvals', requestId: 'all' }));
    await expectMessage(client, { type: 'session_approvals', requestId: 'all', approvals: requests.slice(0, 2) });
    expect(getSession).not.toHaveBeenCalled();
    expect(getPending).toHaveBeenCalledWith(undefined);
    client.send(JSON.stringify({ type: 'get_session_approvals', requestId: 'one', sessionId: 'main' }));
    await expectMessage(client, { type: 'session_approvals', requestId: 'one', sessionId: 'main', approvals: [requests[0]] });
    expect(getSession).toHaveBeenCalledWith('main');
    expect(getPending).toHaveBeenCalledWith('main');
  });

  it('returns explicit pending-query errors and keeps unsupported interaction unavailable', async () => {
    channel = createChannel();
    channel.onMessage(async () => undefined);
    await channel.start();
    const client = await connectClient(channel);
    clients.push(client);
    client.send(JSON.stringify({ type: 'get_session_approvals', requestId: 'unauthenticated' }));
    await expectMessage(client, { type: 'channel_error', code: 'SERVER_NOT_READY', message: 'hello must complete before business messages.' });
    client.send(JSON.stringify({ type: 'hello', clientId: 'query-errors' }));
    await expectMessage(client, { type: 'hello_ack', clientId: 'query-errors' });
    client.send(JSON.stringify({ type: 'get_session_approvals', requestId: 'unbound' }));
    await expectMessage(client, {
      type: 'session_approvals_error', requestId: 'unbound',
      code: 'SERVER_NOT_READY', message: 'Runtime Approvals are not bound.',
    });
    const getPending = vi.fn(() => [approvalRequest()]);
    const getSession = vi.fn(async () => { throw new ChannelOperationError('SESSION_NOT_FOUND', 'Missing Session'); });
    channel.bindRuntimeCapabilities({
      ...capabilities(undefined, undefined, sessionCapabilities({ getSession })),
      approvals: { getPending },
    });
    client.send(JSON.stringify({ type: 'get_session_approvals', requestId: 'missing', sessionId: 'missing' }));
    await expectMessage(client, {
      type: 'session_approvals_error', requestId: 'missing', sessionId: 'missing',
      code: 'SESSION_NOT_FOUND', message: 'Missing Session',
    });
    expect(getPending).not.toHaveBeenCalled();
    client.send(JSON.stringify({ type: 'get_session_approvals', requestId: 'disabled' }));
    await expectMessage(client, { type: 'session_approvals', requestId: 'disabled', approvals: [] });
    expect(channel.interaction.sendInteractionRequest(approvalRequest())).toEqual({ status: 'unavailable', reason: 'delivery_failed' });
    client.send(JSON.stringify({ type: 'get_session_approvals', requestId: 'invalid', sessionId: '' }));
    await expectMessage(client, { type: 'channel_error', code: 'INVALID_MESSAGE', message: 'sessionId must be a non-empty string.' });
  });

  it('takes the pending snapshot after async Session validation and sends it before subsequent closure', async () => {
    channel = createChannel({ approval: true });
    channel.onMessage(async () => undefined);
    let release!: () => void;
    const validation = new Promise<void>(resolve => { release = resolve; });
    const getSession = vi.fn(async (sessionId: string) => {
      await validation;
      return { sessionId, createdAt: 1, updatedAt: 1 };
    });
    const request = approvalRequest();
    let pending = [request];
    const getPending = vi.fn(() => pending);
    channel.bindRuntimeCapabilities({
      ...capabilities(undefined, undefined, sessionCapabilities({ getSession })),
      approvals: { getPending },
    });
    await channel.start();
    const client = await connectClient(channel);
    clients.push(client);
    client.send(JSON.stringify({ type: 'hello', clientId: 'ordered-client' }));
    await expectMessage(client, { type: 'hello_ack', clientId: 'ordered-client' });
    client.send(JSON.stringify({ type: 'get_session_approvals', requestId: 'ordered', sessionId: 'main' }));
    await vi.waitFor(() => expect(getSession).toHaveBeenCalledOnce());
    expect(getPending).not.toHaveBeenCalled();
    const messages: Record<string, unknown>[] = [];
    client.on('message', raw => messages.push(JSON.parse(raw.toString())));
    release();
    await vi.waitFor(() => expect(messages).toHaveLength(1));
    pending = [];
    channel.interaction.sendInteractionClosed(request, { outcome: 'denied', reason: 'user' });
    await vi.waitFor(() => expect(messages).toHaveLength(2));
    expect(messages[0]).toEqual({
      type: 'session_approvals', requestId: 'ordered', sessionId: 'main', approvals: [request],
    });
    expect(messages[1]).toMatchObject({ type: 'approval_closed', id: request.id, outcome: 'denied' });
  });

  it('does not read a pending snapshot when the validated socket disconnected', async () => {
    channel = createChannel({ approval: true });
    channel.onMessage(async () => undefined);
    let release!: () => void;
    const validation = new Promise<void>(resolve => { release = resolve; });
    const getSession = vi.fn(async (sessionId: string) => {
      await validation;
      return { sessionId, createdAt: 1, updatedAt: 1 };
    });
    const getPending = vi.fn(() => []);
    channel.bindRuntimeCapabilities({
      ...capabilities(undefined, undefined, sessionCapabilities({ getSession })),
      approvals: { getPending },
    });
    await channel.start();
    const client = await connectClient(channel);
    clients.push(client);
    client.send(JSON.stringify({ type: 'hello', clientId: 'closing-query' }));
    await expectMessage(client, { type: 'hello_ack', clientId: 'closing-query' });
    client.send(JSON.stringify({ type: 'get_session_approvals', requestId: 'closing', sessionId: 'main' }));
    await vi.waitFor(() => expect(getSession).toHaveBeenCalledOnce());
    const closed = once(client, 'close');
    client.close();
    await closed;
    release();
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(getPending).not.toHaveBeenCalled();
  });

  it.each<[ApprovalClosedResult, string]>([
    [{ outcome: 'approved' }, 'user'],
    [{ outcome: 'denied', reason: 'user' }, 'user'],
    [{ outcome: 'aborted', reason: 'turn' }, 'turn'],
    [{ outcome: 'unavailable', reason: 'delivery_failed' }, 'delivery_failed'],
    [{ outcome: 'failed', message: 'adapter failed' }, 'adapter failed'],
  ])('broadcasts terminal closure %j without an origin Client or opened Session', async (result, reason) => {
    channel = createChannel({ approval: true });
    channel.onMessage(async () => undefined);
    await channel.start();
    const client = await connectClient(channel);
    clients.push(client);
    client.send(JSON.stringify({ type: 'hello', clientId: 'closure-only' }));
    await expectMessage(client, { type: 'hello_ack', clientId: 'closure-only' });
    const request = approvalRequest();
    channel.interaction.sendInteractionClosed(request, result);
    await expectMessage(client, {
      type: 'approval_closed', id: request.id, sessionId: request.sessionId,
      turnId: request.turnId, callId: request.callId, outcome: result.outcome, reason,
    });
  });

  it('retains canonical pending after client disconnect and exposes it to another client', async () => {
    const interactionResponse = vi.fn();
    channel = createChannel({ port: 0, approval: true });
    channel.onMessage(async () => undefined);
    channel.interaction.onInteractionResponse(interactionResponse);
    await channel.start();

    const client = await connectClient(channel);
    clients.push(client);
    client.send(JSON.stringify({ type: 'hello', clientId: 'client-disconnect' }));
    await expectMessage(client, { type: 'hello_ack', clientId: 'client-disconnect' });
    subscribe(channel, 'client-disconnect', 'main');

    const request: ApprovalInteractionRequest = {
      id: 'apr-disconnect',
      kind: 'approval',
      callId: 'call-disconnect',
      toolName: 'write_file',
      input: {},
      sessionId: 'main',
      turnId: 'turn-disconnect',
      originClientId: 'client-disconnect',
    };
    const getPending = vi.fn(() => [request]);
    channel.bindRuntimeCapabilities({ ...capabilities(), approvals: { getPending } });
    channel.interaction.sendInteractionRequest(request);
    await expectMessage(client, {
      type: 'approval_requested',
      id: 'apr-disconnect',
      originClientId: 'client-disconnect',
      callId: 'call-disconnect',
      sessionId: 'main',
      turnId: 'turn-disconnect',
      toolName: 'write_file',
      input: {},
    });

    client.close();
    await once(client, 'close');
    const replacement = await connectClient(channel);
    clients.push(replacement);
    replacement.send(JSON.stringify({ type: 'hello', clientId: 'another-client' }));
    await expectMessage(replacement, { type: 'hello_ack', clientId: 'another-client' });
    replacement.send(JSON.stringify({ type: 'get_session_approvals', requestId: 'pending-1' }));
    await expectMessage(replacement, {
      type: 'session_approvals', requestId: 'pending-1', approvals: [request],
    });
    replacement.send(JSON.stringify({ type: 'approval_resolve', id: request.id, decision: 'allow' }));
    await vi.waitFor(() => expect(interactionResponse).toHaveBeenCalledWith({
      id: request.id, kind: 'approval', outcome: 'submitted', decision: 'allow',
    }));
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
      timestamp: 1,
    });
    await expectMessage(client, {
      type: 'user_message',
      sessionId: 'main',
      messageId: 'origin-queued',
      content: 'queued',
      originClientId: 'client-request-end',
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
        timestamp,
      });

      const expected = {
        type: 'user_message',
        sessionId: 'main',
        messageId: 'msg-abc',
        content: 'hello everyone',
        attachmentSummaries: [{ type: 'image', mime: 'image/png', bytes: 1024 }],
        originClientId: 'client-A',
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
    approvals: { getPending: () => [] },
  };
}

function subscribe(channel: WebSocketChannel, clientId: string, ...sessionIds: string[]): void {
  for (const sessionId of sessionIds) {
    (channel as unknown as { registerSessionAudience(clientId: string, sessionId: string): void })
      .registerSessionAudience(clientId, sessionId);
  }

}

function approvalRequest(overrides: Partial<ApprovalInteractionRequest> = {}): ApprovalInteractionRequest {
  return {
    id: 'pending-query', kind: 'approval', sessionId: 'main', turnId: 'turn-query',
    callId: 'call-query', toolName: 'write_file', input: {}, ...overrides,
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
    getHistory: async ({ sessionId: requestedSessionId }) => ({
      sessionId: requestedSessionId,
      items: [],
      nextCursor: null,
      hasMore: false,
    }),
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
    clientVariants: Object.freeze({ '/chat2.html': CLIENT_VARIANT_FILE_PATH }),
    logger,
    ...(browserLauncher === undefined ? {} : { browserLauncher }),
  };
  return new WebSocketChannel(options);
}