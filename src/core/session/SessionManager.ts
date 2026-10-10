import { randomUUID } from 'crypto';
import { mkdir, readdir, rename, unlink, writeFile } from 'fs/promises';
import { join } from 'path';
import { SessionError } from './errors.js';
import { isCanonicalSessionId, loadStore, updateStore } from './store.js';
import {
  loadTranscript,
  resolveLinearPath,
  appendToTranscript,
  findLastCompaction,
  replaceTranscript,
} from './transcript.js';
import type {
  ExecutionTerminalFact,
  HostTaskCompletion,
} from '../tools/execution.js';
import type {
  AsyncToolTranscriptRecord,
  SessionEntry,
  TranscriptState,
  MessageRecord,
  SessionRecord,
  CompactionRecord,
  ContentBlock,
  SessionHistoryPage,
  SessionHistoryQuery,
  SessionHistoryContentBlock,
  TranscriptEntry,
  ToolExecutionAcceptedRecord,
  ToolExecutionTerminalRecord,
  HostTaskCompletionRecord,
  TurnAbortedRecord,
  UpdateSessionInput,
} from './types.js';
import {
  normalizeReasoningPreference,
  projectThinkingText,
  type ReasoningPreference,
} from '../model-invocation/index.js';

const SESSIONS_DIR = 'sessions';
const STORE_FILE = 'sessions.json';
const TRANSCRIPT_VERSION = 2;
const DEFAULT_HISTORY_LIMIT = 50;
const MAX_HISTORY_LIMIT = 100;

/** SessionManager construction options. */
export interface SessionManagerOptions {
  /** Maximum number of leading tool-result characters to retain. */
  toolResultHeadChars?: number;
  /** Maximum number of trailing tool-result characters to retain. */
  toolResultTailChars?: number;
  now?: () => number;
}

export interface SessionMessageInput {
  turnId: string;
  role: 'user' | 'assistant' | 'toolResult';
  content: string | ContentBlock[];
  invocation?: import('../model-invocation/index.js').AssistantInvocation;
  reasoning?: ReasoningPreference;
  abortMeta?: { partial: boolean; stopReason: 'aborted' };
  turnStopReason?: 'max_llm_calls';
}

export interface MaterializeSessionInput {
  sessionId: string;
  createdAt: number;
  title?: string;
}

export interface CreateTransientSubagentTranscriptInput {
  sessionId: string;
  callerSessionId: string;
  createdAt: number;
}

export interface ToolExecutionAcceptedInput {
  readonly turnId: string;
  readonly callId: string;
  readonly executionId: string;
  readonly toolName: string;
}

export type ToolExecutionTerminalInput = {
  readonly executionId: string;
} & ExecutionTerminalFact;

export interface HostTaskCompletionInput {
  readonly turnId: string;
  readonly completion: HostTaskCompletion;
}

/**
 * Owns persisted Session metadata and tree-structured Transcript operations.
 * Metadata is stored in <agentHome>/sessions/sessions.json and each Transcript
 * is derived as <agentHome>/sessions/<sessionId>.jsonl.
 */
export class SessionManager {
  private readonly sessionsDir: string;
  private readonly storePath: string;
  private readonly options: SessionManagerOptions;

  /** In-memory Transcript state keyed by canonical Session ID. */
  private transcripts = new Map<string, TranscriptState>();
  private transientTranscriptIds = new Set<string>();
  private transcriptWriteTails = new Map<string, Promise<void>>();

  constructor(agentHome: string, options: SessionManagerOptions = {}) {
    this.sessionsDir = join(agentHome, SESSIONS_DIR);
    this.storePath = join(this.sessionsDir, STORE_FILE);
    this.options = options;
  }

  async initialize(): Promise<void> {
    let fileNames: string[];
    try {
      fileNames = await readdir(this.sessionsDir);
    } catch (error) {
      if ((error as { code?: string }).code === 'ENOENT') return;
      throw error;
    }

    const store = loadStore(this.storePath);
    await Promise.all(fileNames.map(async (fileName) => {
      if (fileName.endsWith('.tmp')) {
        await unlink(join(this.sessionsDir, fileName));
        return;
      }
      const match = /^([0-9a-f-]+)\.jsonl$/.exec(fileName);
      if (match && isCanonicalSessionId(match[1]) && !store.sessions[match[1]]) {
        await unlink(join(this.sessionsDir, fileName));
      }
    }));
  }

  // ── Session CRUD ─────────────────────────────────────

  async materializeSession(input: MaterializeSessionInput): Promise<SessionEntry> {
    this.assertSessionId(input.sessionId);
    await mkdir(this.sessionsDir, { recursive: true });

    if (this.getSession(input.sessionId)) {
      throw new SessionError(
        'SESSION_PERSISTENCE_FAILED',
        `Session "${input.sessionId}" is already materialized.`,
      );
    }

    const now = Math.max(input.createdAt, this.now());

    const entry: SessionEntry = {
      sessionId: input.sessionId,
      createdAt: input.createdAt,
      updatedAt: now,
      ...(input.title === undefined ? {} : { title: input.title }),
    };

    const sessionRecord: SessionRecord = {
      type: 'session',
      id: randomUUID(),
      parentId: null,
      timestamp: new Date(input.createdAt).toISOString(),
      version: TRANSCRIPT_VERSION,
    };

    await this.persistNewSession(entry, [sessionRecord]);

    return entry;
  }

  async createTransientSubagentTranscript(
    input: CreateTransientSubagentTranscriptInput,
  ): Promise<void> {
    this.assertSessionId(input.sessionId);
    this.requireTranscript(input.callerSessionId);
    await mkdir(this.sessionsDir, { recursive: true });

    if (this.getSession(input.sessionId) || this.transientTranscriptIds.has(input.sessionId)) {
      throw new SessionError(
        'SESSION_PERSISTENCE_FAILED',
        `Transcript "${input.sessionId}" already exists.`,
      );
    }

    const sessionRecord: SessionRecord = {
      type: 'session',
      id: randomUUID(),
      parentId: null,
      timestamp: new Date(input.createdAt).toISOString(),
      version: TRANSCRIPT_VERSION,
      provenance: {
        type: 'subagent',
        callerSessionId: input.callerSessionId,
      },
    };

    let state: TranscriptState;
    try {
      state = await this.writeNewTranscript(input.sessionId, [sessionRecord]);
    } catch (error) {
      throw new SessionError(
        'SESSION_PERSISTENCE_FAILED',
        `Transcript "${input.sessionId}" could not be persisted.`,
        { cause: error },
      );
    }
    this.transientTranscriptIds.add(input.sessionId);
    this.transcripts.set(input.sessionId, state);
  }

  async deleteTransientSubagentTranscript(sessionId: string): Promise<void> {
    this.assertSessionId(sessionId);
    if (!this.transientTranscriptIds.has(sessionId)) {
      throw new SessionError('SESSION_NOT_FOUND', `Transcript "${sessionId}" was not found.`);
    }

    await unlink(this.resolveTranscriptPathUnchecked(sessionId)).catch((error: unknown) => {
      if ((error as { code?: string }).code !== 'ENOENT') throw error;
    });
    this.transcripts.delete(sessionId);
    this.transientTranscriptIds.delete(sessionId);
  }

  getSession(sessionId: string): SessionEntry | undefined {
    const store = loadStore(this.storePath);
    return store.sessions[sessionId];
  }

  listSessions(input: { archived?: boolean } = {}): SessionEntry[] {
    const store = loadStore(this.storePath);
    const archived = input.archived ?? false;
    return Object.values(store.sessions)
      .filter((entry) => (entry.archivedAt !== undefined) === archived)
      .sort((left, right) => right.updatedAt - left.updatedAt
        || left.sessionId.localeCompare(right.sessionId));
  }

  async renameSession(sessionId: string, input: UpdateSessionInput): Promise<SessionEntry> {
    const title = input.title === null ? undefined : input.title?.trim();
    if (input.title !== null && !title) {
      throw new SessionError('SESSION_TITLE_INVALID', 'Session title must not be empty.');
    }

    let updated!: SessionEntry;
    await updateStore(this.storePath, (store) => {
      const entry = this.requireSession(store.sessions, sessionId);
      if (title === undefined) delete entry.title;
      else entry.title = title;
      entry.updatedAt = this.nextTimestamp(entry.updatedAt);
      updated = { ...entry };
    });
    return updated;
  }

  async archiveSession(sessionId: string): Promise<SessionEntry> {
    let updated!: SessionEntry;
    await updateStore(this.storePath, (store) => {
      const entry = this.requireSession(store.sessions, sessionId);
      const now = this.nextTimestamp(entry.updatedAt);
      entry.archivedAt = now;
      entry.updatedAt = now;
      updated = { ...entry };
    });
    return updated;
  }

  async unarchiveSession(sessionId: string): Promise<SessionEntry> {
    let updated!: SessionEntry;
    await updateStore(this.storePath, (store) => {
      const entry = this.requireSession(store.sessions, sessionId);
      delete entry.archivedAt;
      entry.updatedAt = this.nextTimestamp(entry.updatedAt);
      updated = { ...entry };
    });
    return updated;
  }

  assertSessionDeletable(sessionId: string): void {
    const sessions = loadStore(this.storePath).sessions;
    this.requireSession(sessions, sessionId);
    if (Object.values(sessions).some(
      (entry) => entry.forkedFromSessionId === sessionId,
    )) {
      throw new SessionError(
        'SESSION_HAS_DESCENDANTS',
        `Session "${sessionId}" has fork descendants.`,
      );
    }
  }

  async deleteSession(sessionId: string): Promise<void> {
    await updateStore(this.storePath, (store) => {
      this.requireSession(store.sessions, sessionId);
      if (Object.values(store.sessions).some(
        (entry) => entry.forkedFromSessionId === sessionId,
      )) {
        throw new SessionError(
          'SESSION_HAS_DESCENDANTS',
          `Session "${sessionId}" has fork descendants.`,
        );
      }
      delete store.sessions[sessionId];
    });

    await unlink(this.resolveTranscriptPathUnchecked(sessionId)).catch((error: unknown) => {
      if ((error as { code?: string }).code !== 'ENOENT') throw error;
    });
    this.transcripts.delete(sessionId);
  }

  async forkSession(sourceSessionId: string, entryId?: string): Promise<SessionEntry> {
    const source = this.requireExistingSession(sourceSessionId);
    const sourceState = this.ensureTranscriptLoaded(sourceSessionId);
    const selectedId = entryId ?? sourceState.leafId;
    const selected = selectedId ? sourceState.byId.get(selectedId) : undefined;
    if (!selected || selected.type !== 'message') {
      throw new SessionError(
        'SESSION_NOT_FOUND',
        `Transcript entry "${entryId ?? ''}" was not found.`,
      );
    }

    const sourceMessages = resolveLinearPath(sourceState, selected.id) as MessageRecord[];
    const sessionId = randomUUID();
    const now = this.now();
    const root: SessionRecord = {
      type: 'session',
      id: randomUUID(),
      parentId: null,
      timestamp: new Date(now).toISOString(),
      version: TRANSCRIPT_VERSION,
    };
    let parentId = root.id;
    const messages = sourceMessages.map((message): MessageRecord => {
      const copy = { ...message, parentId };
      parentId = copy.id;
      return copy;
    });
    const copiedMessageIds = new Set(messages.map((message) => message.id));
    const lifecycle = [...sourceState.byId.values()].filter(
      (record): record is AsyncToolTranscriptRecord => (
        (
          record.type === 'tool_execution_accepted'
          || record.type === 'tool_execution_terminal'
          || record.type === 'host_task_completion'
          || record.type === 'turn_aborted'
        )
        && record.parentId !== null
        && copiedMessageIds.has(record.parentId)
      ),
    );
    const entry: SessionEntry = {
      sessionId,
      createdAt: now,
      updatedAt: now,
      forkedFromSessionId: sourceSessionId,
      ...(source.title === undefined ? {} : { title: source.title }),
    };

    await this.persistNewSession(entry, [root, ...messages, ...lifecycle]);
    return entry;
  }

  // Tree-structured message operations.

  /** Appends a message to the active branch and returns the persisted record. */
  async appendMessage(
    sessionId: string,
    message: SessionMessageInput,
  ): Promise<MessageRecord> {
    return this.withTranscriptWrite(
      sessionId,
      () => this.appendMessageUnlocked(sessionId, message),
    );
  }

  private async appendMessageUnlocked(
    sessionId: string,
    message: SessionMessageInput,
  ): Promise<MessageRecord> {
    const state = this.ensureTranscriptLoaded(sessionId);
    const filePath = this.resolveTranscriptPath(sessionId);
    const { turnId, turnStopReason, ...messagePayload } = message;
    if (turnStopReason !== undefined && messagePayload.role !== 'assistant') {
      throw new TypeError('turnStopReason can only be set on an Assistant message.');
    }
    if (messagePayload.reasoning !== undefined && messagePayload.role !== 'user') {
      throw new TypeError('reasoning can only be set on a User message.');
    }
    const reasoning = messagePayload.reasoning === undefined
      ? undefined
      : normalizeReasoningPreference(messagePayload.reasoning).preference;
    const normalizedMessagePayload = reasoning === undefined
      ? messagePayload
      : { ...messagePayload, reasoning };

    // Persist capped tool results so later history loads need no repeated trimming.
    const persistedMessage = normalizedMessagePayload.role === 'toolResult'
      ? {
          ...normalizedMessagePayload,
          content: this.capToolResults(normalizedMessagePayload.content as ContentBlock[]),
        }
      : normalizedMessagePayload;

    const record: MessageRecord = {
      type: 'message',
      id: randomUUID(),
      parentId: state.leafId,
      timestamp: new Date().toISOString(),
      turnId,
      ...(turnStopReason === undefined ? {} : { turnStopReason }),
      message: persistedMessage,
    };

    const requiresV2 = normalizedMessagePayload.invocation !== undefined
      || normalizedMessagePayload.reasoning !== undefined
      || (
        Array.isArray(normalizedMessagePayload.content)
        && normalizedMessagePayload.content.some((block) => block.type === 'thinking')
      );
    if (state.version !== 2 && requiresV2) {
      const entries = [...state.byId.values()];
      const root = entries[0];
      if (!root || root.type !== 'session') {
        throw new SessionError(
          'SESSION_DATA_INVALID',
          `Session "${sessionId}" has no Transcript root.`,
        );
      }
      const upgradedRoot: SessionRecord = { ...root, version: 2 };
      await replaceTranscript(filePath, [upgradedRoot, ...entries.slice(1), record]);
      state.byId.set(upgradedRoot.id, upgradedRoot);
      state.version = 2;
    } else {
      await appendToTranscript(filePath, record);
    }

    state.byId.set(record.id, record);
    state.leafId = record.id;
    await this.touchSession(sessionId);

    return record;
  }

  /** Returns the active branch in chronological order. */
  getMessages(key: string): MessageRecord[] {
    const state = this.ensureTranscriptLoaded(key);
    return resolveLinearPath(state, state.leafId) as MessageRecord[];
  }

  getHistory(query: SessionHistoryQuery): SessionHistoryPage {
    const limit = query.limit ?? DEFAULT_HISTORY_LIMIT;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_HISTORY_LIMIT) {
      throw new TypeError(`Session history limit must be an integer from 1 through ${MAX_HISTORY_LIMIT}.`);
    }

    const messages = this.getMessages(query.sessionId);
    let end = messages.length;
    if (query.beforeEntryId !== undefined) {
      end = messages.findIndex((message) => message.id === query.beforeEntryId);
      if (end < 0) {
        throw new SessionError(
          'SESSION_HISTORY_CURSOR_INVALID',
          'The history cursor is not on the active branch.',
        );
      }
    }

    const start = Math.max(0, end - limit);
    const selected = messages.slice(start, end);
    const lifecycle = this.getAsyncToolRecords(query.sessionId);
    const items = selected.map((record) => this.projectHistoryMessage(record, lifecycle));
    const hasMore = start > 0;
    return {
      sessionId: query.sessionId,
      items,
      nextCursor: hasMore ? (items[0]?.entryId ?? null) : null,
      hasMore,
    };
  }

  /** Moves the in-memory leaf so subsequent messages form a new branch. */
  branch(key: string, entryId: string): void {
    const state = this.ensureTranscriptLoaded(key);
    if (!state.byId.has(entryId)) {
      throw new Error(`Entry "${entryId}" not found in session "${key}"`);
    }
    state.leafId = entryId;
  }

  /** Returns the current active branch leaf. */
  getLeafId(key: string): string | null {
    const state = this.ensureTranscriptLoaded(key);
    return state.leafId;
  }

  async appendToolExecutionAccepted(
    sessionId: string,
    input: ToolExecutionAcceptedInput,
  ): Promise<string> {
    return this.withTranscriptWrite(sessionId, async () => {
      const state = this.ensureTranscriptLoaded(sessionId);
      const acceptedRecords = this.asyncToolRecords(state)
        .filter((record): record is ToolExecutionAcceptedRecord => (
          record.type === 'tool_execution_accepted'
        ));
      const byExecution = acceptedRecords.find(
        (record) => record.executionId === input.executionId,
      );
      const byCall = acceptedRecords.find(
        (record) => record.turnId === input.turnId && record.callId === input.callId,
      );
      const existing = byExecution ?? byCall;
      if (existing) {
        if (
          existing.executionId === input.executionId
          && existing.turnId === input.turnId
          && existing.callId === input.callId
          && existing.toolName === input.toolName
        ) {
          return existing.id;
        }
        throw this.lifecycleConflict(
          `Tool execution acceptance conflicts with existing record "${existing.id}".`,
        );
      }

      const record: ToolExecutionAcceptedRecord = {
        type: 'tool_execution_accepted',
        id: randomUUID(),
        parentId: state.leafId,
        timestamp: this.nowIso(),
        ...input,
      };
      await this.appendAsyncToolRecord(sessionId, state, record);
      return record.id;
    });
  }

  async appendToolExecutionTerminal(
    sessionId: string,
    input: ToolExecutionTerminalInput,
  ): Promise<string> {
    return this.withTranscriptWrite(sessionId, async () => {
      const state = this.ensureTranscriptLoaded(sessionId);
      const records = this.asyncToolRecords(state);
      const accepted = records.find(
        (record): record is ToolExecutionAcceptedRecord => (
          record.type === 'tool_execution_accepted'
          && record.executionId === input.executionId
        ),
      );
      if (!accepted) {
        throw this.lifecycleConflict(
          `Tool execution "${input.executionId}" has no accepted record.`,
        );
      }

      const existing = records.find(
        (record): record is ToolExecutionTerminalRecord => (
          record.type === 'tool_execution_terminal'
          && record.executionId === input.executionId
        ),
      );
      if (existing) {
        if (
          existing.outcome === input.outcome
          && existing.content === input.content
          && existing.reason === input.reason
        ) {
          return existing.id;
        }
        throw this.lifecycleConflict(
          `Tool execution "${input.executionId}" already has a conflicting terminal fact.`,
        );
      }

      const record: ToolExecutionTerminalRecord = {
        type: 'tool_execution_terminal',
        id: randomUUID(),
        parentId: state.leafId,
        timestamp: this.nowIso(),
        ...input,
      };
      await this.appendAsyncToolRecord(sessionId, state, record);
      return record.id;
    });
  }

  async appendHostTaskCompletion(
    sessionId: string,
    input: HostTaskCompletionInput,
  ): Promise<string> {
    return this.withTranscriptWrite(sessionId, async () => {
      const state = this.ensureTranscriptLoaded(sessionId);
      const records = this.asyncToolRecords(state);
      const accepted = records.find(
        (record): record is ToolExecutionAcceptedRecord => (
          record.type === 'tool_execution_accepted'
          && record.executionId === input.completion.executionId
        ),
      );
      const terminal = records.find(
        (record): record is ToolExecutionTerminalRecord => (
          record.type === 'tool_execution_terminal'
          && record.executionId === input.completion.executionId
        ),
      );
      if (!accepted || !terminal) {
        throw this.lifecycleConflict(
          `Host completion "${input.completion.executionId}" has no terminal execution fact.`,
        );
      }
      if (
        accepted.turnId !== input.turnId
        || accepted.toolName !== input.completion.toolName
        || this.hostCompletionStatus(terminal.outcome) !== input.completion.status
        || terminal.content !== input.completion.content
      ) {
        throw this.lifecycleConflict(
          `Host completion "${input.completion.executionId}" conflicts with its execution facts.`,
        );
      }

      const existing = records.find(
        (record): record is HostTaskCompletionRecord => (
          record.type === 'host_task_completion'
          && record.completion.executionId === input.completion.executionId
        ),
      );
      if (existing) {
        if (
          existing.turnId === input.turnId
          && existing.completion.toolName === input.completion.toolName
          && existing.completion.status === input.completion.status
          && existing.completion.content === input.completion.content
        ) {
          return existing.id;
        }
        throw this.lifecycleConflict(
          `Tool execution "${input.completion.executionId}" already has a conflicting Host completion.`,
        );
      }

      const record: HostTaskCompletionRecord = {
        type: 'host_task_completion',
        id: randomUUID(),
        parentId: state.leafId,
        timestamp: this.nowIso(),
        turnId: input.turnId,
        completion: { ...input.completion },
      };
      await this.appendAsyncToolRecord(sessionId, state, record);
      return record.id;
    });
  }

  async appendTurnAborted(sessionId: string, turnId: string): Promise<string> {
    return this.withTranscriptWrite(sessionId, async () => {
      const state = this.ensureTranscriptLoaded(sessionId);
      const existing = this.asyncToolRecords(state).find(
        (record): record is TurnAbortedRecord => (
          record.type === 'turn_aborted' && record.turnId === turnId
        ),
      );
      if (existing) return existing.id;

      const record: TurnAbortedRecord = {
        type: 'turn_aborted',
        id: randomUUID(),
        parentId: state.leafId,
        timestamp: this.nowIso(),
        turnId,
      };
      await this.appendAsyncToolRecord(sessionId, state, record);
      return record.id;
    });
  }

  getAsyncToolRecords(sessionId: string): readonly AsyncToolTranscriptRecord[] {
    const records = this.asyncToolRecords(this.ensureTranscriptLoaded(sessionId));
    return records.map((record) => (
      record.type === 'host_task_completion'
        ? { ...record, completion: { ...record.completion } }
        : { ...record }
    ));
  }

  // Compaction record operations.

  /**
   * Appends a Compaction marker without moving the active message leaf.
   * parentId records the leaf at Compaction time, while firstKeptEntryId marks
   * the retained-history boundary used by loadHistory().
   */
  async appendCompactionRecord(
    sessionId: string,
    record: Omit<CompactionRecord, 'parentId' | 'firstKeptEntryId'>,
    firstKeptEntryId: string,
  ): Promise<void> {
    await this.withTranscriptWrite(sessionId, async () => {
      const state = this.ensureTranscriptLoaded(sessionId);
      const filePath = this.resolveTranscriptPath(sessionId);

      const fullRecord: CompactionRecord = {
        ...record,
        parentId: state.leafId,
        firstKeptEntryId,
      };

      await appendToTranscript(filePath, fullRecord);

      state.byId.set(fullRecord.id, fullRecord);

      // Compaction statistics remain authoritative in the Transcript record.
      await this.touchSession(sessionId);
    });
  }

  /** Returns the latest Compaction summary, or null when none exists. */
  getLastCompactionSummary(key: string): string | null {
    const state = this.ensureTranscriptLoaded(key);
    const record = findLastCompaction(state);
    return record?.summary ?? null;
  }

  /** Returns the latest Compaction record used to rebuild model history. */
  getLastCompactionRecord(key: string): CompactionRecord | null {
    const state = this.ensureTranscriptLoaded(key);
    return findLastCompaction(state);
  }

  // Internal helpers.

  private async withTranscriptWrite<T>(
    sessionId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const prior = this.transcriptWriteTails.get(sessionId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = prior.catch(() => undefined).then(() => current);
    this.transcriptWriteTails.set(sessionId, tail);
    await prior.catch(() => undefined);
    try {
      return await operation();
    } finally {
      release();
      if (this.transcriptWriteTails.get(sessionId) === tail) {
        this.transcriptWriteTails.delete(sessionId);
      }
    }
  }

  private async appendAsyncToolRecord(
    sessionId: string,
    state: TranscriptState,
    record: AsyncToolTranscriptRecord,
  ): Promise<void> {
    await appendToTranscript(this.resolveTranscriptPath(sessionId), record);
    state.byId.set(record.id, record);
    await this.touchSession(sessionId);
  }

  private async touchSession(sessionId: string): Promise<void> {
    if (this.transientTranscriptIds.has(sessionId)) return;

    await updateStore(this.storePath, (store) => {
      const entry = store.sessions[sessionId];
      if (entry) entry.updatedAt = this.nextTimestamp(entry.updatedAt);
    });
  }

  private asyncToolRecords(state: TranscriptState): AsyncToolTranscriptRecord[] {
    return [...state.byId.values()].filter(
      (record): record is AsyncToolTranscriptRecord => (
        record.type === 'tool_execution_accepted'
        || record.type === 'tool_execution_terminal'
        || record.type === 'host_task_completion'
        || record.type === 'turn_aborted'
      ),
    );
  }

  private hostCompletionStatus(
    outcome: ToolExecutionTerminalRecord['outcome'],
  ): HostTaskCompletion['status'] {
    if (outcome === 'success' || outcome === 'failed') return outcome;
    return 'aborted';
  }

  private lifecycleConflict(message: string): SessionError {
    return new SessionError('SESSION_DATA_INVALID', message);
  }

  private nowIso(): string {
    return new Date(this.now()).toISOString();
  }

  /** Caps persisted tool-result blocks when both head and tail limits are set. */
  private capToolResults(blocks: ContentBlock[]): ContentBlock[] {
    const { toolResultHeadChars, toolResultTailChars } = this.options;
    if (!toolResultHeadChars || !toolResultTailChars) {
      return blocks;
    }

    const maxChars = toolResultHeadChars + toolResultTailChars;
    return blocks.map((block) => {
      if (block.type !== 'tool_result' || block.content.length <= maxChars) {
        return block;
      }
      const head = block.content.slice(0, toolResultHeadChars);
      const tail = block.content.slice(-toolResultTailChars);
      const capped = `${head}\n\n...\n\n${tail}`
        + `\n\n[Tool result trimmed: kept first ${toolResultHeadChars} and last ${toolResultTailChars}`
        + ` of ${block.content.length} chars]`;
      return { ...block, content: capped };
    });
  }

  private projectHistoryMessage(
    record: MessageRecord,
    lifecycle: readonly AsyncToolTranscriptRecord[],
  ): import('./types.js').SessionHistoryMessage {
    const content = typeof record.message.content === 'string'
      ? record.message.content
      : record.message.content.flatMap((block): SessionHistoryContentBlock[] => {
          if (block.type === 'thinking') {
            const text = projectThinkingText(block);
            return text
              ? [{
                  type: 'thinking',
                  id: block.id,
                  text,
                  status: block.status,
                }]
              : [];
          }
          if (block.type !== 'tool_use') return [block];
          const accepted = lifecycle.find(
            (candidate): candidate is ToolExecutionAcceptedRecord => (
              candidate.type === 'tool_execution_accepted'
              && candidate.parentId === record.id
              && candidate.callId === block.id
            ),
          );
          if (!accepted) return [block];
          const terminal = lifecycle.find(
            (candidate): candidate is ToolExecutionTerminalRecord => (
              candidate.type === 'tool_execution_terminal'
              && candidate.executionId === accepted.executionId
            ),
          );
          return [{
            ...block,
            execution_id: accepted.executionId,
            ...(terminal === undefined
              ? {}
              : {
                  status: terminal.outcome === 'success'
                    ? 'success' as const
                    : terminal.outcome === 'failed'
                      ? 'error' as const
                      : 'aborted' as const,
                  result_content: terminal.content,
                }),
          }];
        });
    return {
      entryId: record.id,
      turnId: record.turnId,
      timestamp: record.timestamp,
      role: record.message.role,
      content,
      ...(record.message.reasoning === undefined
        ? {}
        : { reasoning: record.message.reasoning }),
      ...(record.message.abortMeta === undefined ? {} : { abortMeta: record.message.abortMeta }),
    };
  }

  /** Loads and caches a persisted Transcript on first access. */
  private ensureTranscriptLoaded(sessionId: string): TranscriptState {
    let state = this.transcripts.get(sessionId);
    if (state) return state;

    this.requireTranscript(sessionId);

    const filePath = this.resolveTranscriptPathUnchecked(sessionId);
    state = loadTranscript(filePath);
    this.transcripts.set(sessionId, state);
    return state;
  }

  /** Resolves the Transcript path from a validated Session ID. */
  private resolveTranscriptPath(sessionId: string): string {
    this.requireTranscript(sessionId);
    return this.resolveTranscriptPathUnchecked(sessionId);
  }

  private resolveTranscriptPathUnchecked(sessionId: string): string {
    this.assertSessionId(sessionId);
    return join(this.sessionsDir, `${sessionId}.jsonl`);
  }

  private requireExistingSession(sessionId: string): SessionEntry {
    const entry = this.getSession(sessionId);
    if (!entry) {
      throw new SessionError('SESSION_NOT_FOUND', `Session "${sessionId}" was not found.`);
    }
    return entry;
  }

  private requireTranscript(sessionId: string): void {
    this.assertSessionId(sessionId);
    if (!this.transientTranscriptIds.has(sessionId)) {
      this.requireExistingSession(sessionId);
    }
  }

  private requireSession(
    sessions: Record<string, SessionEntry>,
    sessionId: string,
  ): SessionEntry {
    this.assertSessionId(sessionId);
    const entry = sessions[sessionId];
    if (!entry) {
      throw new SessionError('SESSION_NOT_FOUND', `Session "${sessionId}" was not found.`);
    }
    return entry;
  }

  private assertSessionId(sessionId: string): void {
    if (!isCanonicalSessionId(sessionId)) {
      throw new SessionError('SESSION_NOT_FOUND', `Session "${sessionId}" was not found.`);
    }
  }

  private nextTimestamp(previous: number): number {
    return Math.max(this.now(), previous + 1);
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  private async persistNewSession(
    entry: SessionEntry,
    records: TranscriptEntry[],
  ): Promise<void> {
    const finalPath = this.resolveTranscriptPathUnchecked(entry.sessionId);
    let state: TranscriptState;

    try {
      state = await this.writeNewTranscript(entry.sessionId, records);
      await updateStore(this.storePath, (store) => {
        if (store.sessions[entry.sessionId]) {
          throw new SessionError(
            'SESSION_PERSISTENCE_FAILED',
            `Session "${entry.sessionId}" is already materialized.`,
          );
        }
        store.sessions[entry.sessionId] = entry;
      });
    } catch (error) {
      await unlink(finalPath).catch(() => undefined);
      this.transcripts.delete(entry.sessionId);
      if (error instanceof SessionError) throw error;
      throw new SessionError(
        'SESSION_PERSISTENCE_FAILED',
        `Session "${entry.sessionId}" could not be persisted.`,
        { cause: error },
      );
    }

    this.transcripts.set(entry.sessionId, state);
  }

  private async writeNewTranscript(
    sessionId: string,
    records: TranscriptEntry[],
  ): Promise<TranscriptState> {
    const finalPath = this.resolveTranscriptPathUnchecked(sessionId);
    const temporaryPath = join(this.sessionsDir, `${sessionId}.${randomUUID()}.tmp`);
    const serialized = records.map((record) => JSON.stringify(record)).join('\n') + '\n';

    try {
      await unlink(finalPath).catch((error: unknown) => {
        if ((error as { code?: string }).code !== 'ENOENT') throw error;
      });
      await writeFile(temporaryPath, serialized, { encoding: 'utf-8', flag: 'wx' });
      await rename(temporaryPath, finalPath);
    } catch (error) {
      await Promise.all([
        unlink(temporaryPath).catch(() => undefined),
        unlink(finalPath).catch(() => undefined),
      ]);
      throw error;
    }

    let leafId: string | null = null;
    for (const record of records) {
      if (record.type === 'session' || record.type === 'message') {
        leafId = record.id;
      }
    }

    return {
      version: TRANSCRIPT_VERSION,
      byId: new Map(records.map((record) => [record.id, record])),
      leafId,
    };
  }
}
