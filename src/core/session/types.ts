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
  message: {
    role: 'user' | 'assistant' | 'toolResult';
    content: string | ContentBlock[];
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
export type TranscriptEntry = SessionRecord | MessageRecord | CompactionRecord;

// Content blocks aligned with the model message format.

export type ContentBlock =
  | { type: 'text'; text: string }
  | {
      type: 'image';
      source: { type: 'base64'; media_type: string; data: string };
      dimensions: { width: number; height: number };
    }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: string };

// Versioned Session Store.

export interface SessionStore {
  version: 1;
  sessions: Record<string, SessionEntry>;
}

// In-memory Transcript state.

export interface TranscriptState {
  /** Record index by ID. */
  byId: Map<string, TranscriptEntry>;
  /** Active branch leaf. */
  leafId: string | null;
}
