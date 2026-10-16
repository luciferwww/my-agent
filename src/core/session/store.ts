import { readFileSync } from 'fs';
import { rename, unlink, writeFile } from 'fs/promises';
import { randomUUID } from 'crypto';
import { SessionError } from './errors.js';
import { withFileLock } from './lock.js';
import type {
  SessionEntry,
  SessionStore,
  SessionStoreEntry,
} from './types.js';

const CHAT_SESSION_ENTRY_FIELDS = new Set([
  'sessionId',
  'title',
  'createdAt',
  'updatedAt',
  'archivedAt',
  'forkedFromSessionId',
]);
const SUBAGENT_SESSION_ENTRY_FIELDS = new Set([
  'kind',
  'sessionId',
  'callerSessionId',
  'createdAt',
  'updatedAt',
  'completedAt',
  'expiresAt',
  'outcome',
]);
const SUBAGENT_OUTCOMES = new Set([
  'ok',
  'max_llm_calls',
  'aborted',
  'error',
  'interrupted',
]);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export class SessionDataError extends SessionError {
  constructor(message: string, options?: ErrorOptions) {
    super('SESSION_DATA_INVALID', message, options);
    this.name = 'SessionDataError';
  }
}

export function createEmptyStore(): SessionStore {
  return { sessions: {} };
}

/** Loads sessions.json, returning a new Store when it is absent. */
export function loadStore(storePath: string): SessionStore {
  try {
    const raw = readFileSync(storePath, 'utf-8');
    const parsed: unknown = JSON.parse(raw);
    return normalizeStore(parsed);
  } catch (err: unknown) {
    const error = err as { code?: string };
    if (error?.code === 'ENOENT') {
      return createEmptyStore();
    }
    if (err instanceof SessionDataError) throw err;
    if (err instanceof SyntaxError) {
      throw new SessionDataError('Session Store is not valid JSON.');
    }
    throw err;
  }
}

/** Serializes mutations and atomically replaces sessions.json. */
export async function updateStore<T>(
  storePath: string,
  mutator: (store: SessionStore) => T,
): Promise<T> {
  return withFileLock(storePath, async () => {
    const store = loadStore(storePath);
    const result = mutator(store);
    assertValidStore(store);

    const temporaryPath = `${storePath}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporaryPath, JSON.stringify(store, null, 2) + '\n', {
        encoding: 'utf-8',
        flag: 'wx',
      });
      await rename(temporaryPath, storePath);
    } catch (error) {
      await unlink(temporaryPath).catch(() => undefined);
      throw error;
    }
    return result;
  });
}

function normalizeStore(value: unknown): SessionStore {
  if (
    !isRecord(value)
    || !isRecord(value.sessions)
  ) {
    throw new SessionDataError('Session Store must contain a sessions object.');
  }
  if (Object.keys(value).some((key) => key !== 'sessions')) {
    throw new SessionDataError('Session Store contains unsupported fields.');
  }

  for (const [sessionId, entry] of Object.entries(value.sessions)) {
    assertValidEntry(sessionId, entry);
  }
  for (const entry of Object.values(value.sessions)) {
    if (
      isChatSessionEntry(entry)
      && entry.forkedFromSessionId
      && !isChatSessionEntry(value.sessions[entry.forkedFromSessionId])
    ) {
      throw new SessionDataError(`Session "${entry.sessionId}" has an unknown fork source.`);
    }
  }
  return {
    sessions: value.sessions as Record<string, SessionStoreEntry>,
  };
}

function assertValidStore(value: unknown): asserts value is SessionStore {
  normalizeStore(value);
}

function assertValidEntry(sessionId: string, value: unknown): asserts value is SessionStoreEntry {
  if (isRecord(value) && value.kind === 'subagent') {
    assertValidSubagentEntry(sessionId, value);
    return;
  }
  assertValidChatEntry(sessionId, value);
}

function assertValidChatEntry(sessionId: string, value: unknown): asserts value is SessionEntry {
  if (!isCanonicalSessionId(sessionId) || !isRecord(value) || value.sessionId !== sessionId) {
    throw new SessionDataError('Session Store key and entry identity must be matching UUIDs.');
  }
  if (Object.keys(value).some((key) => !CHAT_SESSION_ENTRY_FIELDS.has(key))) {
    throw new SessionDataError(`Session "${sessionId}" contains unsupported metadata.`);
  }
  if (!isTimestamp(value.createdAt) || !isTimestamp(value.updatedAt)) {
    throw new SessionDataError(`Session "${sessionId}" contains invalid timestamps.`);
  }
  if (value.title !== undefined && (typeof value.title !== 'string' || !value.title.trim())) {
    throw new SessionDataError(`Session "${sessionId}" contains an invalid title.`);
  }
  if (value.archivedAt !== undefined && !isTimestamp(value.archivedAt)) {
    throw new SessionDataError(`Session "${sessionId}" contains an invalid archive timestamp.`);
  }
  if (value.forkedFromSessionId !== undefined) {
    if (
      !isCanonicalSessionId(value.forkedFromSessionId)
      || value.forkedFromSessionId === sessionId
    ) {
      throw new SessionDataError(`Session "${sessionId}" contains an invalid fork source.`);
    }
  }
}

function assertValidSubagentEntry(
  sessionId: string,
  value: Record<string, unknown>,
): void {
  if (!isCanonicalSessionId(sessionId) || value.sessionId !== sessionId) {
    throw new SessionDataError('Session Store key and entry identity must be matching UUIDs.');
  }
  if (Object.keys(value).some((key) => !SUBAGENT_SESSION_ENTRY_FIELDS.has(key))) {
    throw new SessionDataError(`Session "${sessionId}" contains unsupported metadata.`);
  }
  if (!isCanonicalSessionId(value.callerSessionId)) {
    throw new SessionDataError(`Session "${sessionId}" contains an invalid caller identity.`);
  }
  if (!isTimestamp(value.createdAt) || !isTimestamp(value.updatedAt)) {
    throw new SessionDataError(`Session "${sessionId}" contains invalid timestamps.`);
  }
  const hasTerminalField = value.completedAt !== undefined
    || value.expiresAt !== undefined
    || value.outcome !== undefined;
  const hasCompleteTerminal = isTimestamp(value.completedAt)
    && isTimestamp(value.expiresAt)
    && typeof value.outcome === 'string'
    && SUBAGENT_OUTCOMES.has(value.outcome);
  if (hasTerminalField !== hasCompleteTerminal) {
    throw new SessionDataError(`Session "${sessionId}" contains incomplete terminal metadata.`);
  }
  if (
    hasCompleteTerminal
    && (
      (value.completedAt as number) < (value.createdAt as number)
      || (value.expiresAt as number) <= (value.completedAt as number)
      || (value.updatedAt as number) < (value.completedAt as number)
    )
  ) {
    throw new SessionDataError(`Session "${sessionId}" contains invalid terminal timestamps.`);
  }
}

function isChatSessionEntry(value: unknown): value is SessionEntry {
  return isRecord(value) && value.kind !== 'subagent';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isCanonicalSessionId(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

function isTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}
