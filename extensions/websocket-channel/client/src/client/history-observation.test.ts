import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import type { SessionHistoryPage } from '../../../../../src/core/session/types.js';
import { SessionManager } from '../../../../../src/core/session/SessionManager.js';
import { WebSocketChannel } from '../../../WebSocketChannel.js';
import type { ChannelRuntimeCapabilities } from '../../../../../src/core/channel/types.js';
import { applyAgentEvent } from './conversation';
import { applyHistoryPage, beginHistoryRequest, mergeRealtimeWithHistory } from './history';
import { createSessionUiState } from './session-state';
import { applyExecutionHistoryPage, buildExecutionPresentation } from './execution';

describe('running History observation timing', () => {
  it('returns retained descendant items and scopes over the real socket after Child cleanup', async () => {
    const { sessions, socketChannel, sessionId } = await setup();
    await sessions.appendMessage(sessionId, {
      turnId: 'parent-turn', role: 'assistant',
      content: [{ type: 'tool_use', id: 'task', name: 'task', input: {} }],
    });
    const identity = {
      sessionId: '11111111-1111-4111-8111-111111111111', callerSessionId: sessionId,
      turnId: 'child-turn', parentTurnId: 'parent-turn', parentToolUseId: 'task',
      runId: 'run', depth: 1, subagentType: 'test',
    };
    const registration = { sessionId: identity.sessionId, callerSessionId: sessionId, createdAt: 1 };
    sessions.registerPreparingSubagentSession(registration);
    await sessions.beginSubagentPresentation(identity);
    await sessions.createTransientSubagentTranscript(registration);
    const source = await sessions.appendMessage(identity.sessionId, {
      turnId: identity.turnId, messageId: 'child-message', role: 'assistant', content: 'retained child', llmRound: 0,
    });
    await sessions.endSubagentPresentation({
      ...identity, outcome: 'ok', durationMs: 1, usage: { inputTokens: 1, outputTokens: 1 },
    });
    await sessions.deleteTransientSubagentTranscript(identity.sessionId);

    const client = await openObserver(socketChannel, sessionId);
    const response = nextMessage(client);
    client.send(JSON.stringify({
      type: 'get_session_history', requestId: 'retained', sessionId, limit: 1,
    }));
    const wirePage = await response;
    expect(wirePage).toMatchObject({
      type: 'session_history', requestId: 'retained', hasMore: false, nextCursor: null,
      items: expect.arrayContaining([expect.objectContaining({
        sourceSessionId: identity.sessionId, sourceEntryId: source.id,
        messageId: 'child-message', content: 'retained child', llmRound: 0,
      })]),
      scopes: [expect.objectContaining({ ...identity, status: 'terminal', outcome: 'ok' })],
    });
    const page = await sessions.getHistory({ sessionId, limit: 1 });
    expect(wirePage).toEqual({ type: 'session_history', requestId: 'retained', ...page });
    const states = { [sessionId]: createSessionUiState() };
    beginHistoryRequest(states[sessionId], 'retained', { latest: true });
    applyExecutionHistoryPage(states, sessionId, page);
    const presentation = buildExecutionPresentation(states, sessionId, new Map());
    expect(presentation.items).toHaveLength(1);
    expect(presentation.items[0].segments?.[0].callId).toBe('task');
    expect(presentation.itemsBySession[identity.sessionId][0].segments?.[0].text)
      .toBe('retained child');
  });

  it('mounts retained Child content from a reloaded fork without a task-result handle', async () => {
    const { sessions, sessionId } = await setup();
    await sessions.appendMessage(sessionId, {
      turnId: 'parent-turn', role: 'assistant',
      content: [{ type: 'tool_use', id: 'task', name: 'task', input: {} }],
    });
    const identity = {
      sessionId: '11111111-1111-4111-8111-111111111111', callerSessionId: sessionId,
      turnId: 'child-turn', parentTurnId: 'parent-turn', parentToolUseId: 'task',
      runId: 'run', depth: 1, subagentType: 'test',
    };
    const registration = { sessionId: identity.sessionId, callerSessionId: sessionId, createdAt: 1 };
    sessions.registerPreparingSubagentSession(registration);
    await sessions.beginSubagentPresentation(identity);
    await sessions.createTransientSubagentTranscript(registration);
    await sessions.appendMessage(identity.sessionId, {
      turnId: identity.turnId, role: 'assistant', content: 'interrupted child',
    });
    const fork = await sessions.forkSession(sessionId);
    await sessions.deleteTransientSubagentTranscript(identity.sessionId);
    const reloaded = new SessionManager(directory!);
    try {
      const page = reloaded.getHistory({ sessionId: fork.sessionId });
      const states = { [fork.sessionId]: createSessionUiState() };
      beginHistoryRequest(states[fork.sessionId], 'fork-history', { latest: true });
      applyExecutionHistoryPage(states, fork.sessionId, page);
      const presentation = buildExecutionPresentation(states, fork.sessionId, new Map());
      expect(presentation.scopes).toContainEqual(expect.objectContaining({
        sessionId: identity.sessionId, callerSessionId: fork.sessionId, status: 'unknown',
      }));
      expect(presentation.items[0].segments?.[0].callId).toBe('task');
      expect(presentation.itemsBySession[identity.sessionId][0].segments?.[0].text)
        .toBe('interrupted child');
    } finally {
      await reloaded.close();
    }
  });

  let channel: WebSocketChannel | undefined;
  let manager: SessionManager | undefined;
  let directory: string | undefined;
  const clients: WebSocket[] = [];

  afterEach(async () => {
    for (const client of clients.splice(0)) client.close();
    await channel?.stop();
    await manager?.close();
    if (directory) await rm(directory, { recursive: true, force: true });
    channel = undefined;
    manager = undefined;
    directory = undefined;
  });

  async function setup(getHistory?: ChannelRuntimeCapabilities['sessionObservation']['getHistory']) {
    directory = await mkdtemp(join(tmpdir(), 'my-agent-history-timing-'));
    manager = new SessionManager(directory);
    const sessions = manager;
    const sessionId = '823e4567-e89b-42d3-a456-426614174000';
    await sessions.materializeSession({ sessionId, createdAt: 1 });
    const socketChannel = new WebSocketChannel({
      config: {
        host: '127.0.0.1', port: 0, webSocketPath: '/ws', clientPath: '/',
        approval: false, openBrowser: false,
      },
      clientFilePath: fileURLToPath(new URL('../../../test-fixtures/legacy-client.html', import.meta.url)),
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });
    channel = socketChannel;
    socketChannel.onMessage(async () => undefined);
    socketChannel.bindRuntimeCapabilities({
      modelCatalog: {
        getSnapshot: () => ({ generation: 1, defaultSelection: { state: 'unset' }, providers: [] }),
      },
      abort: {
        querySessionsNeedingAbort: () => [],
        abortTurn: () => ({ aborted: false, dropped: 0 }),
      },
      approvals: { getPending: () => [] },
      chatSessions: {
        createSession: async () => { throw new Error('Not used by observation tests'); },
        listSessions: async () => [],
        renameSession: async () => { throw new Error('Not used by observation tests'); },
        archiveSession: async () => { throw new Error('Not used by observation tests'); },
        unarchiveSession: async () => { throw new Error('Not used by observation tests'); },
        deleteSession: async () => { throw new Error('Not used by observation tests'); },
        forkSession: async () => { throw new Error('Not used by observation tests'); },
        getPermissionMode: id => ({ sessionId: id, mode: 'manual', changedAt: 1 }),
        setPermissionMode: () => { throw new Error('Not used by observation tests'); },
        onPermissionModeChanged: () => () => undefined,
      },
      sessionObservation: {
        resolveSession: async id => {
          const resolved = sessions.resolveSession(id);
          if (!resolved) throw new Error(`Unknown test Session ${id}`);
          return resolved;
        },
        getHistory: getHistory ?? (async query => sessions.getHistory(query)),
      },
    });
    await socketChannel.start();
    return { sessions, socketChannel, sessionId };
  }

  async function openObserver(socketChannel: WebSocketChannel, sessionId: string) {
    const address = (socketChannel as unknown as {
      httpServer?: { address(): unknown };
    }).httpServer?.address();
    if (
      !address || typeof address !== 'object'
      || !('port' in address) || typeof address.port !== 'number'
    ) {
      throw new Error('Test WebSocket listener address is unavailable');
    }
    const socket = new WebSocket(`ws://127.0.0.1:${address.port}/ws`);
    clients.push(socket);
    await once(socket, 'open');
    let response = nextMessage(socket);
    socket.send(JSON.stringify({ type: 'hello', clientId: 'history-observer' }));
    expect(await response).toEqual({ type: 'hello_ack', clientId: 'history-observer' });
    response = nextMessage(socket);
    socket.send(JSON.stringify({ type: 'subscribe_session', requestId: 'subscribe', sessionId }));
    expect(await response).toEqual({ type: 'session_subscribed', requestId: 'subscribe', sessionId });
    return socket;
  }

  it.each(['first open', 'reconnect'] as const)(
    'reconciles text after %s midway through an uncommitted response',
    async scenario => {
      const { sessions, socketChannel, sessionId } = await setup();
      const turnId = 'running-turn';
      const messageId = 'running-message';
      await sessions.appendMessage(sessionId, {
        turnId, role: 'user', content: 'continue working',
      });
      const state = createSessionUiState();
      let nextId = 0;
      const context = { clientId: 'history-observer', nextId: () => ++nextId };
      const receiveText = async (socket: WebSocket, text: string) => {
        const received = nextMessage(socket);
        socketChannel.send({ type: 'text_delta', sessionId, turnId, messageId, text });
        expect(await received).toEqual({ type: 'text_delta', sessionId, turnId, messageId, text });
        applyAgentEvent(state, { type: 'text_delta', sessionId, turnId, messageId, text }, context);
      };
      const renderedTexts = () => mergeRealtimeWithHistory(state.historyItems, state.chatItems)
        .flatMap(item => (item.segments ?? [])
          .filter(segment => segment.type === 'text')
          .map(segment => segment.text));

      let client: WebSocket;
      if (scenario === 'reconnect') {
        client = await openObserver(socketChannel, sessionId);
        await receiveText(client, 'A');
        client.close();
        await once(client, 'close');
      } else {
        socketChannel.send({ type: 'text_delta', sessionId, turnId, messageId, text: 'A' });
      }
      client = await openObserver(socketChannel, sessionId);
      await receiveText(client, scenario === 'reconnect' ? 'C' : 'BC');
      await sessions.appendMessage(sessionId, { turnId, messageId, role: 'assistant', content: 'ABC' });

      const initialPage = sessions.getHistory({ sessionId });
      beginHistoryRequest(state, 'history-running', { latest: true });
      let response = nextMessage(client);
      client.send(JSON.stringify({
        type: 'get_session_history', requestId: 'history-running', sessionId,
      }));
      expect(await response).toEqual({
        type: 'session_history', requestId: 'history-running', ...initialPage,
      });
      applyHistoryPage(state, clientPage(initialPage));
      expect(renderedTexts()).toEqual(['ABC']);
      expect(state.chatItems).not.toEqual([]);

      response = nextMessage(client);
      socketChannel.send({
        type: 'run_end', sessionId, turnId, requestId: 'running-request',
        result: {
          text: 'ABC', content: [{ type: 'text', text: 'ABC' }],
          stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 }, toolRounds: 0,
        },
      });
      expect(await response).toMatchObject({ type: 'run_end', turnId });
      const effects = applyAgentEvent(state, {
        type: 'run_end', sessionId, turnId, result: { stopReason: 'end_turn' },
      }, context);
      expect(effects).toContainEqual({ type: 'refresh_history', turnId });
      beginHistoryRequest(state, 'history-terminal', { latest: true, terminalTurnId: turnId });
      response = nextMessage(client);
      client.send(JSON.stringify({
        type: 'get_session_history', requestId: 'history-terminal', sessionId,
      }));
      expect(await response).toEqual({
        type: 'session_history', requestId: 'history-terminal', ...initialPage,
      });
      applyHistoryPage(state, clientPage(initialPage));
      expect(renderedTexts()).toEqual(['ABC']);
      expect(state.chatItems).toEqual([]);
    },
  );

  it('defers terminal replacement until a fresh History response when the Turn ends during a request', async () => {
    let releaseResponse!: () => void;
    const responseReady = new Promise<void>(resolve => { releaseResponse = resolve; });
    let markSnapshotTaken!: () => void;
    const snapshotTaken = new Promise<void>(resolve => { markSnapshotTaken = resolve; });
    let requests = 0;
    const { sessions, socketChannel, sessionId } = await setup(async query => {
      if (!manager) throw new Error('Test SessionManager is not ready');
      const page = manager.getHistory(query);
      if (++requests === 1) {
        markSnapshotTaken();
        await responseReady;
      }
      return page;
    });
    const turnId = 'ending-turn';
    await sessions.appendMessage(sessionId, { turnId, role: 'user', content: 'work' });
    const state = createSessionUiState();
    let nextId = 0;
    const context = { clientId: 'history-observer', nextId: () => ++nextId };
    try {
      const client = await openObserver(socketChannel, sessionId);
      const oldPage = sessions.getHistory({ sessionId });
      beginHistoryRequest(state, 'old-snapshot', { latest: true });
      client.send(JSON.stringify({
        type: 'get_session_history', requestId: 'old-snapshot', sessionId,
      }));
      await snapshotTaken;

      let response = nextMessage(client);
      socketChannel.send({ type: 'text_delta', sessionId, turnId, text: 'finished' });
      expect(await response).toEqual({ type: 'text_delta', sessionId, turnId, text: 'finished' });
      applyAgentEvent(state, { type: 'text_delta', sessionId, turnId, text: 'finished' }, context);
      await sessions.appendMessage(sessionId, { turnId, role: 'assistant', content: 'finished' });
      response = nextMessage(client);
      socketChannel.send({
        type: 'run_end', sessionId, turnId, requestId: 'ending-request',
        result: {
          text: 'finished', content: [{ type: 'text', text: 'finished' }],
          stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 }, toolRounds: 0,
        },
      });
      expect(await response).toMatchObject({ type: 'run_end', turnId });
      const effects = applyAgentEvent(state, {
        type: 'run_end', sessionId, turnId, result: { stopReason: 'end_turn' },
      }, context);
      expect(effects).toContainEqual({ type: 'refresh_history', turnId });
      expect(beginHistoryRequest(state, '', {
        latest: true, terminalTurnId: turnId,
      })).toBeNull();
      expect(state.pendingHistoryRequest?.terminalTurnIds).toEqual([]);

      response = nextMessage(client);
      releaseResponse();
      expect(await response).toEqual({
        type: 'session_history', requestId: 'old-snapshot', ...oldPage,
      });
      const settlement = applyHistoryPage(state, clientPage(oldPage));
      expect(settlement.deferredTerminalTurnIds).toEqual([turnId]);
      expect(state.chatItems.flatMap(item => item.segments ?? [])).toContainEqual(
        expect.objectContaining({ type: 'text', text: 'finished' }),
      );

      beginHistoryRequest(state, 'fresh-snapshot', {
        latest: true, terminalTurnIds: settlement.deferredTerminalTurnIds,
      });
      const finalPage = sessions.getHistory({ sessionId });
      response = nextMessage(client);
      client.send(JSON.stringify({
        type: 'get_session_history', requestId: 'fresh-snapshot', sessionId,
      }));
      expect(await response).toEqual({
        type: 'session_history', requestId: 'fresh-snapshot', ...finalPage,
      });
      applyHistoryPage(state, clientPage(finalPage));
      expect(state.chatItems).toEqual([]);
      expect(state.historyItems.flatMap(item => item.segments ?? [])).toContainEqual(
        expect.objectContaining({ type: 'text', text: 'finished' }),
      );
    } finally {
      releaseResponse();
    }
  });
});

async function nextMessage(socket: WebSocket): Promise<Record<string, unknown>> {
  const [raw] = await once(socket, 'message');
  return JSON.parse(raw.toString('utf-8')) as Record<string, unknown>;
}

function clientPage(page: SessionHistoryPage) {
  return {
    items: page.items.map(item => ({
      ...item,
      content: typeof item.content === 'string' ? item.content : [...item.content],
    })),
    nextCursor: page.nextCursor,
    hasMore: page.hasMore,
  };
}
