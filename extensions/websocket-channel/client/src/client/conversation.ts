const TOOL_RESULT_PREVIEW_HEAD_LINES = 6;
const TOOL_RESULT_PREVIEW_TAIL_LINES = 4;

export interface ConversationSegment {
  id: string | number;
  type: string;
  text?: string;
  status?: string;
  expanded?: boolean;
  resultExpanded?: boolean;
  resultContent?: string;
  input?: unknown;
  name?: string;
  callId?: string;
  thinkingId?: string;
  executionId?: string;
  isError?: boolean;
  subagentSessionId?: string;
  subagentStatus?: 'running' | 'terminal';
  subagentOutcome?: string;
  approval?: {
    id: string;
    toolName: string;
    status: string;
    input: unknown;
    closeReason?: string;
  };
}

export interface ConversationItem {
  id: string | number;
  kind: string;
  label: string;
  timestamp: number;
  entryId?: string;
  turnId?: string | null;
  text?: string;
  isSteer?: boolean;
  isContinuation?: boolean;
  interrupted?: boolean;
  messageId?: string;
  segments?: ConversationSegment[];
  attachments?: Array<{
    id: string | number;
    previewUrl: string;
    name: string;
    sizeBytes: number;
    willResize: boolean;
  }>;
  attachmentSummaries?: Array<{
    type: string;
    mime?: string;
    bytes?: number;
  }>;
  reasoning?: {
    thinking?: string;
    effort?: string;
  };
}

export interface ConversationState {
  chatItems: ConversationItem[];
  turnMap: Record<string, ConversationItem>;
  activeTurnId: string | null;
  isSending: boolean;
}

export interface ConversationPresentationState extends ConversationState {
  historyItems: ConversationItem[];
}

export interface PendingApproval {
  readonly id: string;
  readonly sessionId: string;
  readonly turnId: string;
  readonly callId: string;
  readonly toolName: string;
  readonly input: unknown;
}

export interface AgentEvent {
  readonly type?: string;
  readonly turnId?: string;
  readonly callerSessionId?: string;
  readonly sessionId?: string;
  readonly originMessageId?: string;
  readonly originClientId?: string;
  readonly messageId?: string;
  readonly binding?: string;
  readonly text?: string;
  readonly content?: string;
  readonly thinkingId?: string;
  readonly status?: string;
  readonly callId?: string;
  readonly executionId?: string;
  readonly name?: string;
  readonly input?: unknown;
  readonly round?: number;
  readonly requestId?: string;
  readonly reason?: string;
  readonly error?: string;
  readonly category?: string;
  readonly trigger?: string;
  readonly estimatedTokens?: number;
  readonly tokensBefore?: number;
  readonly tokensAfter?: number;
  readonly droppedMessages?: number;
  readonly toolUseId?: string;
  readonly parentTurnId?: string;
  readonly parentToolUseId?: string;
  readonly outcome?: string;
  readonly subagentType?: string;
  readonly originalChars?: number;
  readonly prunedChars?: number;
  readonly attachmentSummaries?: ConversationItem['attachmentSummaries'];
  readonly reasoning?: ConversationItem['reasoning'];
  readonly result?: {
    readonly status?: string;
    readonly content?: unknown;
    readonly stopReason?: string;
  };
}

export interface ConversationEffect {
  readonly type:
    | 'event'
    | 'protocol_error'
    | 'scroll'
    | 'sync_approvals'
    | 'refresh_history'
    | 'refresh_model_catalog';
  readonly title?: string;
  readonly detail?: string;
  readonly turnId?: string;
}

export interface ConversationContext {
  readonly clientId: string;
  readonly nextId: () => number;
  readonly now?: () => number;
}

export function resolveEventSessionId(
  event: AgentEvent,
  focusedSessionId: string,
): string {
  if (event.type === 'subagent_start' || event.type === 'subagent_end') {
    return event.callerSessionId || focusedSessionId;
  }
  return event.sessionId || event.callerSessionId || focusedSessionId;
}

export function appendConversationItem(
  state: ConversationState,
  fields: Partial<ConversationItem> & { kind: string; label: string },
  context: Pick<ConversationContext, 'nextId' | 'now'>,
): ConversationItem {
  if (fields.kind === 'user') clearTransientChatItems(state);
  const item: ConversationItem = {
    id: context.nextId(),
    timestamp: (context.now ?? Date.now)(),
    text: '',
    turnId: null,
    ...fields,
  };
  state.chatItems.push(item);
  return item;
}

export function applyAgentEvent(
  state: ConversationState,
  event: AgentEvent,
  context: ConversationContext,
): ConversationEffect[] {
  const effects: ConversationEffect[] = [];
  const pushEvent = (title: string, detail: string): void => {
    effects.push({ type: 'event', title, detail });
  };
  const protocolError = (detail: string): void => {
    effects.push({ type: 'protocol_error', detail });
  };
  const scroll = (): void => { effects.push({ type: 'scroll' }); };
  const now = context.now ?? Date.now;

  switch (event.type) {
    case 'run_start':
      clearTransientChatItems(state);
      state.isSending = false;
      state.activeTurnId = event.turnId ?? null;
      if (event.originMessageId) {
        const userItem = state.chatItems.find(
          item => item.kind === 'user' && item.messageId === event.originMessageId,
        );
        if (userItem) userItem.turnId = event.turnId;
      }

      pushEvent('run_start', `Turn ${event.turnId} started`);
      break;

    case 'text_delta':
      bindActiveTurn(state, event.turnId);
      collapseCompletedThinking(state, event.turnId);
      appendTextToTurn(state, event.turnId, event.text ?? '', context.nextId, now);
      scroll();
      break;

    case 'thinking_start': {
      bindActiveTurn(state, event.turnId);
      const turn = getOrCreateTurn(state, event.turnId, context.nextId, now);
      if (turn.segments!.some(segment => segment.thinkingId === event.thinkingId)) {
        protocolError(`Duplicate Thinking ${event.thinkingId}`);
        break;
      }
      turn.segments!.push({
        type: 'thinking',
        id: event.thinkingId ?? context.nextId(),
        thinkingId: event.thinkingId,
        text: '',
        status: 'running',
        expanded: true,
      });
      scroll();
      break;
    }

    case 'thinking_delta': {
      const segment = findThinking(state, event.turnId, event.thinkingId);
      if (!segment) {
        protocolError(`Thinking delta has no start ${event.thinkingId}`);
        break;
      }
      segment.text = `${segment.text ?? ''}${event.text ?? ''}`;
      scroll();
      break;
    }

    case 'thinking_end': {
      const turn = getOrCreateTurn(state, event.turnId, context.nextId, now);
      const segment = findThinking(state, event.turnId, event.thinkingId);
      if (!segment) {
        protocolError(`Thinking end has no start ${event.thinkingId}`);
        break;
      }
      if (!event.text) {
        turn.segments = turn.segments!.filter(candidate => candidate !== segment);
      } else {
        segment.text = event.text;
        segment.status = event.status;
      }
      scroll();
      break;
    }

    case 'tool_call_requested': {
      bindActiveTurn(state, event.turnId);
      collapseCompletedThinking(state, event.turnId);
      const turn = getOrCreateTurn(state, event.turnId, context.nextId, now);
      turn.segments!.push({
        type: 'tool_call',
        id: context.nextId(),
        callId: event.callId,
        name: event.name,
        input: event.input,
        status: 'requested',
        resultContent: '',
        isError: false,
        expanded: false,
        resultExpanded: false,
      });
      effects.push({ type: 'sync_approvals' });
      pushEvent('tool_call_requested', event.name ?? '');
      scroll();
      break;
    }

    case 'tool_use': {
      bindActiveTurn(state, event.turnId);
      const toolCall = findToolCall(state, event.turnId, event.callId);
      if (!toolCall) {
        protocolError(
          `Accepted execution ${event.executionId} has no Tool Call ${event.callId}`,
        );
        break;
      }
      toolCall.executionId = event.executionId;
      toolCall.status = 'running';
      if (toolCall.approval) toolCall.approval.status = 'resolved';
      pushEvent('tool_use', event.name ?? '');
      scroll();
      break;
    }

    case 'tool_result': {
      clearTransientChatItems(state);
      bindActiveTurn(state, event.turnId);
      const toolCall = findToolCall(state, event.turnId, event.callId);
      if (!toolCall) {
        protocolError(`Tool Result has no Tool Call ${event.callId}`);
        break;
      }
      toolCall.status = event.result?.status;
      toolCall.resultContent = normalizeToolResultContent(event.result?.content);
      toolCall.isError = event.result?.status === 'error';
      const subagentSessionId = parseTaskSubagentSessionId(
        toolCall.name,
        toolCall.resultContent,
      );
      if (subagentSessionId) {
        toolCall.subagentSessionId = subagentSessionId;
        toolCall.subagentStatus = 'terminal';
      }
      if (event.executionId) toolCall.executionId = event.executionId;
      if (toolCall.approval) toolCall.approval.status = 'resolved';
      scroll();
      break;
    }

    case 'subagent_start':
    case 'subagent_end': {
      const toolCall = findToolCall(state, event.parentTurnId, event.parentToolUseId);
      if (!toolCall || !event.sessionId) {
        protocolError(
          `${event.type} has no Parent Tool Call ${event.parentToolUseId ?? ''}`,
        );
        break;
      }
      toolCall.subagentSessionId = event.sessionId;
      toolCall.subagentStatus = event.type === 'subagent_start' ? 'running' : 'terminal';
      if (event.type === 'subagent_end') toolCall.subagentOutcome = event.outcome;
      pushEvent(
        event.type,
        `${event.subagentType ?? 'Subagent'} ${event.sessionId}`,
      );
      scroll();
      break;
    }

    case 'llm_call':
      bindActiveTurn(state, event.turnId);
      pushEvent('llm_call', `Round ${event.round} for turn ${event.turnId}`);
      break;

    case 'run_end': {
      closeActiveThinking(state, event.turnId);
      if (state.activeTurnId === event.turnId) state.activeTurnId = null;
      effects.push({ type: 'refresh_history', turnId: event.turnId });
      if (event.result?.stopReason === 'aborted') {
        appendConversationItem(state, {
          kind: 'system',
          label: 'Aborted',
          turnId: event.turnId,
          text: '⚠ Turn aborted',
        }, context);
        pushEvent('run_end', `Turn ${event.turnId} aborted`);
      } else if (event.result?.stopReason === 'max_llm_calls') {
        appendConversationItem(state, {
          kind: 'system',
          label: 'Limit reached',
          turnId: event.turnId,
          text: 'Configured model call limit reached',
        }, context);
        pushEvent('run_end', `Turn ${event.turnId} reached the configured model call limit`);
      } else {
        pushEvent('run_end', `Turn ${event.turnId} finished with ${event.result?.stopReason}`);
      }
      break;
    }

    case 'request_end':
      state.isSending = false;
      appendConversationItem(state, {
        kind: 'system',
        label: 'Cancelled',
        text: event.reason === 'shutdown'
          ? 'Queued request cancelled during shutdown'
          : 'Queued request cancelled',
      }, context);
      pushEvent('request_end', `Request ${event.requestId} cancelled`);
      break;

    case 'error':
      closeActiveThinking(state, event.turnId);
      if (state.activeTurnId === event.turnId) state.activeTurnId = null;
      if (!event.turnId || !state.activeTurnId) state.isSending = false;
      appendConversationItem(state, {
        kind: 'error',
        label: 'Runtime',
        turnId: event.turnId,
        text: event.error || 'Unknown runtime error',
      }, context);
      if (event.category === 'provider_unregistered' || event.category === 'model_rejected') {
        effects.push({ type: 'refresh_model_catalog' });
      }
      pushEvent(
        'error',
        `Turn ${event.turnId} failed${event.category ? ` (${event.category})` : ''}`,
      );
      effects.push({ type: 'refresh_history', turnId: event.turnId });
      break;

    case 'compaction_start':
      appendConversationItem(state, {
        kind: 'system',
        label: 'Compaction',
        turnId: event.turnId,
        text: `Compaction started (${event.trigger}), tokens before: ${event.estimatedTokens}`,
      }, context);
      break;

    case 'compaction_end':
      appendConversationItem(state, {
        kind: 'system',
        label: 'Compaction',
        turnId: event.turnId,
        text: `Compaction finished: ${event.tokensBefore} → ${event.tokensAfter}, dropped ${event.droppedMessages} messages`,
      }, context);
      break;

    case 'tool_result_pruned':
      pushEvent(
        'tool_result_pruned',
        `${event.toolUseId}: ${event.originalChars} → ${event.prunedChars}`,
      );
      break;

    case 'user_message': {
      if (event.originClientId === context.clientId) {
        state.isSending = false;
        const pendingLocal = state.chatItems.find(
          item => item.kind === 'user' && !item.messageId,
        );
        if (pendingLocal) pendingLocal.messageId = event.messageId;
        break;
      }
      const label = event.originClientId
        ? `user @${event.originClientId.slice(0, 6)}`
        : 'user (external)';
      appendConversationItem(state, {
        kind: 'user',
        label,
        text: event.content ?? '',
        isSteer: false,
        messageId: event.messageId,
        turnId: null,
        attachmentSummaries: event.attachmentSummaries ?? [],
        reasoning: event.reasoning,
      }, context);
      break;
    }

    case 'user_message_bound': {
      const userItem = state.chatItems.find(
        item => item.kind === 'user' && item.messageId === event.messageId,
      );
      if (userItem) {
        userItem.turnId = event.turnId;
        userItem.isSteer = event.binding === 'steering';
      }
      break;
    }

    default:
      pushEvent('event', `Unhandled event: ${event.type || 'unknown'}`);
  }
  return effects;
}

export function syncApprovalCards(
  sessionStates: Record<string, ConversationPresentationState>,
  pendingApprovals: ReadonlyMap<string, PendingApproval>,
): void {
  for (const [sessionId, state] of Object.entries(sessionStates)) {
    for (const item of [...state.historyItems, ...state.chatItems]) {
      if (item.kind !== 'turn') continue;
      for (const segment of item.segments ?? []) {
        if (segment.type !== 'tool_call') continue;
        const request = [...pendingApprovals.values()].find(candidate =>
          candidate.sessionId === sessionId
          && candidate.turnId === item.turnId
          && candidate.callId === segment.callId);
        const completed = segment.executionId
          || ['success', 'error', 'denied', 'aborted'].includes(segment.status ?? '');
        if (request && !completed) {
          segment.input = request.input;
          segment.status = 'approval';
          segment.approval = { ...request, status: 'pending' };
        } else if (segment.approval?.status === 'pending') {
          segment.approval.status = 'resolved';
          if (segment.status === 'approval') segment.status = 'requested';
        }
      }
    }
  }
}

export function markApprovalClosed(
  state: ConversationPresentationState,
  approvalId: string,
  outcome: string,
  reason: string | undefined,
  turnId: string,
  callId: string,
): void {
  for (const item of [...state.historyItems, ...state.chatItems]) {
    if (item.kind !== 'turn' || item.turnId !== turnId) continue;
    const segment = item.segments?.find(
      candidate => candidate.callId === callId && candidate.approval?.id === approvalId,
    );
    if (!segment?.approval) continue;
    segment.approval.status = outcome;
    segment.approval.closeReason = reason;
  }
}

function clearTransientChatItems(state: ConversationState): void {
  state.chatItems = state.chatItems.filter(
    item => item.kind !== 'system' && item.kind !== 'error',
  );
}

function bindActiveTurn(state: ConversationState, turnId: string | undefined): void {
  if (!turnId) return;
  for (const item of state.chatItems) {
    if (item.kind === 'user' && item.isSteer && item.messageId && !item.turnId) {
      item.turnId = turnId;
    }
  }
}

function getOrCreateTurn(
  state: ConversationState,
  turnId: string | undefined,
  nextId: () => number,
  now: () => number,
): ConversationItem {
  const resolvedTurnId = turnId ?? '';
  clearTransientChatItems(state);
  bindActiveTurn(state, resolvedTurnId);
  const existing = state.turnMap[resolvedTurnId];
  if (existing) {
    const lastItem = state.chatItems[state.chatItems.length - 1];
    if (lastItem === existing) return existing;
    existing.interrupted = true;
    const continuation: ConversationItem = {
      kind: 'turn',
      id: nextId(),
      turnId: resolvedTurnId,
      label: 'Assistant',
      timestamp: now(),
      segments: [],
      isContinuation: true,
    };
    state.chatItems.push(continuation);
    state.turnMap[resolvedTurnId] = continuation;
    return continuation;
  }
  const turn: ConversationItem = {
    kind: 'turn',
    id: nextId(),
    turnId: resolvedTurnId,
    label: 'Assistant',
    timestamp: now(),
    segments: [],
  };
  state.chatItems.push(turn);
  state.turnMap[resolvedTurnId] = turn;
  return turn;
}

function appendTextToTurn(
  state: ConversationState,
  turnId: string | undefined,
  delta: string,
  nextId: () => number,
  now: () => number,
): void {
  const turn = getOrCreateTurn(state, turnId, nextId, now);
  const last = turn.segments![turn.segments!.length - 1];
  if (last?.type === 'text') {
    last.text = `${last.text ?? ''}${delta}`;
  } else {
    turn.segments!.push({ type: 'text', id: nextId(), text: delta });
  }
  turn.timestamp = now();
}

function findThinking(
  state: ConversationState,
  turnId: string | undefined,
  thinkingId: string | undefined,
): ConversationSegment | null {
  for (let index = state.chatItems.length - 1; index >= 0; index -= 1) {
    const item = state.chatItems[index];
    if (item.kind !== 'turn' || item.turnId !== turnId) continue;
    const segment = item.segments?.find(
      candidate => candidate.type === 'thinking' && candidate.thinkingId === thinkingId,
    );
    if (segment) return segment;
  }
  return null;
}

function collapseCompletedThinking(
  state: ConversationState,
  turnId: string | undefined,
): void {
  for (const item of state.chatItems) {
    if (item.kind !== 'turn' || item.turnId !== turnId) continue;
    for (const segment of item.segments ?? []) {
      if (segment.type === 'thinking' && segment.status !== 'running') {
        segment.expanded = false;
      }
    }
  }
}

function closeActiveThinking(
  state: ConversationState,
  turnId: string | undefined,
): void {
  for (const item of state.chatItems) {
    if (item.kind !== 'turn' || item.turnId !== turnId) continue;
    for (const segment of item.segments ?? []) {
      if (segment.type === 'thinking' && segment.status === 'running') {
        segment.status = 'partial';
      }
    }
  }
}

function findToolCall(
  state: ConversationState,
  turnId: string | undefined,
  callId: string | undefined,
): ConversationSegment | null {
  for (let index = state.chatItems.length - 1; index >= 0; index -= 1) {
    const item = state.chatItems[index];
    if (item.kind !== 'turn' || item.turnId !== turnId) continue;
    const matches = (item.segments ?? []).filter(
      segment => segment.type === 'tool_call' && segment.callId === callId,
    );
    if (matches.length === 1) return matches[0];
    if (matches.length > 1) return null;
  }
  return null;
}

function normalizeToolResultContent(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'object') return prettyJson(value);
  return String(value);
}

export function parseTaskSubagentSessionId(
  toolName: string | undefined,
  content: string,
): string | null {
  if (toolName !== 'task') return null;
  const match = /^Subagent completed\.\r?\nsessionId: ([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\r?\nResult:\r?\n/i
    .exec(content);
  return match?.[1]?.toLowerCase() ?? null;
}

export function itemRoleClass(item: ConversationItem): string {
  if (item.kind === 'user') return 'user';
  if (item.kind === 'error') return 'error';
  if (item.kind === 'system') return 'system';
  return 'assistant';
}

export function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

export function formatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

export function prettyJson(value: unknown): string {
  return stringifySafely(value, 2);
}

export function stringifySafely(value: unknown, space?: number): string {
  try {
    return JSON.stringify(value, null, space);
  } catch {
    return String(value);
  }
}

export function toolInputSummary(input: unknown): string {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return '';
  const entries = Object.entries(input).slice(0, 3);
  const summary = entries
    .map(([key, value]) => `${key}=${singleLineValue(value)}`)
    .join(', ');
  return Object.keys(input).length > entries.length ? `${summary}, …` : summary;
}

export function segmentResultPreview(segment: ConversationSegment): {
  readonly text: string;
  readonly omittedCount: number;
} {
  const lines = String(segment.resultContent || '').split('\n');
  const lineNumberWidth = String(lines.length).length;
  const previewLineCount = TOOL_RESULT_PREVIEW_HEAD_LINES + TOOL_RESULT_PREVIEW_TAIL_LINES;
  if (lines.length <= previewLineCount) {
    return {
      text: lines.map((line, index) =>
        formatLine(index + 1, line, lineNumberWidth)).join('\n'),
      omittedCount: 0,
    };
  }
  const head = lines.slice(0, TOOL_RESULT_PREVIEW_HEAD_LINES)
    .map((line, index) => formatLine(index + 1, line, lineNumberWidth));
  const tailStart = lines.length - TOOL_RESULT_PREVIEW_TAIL_LINES + 1;
  const tail = lines.slice(-TOOL_RESULT_PREVIEW_TAIL_LINES)
    .map((line, index) => formatLine(tailStart + index, line, lineNumberWidth));
  const omittedCount = lines.length - previewLineCount;
  return {
    text: [...head, `...  ${omittedCount} more lines`, ...tail].join('\n'),
    omittedCount,
  };
}

export function toolStatusLabel(status: string | undefined): string {
  switch (status) {
    case 'requested': return 'Requested';
    case 'approval': return 'Approval required';
    case 'approval_unavailable': return 'Approval unavailable';
    case 'running': return 'Running';
    case 'success': return 'Succeeded';
    case 'error': return 'Failed';
    case 'denied': return 'Denied';
    case 'aborted': return 'Aborted';
    default: return String(status || 'Unknown');
  }
}

export function approvalStatusClass(status: string): string {
  return status === 'resolved' ? 'allowed' : status;
}

export function approvalStatusLabel(status: string): string {
  switch (status) {
    case 'pending': return 'Awaiting decision';
    case 'resolved': return 'Allowed';
    case 'denied': return 'Denied';
    case 'aborted': return 'Turn stopped';
    case 'unavailable': return 'Approval unavailable';
    case 'failed': return 'Approval failed';
    default: return status;
  }
}

export function formatReasoningSummary(
  preference: ConversationItem['reasoning'],
): string {
  const thinking = preference?.thinking ?? 'default';
  const effort = preference?.effort ?? 'default';
  return `Thinking ${formatReasoningOption(thinking)} · Effort ${formatReasoningOption(effort)}`;
}

function formatLine(lineNumber: number, line: string, width: number): string {
  return `${String(lineNumber).padStart(width, ' ')} ${line}`;
}

function singleLineValue(value: unknown): string {
  const text = typeof value === 'string' ? JSON.stringify(value) : stringifySafely(value);
  const singleLine = String(text ?? '').replace(/\r?\n/g, '\\n').replace(/\t/g, '\\t');
  return singleLine.length > 120 ? `${singleLine.slice(0, 117)}...` : singleLine;
}

function formatReasoningOption(value: string): string {
  return value === 'xhigh'
    ? 'Extra high'
    : value.charAt(0).toUpperCase() + value.slice(1);
}
