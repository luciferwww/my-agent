// ── SessionEntry（sessions.json 中的元数据） ────────────────

export interface SessionEntry {
  sessionId: string;
  sessionKey: string;
  sessionFile: string;
  createdAt: number;
  updatedAt: number;

  status?: 'running' | 'done' | 'failed';
  abortedLastRun?: boolean;

  totalTokens?: number;
  inputTokens?: number;
  outputTokens?: number;

  compactionCount?: number;

  spawnedBy?: string;
}

// ── Transcript 记录类型（JSONL 中每行的结构） ───────────────

/** 所有记录的基础字段（对齐 pi-coding-agent 的 SessionEntryBase） */
export interface TranscriptEntryBase {
  type: string;
  id: string;
  parentId: string | null;
  timestamp: string;
}

/** session 记录（JSONL 首行，文件元信息） */
export interface SessionRecord extends TranscriptEntryBase {
  type: 'session';
  version: number;
  cwd?: string;
}

/** message 记录（对齐 Anthropic API） */
export interface MessageRecord extends TranscriptEntryBase {
  type: 'message';
  message: {
    role: 'user' | 'assistant' | 'toolResult';
    content: string | ContentBlock[];
  };
}

/** compaction 记录（压缩摘要） */
export interface CompactionRecord extends TranscriptEntryBase {
  type: 'compaction';
  summary: string;
  firstKeptEntryId: string;
  tokensBefore: number;
}

/** 所有 Transcript 记录的联合类型 */
export type TranscriptEntry = SessionRecord | MessageRecord | CompactionRecord;

// ── ContentBlock（对齐 Anthropic API） ──────────────────────

export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: string };

// ── Session Store 类型 ─────────────────────────────────────

export type SessionStore = Record<string, SessionEntry>;

// ── 内存中的 Transcript 状态 ────────────────────────────────

export interface TranscriptState {
  /** 所有记录的索引（id → entry） */
  byId: Map<string, TranscriptEntry>;
  /** 当前活跃分支的末端指针 */
  leafId: string | null;
}
