export { SessionManager } from './SessionManager.js';
export type {
  MaterializeSessionInput,
  SessionManagerOptions,
  SessionMessageInput,
  ToolExecutionAcceptedInput,
  ToolExecutionTerminalInput,
  HostTaskCompletionInput,
} from './SessionManager.js';
export { SessionError } from './errors.js';
export type { SessionErrorCode } from './errors.js';
export { deriveInitialSessionTitle } from './title.js';

export type {
  SessionEntry,
  UpdateSessionInput,
  SessionStore,
  TranscriptEntryBase,
  SessionRecord,
  MessageRecord,
  CompactionRecord,
  ToolExecutionAcceptedRecord,
  ToolExecutionTerminalRecord,
  HostTaskCompletionRecord,
  TurnAbortedRecord,
  AsyncToolTranscriptRecord,
  TranscriptEntry,
  TranscriptState,
  ContentBlock,
  SessionHistoryContentBlock,
  SessionHistoryMessage,
  SessionHistoryPage,
  SessionHistoryQuery,
} from './types.js';
