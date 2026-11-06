import { describe, expect, it } from 'vitest';
import {
  applyAgentEvent, markApprovalClosed, resolveEventSessionId, syncApprovalCards,
  type AgentEvent, type ConversationItem, type PendingApproval,
} from './conversation';
import { applyExecutionHistoryPage, buildExecutionPresentation } from './execution';
import { beginHistoryRequest, failHistoryRequest, type HistoryRecord, type SubagentScope } from './history';
import { ensureSessionUiState, type SessionUiStateMap } from './session-state';

function scope(sessionId: string, callerSessionId = 'root', callId = sessionId): SubagentScope {
  return {
    sessionId, callerSessionId, turnId: `${sessionId}-turn`,
    parentTurnId: `${callerSessionId}-turn`, parentToolUseId: callId,
    subagentType: 'test', status: 'running',
  };
}

function assistant(
  entryId: string, sourceSessionId: string, content: HistoryRecord['content'],
  messageId = entryId,
): HistoryRecord {
  return {
    entryId, messageId, turnId: `${sourceSessionId}-turn`, role: 'assistant', content,
    ...(sourceSessionId === 'root' ? {} : { sourceSessionId, sourceEntryId: entryId }),
  };
}

function task(id: string) {
  return { type: 'tool_use', id, name: 'task', input: { prompt: id } };
}

function setup() {
  const states: SessionUiStateMap = {};
  const root = ensureSessionUiState(states, 'root');
  const pending = new Map<string, PendingApproval>();
  let id = 0;
  const context = { clientId: 'observer', nextId: () => ++id };
  const event = (event: AgentEvent) =>
    applyAgentEvent(ensureSessionUiState(states, resolveEventSessionId(event, 'root')), event, context);
  const history = (
    items: HistoryRecord[], scopes: SubagentScope[], terminal = false,
    beforeEntryId?: string,
  ) => {
    beginHistoryRequest(root, `history-${++id}`, {
      ...(terminal ? { terminalTurnId: 'root-turn' } : {}),
      ...(beforeEntryId ? { beforeEntryId } : { latest: true }),
    });
    const result = applyExecutionHistoryPage(states, 'root', { items, scopes });
    syncApprovalCards(states, pending);
    return result;
  };
  const view = () => buildExecutionPresentation(states, 'root', pending);
  return { states, root, pending, event, history, view };
}

function texts(items: ConversationItem[]): string[] {
  return items.flatMap(item => (item.segments ?? [])
    .filter(segment => segment.type === 'text').map(segment => segment.text ?? ''));
}

describe('recursive execution presentation', () => {
  it.each(['success', 'error'])('collapses History completion once and preserves reopened %s details', status => {
    const { states, root, history, view } = setup();
    const records = (toolStatus: string) => [
      assistant('parent', 'root', [task('a')]),
      assistant('nested', 'a', [task('b')]),
      assistant('leaf', 'b', [{
        type: 'tool_use', id: 'read', name: 'read_file', input: {}, status: toolStatus,
      }]),
    ];
    history(records('running'), [scope('a'), scope('b', 'a')]);
    states.b.historyItems[0].segments![0].expanded = true;
    const scopes: SubagentScope[] = [
      scope('a'), { ...scope('b', 'a'), status: 'terminal', outcome: status === 'success' ? 'ok' : 'failed' },
    ];
    history(records(status), scopes);
    expect(root.historyItems[0].segments![0].subagentExpanded).toBe(true);
    expect(states.a.historyItems[0].segments![0].subagentExpanded).toBe(false);
    expect(states.b.historyItems[0].segments![0].expanded).toBe(false);

    states.a.historyItems[0].segments![0].subagentExpanded = true;
    states.b.historyItems[0].segments![0].expanded = true;
    history(records(status), scopes);
    expect(view().itemsBySession.a[0].segments![0].subagentExpanded).toBe(true);
    expect(view().itemsBySession.b[0].segments![0].expanded).toBe(true);

    const terminalScopes = scopes.map(candidate => ({ ...candidate, status: 'terminal' as const }));
    history(records(status), terminalScopes, true);
    expect(root.historyItems[0].segments![0].subagentExpanded).toBe(false);
    expect(states.a.historyItems[0].segments![0].subagentExpanded).toBe(true);
    expect(states.b.historyItems[0].segments![0].expanded).toBe(true);

    const fresh = setup();
    fresh.history(records(status), terminalScopes);
    expect(fresh.view().items[0].segments![0].subagentExpanded).toBe(false);
    expect(fresh.view().itemsBySession.a[0].segments![0].subagentExpanded).toBe(false);
    expect(fresh.view().itemsBySession.b[0].segments![0].expanded).toBe(false);
  });

  it('settles missed completion facts from History without refolding manually reopened live cards', () => {
    const { root, states, event, history, view } = setup();
    event({ type: 'tool_call_requested', sessionId: 'root', turnId: 'root-turn', callId: 'a', name: 'task' });
    event({ type: 'subagent_start', ...scope('a') });
    event({
      type: 'tool_call_requested', sessionId: 'a', turnId: 'a-turn',
      callId: 'read', name: 'read_file',
    });
    const tool = states.a.chatItems[0].segments![0];
    tool.expanded = true;
    const records = [
      assistant('parent', 'root', [task('a')]),
      assistant('leaf', 'a', [{
        type: 'tool_use', id: 'read', name: 'read_file', status: 'success', result_content: 'done',
      }]),
    ];
    const scopes: SubagentScope[] = [{ ...scope('a'), status: 'terminal' }];
    history(records, scopes);
    expect(view().items[0].segments![0].subagentExpanded).toBe(false);
    expect(view().itemsBySession.a[0].segments![0].expanded).toBe(false);
    root.chatItems[0].segments![0].subagentExpanded = true;
    tool.expanded = true;
    history(records, scopes);
    expect(view().items[0].segments![0].subagentExpanded).toBe(true);
    expect(view().itemsBySession.a[0].segments![0].expanded).toBe(true);
  });

  it.each(['success', 'error'])('collapses completed %s Tools and only folds a Subagent when it ends', status => {
    const { states, root, event, view } = setup();
    const child = '5cb8b687-f263-4355-9d09-7749064e3319';
    event({ type: 'tool_call_requested', sessionId: 'root', turnId: 'root-turn', callId: 'a', name: 'task' });
    event({ type: 'subagent_start', ...scope(child, 'root', 'a') });
    const parent = root.chatItems[0].segments![0];
    parent.subagentExpanded = true;
    event({
      type: 'tool_call_requested', sessionId: child, turnId: `${child}-turn`,
      callId: 'read', name: 'read_file',
    });
    const tool = states[child].chatItems[0].segments![0];
    tool.expanded = true;
    const result: AgentEvent = {
      type: 'tool_result', sessionId: child, turnId: `${child}-turn`,
      callId: 'read', result: { status, content: 'result' },
    };
    event(result);
    expect(view().itemsBySession[child][0].segments![0].expanded).toBe(false);
    expect(parent.subagentExpanded).toBe(true);

    tool.expanded = true;
    event(result);
    event({ type: 'text_delta', sessionId: child, turnId: `${child}-turn`, text: 'next step' });
    expect(tool.expanded).toBe(true);
    expect(parent.subagentExpanded).toBe(true);

    const end: AgentEvent = {
      type: 'subagent_end', ...scope(child, 'root', 'a'), outcome: status === 'success' ? 'ok' : 'failed',
    };
    event(end);
    expect(view().items[0].segments![0].subagentExpanded).toBe(false);
    parent.subagentExpanded = true;
    event(end);
    event({
      type: 'tool_result', sessionId: 'root', turnId: 'root-turn', callId: 'a',
      result: {
        status, content: `Subagent completed.\nsessionId: ${child}\nResult:\ndone`,
      },
    });
    expect(parent.subagentExpanded).toBe(true);
  });

  it('keeps three task slots in parent order despite interleaved text, Tools and completion', () => {
    const { event, history, view } = setup();
    history([assistant('parent', 'root', [task('a'), task('b'), task('c')])], []);
    for (const child of ['c', 'b', 'a']) {
      event({ type: 'subagent_start', ...scope(child) });
      event({
        type: 'text_delta', sessionId: child, turnId: `${child}-turn`,
        messageId: 'same-message', text: child,
      });
    }
    event({
      type: 'text_delta', sessionId: 'b', turnId: 'b-turn',
      messageId: 'same-message', text: ' tail',
    });
    for (const child of ['a', 'c', 'b']) {
      event({
        type: 'tool_call_requested', sessionId: child, turnId: `${child}-turn`,
        messageId: 'same-message', callId: 'same-call', name: 'read_file', input: { path: child },
      });
    }
    for (const child of ['b', 'a', 'c']) {
      event({
        type: 'tool_result', sessionId: child, turnId: `${child}-turn`,
        callId: 'same-call', result: { status: 'success', content: `${child} result` },
      });
      event({ type: 'subagent_end', ...scope(child), outcome: 'ok' });
    }
    const presentation = view();
    expect(presentation.items.flatMap(item => item.segments ?? []).map(segment => segment.callId))
      .toEqual(['a', 'b', 'c']);
    expect(texts(presentation.itemsBySession.a)).toEqual(['a']);
    expect(texts(presentation.itemsBySession.b)).toEqual(['b tail']);
    expect(texts(presentation.itemsBySession.c)).toEqual(['c']);
    for (const child of ['a', 'b', 'c']) {
      expect(presentation.itemsBySession[child].flatMap(item => item.segments ?? [])
        .filter(segment => segment.type === 'tool_call')).toMatchObject([
        { callId: 'same-call', status: 'success', resultContent: `${child} result` },
      ]);
      expect(presentation.scopes.find(candidate => candidate.sessionId === child))
        .toMatchObject({ status: 'terminal', outcome: 'ok' });
    }
    expect(texts(presentation.items)).toEqual([]);
  });

  it('defers unmatched lifecycle facts until their real parent card arrives', () => {
    const { event, history, view } = setup();
    const effects = event({ type: 'subagent_start', ...scope('a') });
    expect(effects.some(effect => effect.type === 'protocol_error')).toBe(false);
    expect(view().items).toEqual([]);
    history([assistant('parent', 'root', [task('a')])], []);
    expect(view().scopes).toContainEqual(scope('a'));
    expect(view().items[0].segments).toHaveLength(1);
  });

  it('reports an unmatched lifecycle without enough identity instead of inventing a slot', () => {
    const { root, event, view } = setup();
    expect(event({ type: 'subagent_start', sessionId: 'a', turnId: 'a-turn' }))
      .toContainEqual({ type: 'protocol_error', detail: 'subagent_start has no Parent Tool Call ' });
    expect(root.subagentScopes).toEqual({});
    expect(view().items).toEqual([]);
  });

  it('restores three source levels from retained ancestor History without Child APIs', () => {
    const { states, history, view } = setup();
    history([
      assistant('parent', 'root', [task('a')]),
      assistant('a-entry', 'a', [{ type: 'text', text: 'A' }, task('b')]),
      assistant('b-entry', 'b', [
        { type: 'thinking', id: 'thinking', text: 'B thinking', status: 'complete' },
        { type: 'text', text: 'B' },
      ]),
    ], [scope('a'), { ...scope('b', 'a'), status: 'terminal', outcome: 'ok' }]);
    expect(Object.keys(states).sort()).toEqual(['a', 'b', 'root']);
    const presentation = view();
    expect(texts(presentation.items)).toEqual([]);
    expect(texts(presentation.itemsBySession.a)).toEqual(['A']);
    expect(texts(presentation.itemsBySession.b)).toEqual(['B']);
    expect(presentation.scopes.find(candidate => candidate.sessionId === 'b'))
      .toMatchObject({ callerSessionId: 'a', parentToolUseId: 'b' });
    expect(presentation.itemsBySession.b[0].segments?.[0])
      .toMatchObject({ type: 'thinking', text: 'B thinking' });
  });

  it.each([['BC'], ['A', 'C']])('merges source-scoped committed messages with fragments %j', (...fragments) => {
    const { states, event, history, view } = setup();
    for (const source of ['a', 'b']) {
      for (const text of fragments) {
        event({
          type: 'text_delta', sessionId: source, turnId: `${source}-turn`,
          messageId: 'shared', text,
        });
      }
    }
    history([
      assistant('parent', 'root', [task('a'), task('b')]),
      assistant('a-entry', 'a', 'ABC', 'shared'),
    ], [scope('a'), scope('b')]);
    expect(texts(view().itemsBySession.a)).toEqual(['ABC']);
    expect(texts(view().itemsBySession.b)).toEqual([fragments.join('')]);
    expect(states.a.chatItems).toHaveLength(1);
    event({
      type: 'text_delta', sessionId: 'a', turnId: 'a-turn',
      messageId: 'next', text: 'ABC',
    });
    expect(texts(view().itemsBySession.a)).toEqual(['ABC', 'ABC']);
  });

  it('does not let Child run_end terminate its Root or retire running Root contents', () => {
    const { root, states, event, history } = setup();
    event({ type: 'run_start', sessionId: 'root', turnId: 'root-turn' });
    event({ type: 'text_delta', sessionId: 'root', turnId: 'root-turn', text: 'uncommitted' });
    event({ type: 'text_delta', sessionId: 'a', turnId: 'a-turn', text: 'child' });
    event({ type: 'run_end', sessionId: 'a', turnId: 'a-turn' });
    history([assistant('parent', 'root', [task('a')])], [scope('a')]);
    expect(root.activeTurnId).toBe('root-turn');
    expect(root.terminalTurnId).toBeNull();
    expect(root.chatItems).toHaveLength(1);
    expect(states.a.chatItems).toHaveLength(1);
  });

  it.each(['running', 'unknown'] as const)('does not settle Root while a nested scope is %s', status => {
    const { root, states, event, history } = setup();
    event({ type: 'text_delta', sessionId: 'root', turnId: 'root-turn', text: 'root-live' });
    event({ type: 'text_delta', sessionId: 'b', turnId: 'b-turn', text: 'child-live' });
    const result = history([
      assistant('parent', 'root', [task('a')]),
      assistant('a-entry', 'a', [task('b')]),
    ], [{ ...scope('a'), status: 'terminal' }, { ...scope('b', 'a'), status }], true);
    expect(result.settledTurnIds).toEqual([]);
    expect(root.chatItems).toHaveLength(1);
    expect(states.b.chatItems).toHaveLength(1);
  });

  it('takes over the entire terminal tree after a fresh converged snapshot', () => {
    const { states, root, event, history, view } = setup();
    event({ type: 'tool_call_requested', sessionId: 'root', turnId: 'root-turn', callId: 'a', name: 'task' });
    event({ type: 'subagent_start', ...scope('a') });
    event({ type: 'text_delta', sessionId: 'a', turnId: 'a-turn', messageId: 'message', text: 'tail' });
    root.chatItems[0].segments![0].subagentExpanded = false;
    event({ type: 'run_end', sessionId: 'root', turnId: 'root-turn' });
    history([
      assistant('parent', 'root', [task('a')]),
      assistant('a-entry', 'a', 'complete', 'message'),
    ], [{ ...scope('a'), status: 'terminal', outcome: 'ok' }], true);
    expect(root.chatItems).toEqual([]);
    expect(states.a.chatItems).toEqual([]);
    expect(root.subagentScopes).toEqual({});
    expect(view().items[0].segments![0].subagentExpanded).toBe(false);
    expect(texts(view().itemsBySession.a)).toEqual(['complete']);
  });

  it('keeps a pre-terminal pending snapshot separate from the terminal refresh', () => {
    const { states, root, event } = setup();
    event({ type: 'text_delta', sessionId: 'a', turnId: 'a-turn', text: 'tail' });
    beginHistoryRequest(root, 'running', { latest: true });
    beginHistoryRequest(root, '', { latest: true, terminalTurnId: 'root-turn' });
    const page = {
      items: [assistant('parent', 'root', [task('a')]), assistant('a-entry', 'a', 'complete')],
      scopes: [{ ...scope('a'), status: 'terminal' as const }],
    };
    const first = applyExecutionHistoryPage(states, 'root', page);
    expect(first.deferredTerminalTurnIds).toEqual(['root-turn']);
    expect(states.a.chatItems).toHaveLength(1);
    beginHistoryRequest(root, 'terminal', { latest: true, terminalTurnIds: first.deferredTerminalTurnIds });
    applyExecutionHistoryPage(states, 'root', page);
    expect(states.a.chatItems).toEqual([]);
  });

  it.each(['success', 'error'])('drains queued nonterminal refreshes after History %s', outcome => {
    const { states, root } = setup();
    beginHistoryRequest(root, 'older-snapshot', { latest: true });
    expect(beginHistoryRequest(root, '', { latest: true })).toBeNull();
    const result = outcome === 'success'
      ? applyExecutionHistoryPage(states, 'root', {
          items: [assistant('parent', 'root', [task('a')])], scopes: [scope('a')],
        })
      : failHistoryRequest(root, 'temporary History failure');
    expect(result.refreshLatest).toBe(true);
    expect(result.deferredTerminalTurnIds).toEqual([]);
    beginHistoryRequest(root, 'fresh-snapshot', { latest: true });
    const fresh = applyExecutionHistoryPage(states, 'root', {
      items: [
        assistant('parent', 'root', [task('a')]),
        assistant('a-entry', 'a', 'committed while request was pending'),
      ],
      scopes: [{ ...scope('a'), status: 'terminal' }],
    });
    expect(fresh.refreshLatest).toBe(false);
    expect(texts(states.a.historyItems)).toEqual(['committed while request was pending']);
  });

  it('keeps earlier complete Turn scopes when the latest page is refreshed', () => {
    const { history, view } = setup();
    history([assistant('current', 'root', [task('a')])], [scope('a')]);
    history([
      { ...assistant('earlier', 'root', [task('old')]), turnId: 'earlier-turn' },
      assistant('old-entry', 'old', 'older child'),
    ], [{ ...scope('old'), parentTurnId: 'earlier-turn', status: 'terminal' }], false, 'current');
    history([assistant('current', 'root', [task('a')])], [scope('a')]);
    expect(view().scopes.map(candidate => candidate.sessionId).sort()).toEqual(['a', 'old']);
    expect(texts(view().itemsBySession.old)).toEqual(['older child']);
    expect(view().items.map(item => item.entryId)).toEqual(['earlier', 'current']);
  });

  it('does not retain an invalidated latest-window scope or guess one from identical text', () => {
    const { history, view } = setup();
    history([
      assistant('old-parent', 'root', [task('a')]),
      assistant('a-entry', 'a', 'same'),
    ], [scope('a')]);
    history([assistant('replacement', 'root', 'same')], []);
    expect(view().scopes).toEqual([]);
    expect(view().itemsBySession.a).toBeUndefined();
    expect(texts(view().items)).toEqual(['same']);
  });

  it('retains explicit expansion choices through running and terminal History refreshes', () => {
    const { states, root, history } = setup();
    const records = [
      assistant('parent', 'root', [task('a')]),
      assistant('a-entry', 'a', [task('b')]),
    ];
    history(records, [scope('a'), scope('b', 'a')]);
    root.historyItems[0].segments![0].subagentExpanded = false;
    states.a.historyItems[0].segments![0].subagentExpanded = false;
    history(records, [scope('a'), scope('b', 'a')]);
    history(records, [
      { ...scope('a'), status: 'terminal' },
      { ...scope('b', 'a'), status: 'terminal' },
    ], true);
    expect(root.historyItems[0].segments![0].subagentExpanded).toBe(false);
    expect(states.a.historyItems[0].segments![0].subagentExpanded).toBe(false);
  });

  it('matches Tool results within their source and Turn rather than globally by callId', () => {
    const { history, view } = setup();
    history([
      assistant('parent', 'root', [task('a'), task('b')]),
      assistant('a-entry', 'a', [{ type: 'tool_use', id: 'shared', name: 'read_file' }]),
      assistant('b-entry', 'b', [{ type: 'tool_use', id: 'shared', name: 'read_file' }]),
      { ...assistant('a-result', 'a', [{ type: 'tool_result', tool_use_id: 'shared', content: 'A', status: 'success' }]),
        role: 'toolResult' },
      { ...assistant('b-result', 'b', [{ type: 'tool_result', tool_use_id: 'shared', content: 'B', status: 'error' }]),
        role: 'toolResult' },
      { ...assistant('a-earlier', 'a', [{ type: 'tool_use', id: 'shared', name: 'read_file' }]),
        turnId: 'earlier-child-turn' },
    ], [scope('a'), scope('b')]);
    expect(view().itemsBySession.a[0].segments![0])
      .toMatchObject({ resultContent: 'A', status: 'success' });
    expect(view().itemsBySession.b[0].segments![0])
      .toMatchObject({ resultContent: 'B', status: 'error' });
    expect(view().itemsBySession.a[1].segments![0].resultContent).toBe('');
  });

  it('moves a Root-addressed pending approval onto the exact nested Tool without duplication', () => {
    const { states, root, pending, event, history, view } = setup();
    const request = {
      id: 'approval', sessionId: 'root', turnId: 'b-turn', callId: 'read',
      toolName: 'read_file', input: { path: 'example' },
    };
    pending.set(request.id, request);
    expect(view().items[0].segments?.[0].type).toBe('approval');
    history([
      assistant('parent', 'root', [task('a')]),
      assistant('a-entry', 'a', [task('b')]),
      assistant('b-entry', 'b', [{ type: 'tool_use', id: 'read', name: 'read_file', input: {} }]),
    ], [scope('a'), scope('b', 'a')]);
    expect(view().items.some(item => item.id === 'pending-approval')).toBe(false);
    expect(view().itemsBySession.b[0].segments![0].approval)
      .toMatchObject({ id: request.id, status: 'pending', input: request.input });
    expect(root.historyItems[0].segments![0].approval).toBeUndefined();
    pending.delete(request.id);
    markApprovalClosed(states.b, request.id, 'denied', 'user', 'b-turn', 'read');
    syncApprovalCards(states, pending);
    expect(view().itemsBySession.b[0].segments![0].approval?.status).toBe('denied');
    event({
      type: 'tool_result', sessionId: 'b', turnId: 'b-turn', callId: 'read',
      executionId: 'execution', result: { status: 'denied', content: 'denied' },
    });
    expect(view().itemsBySession.b[0].segments![0])
      .toMatchObject({ status: 'denied', resultContent: 'denied' });
  });

  it('keeps unmatched approvals actionable and never activates closed historical requests', () => {
    const { pending, history, view } = setup();
    history([assistant('parent', 'root', [task('a')])], [scope('a')]);
    pending.set('unmatched', {
      id: 'unmatched', sessionId: 'root', turnId: 'not-loaded', callId: 'missing',
      toolName: 'write_file', input: {},
    });
    pending.set('unrelated', {
      id: 'unrelated', sessionId: 'other', turnId: 'other-turn', callId: 'other',
      toolName: 'read_file', input: {},
    });
    expect(view().items.filter(item => item.label === 'Approval')).toHaveLength(1);
    pending.clear();
    expect(view().items.filter(item => item.label === 'Approval')).toHaveLength(0);
    expect(view().items[0].segments![0].approval).toBeUndefined();
  });

  it.each([
    ['approved', 'resolved', 'requested'],
    ['denied', 'denied', 'denied'],
    ['aborted', 'aborted', 'aborted'],
    ['unavailable', 'unavailable', 'approval_unavailable'],
    ['failed', 'failed', 'error'],
  ])('closes nested approval %s without leaving an awaiting-decision badge', (outcome, approvalStatus, toolStatus) => {
    const { states, pending, history, view } = setup();
    pending.set('approval', {
      id: 'approval', sessionId: 'root', turnId: 'a-turn',
      callId: 'read', toolName: 'read_file', input: {},
    });
    history([
      assistant('parent', 'root', [task('a')]),
      assistant('a-entry', 'a', [{ type: 'tool_use', id: 'read', name: 'read_file' }]),
    ], [scope('a')]);
    pending.clear();
    markApprovalClosed(states.a, 'approval', outcome, 'user', 'a-turn', 'read');
    syncApprovalCards(states, pending);
    expect(view().itemsBySession.a[0].segments![0])
      .toMatchObject({ status: toolStatus, approval: { status: approvalStatus } });
  });

  it('renders every retained item of a complete Turn larger than the request maximum', () => {
    const { root, history, view } = setup();
    history([
      assistant('parent', 'root', [task('a')]),
      ...Array.from({ length: 104 }, (_, index) =>
        assistant(`child-${index}`, 'a', `item-${index}`)),
    ], [{ ...scope('a'), status: 'terminal' }], true);
    expect(root.historyRecords).toHaveLength(105);
    expect(view().itemsBySession.a).toHaveLength(104);
    expect(texts(view().itemsBySession.a)[103]).toBe('item-103');
  });
});
