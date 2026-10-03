import { readFileSync } from 'fs';
import { rename, unlink, writeFile } from 'fs/promises';
import { randomUUID } from 'crypto';
import { SessionError } from './errors.js';
import { withFileLock } from './lock.js';
import type { SessionEntry, SessionStore } from './types.js';

const SESSION_ENTRY_FIELDS = new Set([
  'sessionId',
  'title',
  'createdAt',
  'updatedAt',
  'archivedAt',
  'forkedFromSessionId',
]);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export class SessionDataError extends SessionError {
  constructor(message: string, options?: ErrorOptions) {
    super('SESSION_DATA_INVALID', message, options);
    this.name = 'SessionDataError';
  }
}

export function createEmptyStore(): SessionStore {
  return { version: 1, sessions: {} };
}

/** Loads sessions.json, returning a new versioned Store when it is absent. */
export function loadStore(storePath: string): SessionStore {
  try {
    const raw = readFileSync(storePath, 'utf-8');
    const parsed: unknown = JSON.parse(raw);
    assertValidStore(parsed);
    return parsed;
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

function assertValidStore(value: unknown): asserts value is SessionStore {
  if (!isRecord(value) || value.version !== 1 || !isRecord(value.sessions)) {
    throw new SessionDataError('Session Store must use schema version 1.');
  }
  if (Object.keys(value).some((key) => key !== 'version' && key !== 'sessions')) {
    throw new SessionDataError('Session Store contains unsupported fields.');
  }

  for (const [sessionId, entry] of Object.entries(value.sessions)) {
    assertValidEntry(sessionId, entry);
    if (entry.forkedFromSessionId && !value.sessions[entry.forkedFromSessionId]) {
      throw new SessionDataError(`Session "${entry.sessionId}" has an unknown fork source.`);
    }
  }
}

function assertValidEntry(sessionId: string, value: unknown): asserts value is SessionEntry {
  if (!isCanonicalSessionId(sessionId) || !isRecord(value) || value.sessionId !== sessionId) {
    throw new SessionDataError('Session Store key and entry identity must be matching UUIDs.');
  }
  if (Object.keys(value).some((key) => !SESSION_ENTRY_FIELDS.has(key))) {
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isCanonicalSessionId(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

function isTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}
