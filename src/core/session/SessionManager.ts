import { randomUUID } from 'crypto';
import { mkdir, readdir, rename, unlink, writeFile } from 'fs/promises';
import { join } from 'path';
import { SessionError } from './errors.js';
import { isCanonicalSessionId, loadStore, updateStore } from './store.js';
import { loadTranscript, resolveLinearPath, appendToTranscript, findLastCompaction } from './transcript.js';
import type {
  SessionEntry,
  TranscriptState,
  MessageRecord,
  SessionRecord,
  CompactionRecord,
  ContentBlock,
  UpdateSessionInput,
} from './types.js';

const SESSIONS_DIR = 'sessions';
const STORE_FILE = 'sessions.json';
const TRANSCRIPT_VERSION = 1;

/** SessionManager construction options. */
export interface SessionManagerOptions {
  /** Maximum number of leading tool-result characters to retain. */
  toolResultHeadChars?: number;
  /** Maximum number of trailing tool-result characters to retain. */
  toolResultTailChars?: number;
  now?: () => number;
}

export interface SessionMessageInput {
  role: 'user' | 'assistant' | 'toolResult';
  content: string | ContentBlock[];
  abortMeta?: { partial: boolean; stopReason: 'aborted' };
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
    const entry: SessionEntry = {
      sessionId,
      createdAt: now,
      updatedAt: now,
      forkedFromSessionId: sourceSessionId,
      ...(source.title === undefined ? {} : { title: source.title }),
    };

    await this.persistNewSession(entry, [root, ...messages]);
    return entry;
  }

  // Tree-structured message operations.

  /** Appends a message to the active branch and returns its record ID. */
  async appendMessage(
    sessionId: string,
    message: SessionMessageInput,
  ): Promise<string> {
    const state = this.ensureTranscriptLoaded(sessionId);
    const filePath = this.resolveTranscriptPath(sessionId);

    // Persist capped tool results so later history loads need no repeated trimming.
    const persistedMessage = message.role === 'toolResult'
      ? { ...message, content: this.capToolResults(message.content as ContentBlock[]) }
      : message;

    const record: MessageRecord = {
      type: 'message',
      id: randomUUID(),
      parentId: state.leafId,
      timestamp: new Date().toISOString(),
      message: persistedMessage,
    };

    await appendToTranscript(filePath, record);

    state.byId.set(record.id, record);
    state.leafId = record.id;

    await updateStore(this.storePath, (store) => {
      const entry = store.sessions[sessionId];
      if (entry) {
        entry.updatedAt = this.nextTimestamp(entry.updatedAt);
      }
    });

    return record.id;
  }

  /** Returns the active branch in chronological order. */
  getMessages(key: string): MessageRecord[] {
    const state = this.ensureTranscriptLoaded(key);
    return resolveLinearPath(state, state.leafId) as MessageRecord[];
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
    await updateStore(this.storePath, (store) => {
      const entry = store.sessions[sessionId];
      if (entry) {
        entry.updatedAt = this.nextTimestamp(entry.updatedAt);
      }
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
    records: Array<SessionRecord | MessageRecord>,
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
    records: Array<SessionRecord | MessageRecord>,
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

    return {
      byId: new Map(records.map((record) => [record.id, record])),
      leafId: records.at(-1)?.id ?? null,
    };
  }
}
