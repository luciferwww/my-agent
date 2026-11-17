import type { ConversationItem, PendingApproval } from './conversation';
import {
  applyHistoryPage,
  buildHistoryItems,
  mergeRealtimeWithHistory,
  preserveRealtimePresentationIdentity,
  scopeRootTurnId,
  type HistoryPage,
  type HistorySettlement,
  type SubagentScope,
} from './history';
import { ensureSessionUiState, type SessionUiStateMap } from './session-state';

export function applyExecutionHistoryPage(
  states: SessionUiStateMap,
  sessionId: string,
  page: HistoryPage,
): HistorySettlement {
  const state = ensureSessionUiState(states, sessionId);
  const settlement = applyHistoryPage(state, page);
  const sources = new Set(state.historyRecords.flatMap(record =>
    record.sourceSessionId ? [record.sourceSessionId] : []));
  for (const scope of state.historyScopes) sources.add(scope.sessionId);
  for (const source of sources) {
    const child = ensureSessionUiState(states, source);
    const items = buildHistoryItems(state.historyRecords, source, state.historyScopes);
    const settledScopes = state.historyScopes.filter(scope =>
      scope.sessionId === source
      && settlement.settledTurnIds?.includes(scopeRootTurnId(scope, state.historyScopes)));
    const turnIds = settledScopes.map(scope => scope.turnId);
    preserveRealtimePresentationIdentity(
      items, child.historyItems,
      [...new Set(items.flatMap(item => item.turnId ? [item.turnId] : []))],
    );
    preserveRealtimePresentationIdentity(items, child.chatItems, turnIds);
    child.historyItems = items;
    for (const turnId of turnIds) {
      child.chatItems = child.chatItems.filter(item =>
        item.turnId !== turnId || item.kind === 'system' || item.kind === 'error');
      delete child.turnMap[turnId];
    }
  }
  // Only a terminal ancestor snapshot retires live lifecycle overlays.
  for (const owner of Object.values(states)) {
    for (const scope of Object.values(owner.subagentScopes)) {
      const retained = state.historyScopes.find(candidate => candidate.sessionId === scope.sessionId);
      if (retained && settlement.settledTurnIds?.includes(
        scopeRootTurnId(retained, state.historyScopes),
      )) delete owner.subagentScopes[scope.sessionId];
    }
  }
  return settlement;
}

export interface ExecutionPresentation {
  readonly items: ConversationItem[];
  readonly itemsBySession: Record<string, ConversationItem[]>;
  readonly scopes: SubagentScope[];
}

export function buildExecutionPresentation(
  states: SessionUiStateMap,
  sessionId: string,
  pendingApprovals: ReadonlyMap<string, PendingApproval>,
): ExecutionPresentation {
  const root = states[sessionId];
  if (!root) return { items: [], itemsBySession: {}, scopes: [] };
  const scopes = new Map(root.historyScopes.map(scope => [scope.sessionId, scope]));
  const itemsBySession: Record<string, ConversationItem[]> = {};
  const visit = (source: string): void => {
    if (itemsBySession[source]) return;
    const state = states[source];
    itemsBySession[source] = state
      ? mergeRealtimeWithHistory(state.historyItems, state.chatItems)
      : [];
    for (const scope of Object.values(state?.subagentScopes ?? {})) {
      const retained = scopes.get(scope.sessionId);
      if (retained?.status !== 'terminal') scopes.set(scope.sessionId, scope);
    }
    const childIds = new Set(
      [...scopes.values()]
        .filter(scope => scope.callerSessionId === source)
        .map(scope => scope.sessionId),
    );
    for (const item of itemsBySession[source]) {
      for (const segment of item.segments ?? []) {
        if (segment.subagentSessionId) childIds.add(segment.subagentSessionId);
      }
    }
    for (const child of childIds) visit(child);
  };
  visit(sessionId);
  const items = [...itemsBySession[sessionId]];
  const visible = new Set<string>();
  const inspect = (source: string): void => {
    if (visible.has(source)) return;
    visible.add(source);
    for (const item of itemsBySession[source] ?? []) {
      for (const segment of item.segments ?? []) {
        const scope = [...scopes.values()].find(candidate =>
          candidate.callerSessionId === source
          && candidate.parentTurnId === item.turnId
          && candidate.parentToolUseId === segment.callId);
        if (scope?.status === 'terminal') {
          if (segment.subagentStatus !== 'terminal') segment.subagentExpanded = false;
          segment.subagentSessionId = scope.sessionId;
          segment.subagentStatus = 'terminal';
          segment.subagentOutcome = scope.outcome ?? segment.subagentOutcome;
        }
        const child = scope?.sessionId ?? segment.subagentSessionId;
        if (child) inspect(child);
      }
    }
  };
  inspect(sessionId);
  for (const request of pendingApprovals.values()) {
    if (request.sessionId !== sessionId) continue;
    const attached = [...visible].some(source =>
      itemsBySession[source].some(item =>
        item.turnId === request.turnId && item.segments?.some(segment =>
          segment.type === 'tool_call' && segment.callId === request.callId)));
    if (attached) continue;
    items.push({
      kind: 'turn', id: `pending-${request.id}`, turnId: request.turnId,
      label: 'Approval', timestamp: 0,
      segments: [{
        type: 'approval', id: `pending-${request.id}`,
        approval: { ...request, status: 'pending' }, expanded: true,
      }],
    });
  }
  return { items, itemsBySession, scopes: [...scopes.values()] };
}
