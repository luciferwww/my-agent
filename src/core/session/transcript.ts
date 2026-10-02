import { readFileSync } from 'fs';
import { randomUUID } from 'crypto';
import { appendFile, rename, unlink, writeFile } from 'fs/promises';
import { SessionDataError } from './store.js';
import { withFileLock } from './lock.js';
import type { CompactionRecord, TranscriptEntry, TranscriptState } from './types.js';
import {
  normalizeReasoningPreference,
  ReasoningPreferenceValidationError,
} from '../model-invocation/index.js';

const TRANSCRIPT_RECORD_TYPES = new Set<string>([
  'message',
  'compaction',
  'tool_execution_accepted',
  'tool_execution_terminal',
  'host_task_completion',
  'turn_aborted',
]);
const EXECUTION_OUTCOMES = new Set([
  'success',
  'failed',
  'aborted',
  'outcome_unknown',
]);
const ABORTED_REASONS = new Set(['cancelled', 'start_interrupted']);
const OUTCOME_UNKNOWN_REASONS = new Set([
  'cancellation_grace_expired',
  'host_recovery',
]);
const HOST_COMPLETION_STATUSES = new Set(['success', 'failed', 'aborted']);
const TOOL_RESULT_STATUSES = new Set(['success', 'error', 'denied', 'aborted']);

/**
 * Loads a JSONL Transcript into its record index and active leaf.
 * The last message is the active leaf; trailing Compaction records do not
 * change the branch. Missing or structurally invalid persisted data fails
 * closed as a Session data error.
 */
export function loadTranscript(filePath: string): TranscriptState {
  const byId = new Map<string, TranscriptEntry>();
  let leafId: string | null = null;
  let version: 1 | 2 | undefined;

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

    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed) as unknown;
    } catch (error) {
      throw new SessionDataError(`Session Transcript "${filePath}" contains invalid JSON.`, {
        cause: error,
      });
    }
    assertTranscriptEntry(parsed, byId.size === 0, byId, version);
    const entry = parsed;
    if (entry.type === 'session') version = entry.version as 1 | 2;
    byId.set(entry.id, entry);
    if (entry.type === 'session' || entry.type === 'message') {
      leafId = entry.id;
    }
  }

  if (byId.size === 0) {
    throw new SessionDataError(`Session Transcript "${filePath}" is empty.`);
  }

  return { version: version!, byId, leafId };
}

function assertTranscriptEntry(
  value: unknown,
  first: boolean,
  priorEntries: ReadonlyMap<string, TranscriptEntry>,
  version: 1 | 2 | undefined,
): asserts value is TranscriptEntry {
  if (!isRecord(value) || typeof value.id !== 'string' || !value.id) {
    throw new SessionDataError('Session Transcript contains an invalid record identity.');
  }
  const id = value.id;
  const entry = value;
  if (priorEntries.has(id)) {
    throw new SessionDataError(`Session Transcript contains duplicate record "${id}".`);
  }
  if (first) {
    if (
      entry.type !== 'session'
      || entry.parentId !== null
      || (entry.version !== 1 && entry.version !== 2)
    ) {
      throw new SessionDataError('Session Transcript must begin with a supported root record.');
    }
    return;
  }
  if (typeof entry.type !== 'string' || !TRANSCRIPT_RECORD_TYPES.has(entry.type)) {
    throw new SessionDataError(`Session Transcript contains unsupported record type "${entry.type}".`);
  }
  if (typeof entry.parentId !== 'string' || !priorEntries.has(entry.parentId)) {
    throw new SessionDataError(`Session Transcript record "${entry.id}" has an invalid parent.`);
  }

  switch (entry.type) {
    case 'message':
      assertTurnId(entry.turnId, `message "${entry.id}"`);
      assertMessage(entry.message, id);
      if (
        entry.turnStopReason !== undefined
        && (
          !isRecord(entry.message)
          || entry.message.role !== 'assistant'
          || entry.turnStopReason !== 'max_llm_calls'
        )
      ) {
        throw new SessionDataError(
          `Session Transcript message "${entry.id}" has an invalid Turn stop reason.`,
        );
      }

      function assertMessage(value: unknown, entryId: string): void {
        if (!isRecord(value)) {
          throw new SessionDataError(`Session Transcript message "${entryId}" is invalid.`);
        }
        if (value.role !== 'user' && value.role !== 'assistant' && value.role !== 'toolResult') {
          throw new SessionDataError(`Session Transcript message "${entryId}" has an invalid role.`);
        }
        if (value.invocation !== undefined) {
          if (value.role !== 'assistant' || version !== 2) {
            throw new SessionDataError(
              `Session Transcript message "${entryId}" has invalid invocation metadata.`,
            );
          }
          assertInvocation(value.invocation, entryId);
        }
        if (value.reasoning !== undefined) {
          if (value.role !== 'user' || version !== 2) {
            throw new SessionDataError(
              `Session Transcript message "${entryId}" has invalid reasoning metadata.`,
            );
          }
          try {
            normalizeReasoningPreference(value.reasoning);
          } catch (error) {
            if (!(error instanceof ReasoningPreferenceValidationError)) throw error;
            throw new SessionDataError(
              `Session Transcript message "${entryId}" has invalid reasoning metadata.`,
            );
          }
        }
        if (typeof value.content === 'string') return;
        if (!Array.isArray(value.content)) {
          throw new SessionDataError(`Session Transcript message "${entryId}" has invalid content.`);
        }
        let hasThinking = false;
        for (const block of value.content) {
          if (!isRecord(block) || typeof block.type !== 'string') {
            throw new SessionDataError(
              `Session Transcript message "${entryId}" has an invalid content block.`,
            );
          }
          if (block.type === 'tool_result') {
            if (
              typeof block.tool_use_id !== 'string'
              || typeof block.content !== 'string'
              || typeof block.status !== 'string'
              || !TOOL_RESULT_STATUSES.has(block.status)
            ) {
              throw new SessionDataError(
                `Session Transcript message "${entryId}" has an invalid Tool Result block.`,
              );
            }
          } else if (block.type === 'thinking') {
            hasThinking = true;
            if (version !== 2) {
              throw new SessionDataError(
                `Session Transcript v1 message "${entryId}" contains Thinking state.`,
              );
            }
            assertThinkingBlock(block, entryId);
          }
        }
        if (hasThinking && value.invocation === undefined) {
          throw new SessionDataError(
            `Session Transcript message "${entryId}" is missing invocation metadata.`,
          );
        }
      }
      return;
    case 'compaction':
      return;
    case 'tool_execution_accepted':
      assertTurnId(entry.turnId, `accepted execution "${entry.id}"`);
      assertNonEmptyString(entry.callId, `accepted execution "${entry.id}" call identity`);
      assertNonEmptyString(
        entry.executionId,
        `accepted execution "${entry.id}" execution identity`,
      );
      assertNonEmptyString(entry.toolName, `accepted execution "${entry.id}" Tool name`);
      if ([...priorEntries.values()].some((record) => (
        record.type === 'tool_execution_accepted'
        && (
          record.executionId === entry.executionId
          || (record.turnId === entry.turnId && record.callId === entry.callId)
        )
      ))) {
        throw new SessionDataError(
          `Session Transcript accepted execution "${entry.id}" conflicts with an existing mapping.`,
        );
      }

      return;
    case 'tool_execution_terminal':
      assertNonEmptyString(
        entry.executionId,
        `terminal execution "${entry.id}" execution identity`,
      );
      if (typeof entry.outcome !== 'string' || !EXECUTION_OUTCOMES.has(entry.outcome)) {
        throw new SessionDataError(
          `Session Transcript terminal execution "${entry.id}" has an invalid outcome.`,
        );
      }
      if (
        (entry.outcome === 'success' || entry.outcome === 'failed')
        && entry.reason !== undefined
      ) {
        throw new SessionDataError(
          `Session Transcript terminal execution "${entry.id}" has an invalid reason.`,
        );
      }
      if (
        entry.outcome === 'aborted'
        && (typeof entry.reason !== 'string' || !ABORTED_REASONS.has(entry.reason))
      ) {
        throw new SessionDataError(
          `Session Transcript terminal execution "${entry.id}" has an invalid reason.`,
        );
      }
      if (
        entry.outcome === 'outcome_unknown'
        && (
          typeof entry.reason !== 'string'
          || !OUTCOME_UNKNOWN_REASONS.has(entry.reason)
        )
      ) {
        throw new SessionDataError(
          `Session Transcript terminal execution "${entry.id}" has an invalid reason.`,
        );
      }
      if (typeof entry.content !== 'string') {
        throw new SessionDataError(
          `Session Transcript terminal execution "${entry.id}" has invalid content.`,
        );
      }
      if (![...priorEntries.values()].some((record) => (
        record.type === 'tool_execution_accepted'
        && record.executionId === entry.executionId
      ))) {
        throw new SessionDataError(
          `Session Transcript terminal execution "${entry.id}" has no accepted record.`,
        );
      }
      if ([...priorEntries.values()].some((record) => (
        record.type === 'tool_execution_terminal'
        && record.executionId === entry.executionId
      ))) {
        throw new SessionDataError(
          `Session Transcript terminal execution "${entry.id}" duplicates an existing fact.`,
        );
      }
      return;
    case 'host_task_completion':
      assertTurnId(entry.turnId, `Host completion "${entry.id}"`);
      if (!isRecord(entry.completion)) {
        throw new SessionDataError(
          `Session Transcript Host completion "${entry.id}" is invalid.`,
        );
      }
      const completion = entry.completion;
      assertNonEmptyString(
        completion.executionId,
        `Host completion "${entry.id}" execution identity`,
      );
      assertNonEmptyString(completion.toolName, `Host completion "${entry.id}" Tool name`);
      if (
        typeof completion.status !== 'string'
        || !HOST_COMPLETION_STATUSES.has(completion.status)
      ) {
        throw new SessionDataError(
          `Session Transcript Host completion "${entry.id}" has an invalid status.`,
        );
      }
      if (typeof completion.content !== 'string') {
        throw new SessionDataError(
          `Session Transcript Host completion "${entry.id}" has invalid content.`,
        );
      }
      {
        const accepted = [...priorEntries.values()].find((record) => (
          record.type === 'tool_execution_accepted'
          && record.executionId === completion.executionId
        ));
        const terminal = [...priorEntries.values()].find((record) => (
          record.type === 'tool_execution_terminal'
          && record.executionId === completion.executionId
        ));
        if (
          accepted?.type !== 'tool_execution_accepted'
          || terminal?.type !== 'tool_execution_terminal'
        ) {
          throw new SessionDataError(
            `Session Transcript Host completion "${entry.id}" has no terminal execution fact.`,
          );
        }
        if (
          accepted.turnId !== entry.turnId
          || accepted.toolName !== completion.toolName
          || hostCompletionStatus(terminal.outcome) !== completion.status
          || terminal.content !== completion.content
        ) {
          throw new SessionDataError(
            `Session Transcript Host completion "${entry.id}" conflicts with its execution facts.`,
          );
        }
        if ([...priorEntries.values()].some((record) => (
          record.type === 'host_task_completion'
          && record.completion.executionId === completion.executionId
        ))) {
          throw new SessionDataError(
            `Session Transcript Host completion "${entry.id}" duplicates an existing completion.`,
          );
        }
      }
      return;
    case 'turn_aborted':
      assertTurnId(entry.turnId, `Turn-aborted record "${entry.id}"`);
      if ([...priorEntries.values()].some((record) => (
        record.type === 'turn_aborted' && record.turnId === entry.turnId
      ))) {
        throw new SessionDataError(
          `Session Transcript Turn-aborted record "${entry.id}" duplicates an existing fact.`,
        );
      }
  }
}

function hostCompletionStatus(
  outcome: Extract<TranscriptEntry, { type: 'tool_execution_terminal' }>['outcome'],
): 'success' | 'failed' | 'aborted' {
  if (outcome === 'success' || outcome === 'failed') return outcome;
  return 'aborted';
}

function assertInvocation(value: unknown, entryId: string): void {
  if (!isRecord(value)) {
    throw new SessionDataError(`Session Transcript message "${entryId}" has invalid invocation metadata.`);
  }
  assertNonEmptyString(value.id, `message "${entryId}" invocation identity`);
  if (!isRecord(value.source)) {
    throw new SessionDataError(`Session Transcript message "${entryId}" has invalid invocation source.`);
  }
  for (const field of ['providerId', 'connectionId', 'requestModelId', 'wireProtocol'] as const) {
    assertNonEmptyString(
      value.source[field],
      `message "${entryId}" invocation source ${field}`,
    );
  }
  if (
    value.source.responseModelId !== undefined
    && typeof value.source.responseModelId !== 'string'
  ) {
    throw new SessionDataError(
      `Session Transcript message "${entryId}" has invalid response model identity.`,
    );
  }
  if (!isRecord(value.completion)) {
    throw new SessionDataError(
      `Session Transcript message "${entryId}" has invalid invocation completion.`,
    );
  }
  if (value.completion.status === 'partial') {
    if (value.completion.stopReason !== 'aborted' && value.completion.stopReason !== 'error') {
      throw new SessionDataError(
        `Session Transcript message "${entryId}" has invalid partial invocation completion.`,
      );
    }
  } else if (
    value.completion.status !== 'complete'
    || typeof value.completion.stopReason !== 'string'
    || !isRecord(value.completion.usage)
    || !isNonNegativeInteger(value.completion.usage.inputTokens)
    || !isNonNegativeInteger(value.completion.usage.outputTokens)
  ) {
    throw new SessionDataError(
      `Session Transcript message "${entryId}" has invalid complete invocation completion.`,
    );
  }
}

function assertThinkingBlock(value: Record<string, unknown>, entryId: string): void {
  assertNonEmptyString(value.id, `message "${entryId}" Thinking identity`);
  if (typeof value.text !== 'string') {
    throw new SessionDataError(`Session Transcript message "${entryId}" has invalid Thinking text.`);
  }
  if (value.status === 'partial') {
    if (value.replay !== undefined) {
      throw new SessionDataError(
        `Session Transcript message "${entryId}" has replay state on partial Thinking.`,
      );
    }
    return;
  }
  if (value.status !== 'complete' || !isRecord(value.replay)) {
    throw new SessionDataError(`Session Transcript message "${entryId}" has invalid Thinking completion.`);
  }
  assertNonEmptyString(value.replay.format, `message "${entryId}" replay format`);
  if (!isRecord(value.replay.payload) || !isJsonValue(value.replay.payload)) {
    throw new SessionDataError(`Session Transcript message "${entryId}" has invalid replay payload.`);
  }
}

function isJsonValue(value: unknown): boolean {
  if (
    value === null
    || typeof value === 'string'
    || typeof value === 'boolean'
    || (typeof value === 'number' && Number.isFinite(value))
  ) {
    return true;
  }
  if (Array.isArray(value)) return value.every(isJsonValue);
  return isRecord(value) && Object.values(value).every(isJsonValue);
}

function isNonNegativeInteger(value: unknown): boolean {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function assertTurnId(value: unknown, subject: string): asserts value is string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new SessionDataError(`Session Transcript ${subject} has an invalid Turn identity.`);
  }
}

function assertNonEmptyString(value: unknown, subject: string): asserts value is string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new SessionDataError(`Session Transcript ${subject} is invalid.`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
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

/** Atomically replaces a Transcript while preserving the original on failure. */
export async function replaceTranscript(
  filePath: string,
  entries: readonly TranscriptEntry[],
): Promise<void> {
  await withFileLock(filePath, async () => {
    const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
    const serialized = entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n';
    try {
      await writeFile(temporaryPath, serialized, { encoding: 'utf-8', flag: 'wx' });
      await rename(temporaryPath, filePath);
    } catch (error) {
      await unlink(temporaryPath).catch(() => undefined);
      throw error;
    }
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
