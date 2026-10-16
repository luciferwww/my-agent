import type {
  FailedHistoryRequest,
  HistoryRecord,
  HistoryRequest,
  HistoryStatus,
  PresentationItem,
} from './history';

export type PermissionMode = 'manual' | 'allow_all';

export interface SessionUiState {
  draft: string;
  chatItems: PresentationItem[];
  turnMap: Record<string, PresentationItem>;
  activeTurnId: string | null;
  historyRecords: HistoryRecord[];
  historyItems: PresentationItem[];
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

export function createSessionUiState(): SessionUiState {
  return {
    draft: '',
    chatItems: [],
    turnMap: {},
    activeTurnId: null,
    historyRecords: [],
    historyItems: [],
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
