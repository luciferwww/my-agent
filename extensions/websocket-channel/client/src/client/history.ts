import {
  SUPPORTED_IMAGE_MIME,
  base64DecodedSize,
} from '../attachments';
import type {
  ConversationItem,
  ConversationSegment,
  ToolCallGroup,
} from './conversation';
import { isToolGroupComplete, parseTaskSubagentSessionId } from './conversation';

export type HistoryStatus = 'notLoaded' | 'loading' | 'loaded' | 'error';

export interface HistoryRequest {
  readonly requestId: string;
  readonly beforeEntryId: string | null;
  readonly terminalTurnIds: string[];
}

export interface FailedHistoryRequest {
  readonly beforeEntryId: string | null;
  readonly terminalTurnIds: string[];
}

export interface HistoryContentBlock {
  readonly type?: string;
  readonly text?: string;
  readonly id?: string;
  readonly status?: string;
  readonly tool_use_id?: string;
  readonly content?: unknown;
  readonly execution_id?: string;
  readonly name?: string;
  readonly input?: unknown;
  readonly result_content?: unknown;
  readonly source?: {
    readonly type?: string;
    readonly media_type?: string;
    readonly data?: string;
  };
  readonly dimensions?: {
    readonly width?: number;
    readonly height?: number;
  };
}

export interface HistoryRecord {
  readonly entryId?: string;
  readonly messageId?: string;
  readonly llmRound?: number;
  readonly sourceSessionId?: string;
  readonly sourceEntryId?: string;
  readonly turnId?: string;
  readonly role?: string;
  readonly timestamp?: string;
  readonly content?: string | readonly HistoryContentBlock[];
  readonly reasoning?: ConversationItem['reasoning'];
}

export interface SubagentScope {
  readonly sessionId: string;
  readonly turnId: string;
  readonly callerSessionId: string;
  readonly parentTurnId: string;
  readonly parentToolUseId: string;
  readonly subagentType?: string;
  readonly status: 'running' | 'terminal' | 'unknown';
  readonly outcome?: string;
}

export type PresentationSegment = ConversationSegment;
export type PresentationItem = ConversationItem;

export interface HistoryState {
  historyRecords: HistoryRecord[];
  historyItems: PresentationItem[];
  historyScopes?: SubagentScope[];
  historyStatus: HistoryStatus;
  historyError: string;
  historyNextCursor: string | null;
  historyHasMore: boolean;
  pendingHistoryRequest: HistoryRequest | null;
  failedHistoryRequest: FailedHistoryRequest | null;
  pendingLatestHistoryRefresh: boolean;
  pendingLatestHistoryTurnIds: string[];
  chatItems: PresentationItem[];
  turnMap: Record<string, PresentationItem>;
}

export interface HistoryRequestOptions {
  readonly beforeEntryId?: string;
  readonly latest?: boolean;
  readonly terminalTurnId?: string;
  readonly terminalTurnIds?: readonly string[];
}

export interface HistoryPage {
  readonly items?: readonly HistoryRecord[];
  readonly nextCursor?: string | null;
  readonly hasMore?: boolean;
  readonly scopes?: readonly SubagentScope[];
}

export interface HistorySettlement {
  readonly pendingWasEarlier: boolean;
  readonly deferredTerminalTurnIds: string[];
  readonly settledTurnIds?: string[];
  readonly refreshLatest?: boolean;
}

export function scopeRootTurnId(scope: SubagentScope, scopes: readonly SubagentScope[]): string {
  const visited = new Set([scope.sessionId]);
  let current = scope;
  for (;;) {
    const parent = scopes.find(candidate => candidate.sessionId === current.callerSessionId);
    if (!parent) return current.parentTurnId;
    if (visited.has(parent.sessionId)) throw new Error('Cyclic Subagent History scopes');
    visited.add(parent.sessionId);
    current = parent;
  }
}

const TERMINAL_TOOL_STATUSES = new Set(['success', 'error', 'denied', 'aborted']);

function takeFirstMatching<T>(
  items: T[],
  predicate: (item: T) => boolean,
): T | undefined {
  const index = items.findIndex(predicate);
  return index < 0 ? undefined : items.splice(index, 1)[0];
}

function appendUnique(target: string[], values: readonly (string | undefined)[]): string[] {
  for (const value of values) {
    if (value && !target.includes(value)) target.push(value);
  }
  return target;
}

export function beginHistoryRequest(
  state: HistoryState,
  requestId: string,
  options: HistoryRequestOptions = {},
): HistoryRequest | null {
  const terminalTurnIds = appendUnique(
    [],
    options.terminalTurnIds ?? [options.terminalTurnId],
  );
  if (!options.beforeEntryId && state.failedHistoryRequest?.beforeEntryId === null) {
    appendUnique(terminalTurnIds, state.failedHistoryRequest.terminalTurnIds);
  }
  if (state.pendingHistoryRequest) {
    if (options.latest) {
      state.pendingLatestHistoryRefresh = true;
      appendUnique(state.pendingLatestHistoryTurnIds, terminalTurnIds);
    }
    return null;
  }
  const request: HistoryRequest = {
    requestId,
    beforeEntryId: options.beforeEntryId ?? null,
    terminalTurnIds,
  };
  state.pendingHistoryRequest = request;
  state.historyStatus = 'loading';
  state.historyError = '';
  return request;
}

export function historyRetryOptions(
  state: HistoryState,
): HistoryRequestOptions | null {
  const failed = state.failedHistoryRequest;
  if (!failed) return null;
  return {
    ...(failed.beforeEntryId
      ? { beforeEntryId: failed.beforeEntryId }
      : { latest: true }),
    terminalTurnIds: [...failed.terminalTurnIds],
  };
}

export function interruptHistoryRequest(state: HistoryState): void {
  if (state.pendingHistoryRequest) {
    state.failedHistoryRequest = {
      beforeEntryId: state.pendingHistoryRequest.beforeEntryId,
      terminalTurnIds: [...state.pendingHistoryRequest.terminalTurnIds],
    };
  }
  state.pendingHistoryRequest = null;
  state.pendingLatestHistoryRefresh = false;
  state.pendingLatestHistoryTurnIds = [];
  if (state.historyStatus === 'loading') state.historyStatus = 'notLoaded';
}

function settleHistoryRequest(state: HistoryState): string[] {
  state.pendingHistoryRequest = null;
  state.historyStatus = state.historyError ? 'error' : 'loaded';
  if (!state.pendingLatestHistoryRefresh) return [];
  state.pendingLatestHistoryRefresh = false;
  const terminalTurnIds = [...state.pendingLatestHistoryTurnIds];
  state.pendingLatestHistoryTurnIds = [];
  return terminalTurnIds;
}

export function applyHistoryPage(
  state: HistoryState,
  page: HistoryPage,
): HistorySettlement {
  const pending = state.pendingHistoryRequest;
  if (!pending) {
    return { pendingWasEarlier: false, deferredTerminalTurnIds: [] };
  }
  const incoming = Array.isArray(page.items) ? page.items : [];
  const hadHistory = state.historyRecords.length > 0;
  const recordsById = new Map(
    state.historyRecords
      .filter(record => record.entryId)
      .map(record => [record.entryId!, record]),
  );
  for (const record of incoming) {
    if (record.entryId) recordsById.set(record.entryId, record);
  }

  let merged: HistoryRecord[];
  let replacedPersistedWindow = false;
  if (pending.beforeEntryId) {
    merged = [...incoming, ...state.historyRecords];
  } else {
    const firstIncomingId = incoming[0]?.entryId;
    const overlapIndex = firstIncomingId
      ? state.historyRecords.findIndex(record => record.entryId === firstIncomingId)
      : -1;
    merged = overlapIndex >= 0
      ? [...state.historyRecords.slice(0, overlapIndex), ...incoming]
      : [...incoming];
    replacedPersistedWindow = overlapIndex < 0 && hadHistory;
  }

  const seen = new Set<string>();
  state.historyRecords = merged.filter(record => {
    if (!record.entryId || seen.has(record.entryId)) return false;
    seen.add(record.entryId);
    return recordsById.has(record.entryId);
  });
  if (pending.beforeEntryId || !hadHistory || replacedPersistedWindow) {
    state.historyNextCursor = page.nextCursor ?? null;
    state.historyHasMore = page.hasMore === true;
  }

  const incomingTurnIds = new Set(incoming
    .filter(record => !record.sourceSessionId).map(record => record.turnId));
  const retainedTurnIds = new Set(state.historyRecords
    .filter(record => !record.sourceSessionId).map(record => record.turnId));
  const previousScopes = state.historyScopes ?? [];
  const scopes = new Map(previousScopes.filter(scope => {
    const turnId = scopeRootTurnId(scope, previousScopes);
    return retainedTurnIds.has(turnId)
      && (pending.beforeEntryId || !incomingTurnIds.has(turnId));
  }).map(scope => [scope.sessionId, scope]));
  for (const scope of page.scopes ?? []) scopes.set(scope.sessionId, scope);
  state.historyScopes = [...scopes.values()];
  const settledTurnIds = pending.terminalTurnIds.filter(turnId =>
    incoming.some(record => !record.sourceSessionId && record.turnId === turnId)
    && state.historyScopes!.every(scope =>
      scopeRootTurnId(scope, state.historyScopes!) !== turnId || scope.status === 'terminal'));
  const historyItems = buildHistoryItems(state.historyRecords, undefined, state.historyScopes);
  preserveRealtimePresentationIdentity(
    historyItems, state.historyItems,
    [...new Set(historyItems.flatMap(item => item.turnId ? [item.turnId] : []))],
  );
  preserveRealtimePresentationIdentity(historyItems, state.chatItems, settledTurnIds);
  state.historyItems = historyItems;
  for (const turnId of settledTurnIds) {
    state.chatItems = state.chatItems.filter(
      item => item.turnId !== turnId || item.kind === 'system' || item.kind === 'error',
    );
    delete state.turnMap[turnId];
  }
  if (state.failedHistoryRequest?.beforeEntryId === pending.beforeEntryId) {
    state.failedHistoryRequest = null;
  }
  const refreshLatest = state.pendingLatestHistoryRefresh;
  return {
    pendingWasEarlier: Boolean(pending.beforeEntryId),
    deferredTerminalTurnIds: settleHistoryRequest(state),
    settledTurnIds,
    refreshLatest,
  };
}

export function failHistoryRequest(
  state: HistoryState,
  error: string,
): HistorySettlement {
  const pending = state.pendingHistoryRequest;
  if (!pending) {
    return { pendingWasEarlier: false, deferredTerminalTurnIds: [] };
  }
  state.failedHistoryRequest = {
    beforeEntryId: pending.beforeEntryId,
    terminalTurnIds: [...pending.terminalTurnIds],
  };
  state.historyError = error;
  const refreshLatest = state.pendingLatestHistoryRefresh;
  return {
    pendingWasEarlier: Boolean(pending.beforeEntryId),
    deferredTerminalTurnIds: settleHistoryRequest(state),
    refreshLatest,
  };
}

export function buildHistoryItems(
  records: readonly HistoryRecord[],
  sourceSessionId?: string,
  scopes: readonly SubagentScope[] = [],
): PresentationItem[] {
  const items: PresentationItem[] = [];
  const toolCalls = new Map<string, PresentationSegment>();
  const unmatchedResults = new Map<string, { content: string; status?: string }>();
  for (const record of records) {
    if (record.sourceSessionId !== sourceSessionId) continue;
    if (!record.entryId) continue;
    const content = typeof record.content === 'string'
      ? [{ type: 'text', text: record.content }]
      : Array.isArray(record.content) ? record.content : [];
    if (record.role === 'toolResult') {
      for (const block of content) {
        if (block.type !== 'tool_result' || !block.tool_use_id) continue;
        const key = `${record.turnId ?? ''}\0${block.tool_use_id}`;
        const segment = toolCalls.get(key);
        if (segment) {
          segment.status = block.status;
          segment.resultContent = String(block.content ?? '');
          segment.isError = block.status === 'error';
          attachSubagentHandle(segment);
        } else {
          unmatchedResults.set(key, {
            content: String(block.content ?? ''),
            status: block.status,
          });
        }
      }
      continue;
    }
    if (record.role === 'user') {
      const attachments = content
        .filter(block =>
          block.type === 'image'
          && block.source?.type === 'base64'
          && typeof block.source.media_type === 'string'
          && SUPPORTED_IMAGE_MIME.has(block.source.media_type)
          && typeof block.source.data === 'string')
        .map((block, index) => ({
          id: `${record.entryId}-image-${index}`,
          previewUrl: `data:${block.source!.media_type};base64,${block.source!.data}`,
          name: `Image ${index + 1} (${block.dimensions?.width ?? '?'}×${block.dimensions?.height ?? '?'})`,
          sizeBytes: base64DecodedSize(block.source!.data!),
          willResize: false,
        }));
      items.push({
        kind: 'user',
        id: `history-${record.entryId}`,
        entryId: record.entryId,
        ...(record.messageId === undefined ? {} : { messageId: record.messageId }),
        turnId: record.turnId,
        label: 'You',
        timestamp: Date.parse(record.timestamp ?? '') || Date.now(),
        text: content
          .filter(block => block.type === 'text')
          .map(block => block.text)
          .join('\n'),
        attachments,
        reasoning: record.reasoning,
      });
      continue;
    }
    const turn: PresentationItem = {
      kind: 'turn',
      id: `history-${record.entryId}`,
      entryId: record.entryId,
      ...(record.messageId === undefined ? {} : { messageId: record.messageId }),
      turnId: record.turnId,
      label: 'Assistant',
      timestamp: Date.parse(record.timestamp ?? '') || Date.now(),
      segments: [],
    };
    const toolGroup: ToolCallGroup | undefined = record.llmRound === undefined
      ? undefined
      : { id: `llm-${record.entryId}`, round: record.llmRound, expanded: true };
    for (const block of content) {
      if (block.type === 'text') {
        turn.segments!.push({
          type: 'text',
          ...(record.messageId === undefined ? {} : { messageId: record.messageId }),
          id: `${record.entryId}-text-${turn.segments!.length}`,
          text: block.text,
        });
      } else if (block.type === 'thinking' && block.text) {
        turn.segments!.push({
          type: 'thinking',
          ...(record.messageId === undefined ? {} : { messageId: record.messageId }),
          id: block.id ?? `${record.entryId}-thinking-${turn.segments!.length}`,
          thinkingId: block.id,
          text: block.text,
          status: block.status,
          expanded: false,
        });
      } else if (block.type === 'tool_use' && block.id) {
        const key = `${record.turnId ?? ''}\0${block.id}`;
        const unmatched = unmatchedResults.get(key);
        const segment: PresentationSegment = {
          type: 'tool_call',
          ...(toolGroup ? { toolGroup } : {}),
          ...(record.messageId === undefined ? {} : { messageId: record.messageId }),
          id: `${record.entryId}-tool-${block.id}`,
          callId: block.id,
          executionId: block.execution_id,
          name: block.name,
          input: block.input,
          status: block.status ?? unmatched?.status ?? 'running',
          resultContent: block.result_content === undefined
            ? unmatched?.content ?? ''
            : String(block.result_content),
          isError: (block.status ?? unmatched?.status) === 'error',
          expanded: false,
          resultExpanded: false,
        };
        attachSubagentHandle(segment);
        toolCalls.set(key, segment);
        turn.segments!.push(segment);
      }

    }
    items.push(turn);
  }
  for (const item of items) {
    const group = item.segments?.find(segment => segment.toolGroup)?.toolGroup;
    if (group && isToolGroupComplete(item.segments ?? [], group)) group.expanded = false;
    for (const segment of item.segments ?? []) {
      if (segment.type !== 'tool_call') continue;
      const scope = scopes.find(candidate =>
        candidate.parentTurnId === item.turnId
        && candidate.parentToolUseId === segment.callId
        && (sourceSessionId === undefined || candidate.callerSessionId === sourceSessionId));
      if (!scope) continue;
      segment.subagentSessionId = scope.sessionId;
      segment.subagentStatus = scope.status === 'unknown' ? undefined : scope.status;
      segment.subagentOutcome = scope.outcome;
      segment.subagentExpanded = scope.status !== 'terminal';
    }
  }
  return items;
}

function attachSubagentHandle(segment: PresentationSegment): void {
  const sessionId = parseTaskSubagentSessionId(
    segment.name,
    segment.resultContent ?? '',
  );
  if (!sessionId) return;
  segment.subagentSessionId = sessionId;
  segment.subagentStatus = 'terminal';
  segment.subagentExpanded = false;
}

function preservedExpansion(
  current: PresentationSegment,
  previous: PresentationSegment,
): Pick<PresentationSegment,
  'expanded' | 'resultExpanded' | 'subagentExpanded'> {
  return {
    expanded: current.type === 'tool_call'
      && (current.status === 'success' || current.status === 'error')
      && !TERMINAL_TOOL_STATUSES.has(previous.status ?? '')
      ? false : previous.expanded ?? current.expanded,
    resultExpanded: previous.resultExpanded ?? current.resultExpanded,
    subagentExpanded: current.subagentStatus === 'terminal'
      && previous.subagentStatus !== 'terminal'
      ? false : previous.subagentExpanded ?? current.subagentExpanded,
  };
}

export function mergeRealtimeWithHistory(
  historyItems: PresentationItem[],
  chatItems: PresentationItem[],
): PresentationItem[] {
  const users = chatItems.filter(item => item.kind === 'user');
  const segments = chatItems.flatMap(item =>
    item.kind === 'turn' && item.turnId
      ? (item.segments ?? []).map(segment => ({ item, segment }))
      : []);
  const usedUsers = new Set<PresentationItem>();
  const usedSegments = new Set<PresentationSegment>();
  const usedIds = new Set<PresentationItem['id']>();
  const items = historyItems.map(historyItem => {
    if (!historyItem.turnId) return historyItem;
    if (historyItem.kind === 'user') {
      const realtime = takeFirstMatching(users, item =>
        historyItem.messageId
          ? item.messageId === historyItem.messageId
          : !item.messageId
            && item.turnId === historyItem.turnId
            && item.text === historyItem.text
            && (item.attachments?.length ?? item.attachmentSummaries?.length ?? 0)
              === (historyItem.attachments?.length ?? 0));
      if (!realtime) return historyItem;
      usedUsers.add(realtime);
      return historyItem.messageId
        ? { ...realtime, turnId: historyItem.turnId, entryId: historyItem.entryId }
        : realtime;
    }
    if (historyItem.kind !== 'turn') return historyItem;

    const historyGroup = historyItem.segments?.find(segment => segment.toolGroup)?.toolGroup;
    const toolGroup = historyGroup && (segments.find(({ item, segment }) =>
      item.turnId === historyItem.turnId && segment.type === 'tool_call' && segment.toolGroup
      && historyItem.segments?.some(candidate =>
        candidate.type === 'tool_call' && candidate.callId === segment.callId))?.segment.toolGroup
      ?? historyGroup);
    const groupWasComplete = toolGroup && isToolGroupComplete(
      toolGroup === historyGroup ? historyItem.segments ?? [] : segments.map(({ segment }) => segment),
      toolGroup,
    );
    let id = historyItem.id;
    const committedSegments = historyItem.messageId
      ? segments.filter(({ item, segment }) =>
          item.turnId === historyItem.turnId
          && segment.messageId === historyItem.messageId
          && (segment.type === 'text' || segment.type === 'thinking'))
      : [];
    for (const realtime of committedSegments) usedSegments.add(realtime.segment);
    const mergedSegments = (historyItem.segments ?? []).map(historySegment => {
      if (
        historyItem.messageId
        && (historySegment.type === 'text' || historySegment.type === 'thinking')
      ) {
        const realtime = takeFirstMatching(committedSegments, ({ segment }) =>
          segment.type === historySegment.type
          && (segment.type !== 'thinking' || segment.thinkingId === historySegment.thinkingId));
        if (!realtime) return historySegment;
        if (id === historyItem.id && !usedIds.has(realtime.item.id)) id = realtime.item.id;
        return {
          ...historySegment,
          id: realtime.segment.id,
          expanded: realtime.segment.expanded,
        };
      }
      const realtime = takeFirstMatching(segments, ({ item, segment }) => {
        if (item.turnId !== historyItem.turnId || segment.type !== historySegment.type) {
          return false;
        }
        if (segment.type === 'tool_call') {
          return Boolean(segment.callId && segment.callId === historySegment.callId);
        }
        if (segment.type === 'thinking') {
          return Boolean(
            segment.thinkingId && segment.thinkingId === historySegment.thinkingId,
          );
        }
        return segment.type === 'text'
          && !segment.messageId
          && !historySegment.messageId
          && Boolean(historySegment.text)
          && Boolean(segment.text)
          && (segment.text!.startsWith(historySegment.text!)
            || historySegment.text!.startsWith(segment.text!));
      });
      if (!realtime) return historySegment;

      usedSegments.add(realtime.segment);
      if (id === historyItem.id && !usedIds.has(realtime.item.id)) {
        id = realtime.item.id;
      }
      if (historySegment.subagentStatus === 'terminal'
        && realtime.segment.subagentStatus !== 'terminal') {
        realtime.segment.subagentSessionId = historySegment.subagentSessionId;
        realtime.segment.subagentStatus = 'terminal';
        realtime.segment.subagentOutcome = historySegment.subagentOutcome;
        realtime.segment.subagentExpanded = false;
      }
      if (
        (
          historySegment.type === 'tool_call'
          && TERMINAL_TOOL_STATUSES.has(historySegment.status ?? '')
          && !TERMINAL_TOOL_STATUSES.has(realtime.segment.status ?? '')
        )
        || (
          historySegment.type === 'text'
          && (historySegment.text?.length ?? 0) > (realtime.segment.text?.length ?? 0)
        )
      ) {
        const merged = {
          ...historySegment,
          id: realtime.segment.id,
          ...preservedExpansion(historySegment, realtime.segment),
        };
        return historySegment.type === 'tool_call'
          ? Object.assign(realtime.segment, merged) : merged;
      }
      return realtime.segment;
    });
    if (toolGroup) {
      for (const segment of mergedSegments) {
        if (segment.type === 'tool_call') segment.toolGroup = toolGroup;
      }
      if (!groupWasComplete && isToolGroupComplete(mergedSegments, toolGroup)) {
        toolGroup.expanded = false;
      }
    }
    usedIds.add(id);
    return { ...historyItem, id, segments: mergedSegments };
  });

  for (const item of chatItems) {
    if (usedUsers.has(item)) continue;
    if (item.kind !== 'turn') {
      items.push(item);
      continue;
    }
    const remaining = (item.segments ?? []).filter(segment => !usedSegments.has(segment));
    if (remaining.length === (item.segments?.length ?? 0)) {
      items.push(item);
    } else if (remaining.length > 0) {
      const id = usedIds.has(item.id) ? `realtime-${item.id}` : item.id;
      items.push({ ...item, id, segments: remaining });
    }
  }
  return items;
}

export function preserveRealtimePresentationIdentity(
  historyItems: PresentationItem[],
  chatItems: PresentationItem[],
  turnIds: readonly string[],
): void {
  for (const turnId of turnIds) {
    const candidates = chatItems.filter(
      item => item.turnId === turnId && item.kind !== 'system' && item.kind !== 'error',
    );
    const realtimeSegments = candidates.flatMap(item => item.segments ?? []);
    for (const historyItem of historyItems.filter(item => item.turnId === turnId)) {
      const realtimeItem = takeFirstMatching(
        candidates,
        item => item.kind === historyItem.kind
          && (!historyItem.messageId
            || item.messageId === historyItem.messageId
            || item.segments?.some(segment => segment.messageId === historyItem.messageId) === true),
      );
      if (realtimeItem) historyItem.id = realtimeItem.id;

      if (historyItem.kind !== 'turn') continue;
      const group = historyItem.segments?.find(segment => segment.toolGroup)?.toolGroup;
      const previousGroup = group && realtimeSegments.find(segment =>
        segment.toolGroup && historyItem.segments?.some(candidate =>
          candidate.type === 'tool_call' && candidate.callId === segment.callId))?.toolGroup;
      if (group && previousGroup) {
        const newlyComplete = isToolGroupComplete(historyItem.segments ?? [], group)
          && !isToolGroupComplete(realtimeSegments, previousGroup);
        group.id = previousGroup.id;
        group.expanded = newlyComplete ? false : previousGroup.expanded;
      }
      for (const historySegment of historyItem.segments ?? []) {
        const realtimeSegment = takeFirstMatching(
          realtimeSegments,
          segment => segment.type === historySegment.type
            && (segment.type === 'tool_call'
              || !historySegment.messageId || segment.messageId === historySegment.messageId)
            && (segment.type !== 'tool_call' || segment.callId === historySegment.callId)
            && (segment.type !== 'thinking' || segment.thinkingId === historySegment.thinkingId),
        );
        if (realtimeSegment) {
          historySegment.id = realtimeSegment.id;
          Object.assign(historySegment, preservedExpansion(historySegment, realtimeSegment));
        }
      }
    }
  }
}
