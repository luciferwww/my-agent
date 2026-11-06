import { describe, expect, it } from 'vitest';
import { applyAgentEvent } from './conversation';
import {
  applyHistoryPage,
  beginHistoryRequest,
  buildHistoryItems,
  mergeRealtimeWithHistory,
} from './history';
import { createSessionUiState } from './session-state';

describe('message identity reconciliation', () => {
  it('does not flatten descendant history into parent text before recursive slots are wired', () => {
    expect(buildHistoryItems([
      { entryId: 'parent', turnId: 'parent-turn', role: 'assistant', content: 'parent answer' },
      { entryId: 'copy', turnId: 'child-turn', role: 'assistant', content: 'child answer',
        sourceSessionId: 'child', sourceEntryId: 'source' },
    ]).flatMap(item => item.segments ?? []).filter(segment => segment.type === 'text')
      .map(segment => segment.text)).toEqual(['parent answer']);
  });
  function setup() {
    const state = createSessionUiState();
    let id = 0;
    const context = { clientId: 'observer', nextId: () => ++id };
    const texts = () => mergeRealtimeWithHistory(state.historyItems, state.chatItems)
      .flatMap(item => (item.segments ?? [])
        .filter(segment => segment.type === 'text')
        .map(segment => segment.text));
    return { state, context, texts };
  }

  it.each([['BC'], ['A', 'C']])('replaces incomplete realtime fragments %j by the committed message', (...fragments) => {
    const { state, context, texts } = setup();
    for (const text of fragments) {
      applyAgentEvent(state, {
        type: 'text_delta', turnId: 'turn', messageId: 'message', text,
      }, context);
    }
    state.historyItems = buildHistoryItems([{
      entryId: 'entry', turnId: 'turn', messageId: 'message',
      role: 'assistant', content: 'ABC',
    }]);

    expect(texts()).toEqual(['ABC']);
    expect(state.chatItems).toHaveLength(1);
  });

  it('keeps message boundaries and a newer uncommitted message with identical text', () => {
    const { state, context, texts } = setup();
    for (const messageId of ['first', 'second']) {
      applyAgentEvent(state, {
        type: 'text_delta', turnId: 'turn', messageId, text: 'same',
      }, context);
    }
    expect(state.chatItems[0]?.segments).toHaveLength(2);
    state.historyItems = buildHistoryItems([{
      entryId: 'entry', turnId: 'turn', messageId: 'first',
      role: 'assistant', content: 'same',
    }]);

    expect(texts()).toEqual(['same', 'same']);
  });

  it('does not consume an unrelated message whose text is a prefix', () => {
    const { state, context, texts } = setup();
    applyAgentEvent(state, {
      type: 'text_delta', turnId: 'turn', messageId: 'new', text: 'ABC',
    }, context);
    state.historyItems = buildHistoryItems([{
      entryId: 'entry', turnId: 'turn', messageId: 'old',
      role: 'assistant', content: 'AB',
    }]);

    expect(texts()).toEqual(['AB', 'ABC']);
  });

  it('reports an invalid realtime identity without appending content', () => {
    const { state, context } = setup();
    expect(applyAgentEvent(state, {
      type: 'text_delta', turnId: 'turn', messageId: ' ', text: 'invalid',
    }, context)).toContainEqual({
      type: 'protocol_error', detail: 'Message identity must be a non-empty string',
    });
    expect(state.chatItems).toEqual([]);
  });

  it('matches user identity despite prompt transformation and a not-yet-received Turn binding', () => {
    const { state, context } = setup();
    applyAgentEvent(state, {
      type: 'user_message', messageId: 'input', originClientId: 'another',
      content: 'work',
    }, context);
    state.historyItems = buildHistoryItems([{
      entryId: 'entry', turnId: 'turn', messageId: 'input',
      role: 'user', content: '<turn_start>timestamp</turn_start>\n\nwork',
    }]);

    const merged = mergeRealtimeWithHistory(state.historyItems, state.chatItems);
    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({
      messageId: 'input', entryId: 'entry', turnId: 'turn', text: 'work',
    });
  });

  it('recovers Thinking when subscription starts after thinking_start', () => {
    const { state, context } = setup();
    const effects = applyAgentEvent(state, {
      type: 'thinking_delta', turnId: 'turn', messageId: 'message',
      thinkingId: 'thinking', text: 'tail',
    }, context);
    expect(effects).not.toContainEqual(expect.objectContaining({ type: 'protocol_error' }));
    applyAgentEvent(state, {
      type: 'thinking_end', turnId: 'turn', messageId: 'message',
      thinkingId: 'thinking', text: 'full thinking', status: 'complete',
    }, context);
    state.historyItems = buildHistoryItems([{
      entryId: 'entry', turnId: 'turn', messageId: 'message', role: 'assistant',
      content: [{ type: 'thinking', id: 'thinking', text: 'full thinking', status: 'complete' }],
    }]);

    const merged = mergeRealtimeWithHistory(state.historyItems, state.chatItems);
    expect(merged.flatMap(item => item.segments ?? [])).toMatchObject([
      { type: 'thinking', text: 'full thinking', messageId: 'message' },
    ]);
  });

  it('recovers Thinking from the end event alone', () => {
    const { state, context } = setup();
    const effects = applyAgentEvent(state, {
      type: 'thinking_end', turnId: 'turn', messageId: 'message',
      thinkingId: 'thinking', text: 'full thinking', status: 'complete',
    }, context);
    expect(effects).not.toContainEqual(expect.objectContaining({ type: 'protocol_error' }));
    expect(state.chatItems[0]?.segments).toMatchObject([
      { type: 'thinking', text: 'full thinking', messageId: 'message' },
    ]);
  });

  it('continues updating a history-only tool card and retains the overlay across History rebuilds', () => {
    const { state, context } = setup();
    const record = {
      entryId: 'entry', turnId: 'turn', messageId: 'message', role: 'assistant',
      content: [{ type: 'tool_use', id: 'call', name: 'work', input: {} }],
    };
    beginHistoryRequest(state, 'initial', { latest: true });
    applyHistoryPage(state, { items: [record] });
    expect(applyAgentEvent(state, {
      type: 'tool_use', turnId: 'turn', callId: 'call', executionId: 'execution',
    }, context)).not.toContainEqual(expect.objectContaining({ type: 'protocol_error' }));
    const tool = state.chatItems[0]?.segments?.[0];
    if (!tool) throw new Error('Expected tool overlay');
    tool.status = 'approval';
    tool.approval = { id: 'approval', toolName: 'work', input: {}, status: 'pending' };
    applyAgentEvent(state, {
      type: 'tool_result', turnId: 'turn', callId: 'call', executionId: 'execution',
      result: { status: 'success', content: 'done' },
    }, context);
    beginHistoryRequest(state, 'refresh', { latest: true });
    applyHistoryPage(state, { items: [record] });

    const segments = mergeRealtimeWithHistory(state.historyItems, state.chatItems)
      .flatMap(item => item.segments ?? []);
    expect(segments).toHaveLength(1);
    expect(segments[0]).toMatchObject({
      callId: 'call', executionId: 'execution', status: 'success', resultContent: 'done',
      approval: { status: 'resolved' },
    });
  });

  it('preserves multiple Tool results in one History message without separate message identities', () => {
    const items = buildHistoryItems([{
      entryId: 'assistant', turnId: 'turn', messageId: 'message', role: 'assistant',
      content: ['first', 'second'].map(id => ({
        type: 'tool_use', id, name: 'work', input: {},
      })),
    }, {
      entryId: 'results', turnId: 'turn', role: 'toolResult',
      content: ['first', 'second'].map(id => ({
        type: 'tool_result', tool_use_id: id, content: `${id} done`, status: 'success',
      })),
    }]);
    expect(items).toHaveLength(1);
    expect(items[0]?.segments).toMatchObject([
      { callId: 'first', status: 'success', resultContent: 'first done' },
      { callId: 'second', status: 'success', resultContent: 'second done' },
    ]);
  });
});
