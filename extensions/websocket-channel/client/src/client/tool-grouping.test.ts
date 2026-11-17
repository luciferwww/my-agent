import { describe, expect, it } from 'vitest';
import {
  applyAgentEvent, groupConversationSegments, type AgentEvent, type ConversationSegment,
} from './conversation';
import { applyHistoryPage, beginHistoryRequest, buildHistoryItems, mergeRealtimeWithHistory } from './history';
import { createSessionUiState } from './session-state';

function setup() {
  const state = createSessionUiState();
  let id = 0;
  const context = { clientId: 'observer', nextId: () => ++id };
  const event = (event: AgentEvent) => applyAgentEvent(state, { turnId: 'turn', ...event }, context);
  const call = (messageId: string, round = 0) => event({ type: 'llm_call', messageId, round });
  const tool = (callId: string, messageId?: string) =>
    event({ type: 'tool_call_requested', callId, messageId, name: 'read_file', input: {} });
  const segments = () => state.chatItems.flatMap(item => item.segments ?? []);
  return { state, event, call, tool, segments };
}

function record(entryId: string, llmRound?: number) {
  return {
    entryId, messageId: entryId, turnId: 'turn', role: 'assistant', llmRound,
    content: ['a', 'b'].map(id => ({
      type: 'tool_use', id: `${entryId}-${id}`, name: 'read_file', input: {},
    })),
  };
}

describe('LLM-call Tool groups', () => {
  it('groups tools in observed call order, not by repeated round numbers', () => {
    const { call, tool, segments } = setup();
    call('first', 0);
    tool('a', 'first');
    tool('b', 'first');
    call('retry', 0);
    tool('c', 'retry');
    const groups = groupConversationSegments(segments());
    expect(groups.map(block => block.segments.map(segment => segment.callId)))
      .toEqual([['a', 'b'], ['c']]);
    expect(groups.map(block => block.group?.round)).toEqual([0, 0]);
    expect(groups[0].group?.id).not.toBe(groups[1].group?.id);
    expect(groups.every(block => block.group?.expanded)).toBe(true);
  });

  it('uses each actual boundary even if a legacy stream has no message identity', () => {
    const { event, tool, segments } = setup();
    event({ type: 'llm_call', round: 0 });
    tool('a');
    event({ type: 'llm_call', round: 0 });
    tool('b');
    expect(groupConversationSegments(segments())).toHaveLength(2);
  });

  it('does not create empty groups for text-only model calls', () => {
    const { call, event, segments } = setup();
    call('message');
    event({ type: 'text_delta', messageId: 'message', text: 'answer' });
    expect(groupConversationSegments(segments())[0].group).toBeUndefined();
  });

  it('does not infer a missed boundary from matching message IDs or a previous call', () => {
    const { call, tool, segments } = setup();
    tool('a', 'missed');
    call('current');
    tool('b', 'different');
    expect(segments().every(segment => segment.toolGroup === undefined)).toBe(true);
  });

  it('does not reuse a completed Turn boundary in later tools or a new Turn', () => {
    const { state, call, event, tool, segments } = setup();
    call('message');
    event({ type: 'run_end' });
    tool('a', 'message');
    expect(segments()[0].toolGroup).toBeUndefined();
    call('next');
    event({ type: 'run_start', turnId: 'another-turn' });
    expect(state.llmCall).toBeNull();
  });

  it('does not let Root and Child tools share a group just because hints match', () => {
    const root = setup();
    const child = setup();
    root.call('same');
    root.tool('root', 'same');
    child.call('same');
    child.tool('child', 'same');
    root.segments()[0].toolGroup!.expanded = false;
    expect(child.segments()[0].toolGroup!.expanded).toBe(true);
    expect(groupConversationSegments(root.segments())[0].segments).toHaveLength(1);
    expect(groupConversationSegments(child.segments())[0].segments).toHaveLength(1);
  });

  it('groups History per marked Assistant entry, never by equal round hints', () => {
    const items = buildHistoryItems([record('first', 0), record('retry', 0)]);
    const groups = items.map(item => groupConversationSegments(item.segments ?? [])[0]);
    expect(groups.map(block => block.segments.map(segment => segment.callId)))
      .toEqual([['first-a', 'first-b'], ['retry-a', 'retry-b']]);
    expect(groups[0].group?.id).not.toBe(groups[1].group?.id);
    expect(groups.every(block => block.group?.expanded)).toBe(true);
    const completed = record('completed', 0);
    expect(buildHistoryItems([{
      ...completed,
      content: completed.content.map(block => ({ ...block, status: 'success' })),
    }])[0].segments![0].toolGroup?.expanded).toBe(false);
  });

  it('does not fabricate LLM groups for unmarked old or synthetic Assistant messages', () => {
    const item = buildHistoryItems([record('legacy')])[0];
    expect(groupConversationSegments(item.segments ?? []).map(block => block.group))
      .toEqual([undefined, undefined]);
  });

  it('adds authoritative History grouping to a midstream overlay without losing results', () => {
    const { state, event, tool } = setup();
    tool('message-a', 'message');
    event({ type: 'tool_result', callId: 'message-a', result: { status: 'success', content: 'done' } });
    const merged = mergeRealtimeWithHistory(buildHistoryItems([record('message', 0)]), state.chatItems);
    const blocks = groupConversationSegments(merged[0].segments ?? []);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].segments.map(segment => segment.callId)).toEqual(['message-a', 'message-b']);
    expect(blocks[0].segments[0]).toMatchObject({ status: 'success', resultContent: 'done' });
  });

  it('preserves one live group and its collapse choice through running and terminal takeover', () => {
    const { state, call, event, tool, segments } = setup();
    call('message');
    tool('message-a', 'message');
    tool('message-b', 'message');
    const group = segments()[0].toolGroup!;
    group.expanded = false;
    const page = { items: [record('message', 0)] };
    beginHistoryRequest(state, 'running', { latest: true });
    applyHistoryPage(state, page);
    let merged = mergeRealtimeWithHistory(state.historyItems, state.chatItems);
    expect(merged[0].segments!.every(segment => segment.toolGroup === group)).toBe(true);
    event({ type: 'tool_result', callId: 'message-a', result: { status: 'success', content: 'done' } });
    expect(group.expanded).toBe(false);
    const completed = {
      items: [{
        ...page.items[0],
        content: page.items[0].content.map(block => ({ ...block, status: 'success' })),
      }],
    };
    beginHistoryRequest(state, 'completed', { latest: true });
    applyHistoryPage(state, completed);
    merged = mergeRealtimeWithHistory(state.historyItems, state.chatItems);
    expect(group.expanded).toBe(false);
    group.expanded = true;
    beginHistoryRequest(state, 'repeated', { latest: true });
    applyHistoryPage(state, completed);
    merged = mergeRealtimeWithHistory(state.historyItems, state.chatItems);
    expect(group.expanded).toBe(true);
    event({ type: 'run_end' });
    beginHistoryRequest(state, 'terminal', { latest: true, terminalTurnId: 'turn' });
    applyHistoryPage(state, completed);
    merged = mergeRealtimeWithHistory(state.historyItems, state.chatItems);
    expect(state.chatItems).toEqual([]);
    expect(merged[0].segments!.every(segment =>
      segment.toolGroup?.id === group.id && segment.toolGroup.expanded === true)).toBe(true);
    expect(groupConversationSegments(merged[0].segments!)).toHaveLength(1);
  });

  it('collapses a group only when all its tools succeed or fail and allows reopening', () => {
    const { call, tool, event, segments } = setup();
    call('message');
    tool('a', 'message');
    tool('b', 'message');
    const group = segments()[0].toolGroup!;
    event({ type: 'tool_use', callId: 'a', executionId: 'execution' });
    event({ type: 'tool_result', callId: 'a', result: { status: 'error', content: 'failed' } });
    expect(group.expanded).toBe(true);
    event({ type: 'tool_result', callId: 'b', result: { status: 'success', content: 'done' } });
    expect(group.expanded).toBe(false);
    group.expanded = true;
    event({ type: 'tool_result', callId: 'b', result: { status: 'success', content: 'done' } });
    event({ type: 'run_end' });
    expect(group.expanded).toBe(true);
  });

  it('keeps text and Thinking in their original positions rather than gathering across them', () => {
    const group = { id: 'group', round: 0, expanded: true };
    const segments: ConversationSegment[] = [
      { id: 'a', type: 'tool_call', toolGroup: group },
      { id: 'text', type: 'text', text: 'between' },
      { id: 'b', type: 'tool_call', toolGroup: group },
      { id: 'thinking', type: 'thinking', text: 'after' },
    ];
    const blocks = groupConversationSegments(segments);
    expect(blocks.flatMap(block => block.segments)).toEqual(segments);
    expect(blocks.map(block => block.group?.id)).toEqual(['group', undefined, 'group', undefined]);
  });

  it.each([-1, 0.5, NaN, Infinity, undefined])('reports invalid call boundary round %s', round => {
    const { event, state } = setup();
    expect(event({ type: 'llm_call', round })).toContainEqual({
      type: 'protocol_error', detail: 'LLM call requires a Turn and a non-negative safe integer round',
    });
    expect(state.llmCall).toBeNull();
  });
});
