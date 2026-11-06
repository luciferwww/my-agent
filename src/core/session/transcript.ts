import { readFileSync } from 'fs';
import { randomUUID } from 'crypto';
import { appendFile, rename, unlink, writeFile } from 'fs/promises';
import { isCanonicalSessionId, SessionDataError } from './store.js';
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
  'presentation',
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
  let version: 1 | 2 | 3 | undefined;

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
    if (entry.type === 'session') version = entry.version as 1 | 2 | 3;
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
  version: 1 | 2 | 3 | undefined,
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
      || (entry.version !== 1 && entry.version !== 2 && entry.version !== 3)
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
    case 'presentation':
      if (version !== 3 || priorEntries.get(entry.parentId)?.type !== 'message') {
        throw new SessionDataError(`Session presentation "${id}" requires v3 and a message anchor.`);
      }
      if (typeof entry.sourceSessionId !== 'string' || !isCanonicalSessionId(entry.sourceSessionId)) {
        throw new SessionDataError(`Session presentation "${id}" has an invalid source Session.`);
      }
      assertNonEmptyString(entry.sourceEntryId, `presentation "${id}" source entry`);
      assertPresentationBody(entry.body, id);
      const body = entry.body;
      if ([...priorEntries.values()].some(record => record.type === 'presentation'
        && record.sourceSessionId === entry.sourceSessionId
        && (record.sourceEntryId === entry.sourceEntryId
          || (record.body.type === body.type
            && (body.type === 'subagent_start' || body.type === 'subagent_end'))))) {
        throw new SessionDataError(`Session presentation "${id}" duplicates a source fact.`);
      }
      if (
        (entry.body.type === 'subagent_start' || entry.body.type === 'subagent_end')
        && entry.body.sessionId !== entry.sourceSessionId
      ) {
        throw new SessionDataError(`Session presentation "${id}" has conflicting lifecycle identity.`);
      }
      return;
    case 'message':
      assertTurnId(entry.turnId, `message "${entry.id}"`);
      if (entry.messageId !== undefined) {
        if (version !== 3) {
          throw new SessionDataError(
            `Session Transcript message "${entry.id}" requires v3 for messageId.`,
          );
        }
        assertNonEmptyString(entry.messageId, `message "${entry.id}" messageId`);
      }
      assertMessage(entry.message, id);
      if (entry.llmRound !== undefined && (
        version !== 3 || !isNonNegativeInteger(entry.llmRound)
        || !isRecord(entry.message) || entry.message.role !== 'assistant'
      )) {
        throw new SessionDataError(`Session Transcript message "${entry.id}" has an invalid llmRound.`);
      }
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
          if (value.role !== 'assistant' || version === 1) {
            throw new SessionDataError(
              `Session Transcript message "${entryId}" has invalid invocation metadata.`,
            );
          }
          assertInvocation(value.invocation, entryId);
        }
        if (value.reasoning !== undefined) {
          if (value.role !== 'user' || version === 1) {
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
            if (version === 1) {
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

export function assertPresentationBody(
  value: unknown,
  entryId: string,
): asserts value is import('./types.js').PresentationBody {
  const invalid = () => new SessionDataError(`Session presentation "${entryId}" has an invalid body.`);
  const assertFields = (record: Record<string, unknown>, fields: readonly string[]): void => {
    if (Object.keys(record).some(key => !fields.includes(key))) throw invalid();
  };
  if (!isRecord(value)) throw invalid();
  const identityFields = [
    'sessionId', 'turnId', 'callerSessionId', 'parentTurnId', 'parentToolUseId',
    'runId', 'subagentType',
  ];
  switch (value.type) {
    case 'message': {
      const allowed = new Set(['type', 'turnId', 'role', 'content', 'messageId', 'llmRound', 'reasoning', 'abortMeta']);
      if (Object.keys(value).some(key => !allowed.has(key))) throw invalid();
      assertTurnId(value.turnId, `presentation "${entryId}"`);
      if (!['user', 'assistant', 'toolResult'].includes(String(value.role))) throw invalid();
      if (value.messageId !== undefined) assertNonEmptyString(value.messageId, 'presentation messageId');
      if (value.llmRound !== undefined
        && (value.role !== 'assistant' || !isNonNegativeInteger(value.llmRound))) throw invalid();
      if (value.reasoning !== undefined) {
        if (value.role !== 'user') throw invalid();
        try {
          normalizeReasoningPreference(value.reasoning);
        } catch (error) {
          if (!(error instanceof ReasoningPreferenceValidationError)) throw error;
          throw invalid();
        }
      }
      if (value.abortMeta !== undefined && (
        value.role !== 'assistant' || !isRecord(value.abortMeta)
        || typeof value.abortMeta.partial !== 'boolean' || value.abortMeta.stopReason !== 'aborted'
      )) throw invalid();
      if (isRecord(value.abortMeta)) assertFields(value.abortMeta, ['partial', 'stopReason']);
      if (typeof value.content === 'string') return;
      if (!Array.isArray(value.content)) throw invalid();
      for (const block of value.content) {
        if (!isRecord(block)) throw invalid();
        switch (block.type) {
          case 'thinking':
            if (
              Object.keys(block).some(key => !['type', 'id', 'text', 'status'].includes(key))
              || typeof block.id !== 'string' || !block.id
              || typeof block.text !== 'string'
              || !['partial', 'complete'].includes(String(block.status))
            ) throw invalid();
            break;
          case 'text':
            assertFields(block, ['type', 'text']);
            if (typeof block.text !== 'string') throw invalid();
            break;
          case 'tool_use':
            assertFields(block, ['type', 'id', 'name', 'input']);
            if (
              typeof block.id !== 'string' || !block.id || typeof block.name !== 'string'
              || !isRecord(block.input)
            ) throw invalid();
            break;
          case 'tool_result':
            assertFields(block, ['type', 'tool_use_id', 'content', 'status']);
            if (typeof block.tool_use_id !== 'string' || typeof block.content !== 'string'
              || !TOOL_RESULT_STATUSES.has(String(block.status))) throw invalid();
            break;
          case 'execution_accepted':
            assertFields(block, ['type', 'tool_use_id', 'execution_id']);
            if (typeof block.tool_use_id !== 'string' || typeof block.execution_id !== 'string') throw invalid();
            break;
          case 'image':
            assertFields(block, ['type', 'source', 'dimensions']);
            if (!isRecord(block.source) || block.source.type !== 'base64'
              || typeof block.source.media_type !== 'string' || typeof block.source.data !== 'string'
              || !isRecord(block.dimensions)
              || typeof block.dimensions.width !== 'number'
              || typeof block.dimensions.height !== 'number') throw invalid();
            assertFields(block.source, ['type', 'media_type', 'data']);
            assertFields(block.dimensions, ['width', 'height']);
            break;
          default:
            throw invalid();
        }
      }
      return;
    }
    case 'tool_execution_accepted':
      for (const key of ['turnId', 'callId', 'executionId', 'toolName']) {
        assertNonEmptyString(value[key], `presentation ${key}`);
      }
      if (Object.keys(value).some(key => !['type', 'turnId', 'callId', 'executionId', 'toolName'].includes(key))) throw invalid();
      return;
    case 'tool_execution_terminal':
      assertNonEmptyString(value.executionId, 'presentation executionId');
      if (!EXECUTION_OUTCOMES.has(String(value.outcome)) || typeof value.content !== 'string') throw invalid();
      if (
        ((value.outcome === 'success' || value.outcome === 'failed') && value.reason !== undefined)
        || (value.outcome === 'aborted' && !ABORTED_REASONS.has(String(value.reason)))
        || (value.outcome === 'outcome_unknown' && !OUTCOME_UNKNOWN_REASONS.has(String(value.reason)))
        || Object.keys(value).some(key => !['type', 'executionId', 'outcome', 'content', 'reason'].includes(key))
      ) throw invalid();
      return;
    case 'subagent_start':
    case 'subagent_end': {
      for (const key of identityFields) assertNonEmptyString(value[key], `presentation ${key}`);
      if (!isCanonicalSessionId(String(value.sessionId))
        || !isCanonicalSessionId(String(value.callerSessionId))
        || !Number.isSafeInteger(value.depth) || Number(value.depth) < 1) throw invalid();
      const allowed = ['type', ...identityFields, 'depth'];
      if (value.type === 'subagent_end') {
        allowed.push('outcome', 'failure', 'usage', 'durationMs');
        if (!['ok', 'error', 'aborted', 'max_llm_calls'].includes(String(value.outcome))
          || !isRecord(value.usage) || !isNonNegativeInteger(value.usage.inputTokens)
          || !isNonNegativeInteger(value.usage.outputTokens)
          || typeof value.durationMs !== 'number' || !Number.isFinite(value.durationMs)
          || value.durationMs < 0) throw invalid();
        assertFields(value.usage, ['inputTokens', 'outputTokens']);
        if (value.failure !== undefined && (
          !isRecord(value.failure) || typeof value.failure.message !== 'string'
          || !['setup', 'resolution', 'execution'].includes(String(value.failure.phase))
        )) throw invalid();
        if (isRecord(value.failure)) {
          assertFields(value.failure, ['phase', 'message', 'category']);
          if (value.failure.phase === 'resolution') {
            assertNonEmptyString(value.failure.category, 'presentation failure category');
          } else if (value.failure.category !== undefined) {
            throw invalid();
          }
        }
      }
      if (Object.keys(value).some(key => !allowed.includes(key))) throw invalid();
      return;
    }
    default:
      throw invalid();
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
