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
    /**
     * abort 路径标记。**透明持久化到 JSONL**，供调试 / audit / 未来不同
     * UI 渲染使用；**不反向影响 LLM 请求**——AgentRunner.loadHistory() 转
     * ChatMessage 时丢弃此字段，LLM 看到的历史与正常消息一致。
     * 详见 core-abort-spec.md §6.5。
     */
    abortMeta?: {
      partial: boolean;
      stopReason: 'aborted';
    };
  };
}

/** compaction 记录（压缩摘要） */
export interface CompactionRecord extends TranscriptEntryBase {
  type: 'compaction';
  /** LLM 生成的历史摘要文本（失败时为兜底文本） */
  summary: string;
  /**
   * 保留区第一条消息的 ID。
   * loadHistory() 用此字段截断历史：只取 firstKeptEntryId 之后的消息，
   * 并在最前面注入摘要，避免重复加载已被压缩的旧消息。
   */
  firstKeptEntryId: string;
  /** 压缩前的估算 token 数（含 SAFETY_MARGIN） */
  tokensBefore: number;
  /** 压缩后的估算 token 数（含 SAFETY_MARGIN） */
  tokensAfter: number;
  /**
   * 触发原因：
   *   'preemptive' — runAttempt 开头的预判检测（checkContextBudget 返回 compact）
   *   'overflow'   — 内层 90% 阈值检查或 LLM API 报错后的被动触发
   *   'manual'     — 未来预留（用户手动触发）
   */
  trigger: 'preemptive' | 'overflow' | 'manual';
  /**
   * 被摘要替代的消息条数（压缩区消息数）。
   * 纯审计字段，不参与运行时决策。
   */
  droppedMessages: number;
}

/** 所有 Transcript 记录的联合类型 */
export type TranscriptEntry = SessionRecord | MessageRecord | CompactionRecord;

// ── ContentBlock（对齐 Anthropic API） ──────────────────────

export type ContentBlock =
  | { type: 'text'; text: string }
  | {
      type: 'image';
      source: { type: 'base64'; media_type: string; data: string };
      dimensions: { width: number; height: number };
    }
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
