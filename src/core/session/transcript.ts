import { readFileSync } from 'fs';
import { appendFile } from 'fs/promises';
import { SessionDataError } from './store.js';
import { withFileLock } from './lock.js';
import type { CompactionRecord, TranscriptEntry, TranscriptState } from './types.js';

/**
 * Loads a JSONL Transcript into its record index and active leaf.
 * The last message is the active leaf; trailing Compaction records do not
 * change the branch. Missing or structurally invalid persisted data fails
 * closed as a Session data error.
 */
export function loadTranscript(filePath: string): TranscriptState {
  const byId = new Map<string, TranscriptEntry>();
  let leafId: string | null = null;

  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf-8');
  } catch (error) {
    throw new SessionDataError(`Session Transcript "${filePath}" could not be read.`, {
      cause: error,
    });
  }

  const lines = raw.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let entry: TranscriptEntry;
    try {
      entry = JSON.parse(trimmed) as TranscriptEntry;
    } catch (error) {
      throw new SessionDataError(`Session Transcript "${filePath}" contains invalid JSON.`, {
        cause: error,
      });
    }
    assertTranscriptEntry(entry, byId.size === 0, byId);
    byId.set(entry.id, entry);
    if (entry.type === 'session' || entry.type === 'message') {
      leafId = entry.id;
    }
  }

  if (byId.size === 0) {
    throw new SessionDataError(`Session Transcript "${filePath}" is empty.`);
  }

  return { byId, leafId };
}

function assertTranscriptEntry(
  entry: TranscriptEntry,
  first: boolean,
  priorEntries: ReadonlyMap<string, TranscriptEntry>,
): void {
  if (!entry || typeof entry !== 'object' || typeof entry.id !== 'string' || !entry.id) {
    throw new SessionDataError('Session Transcript contains an invalid record identity.');
  }
  if (priorEntries.has(entry.id)) {
    throw new SessionDataError(`Session Transcript contains duplicate record "${entry.id}".`);
  }
  if (first) {
    if (entry.type !== 'session' || entry.parentId !== null || entry.version !== 1) {
      throw new SessionDataError('Session Transcript must begin with a version 1 root record.');
    }
    return;
  }
  if (entry.type !== 'message' && entry.type !== 'compaction') {
    throw new SessionDataError(`Session Transcript contains unsupported record type "${entry.type}".`);
  }
  if (typeof entry.parentId !== 'string' || !priorEntries.has(entry.parentId)) {
    throw new SessionDataError(`Session Transcript record "${entry.id}" has an invalid parent.`);
  }
}

/** Walks from a leaf to the root and returns messages in chronological order. */
export function resolveLinearPath(
  state: TranscriptState,
  leafId: string | null,
): TranscriptEntry[] {
  const path: TranscriptEntry[] = [];
  let currentId = leafId;

  while (currentId !== null) {
    const entry = state.byId.get(currentId);
    if (!entry) break;

    if (entry.type === 'message') {
      path.unshift(entry);
    }

    currentId = entry.parentId;
  }

  return path;
}

/** Appends one record to a JSONL Transcript under its per-file lock. */
export async function appendToTranscript(
  filePath: string,
  entry: TranscriptEntry,
): Promise<void> {
  await withFileLock(filePath, async () => {
    await appendFile(filePath, JSON.stringify(entry) + '\n', 'utf-8');
  });
}

/**
 * Returns the newest Compaction record by ISO timestamp. Compaction markers
 * are excluded from the active message path but remain available to
 * AgentRunner.loadHistory() for history truncation and summary injection.
 */
export function findLastCompaction(state: TranscriptState): CompactionRecord | null {
  let last: CompactionRecord | null = null;

  for (const entry of state.byId.values()) {
    if (entry.type !== 'compaction') continue;

    const record = entry as CompactionRecord;
    // ISO 8601 timestamps sort chronologically as strings.
    if (!last || record.timestamp > last.timestamp) {
      last = record;
    }
  }

  return last;
}
