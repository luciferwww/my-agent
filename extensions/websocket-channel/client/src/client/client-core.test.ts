import { describe, expect, it } from 'vitest';

import {
  ATTACHMENT_RAW_MAX_BYTES,
  MAX_ATTACHMENTS_PER_MESSAGE,
  base64DecodedSize,
  validateAttachmentSelection,
} from '../attachments';
import {
  applyAgentEvent,
  parseTaskSubagentSessionId,
  resolveEventSessionId,
} from './conversation';
import {
  applyHistoryPage,
  beginHistoryRequest,
  buildHistoryItems,
  mergeRealtimeWithHistory,
  preserveRealtimePresentationIdentity,
  type PresentationItem,
} from './history';
import { renderAssistantMarkdown } from './markdown';
import { parseServerMessage } from './protocol';
import { createSessionUiState } from './session-state';
import { createWebSocketUrl, reconnectDelay } from './socket';
import {
  DEFAULT_THEME,
  isThemeId,
  resolveThemePreference,
} from './theme';

describe('WebSocket Client core', () => {
  it('keeps richer realtime text and its stable presentation identity', () => {
    const history: PresentationItem[] = [{
      id: 'history-turn',
      kind: 'turn',
      label: 'Assistant',
      timestamp: 1,
      turnId: 'turn-1',
      segments: [{ id: 'history-text', type: 'text', text: 'partial' }],
    }];
    const realtime: PresentationItem[] = [{
      id: 'live-turn',
      kind: 'turn',
      label: 'Assistant',
      timestamp: 1,
      turnId: 'turn-1',
      segments: [{ id: 'live-text', type: 'text', text: 'partial response' }],
    }];

    const merged = mergeRealtimeWithHistory(history, realtime);

    expect(merged).toEqual([{
      id: 'live-turn',
      kind: 'turn',
      label: 'Assistant',
      timestamp: 1,
      turnId: 'turn-1',
      segments: [{ id: 'live-text', type: 'text', text: 'partial response' }],
    }]);

    const settledHistory: PresentationItem[] = [{
      id: 'history-turn',
      kind: 'turn',
      label: 'Assistant',
      timestamp: 1,
      turnId: 'turn-1',
      segments: [{ id: 'history-tool', type: 'tool_call' }],
    }];
    const settledRealtime: PresentationItem[] = [{
      id: 'live-turn',
      kind: 'turn',
      label: 'Assistant',
      timestamp: 1,
      turnId: 'turn-1',
      segments: [{ id: 'live-tool', type: 'tool_call' }],
    }];

    preserveRealtimePresentationIdentity(settledHistory, settledRealtime, ['turn-1']);

    expect(settledHistory[0]?.id).toBe('live-turn');
    expect(settledHistory[0]?.segments?.[0]?.id).toBe('live-tool');

    const state = createSessionUiState();
    expect(beginHistoryRequest(state, 'history-1', {
      latest: true,
      terminalTurnId: 'turn-1',
    })?.requestId).toBe('history-1');
    expect(beginHistoryRequest(state, '', {
      latest: true,
      terminalTurnId: 'turn-2',
    })).toBeNull();

    const settlement = applyHistoryPage(state, {
      items: [{
        entryId: 'entry-1',
        turnId: 'turn-1',
        role: 'assistant',
        timestamp: '2026-10-12T00:00:00.000Z',
        content: 'done',
      }],
      hasMore: false,
    });

    expect(state.historyStatus).toBe('loaded');
    expect(state.historyItems).toHaveLength(1);
    expect(settlement.deferredTerminalTurnIds).toEqual(['turn-2']);

    const conversation = createSessionUiState();
    let nextId = 1;
    const context = { clientId: 'browser-1', nextId: () => nextId++ };
    applyAgentEvent(conversation, {
      type: 'run_start',
      turnId: 'turn-2',
    }, context);
    applyAgentEvent(conversation, {
      type: 'thinking_start',
      turnId: 'turn-2',
      thinkingId: 'thinking-1',
    }, context);
    applyAgentEvent(conversation, {
      type: 'thinking_end',
      turnId: 'turn-2',
      thinkingId: 'thinking-1',
      text: 'considered',
      status: 'complete',
    }, context);
    applyAgentEvent(conversation, {
      type: 'text_delta',
      turnId: 'turn-2',
      text: 'answer',
    }, context);
    const effects = applyAgentEvent(conversation, {
      type: 'run_end',
      turnId: 'turn-2',
      result: { stopReason: 'end_turn' },
    }, context);

    expect(conversation.activeTurnId).toBeNull();
    expect(conversation.turnMap['turn-2']?.segments).toMatchObject([
      { type: 'thinking', text: 'considered', status: 'complete' },
      { type: 'text', text: 'answer' },
    ]);
    expect(effects).toContainEqual({ type: 'refresh_history', turnId: 'turn-2' });
  });

  it('creates independent per-Session state with conservative permissions', () => {
    const first = createSessionUiState();
    const second = createSessionUiState();
    first.draft = 'only first';
    first.chatItems.push({
      id: 'message-1',
      kind: 'user',
      label: 'You',
      timestamp: 1,
    });

    expect(second.draft).toBe('');
    expect(second.chatItems).toEqual([]);
    expect(second.permissionMode).toBe('manual');
    expect(second.historyStatus).toBe('notLoaded');
  });

  it('discovers a running Child from Parent lifecycle events', () => {
    const state = createSessionUiState();
    let nextId = 1;
    const context = { clientId: 'browser-1', nextId: () => nextId++ };
    applyAgentEvent(state, {
      type: 'tool_call_requested',
      turnId: 'parent-turn',
      callId: 'task-call',
      name: 'task',
      input: { prompt: 'review' },
    }, context);

    applyAgentEvent(state, {
      type: 'subagent_start',
      sessionId: '5cb8b687-f263-4355-9d09-7749064e3319',
      parentTurnId: 'parent-turn',
      parentToolUseId: 'task-call',
      subagentType: 'reviewer',
    }, context);

    const segment = state.turnMap['parent-turn']?.segments?.[0];
    expect(segment).toMatchObject({
      subagentSessionId: '5cb8b687-f263-4355-9d09-7749064e3319',
      subagentStatus: 'running',
    });

    applyAgentEvent(state, {
      type: 'subagent_end',
      sessionId: '5cb8b687-f263-4355-9d09-7749064e3319',
      parentTurnId: 'parent-turn',
      parentToolUseId: 'task-call',
      outcome: 'ok',
    }, context);
    expect(segment).toMatchObject({
      subagentStatus: 'terminal',
      subagentOutcome: 'ok',
    });
  });

  it('recovers a Child handle only from the stable task Result header', () => {
    const sessionId = '5cb8b687-f263-4355-9d09-7749064e3319';
    const result = `Subagent completed.\nsessionId: ${sessionId}\nResult:\nreviewed`;

    expect(parseTaskSubagentSessionId('task', result)).toBe(sessionId);
    expect(parseTaskSubagentSessionId('other', result)).toBeNull();
    expect(parseTaskSubagentSessionId('task', `prefix\n${result}`)).toBeNull();

    const items = buildHistoryItems([{
      entryId: 'assistant-entry',
      turnId: 'parent-turn',
      role: 'assistant',
      content: [{
        type: 'tool_use',
        id: 'task-call',
        name: 'task',
        input: { prompt: 'review' },
        status: 'success',
        result_content: result,
      }],
    }]);
    expect(items[0]?.segments?.[0]).toMatchObject({
      subagentSessionId: sessionId,
      subagentStatus: 'terminal',
    });

  });

  it('routes lifecycle discovery to the Parent and ordinary events to the Child', () => {
    const childSessionId = '5cb8b687-f263-4355-9d09-7749064e3319';
    expect(resolveEventSessionId({
      type: 'subagent_start',
      sessionId: childSessionId,
      callerSessionId: 'parent',
    }, 'focused')).toBe('parent');
    expect(resolveEventSessionId({
      type: 'text_delta',
      sessionId: childSessionId,
      callerSessionId: 'parent',
    }, 'focused')).toBe(childSessionId);
  });

  it('keeps protocol parsing and socket derivation bounded', () => {
    expect(parseServerMessage('{"type":"hello_ack","clientId":"browser-1"}')).toEqual({
      ok: true,
      message: { type: 'hello_ack', clientId: 'browser-1' },
    });
    expect(parseServerMessage('{')).toEqual({ ok: false, reason: 'invalid_json' });
    expect(parseServerMessage('[]')).toEqual({ ok: false, reason: 'non_object' });
    expect(parseServerMessage('{}')).toEqual({ ok: true, message: {} });
    expect(createWebSocketUrl('/ws', {
      protocol: 'https:',
      host: 'agent.example:8443',
    })).toBe('wss://agent.example:8443/ws');
    expect(createWebSocketUrl('/nested/ws', {
      protocol: 'http:',
      host: 'localhost:4317',
    })).toBe('ws://localhost:4317/nested/ws');
    expect([0, 1, 2, 3, 4, 8].map(reconnectDelay)).toEqual([
      750,
      1_500,
      3_000,
      6_000,
      12_000,
      12_000,
    ]);
    expect(isThemeId('botanical')).toBe(true);
    expect(resolveThemePreference('botanical')).toBe('botanical');
    expect(resolveThemePreference('unknown')).toBe(DEFAULT_THEME);
  });

  it('renders Markdown without executable HTML or unsafe links', () => {
    expect(renderAssistantMarkdown('<img src=x onerror=alert(1)>')).toContain(
      '&lt;img src=x onerror=alert(1)&gt;',
    );
    expect(renderAssistantMarkdown('<script>alert(1)</script>')).not.toContain('<script>');
    expect(renderAssistantMarkdown('[unsafe](javascript:alert(1))')).not.toContain('href=');
    expect(renderAssistantMarkdown('[safe](https://example.com)')).toContain(
      'rel="noopener noreferrer"',
    );
  });

  it('validates an attachment selection atomically', () => {
    const valid = file('diagram.png', 'image/png', 1024);
    expect(validateAttachmentSelection([], [valid])).toEqual([]);

    const unsupported = file('notes.txt', 'text/plain', 20);
    const oversized = file('large.jpg', 'image/jpeg', ATTACHMENT_RAW_MAX_BYTES + 1);
    expect(validateAttachmentSelection([], [unsupported, oversized])).toEqual([
      'notes.txt: type text/plain is not supported',
      'large.jpg: exceeds the 10 MB per-image limit',
      'Total size exceeds 10 MB',
    ]);

    const existing = Array.from(
      { length: MAX_ATTACHMENTS_PER_MESSAGE },
      () => ({ sizeBytes: 1 }),
    );
    expect(validateAttachmentSelection(existing, [valid])).toEqual([
      `Maximum ${MAX_ATTACHMENTS_PER_MESSAGE} images`,
    ]);
    expect(base64DecodedSize('aGVsbG8=')).toBe(5);
  });
});

function file(name: string, type: string, size: number): File {
  return { name, type, size } as File;
}
