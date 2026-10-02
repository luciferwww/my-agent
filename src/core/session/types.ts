import type {
  ExecutionTerminalFact,
  HostTaskCompletion,
} from '../tools/execution.js';
import type {
  AssistantInvocation,
  ChatContentBlock,
  PresentationThinkingBlock,
  ReasoningPreference,
} from '../model-invocation/index.js';

// Session metadata stored in sessions.json.

export interface SessionEntry {
  sessionId: string;
  createdAt: number;
  updatedAt: number;
  title?: string;
  archivedAt?: number;
  forkedFromSessionId?: string;
}

export interface UpdateSessionInput {
  title?: string | null;
}

// Transcript record types, one record per JSONL line.

/** Fields shared by every Transcript record. */
export interface TranscriptEntryBase {
  type: string;
  id: string;
  parentId: string | null;
  timestamp: string;
}

/** Transcript root record, stored as the first JSONL line. */
export interface SessionRecord extends TranscriptEntryBase {
  type: 'session';
  version: number;
  cwd?: string;
  provenance?: {
    type: 'subagent';
    callerSessionId: string;
  };
}

/** Persisted conversation message. */
export interface MessageRecord extends TranscriptEntryBase {
  type: 'message';
  turnId: string;
  turnStopReason?: 'max_llm_calls';
  message: {
    role: 'user' | 'assistant' | 'toolResult';
    content: string | ContentBlock[];
    invocation?: AssistantInvocation;
    reasoning?: ReasoningPreference;
    /**
      * Abort metadata is persisted unchanged for diagnostics, auditing, and UI
      * rendering. AgentRunner.loadHistory() does not send it to the model; it
      * only uses it to filter empty aborted assistant records.
     */
    abortMeta?: {
      partial: boolean;
      stopReason: 'aborted';
    };
  };
}

/** Durable Host ownership of one admitted Tool invocation. */
export interface ToolExecutionAcceptedRecord extends TranscriptEntryBase {
  type: 'tool_execution_accepted';
  turnId: string;
  callId: string;
  executionId: string;
  toolName: string;
}

/** Immutable terminal fact for one accepted Tool invocation. */
export type ToolExecutionTerminalRecord = TranscriptEntryBase & {
  type: 'tool_execution_terminal';
  executionId: string;
} & ExecutionTerminalFact;

/** Trusted Host-origin completion queued for Model delivery. */
export interface HostTaskCompletionRecord extends TranscriptEntryBase {
  type: 'host_task_completion';
  turnId: string;
  completion: HostTaskCompletion;
}

/** Records intentional non-consumption of trailing completions after Root Abort. */
export interface TurnAbortedRecord extends TranscriptEntryBase {
  type: 'turn_aborted';
  turnId: string;
}

export type AsyncToolTranscriptRecord =
  | ToolExecutionAcceptedRecord
  | ToolExecutionTerminalRecord
  | HostTaskCompletionRecord
  | TurnAbortedRecord;

/** Persisted Compaction summary record. */
export interface CompactionRecord extends TranscriptEntryBase {
  type: 'compaction';
  /** Model-generated history summary, or a fallback summary on failure. */
  summary: string;
  /**
  * ID of the first retained message. loadHistory() uses it to omit compacted
  * messages and prepend the summary.
   */
  firstKeptEntryId: string;
  /** Estimated token count before Compaction, including the safety margin. */
  tokensBefore: number;
  /** Estimated token count after Compaction, including the safety margin. */
  tokensAfter: number;
  /**
  * Trigger source: preflight budget check, overflow recovery, or an explicit
  * manual request.
   */
  trigger: 'preemptive' | 'overflow' | 'manual';
  /**
  * Number of messages replaced by the summary. This is audit data and does
  * not participate in Runtime decisions.
   */
  droppedMessages: number;
}

/** Union of all persisted Transcript records. */
export type TranscriptEntry =
  | SessionRecord
  | MessageRecord
  | CompactionRecord
  | AsyncToolTranscriptRecord;

// Content blocks aligned with the model message format.

export type ContentBlock = ChatContentBlock;

export type SessionHistoryContentBlock =
  | Exclude<ContentBlock, { type: 'tool_use' } | { type: 'thinking' }>
  | PresentationThinkingBlock
  | {
      type: 'tool_use';
      id: string;
      name: string;
      input: Record<string, unknown>;
      execution_id?: string;
      status?: import('../tools/types.js').ToolResultStatus;
      result_content?: string;
    };

export interface SessionHistoryQuery {
  readonly sessionId: string;
  readonly beforeEntryId?: string;
  readonly limit?: number;
}

export interface SessionHistoryMessage {
  readonly entryId: string;
  readonly turnId: string;
  readonly timestamp: string;
  readonly role: MessageRecord['message']['role'];
  readonly content: string | readonly SessionHistoryContentBlock[];
  readonly reasoning?: ReasoningPreference;
  readonly abortMeta?: MessageRecord['message']['abortMeta'];
}

export interface SessionHistoryPage {
  readonly sessionId: string;
  readonly items: readonly SessionHistoryMessage[];
  readonly nextCursor: string | null;
  readonly hasMore: boolean;
}

// Versioned Session Store.

export interface SessionStore {
  version: 1;
  sessions: Record<string, SessionEntry>;
}

// In-memory Transcript state.

export interface TranscriptState {
  /** Transcript root schema version. */
  version?: 1 | 2;
  /** Record index by ID. */
  byId: Map<string, TranscriptEntry>;
  /** Active branch leaf. */
  leafId: string | null;
}
