import type {
  FailedHistoryRequest,
  HistoryRecord,
  HistoryRequest,
  HistoryStatus,
  PresentationItem,
  SubagentScope,
} from './history';
import type { LlmCallBoundary } from './conversation';

export type PermissionMode = 'manual' | 'allow_all';

export interface SessionUiState {
  draft: string;
  modelSelection: Readonly<{ providerId: string; modelId: string }> | null;
  modelSelectionSource: 'none' | 'user' | 'default' | 'fallback';
  reasoningSelection: { thinking: string; effort: string };
  chatItems: PresentationItem[];
  turnMap: Record<string, PresentationItem>;
  activeTurnId: string | null;
  terminalTurnId: string | null;
  llmCall: LlmCallBoundary | null;
  historyRecords: HistoryRecord[];
  historyItems: PresentationItem[];
  historyScopes: SubagentScope[];
  subagentScopes: Record<string, SubagentScope>;
  historyStatus: HistoryStatus;
  historyError: string;
  historyNextCursor: string | null;
  historyHasMore: boolean;
  pendingHistoryRequest: HistoryRequest | null;
  failedHistoryRequest: FailedHistoryRequest | null;
  pendingLatestHistoryRefresh: boolean;
  pendingLatestHistoryTurnIds: string[];
  isSending: boolean;
  permissionMode: PermissionMode;
  permissionChangedAt: number;
  pendingPermissionRequestId: string | null;
  attachments: unknown[];
  attachError: string;
}

export type SessionUiStateMap = Record<string, SessionUiState>;

export function createSessionUiState(
  preferences?: Pick<SessionUiState, 'modelSelection' | 'modelSelectionSource' | 'reasoningSelection'>,
): SessionUiState {
  return {
    draft: '',
    modelSelection: preferences?.modelSelection ? Object.freeze({ ...preferences.modelSelection }) : null,
    modelSelectionSource: preferences?.modelSelectionSource ?? 'none',
    reasoningSelection: preferences ? { ...preferences.reasoningSelection } : { thinking: 'default', effort: 'default' },
    chatItems: [],
    turnMap: {},
    activeTurnId: null,
    terminalTurnId: null,
    llmCall: null,
    historyRecords: [],
    historyItems: [],
    historyScopes: [],
    subagentScopes: {},
    historyStatus: 'notLoaded',
    historyError: '',
    historyNextCursor: null,
    historyHasMore: false,
    pendingHistoryRequest: null,
    failedHistoryRequest: null,
    pendingLatestHistoryRefresh: false,
    pendingLatestHistoryTurnIds: [],
    isSending: false,
    permissionMode: 'manual',
    permissionChangedAt: 0,
    pendingPermissionRequestId: null,
    attachments: [],
    attachError: '',
  };
}

export function ensureSessionUiState(
  states: SessionUiStateMap,
  sessionId: string,
): SessionUiState {
  const key = sessionId || '';
  states[key] ??= createSessionUiState();
  return states[key];
}
