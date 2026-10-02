import type { ChatMessage, ChatContentBlock, TokenUsage } from '../model-invocation/index.js';
import { AgentExecutionFailure } from './errors.js';
import type { ResolvedModel } from '../model-resolution/index.js';
import type { SessionManager } from '../session/SessionManager.js';
import type {
  ContentBlock,
  MessageRecord,
  ToolExecutionAcceptedRecord,
} from '../session/types.js';
import type {
  AgentRunnerConfig,
  RunParams,
  RunResult,
  AgentEvent,
  ToolResult,
  TurnContext,
} from './types.js';
import type {
  CanonicalToolResult,
  ToolCall,
  ToolDefinition,
  ToolResultOutcome,
} from '../tools/types.js';
import type { ResolvedTool } from '../registry/index.js';
import { renderHostTaskCompletion } from '../model-invocation/index.js';
import {
  DEFAULT_COMPACTION_CONFIG,
  type CompactionConfig,
} from './compaction-config.js';
import { runBeforeToolCall, runAfterToolCall, runBeforeCompaction, runAfterCompaction } from './hooks/index.js';
import { pruneToolResults, pruneToolResultsAggregate } from './context/tool-result-pruning.js';
import { checkContextBudget } from './context/context-budget.js';
import { resolveInputTokenBudget } from './context/input-budget.js';
import { estimatePromptTokens } from './context/token-estimation.js';
import { ContextOverflowError } from './errors.js';
import { compactMessages } from './context/compaction.js';
import { Logger } from '../../platform/logger/index.js';
import {
  DefaultAsyncToolExecutionFramework,
  ToolExecutionUnavailableError,
  processToolExecutionRuntimeState,
  type AsyncToolExecutionFramework,
  type ToolExecutionRuntimeState,
  type TurnExecutionEvent,
} from './async-tools/index.js';

const logger = Logger.get('AgentRunner');

/**
 * Maximum outer compaction retries. Each ContextOverflowError triggers one
 * compactHistory call and retry before the error is returned to the caller.
 */
const MAX_COMPACTION_RETRIES = 3;

/**
 * Inner-loop threshold. After a tool result is appended, proactively throw
 * ContextOverflowError when estimated tokens exceed this context-window ratio.
 */
const INNER_LOOP_OVERFLOW_THRESHOLD = 0.9;

interface ImmediateToolAdmission {
  readonly kind: 'immediate';
  readonly toolUse: ToolCall;
  readonly result: CanonicalToolResult;
  readonly effectiveInput: Record<string, unknown>;
  readonly implementationStarted: false;
}

interface PreparedToolAdmission {
  readonly kind: 'prepared';
  readonly toolUse: ToolCall & {
    readonly input: { readonly state: 'ready'; readonly value: Readonly<Record<string, unknown>> };
  };
  readonly resolvedTool: ResolvedTool;
  readonly effectiveInput: Record<string, unknown>;
}

interface AcceptedToolAdmission {
  readonly kind: 'accepted';
  readonly toolUse: ToolCall;
  readonly executionId: string;
  readonly effectiveInput: Record<string, unknown>;
}

type ToolAdmission = ImmediateToolAdmission | AcceptedToolAdmission;

interface CompletedToolCall {
  readonly toolUse: ToolCall;
  readonly result: CanonicalToolResult;
  readonly effectiveInput: Record<string, unknown>;
  readonly implementationStarted: boolean;
  readonly durationMs?: number;
}

function isEmptyAbortedAssistant(record: MessageRecord): boolean {
  if (
    record.message.role !== 'assistant'
    || record.message.abortMeta?.partial !== true
  ) {
    return false;
  }
  return record.message.content.length === 0;
}

/**
 * Agent execution engine for one complete conversation loop.
 *
 * run() owns the outer compaction retry loop; runAttempt() performs one attempt.
 *
 * Context management layers:
 *   Layer 1   - pruneToolResults: in-memory per-result pruning
 *   Layer 1.5 - pruneToolResultsAggregate: aggregate pruning for its dedicated route
 *   Layer 2   - checkContextBudget: fits / truncate_tool_results_only / compact routing
 *   Layer 3   - compactHistory: persisted LLM summarization followed by retry
 *
 * Every overflow path becomes ContextOverflowError and enters the outer retry:
 * preflight routing, the inner-loop threshold, or an LLM API overflow.
 */
export class AgentRunner {
  private sessionManager: SessionManager;
  private readonly toolExecutionRuntimeState: ToolExecutionRuntimeState;
  private onEvent?: (event: AgentEvent) => void;

  constructor(config: AgentRunnerConfig) {
    this.sessionManager = config.sessionManager;
    this.toolExecutionRuntimeState = config.toolExecutionRuntimeState
      ?? processToolExecutionRuntimeState;
    this.onEvent = config.onEvent;
  }

  /**
   * Remove an orphan trailing user message from the active Session branch.
   *
   * Called at runAttempt and compactHistory entry. It moves the in-memory leaf
   * to the trailing user's parent so later history loads and appends omit the
   * orphan. JSONL remains unchanged for audit.
   *
   * A trailing toolResult is only logged because repairing an interrupted tool
   * call requires richer semantic recovery.
   */
  private sanitizeSessionTail(turnCtx: TurnContext): void {
    const { sessionId: sessionKey } = turnCtx;
    const records = this.sessionManager.getMessages(sessionKey);
    if (records.length === 0) return;

    const last = records[records.length - 1]!;
    if (last.message.role !== 'user') {
      if (last.message.role === 'toolResult') {
        logger.warn('[sanitizeSessionTail] session tail is toolResult (interrupted mid-tool-call); skipping cleanup', {
          sessionKey,
          entryId: last.id,
        });
      }
      return;
    }

    // A trailing user's parent is always a known Transcript entry, including
    // the Session root for the first message.
    const parentId = last.parentId;
    if (!parentId) {
      logger.warn('[sanitizeSessionTail] trailing user has no parentId; skipping', {
        sessionKey,
        entryId: last.id,
      });
      return;
    }

    this.sessionManager.branch(sessionKey, parentId);
    this.emit(turnCtx, {
      type: 'session_tail_sanitized',
      discardedEntryId: last.id,
      discardedRole: 'user',
    });
  }

  /**
   * Repair tool_use blocks without matching tool_result blocks at the Session tail.
   *
   * Runs beside sanitizeSessionTail at runAttempt entry to repair persisted
   * damage from the previous Turn. See core-abort-spec.md section 7.3.
   *
   * Covers user aborts, process termination, power loss, unhandled exceptions,
   * and unknown failures. Detection uses persisted getMessages state.
   *
   * abortMeta.partial selects the aborted source; all other causes are recovered.
   *
   * Persistence failures are logged, not thrown, so the next runAttempt retries.
   * If repair remains impossible, the Provider error stays visible to the caller.
   */
  private async repairOrphanToolUses(turnCtx: TurnContext): Promise<void> {
    const { sessionId: sessionKey } = turnCtx;
    try {
      const records = this.sessionManager.getMessages(sessionKey);
      if (records.length === 0) return;

      const lastRecord = records[records.length - 1]!;
      const last = lastRecord.message;
      let orphanIds: string[] = [];
      let orphanToolNames = new Map<string, string>();
      let hint: MessageRecord['message']['abortMeta'] | undefined;
      let repairedTurnId = lastRecord.turnId;
      let sourceAssistant: MessageRecord | undefined;

      // Case A: every tool_use in a trailing assistant message is orphaned.
      if (last.role === 'assistant' && Array.isArray(last.content)) {
        const toolUses = last.content
          .filter((b): b is Extract<ContentBlock, { type: 'tool_use' }> => b.type === 'tool_use');
        orphanIds = toolUses.map((block) => block.id);
        orphanToolNames = new Map(toolUses.map((block) => [block.id, block.name]));
        hint = last.abortMeta;
        sourceAssistant = lastRecord;
      }
      // Case B: a trailing toolResult covers only part of the preceding tool_use set.
      // Persisted results are excluded naturally, including the R6' abort path.
      else if (last.role === 'toolResult' && Array.isArray(last.content) && records.length >= 2) {
        const prevRecord = records[records.length - 2]!;
        const prev = prevRecord.message;
        if (prev.role === 'assistant' && Array.isArray(prev.content)) {
          repairedTurnId = prevRecord.turnId;
          const useIds = new Set(
            prev.content
              .filter((b): b is Extract<ContentBlock, { type: 'tool_use' }> => b.type === 'tool_use')
              .map((b) => b.id),
          );
          orphanToolNames = new Map(
            prev.content
              .filter((b): b is Extract<ContentBlock, { type: 'tool_use' }> => b.type === 'tool_use')
              .map((b) => [b.id, b.name]),
          );
          const resultIds = new Set(
            last.content
              .filter((b): b is Extract<ContentBlock, { type: 'tool_result' }> => b.type === 'tool_result')
              .map((b) => b.tool_use_id),
          );
          orphanIds = [...useIds].filter((id) => !resultIds.has(id));
          hint = prev.abortMeta;
          sourceAssistant = prevRecord;
        }
      }

      if (orphanIds.length === 0) return;
      const acceptedCallIds = new Set(
        this.sessionManager.getAsyncToolRecords(sessionKey)
          .filter((record) => (
            record.type === 'tool_execution_accepted'
            && record.turnId === repairedTurnId
          ))
          .map((record) => record.type === 'tool_execution_accepted' ? record.callId : ''),
      );
      orphanIds = orphanIds.filter((id) => !acceptedCallIds.has(id));
      if (orphanIds.length === 0) return;

      if (sourceAssistant?.turnStopReason === 'max_llm_calls') {
        await this.sessionManager.appendMessage(sessionKey, {
          turnId: repairedTurnId,
          role: 'toolResult',
          content: orphanIds.map((id) => ({
            type: 'tool_result',
            tool_use_id: id,
            content: this.maxLlmCallsUnavailableContent(orphanToolNames.get(id) ?? 'unknown'),
            status: 'error',
          })),
        });
        return;
      }

      // Keep synthetic content neutral. source is audit metadata and does not
      // alter user-visible content. See core-abort-spec.md section 7.3.
      const source: 'abort' | 'recovered' = hint?.partial === true ? 'abort' : 'recovered';
      const content = '[tool call interrupted; session recovered]';
      const blocks: ContentBlock[] = orphanIds.map((id) => ({
        type: 'tool_result',
        tool_use_id: id,
        content,
        status: 'error',
      }));

      await this.sessionManager.appendMessage(sessionKey, {
        turnId: repairedTurnId,
        role: 'toolResult',
        content: blocks,
      });
      this.emit(turnCtx, {
        type: 'orphan_tool_results_repaired',
        count: orphanIds.length,
        source,
      });
    } catch (err) {
      logger.warn('[repairOrphanToolUses] repair failed; leaving session as-is', {
        sessionKey,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // ── Abort helpers (core-abort-spec.md section 7.1) ─────────

  /**
   * Shared name/code predicate used by callLLMStream, runAttempt, and
   * logIfSwallowedByAbortFallback.
   *
   * DOMException and native fetch use AbortError. Anthropic SDK v0.82 wraps
   * upstream aborts in a plain Error with message "Request was aborted.", so
   * the exact message remains a compatibility fallback.
   */
  private isAbortByName(err: Error): boolean {
    return (
      err.name === 'AbortError'
      || err.name === 'APIUserAbortError'
      || (err as { code?: string }).code === 'ABORT_ERR'
      || err.message === 'Request was aborted.'
    );
  }

  /**
   * Decide whether a caught value follows graceful abort handling or is thrown.
   *
   * SDK or wrapper changes may lose err.name, so an aborted associated signal
   * is also treated as abort. Callers should pass the signal when available.
   *
   * This fallback is intentionally coarse: once the signal is aborted, even an
   * unrelated error follows the abort path. The section 4 "never throws"
   * contract takes priority over preserving the exact error type.
   *
   * Callers must warn through logIfSwallowedByAbortFallback when this fallback
   * catches a non-abort error, preserving diagnostic visibility.
   */
  private isAbortError(err: unknown, signal?: AbortSignal): boolean {
    if (!(err instanceof Error)) return false;
    if (this.isAbortByName(err)) return true;
    if (signal?.aborted) return true;
    return false;
  }

  /**
  * Warn when isAbortError succeeds only through the signal fallback rather
  * than an abort-specific name or code.
   */
  private logIfSwallowedByAbortFallback(err: unknown, sessionKey: string): void {
    if (err instanceof Error && !this.isAbortByName(err)) {
      logger.warn('non-abort error swallowed by abort fallback', {
        sessionKey,
        errName: err.name,
        errMessage: err.message,
      });
    }
  }

  /**
   * Build an aborted result without compacted; run() adds that outer-loop flag.
   *
   * Empty lastContent means no LLM call started; otherwise it carries the final
   * assistant content observed before cancellation.
   *
   * accumulated preserves billed usage and completed tool rounds before abort.
   * The pre-run fast path can omit it because no LLM call occurred.
   */
  private buildAbortedResult(
    lastContent: ChatContentBlock[],
    accumulated?: { usage: TokenUsage; toolRounds: number },
  ): Omit<RunResult, 'compacted'> {
    return {
      text: this.extractText(lastContent),
      content: lastContent,
      stopReason: 'aborted',
      usage: accumulated?.usage ?? { inputTokens: 0, outputTokens: 0 },
      toolRounds: accumulated?.toolRounds ?? 0,
    };
  }

  // ── Public entry point ────────────────────────────────────

  async run(params: RunParams): Promise<RunResult> {
    const compaction = params.compaction ?? DEFAULT_COMPACTION_CONFIG;
    const inputBudgetTokens = resolveInputTokenBudget(
      params.resolvedModel.facts,
      compaction.reserveTokens,
      params.resolvedModel.invocationDefaults.outputTokenLimit,
    );

    // Explicit event context prevents nested or concurrent runs from mixing tags.
    const turnCtx: TurnContext = {
      sessionId: params.sessionId,
      turnId: params.turnId,
      requestId: params.requestId ?? params.turnId,
    };

    this.emit(turnCtx, { type: 'run_start', originMessageId: params.originMessageId });

    // Fast-path an already-aborted signal without making an LLM call. run_start
    // has already fired, so emit run_end to preserve event pairing.
    if (params.signal?.aborted) {
      const finalResult: RunResult = {
        ...this.buildAbortedResult([]),
        compacted: false,
      };
      this.emit(turnCtx, { type: 'run_end', result: finalResult });
      return finalResult;
    }

    // runAttempt persists the user message only after Layer 2 preflight, keeping
    // it out of history being compacted and avoiding duplicate writes on retry.

    let compactionAttempts = 0;
    let compacted = false;

    // Outer retry loop compacts the Session after ContextOverflowError.
    while (true) {
      try {
        const result = await this.runAttempt(turnCtx, params, inputBudgetTokens, compaction);
        const finalResult: RunResult = { ...result, compacted };
        this.emit(turnCtx, { type: 'run_end', result: finalResult });
        return finalResult;
      } catch (err) {
        // Defensive implementation of the section 4 "abort never throws" rule.
        // This catches cancellation concurrent with overflow and compaction.
        if (this.isAbortError(err, params.signal)) {
          this.logIfSwallowedByAbortFallback(err, params.sessionId);
          const finalResult: RunResult = {
            ...this.buildAbortedResult([]),
            compacted,
          };
          this.emit(turnCtx, { type: 'run_end', result: finalResult });
          return finalResult;
        }

        if (err instanceof ContextOverflowError && compactionAttempts < MAX_COMPACTION_RETRIES) {
          logger.info('compaction retry triggered', {
            sessionKey: params.sessionId,
            turnId: params.turnId,
            trigger: err.trigger,
            attempt: compactionAttempts + 1,
            maxAttempts: MAX_COMPACTION_RETRIES,
            reason: err.message,
          });
          // Persist an LLM summary, then retry against the reloaded compacted history.
          try {
            await this.compactHistory(turnCtx, params, compaction, err.trigger);
          } catch (compactErr) {
            // An abort during compaction returns cleanly under the section 4 contract.
            if (this.isAbortError(compactErr, params.signal)) {
              this.logIfSwallowedByAbortFallback(compactErr, params.sessionId);
              const finalResult: RunResult = {
                ...this.buildAbortedResult([]),
                compacted,
              };
              this.emit(turnCtx, { type: 'run_end', result: finalResult });
              return finalResult;
            }
            throw compactErr;
          }
          compacted = true;
          compactionAttempts++;
          continue;
        }

        // Propagate non-overflow failures and exhausted overflow retries.
        const error = err instanceof Error ? err : new Error(String(err));
        if (err instanceof ContextOverflowError) {
          logger.error('compaction retries exhausted', {
            sessionKey: params.sessionId,
            turnId: params.turnId,
            attempts: compactionAttempts,
            maxAttempts: MAX_COMPACTION_RETRIES,
            reason: err.message,
          });
        }
        this.emit(turnCtx, { type: 'error', error });
        throw error;
      }
    }
  }

  // ── Single attempt ────────────────────────────────────────

  /**
   * Execute one complete conversation attempt without the outer retry loop.
   *
   * After compactHistory, a retry reloads summarized rather than full history.
   */
  private async runAttempt(
    turnCtx: TurnContext,
    params: RunParams,
    inputBudgetTokens: number,
    compaction: CompactionConfig,
  ): Promise<Omit<RunResult, 'compacted'>> {
    const turnSignal = params.signal ?? new AbortController().signal;

    this.sanitizeSessionTail(turnCtx);

    await this.recoverPersistedToolLifecycle(params.sessionId);

    // Repair missing tool results from persisted state before loading history.
    await this.repairOrphanToolUses(turnCtx);

    let messages: ChatMessage[] = this.loadHistory(params.sessionId);

    // Layer 1 prunes individual historical tool results, not the current message.
    if (compaction.enabled) {
      messages = pruneToolResults(messages, compaction, inputBudgetTokens, (info) => {
        this.emit(turnCtx, {
          type: 'tool_result_pruned',
          toolUseId: info.toolUseId ?? `index:${info.index}`,
          originalChars: info.originalChars,
          prunedChars: info.prunedChars,
        });
      });
    }

    // Layer 2 routes before the current message is added to historical messages.
    if (compaction.enabled) {
      const budget = checkContextBudget({
        messages,
        systemPrompt: params.systemPrompt,
        currentPrompt: params.message,
        inputBudgetTokens,
        config: compaction,
      });

      logger.debug('context budget route', {
        sessionKey: params.sessionId,
        turnId: params.turnId,
        route: budget.route,
        estimatedTokens: budget.estimatedTokens,
        availableTokens: budget.availableTokens,
      });

      if (budget.route === 'truncate_tool_results_only') {
        // Layer 1.5 applies the aggregate tool-result budget without an LLM call.
        messages = pruneToolResultsAggregate(messages, inputBudgetTokens, compaction);
      } else if (budget.route === 'compact') {
        // Delegate preemptive LLM summarization to the outer retry loop.
        throw new ContextOverflowError(
          `Preemptive compaction required: estimated ${budget.estimatedTokens} tokens `
          + `exceeds budget ${budget.availableTokens} tokens`,
          'preemptive',
        );
      }
      // A fits route continues directly.
    }

    await this.sessionManager.appendMessage(params.sessionId, {
      turnId: params.turnId,
      role: 'user',
      content: params.message,
    });
    messages = [...messages, { role: 'user', content: params.message }];

    // Main LLM and tool-use loop.
    let totalUsage: TokenUsage = { inputTokens: 0, outputTokens: 0 };
    let totalToolRounds = 0;
    let lastContent: ChatContentBlock[] = [];
    let lastStopReason = 'end_turn';
    let llmCallCount = 0;
    let hasMoreToolCalls = true; // Ensures at least one LLM call.
    let steeringOpen = params.steeringSource !== undefined;
    let completionReserveHeld = false;
    let nextCallConsumesReserve = false;
    const toolFramework = new DefaultAsyncToolExecutionFramework({
      sessionManager: this.sessionManager,
      runtimeState: this.toolExecutionRuntimeState,
    });

    try {
      while (hasMoreToolCalls) {
        let steeringClaimedWhileWaiting = false;
        // Check for abort before every LLM call (core-abort-spec.md section 7.2).
        if (params.signal?.aborted) {
          throw new DOMException('Aborted', 'AbortError');
        }

        if (params.maxLlmCalls !== undefined && llmCallCount >= params.maxLlmCalls) {
          const text = this.extractText(lastContent);
          return {
            text,
            content: lastContent,
            stopReason: 'max_llm_calls',
            usage: totalUsage,
            toolRounds: totalToolRounds,
          };
        }

        this.emit(turnCtx, { type: 'llm_call', round: llmCallCount });
        llmCallCount++;
        const consumesCompletionReserve = nextCallConsumesReserve;
        nextCallConsumesReserve = false;

        // Stream the LLM response, normalizing API overflow and abort behavior.
        const llmResult = await this.callLLMStream(turnCtx, {
          system: params.systemPrompt,
          messages,
          tools: [...params.toolProjection.visibleDefinitions(params.toolPolicy)],
        }, params.resolvedModel, params.signal);

        totalUsage = {
          inputTokens: totalUsage.inputTokens + llmResult.usage.inputTokens,
          outputTokens: totalUsage.outputTokens + llmResult.usage.outputTokens,
        };

        lastContent = llmResult.content;
        lastStopReason = llmResult.stopReason;
        if (consumesCompletionReserve) completionReserveHeld = false;

        // Partial-stream branch: callLLMStream returns stopReason='aborted'.
        //
        // Invariant: params.signal is aborted here. If SDK-internal failures later
        // produce this result without flipping the signal, reassess IO handling.
        //
        // Persist a partial assistant only after receiving content. An abort before
        // content leaves the trailing user for the next Turn to sanitize.
        //
        // appendMessage uses normal IO handling; the section 7.1 signal fallback
        // preserves "abort never throws". The next Turn repairs orphan tool_use
        // blocks from persisted state.
        if (lastStopReason === 'aborted') {
          if (llmResult.content.length > 0) {
            messages.push({ role: 'assistant', content: llmResult.content });
            await this.sessionManager.appendMessage(params.sessionId, {
              turnId: params.turnId,
              role: 'assistant',
              content: llmResult.content,
              abortMeta: { partial: true, stopReason: 'aborted' },
            });
          }
          throw new DOMException('Aborted', 'AbortError');
        }

        const toolUseBlocks = llmResult.toolCalls;
        const lacksCompletionReserve = toolUseBlocks.length > 0
          && params.maxLlmCalls !== undefined
          && llmCallCount >= params.maxLlmCalls;

        messages.push({ role: 'assistant', content: llmResult.content });

        await this.sessionManager.appendMessage(params.sessionId, {
          turnId: params.turnId,
          role: 'assistant',
          content: llmResult.content,
          ...(lacksCompletionReserve ? { turnStopReason: 'max_llm_calls' as const } : {}),
        });

        // Abort was handled above, so only a normal error can return here.
        if (lastStopReason === 'error') {
          const text = this.extractText(lastContent);
          return { text, content: lastContent, stopReason: lastStopReason, usage: totalUsage, toolRounds: totalToolRounds };
        }

        for (const toolUse of toolUseBlocks) {
          const eventInput = toolUse.input.state === 'ready' ? toolUse.input.value : {};
          this.emit(turnCtx, {
            type: 'tool_call_requested',
            callId: toolUse.callId,
            name: toolUse.name,
            input: eventInput,
          });
        }

        if (toolUseBlocks.length === 0) {
          // Exit when the model requests no tools.
          hasMoreToolCalls = false;
        } else if (lacksCompletionReserve) {
          const unavailableBlocks: ChatContentBlock[] = toolUseBlocks.map((toolUse) => ({
            type: 'tool_result',
            tool_use_id: toolUse.callId,
            content: this.maxLlmCallsUnavailableContent(toolUse.name),
            status: 'error',
          }));
          for (const toolUse of toolUseBlocks) {
            this.emit(turnCtx, {
              type: 'tool_result',
              callId: toolUse.callId,
              name: toolUse.name,
              result: {
                status: 'error',
                content: this.maxLlmCallsUnavailableContent(toolUse.name),
              },
            });
          }
          messages.push({ role: 'user', content: unavailableBlocks });
          await this.sessionManager.appendMessage(params.sessionId, {
            turnId: params.turnId,
            role: 'toolResult',
            content: unavailableBlocks,
          });
          totalToolRounds++;
          return {
            text: this.extractText(lastContent),
            content: lastContent,
            stopReason: 'max_llm_calls',
            usage: totalUsage,
            toolRounds: totalToolRounds,
          };
        } else {
          completionReserveHeld = true;
          const admissions = await this.admitToolBatch(
            toolUseBlocks,
            params,
            turnSignal,
            toolFramework,
            (admission) => {
              if (admission.kind === 'accepted') {
                const eventInput = admission.toolUse.input.state === 'ready'
                  ? admission.toolUse.input.value
                  : {};
                this.emit(turnCtx, {
                  type: 'tool_use',
                  callId: admission.toolUse.callId,
                  executionId: admission.executionId,
                  name: admission.toolUse.name,
                  input: eventInput,
                });
                return;
              }
              this.emit(turnCtx, {
                type: 'tool_result',
                callId: admission.toolUse.callId,
                name: admission.toolUse.name,
                result: this.toPublicToolResult(admission.result, false),
              });
            },
          );
          const toolResultBlocks: ChatContentBlock[] = [];
          const immediateCalls: CompletedToolCall[] = [];
          for (const admission of admissions) {
            if (admission.kind === 'accepted') {
              toolResultBlocks.push({
                type: 'execution_accepted',
                tool_use_id: admission.toolUse.callId,
                execution_id: admission.executionId,
              });
              continue;
            }
            const completed: CompletedToolCall = {
              toolUse: admission.toolUse,
              result: admission.result,
              effectiveInput: admission.effectiveInput,
              implementationStarted: false,
            };
            immediateCalls.push(completed);
            toolResultBlocks.push({
              type: 'tool_result',
              tool_use_id: admission.toolUse.callId,
              content: admission.result.content,
              status: this.toPublicToolResult(admission.result, false).status,
            });
          }

          // Anthropic represents tool results as user-role messages.
          messages.push({ role: 'user', content: toolResultBlocks });

          const immediateBlocks = toolResultBlocks.filter(
            (block): block is Extract<ChatContentBlock, { type: 'tool_result' }> => (
              block.type === 'tool_result'
            ),
          );
          if (immediateBlocks.length > 0) {
            await this.sessionManager.appendMessage(params.sessionId, {
              turnId: params.turnId,
              role: 'toolResult',
              content: immediateBlocks,
            });
          }

          if (params.hookProjection.afterToolCall.length > 0 && immediateCalls.length > 0) {
            await Promise.all(immediateCalls.map((execution) => runAfterToolCall(
              params.hookProjection.afterToolCall,
              {
                toolName: execution.toolUse.name,
                input: execution.effectiveInput,
                result: execution.result,
                durationMs: execution.durationMs,
                implementationStarted: execution.implementationStarted,
                turnId: params.turnId,
                sessionId: params.sessionId,
              },
              turnSignal,
            )));
          }

          if (turnSignal.aborted) {
            throw new DOMException('Aborted', 'AbortError');
          }

          // Reapply Layer 1 after appending new tool results.
          if (compaction.enabled) {
            messages = pruneToolResults(messages, compaction, inputBudgetTokens);
          }

          totalToolRounds++;
        }

        if (toolFramework.hasUnsettledWork()) {
          const steeringMayUseBudget = params.maxLlmCalls === undefined
            || (completionReserveHeld
              ? llmCallCount + 1 < params.maxLlmCalls
              : llmCallCount < params.maxLlmCalls);
          steeringClaimedWhileWaiting = await this.waitForToolProgress(
            toolFramework,
            params,
            turnSignal,
            messages,
            turnCtx,
            steeringMayUseBudget,
          );
          if (!steeringClaimedWhileWaiting) nextCallConsumesReserve = true;
          hasMoreToolCalls = true;
        } else if (toolUseBlocks.length > 0 && !lacksCompletionReserve) {
          nextCallConsumesReserve = true;
        }

        if (turnSignal.aborted) {
          throw new DOMException('Aborted', 'AbortError');
        }

        // Never abandon an active Framework to compact. Tool execution and Host
        // completion persistence must converge before the outer retry can reload.
        if (compaction.enabled && !toolFramework.hasUnsettledWork()) {
          const estimated = estimatePromptTokens({ messages, systemPrompt: params.systemPrompt });
          if (estimated > inputBudgetTokens * INNER_LOOP_OVERFLOW_THRESHOLD) {
            logger.warn('inner-loop overflow threshold breached', {
              sessionKey: params.sessionId,
              turnId: params.turnId,
              estimatedTokens: estimated,
              inputBudgetTokens,
              thresholdPct: INNER_LOOP_OVERFLOW_THRESHOLD * 100,
            });
            throw new ContextOverflowError(
              `Context exceeds ${INNER_LOOP_OVERFLOW_THRESHOLD * 100}% threshold during tool loop `
              + `(estimated ${estimated} of ${inputBudgetTokens} tokens)`,
            );
          }
        }

        const steeringMayUseBudget =
          params.maxLlmCalls === undefined
          || (completionReserveHeld
            ? llmCallCount + 1 < params.maxLlmCalls
            : llmCallCount < params.maxLlmCalls);
        if (!steeringClaimedWhileWaiting && steeringOpen && steeringMayUseBudget) {
          const claimedMessages = params.steeringSource?.claimReady() ?? [];
          if (turnSignal.aborted) {
            throw new DOMException('Aborted', 'AbortError');
          }
          if (claimedMessages.length === 0) {
            steeringOpen = false;
          } else {
            const preparedMessages = params.prepareSteeringMessages
              ? await params.prepareSteeringMessages(claimedMessages)
              : claimedMessages;
            await this.appendInjectedMessages(
              params.sessionId,
              params.turnId,
              messages,
              preparedMessages,
            );
            hasMoreToolCalls = true;
          }
        }
      }

      const text = this.extractText(lastContent);
      return { text, content: lastContent, stopReason: lastStopReason, usage: totalUsage, toolRounds: totalToolRounds };
    } catch (err) {
      // Abort exit leaves orphan repair to the next Turn and returns gracefully.
      if (this.isAbortError(err, params.signal)) {
        // Preserve diagnostics when only the signal fallback classified the error.
        this.logIfSwallowedByAbortFallback(err, params.sessionId);
        await this.drainToolFrameworkAfterAbort(toolFramework, params, turnCtx, turnSignal);
        return this.buildAbortedResult(lastContent, {
          usage: totalUsage,
          toolRounds: totalToolRounds,
        });
      }
      if (toolFramework.hasUnsettledWork()) {
        await this.waitForToolProgress(
          toolFramework,
          params,
          turnSignal,
          messages,
          turnCtx,
          false,
        );
      }
      if (err instanceof ContextOverflowError || err instanceof AgentExecutionFailure) {
        throw err;
      }
      const error = err instanceof Error ? err : new Error(String(err));
      throw new AgentExecutionFailure(error.message, totalUsage, { cause: error });
    }
  }

  // ── Compaction ────────────────────────────────────────────

  /**
   * Summarize Session history with the LLM and persist the result.
   *
   * Loads current history, creates a summary, persists a CompactionRecord,
   * and emits compaction_start and compaction_end.
   *
   * The next loadHistory call truncates at firstKeptEntryId and injects the summary.
   *
   * @param trigger Compaction cause.
   */
  private async compactHistory(
    turnCtx: TurnContext,
    params: RunParams,
    compaction: CompactionConfig,
    trigger: 'preemptive' | 'overflow' | 'manual',
  ): Promise<void> {
    this.sanitizeSessionTail(turnCtx);

    const messages = this.loadHistory(params.sessionId);
    const estimatedTokens = estimatePromptTokens({ messages });
    const turnSignal = params.signal ?? new AbortController().signal;

    if (params.hookProjection.beforeCompaction.length > 0) {
      await runBeforeCompaction(params.hookProjection.beforeCompaction, {
        trigger,
        estimatedTokens,
        turnId: params.turnId,
        sessionId: params.sessionId,
      }, turnSignal);
      if (turnSignal.aborted) {
        throw new DOMException('Aborted', 'AbortError');
      }
    }

    this.emit(turnCtx, { type: 'compaction_start', trigger, estimatedTokens });

    // Generate the LLM summary.
    const compactResult = await compactMessages({
      messages,
      config: compaction,
      llmClient: params.resolvedModel.invocationPort,
      model: params.resolvedModel.identity.modelId,
      outputTokenLimit: params.resolvedModel.invocationDefaults.outputTokenLimit,
      trigger,
    });

    // Locate the first retained Session message, excluding the generated summary.
    const keptCount = compactResult.messages.length - 1;
    const allMessages = this.sessionManager.getMessages(params.sessionId);
    const firstKeptIndex = Math.max(0, allMessages.length - keptCount);
    const firstKeptEntryId = allMessages[firstKeptIndex]?.id ?? allMessages[0]?.id ?? '';

    // Persist the Compaction record in the Transcript.
    await this.sessionManager.appendCompactionRecord(
      params.sessionId,
      compactResult.record,
      firstKeptEntryId,
    );

    logger.info('compaction wrote record', {
      sessionKey: params.sessionId,
      turnId: params.turnId,
      trigger,
      firstKeptEntryId,
      tokensBefore: compactResult.stats.tokensBefore,
      tokensAfter: compactResult.stats.tokensAfter,
      droppedMessages: compactResult.stats.droppedMessages,
    });

    if (params.hookProjection.afterCompaction.length > 0) {
      await runAfterCompaction(params.hookProjection.afterCompaction, {
        trigger,
        tokensBefore: compactResult.stats.tokensBefore,
        tokensAfter: compactResult.stats.tokensAfter,
        droppedMessages: compactResult.stats.droppedMessages,
        turnId: params.turnId,
        sessionId: params.sessionId,
      }, turnSignal);
    }

    this.emit(turnCtx, {
      type: 'compaction_end',
      tokensBefore: compactResult.stats.tokensBefore,
      tokensAfter: compactResult.stats.tokensAfter,
      droppedMessages: compactResult.stats.droppedMessages,
    });

  }

  // ── Compaction-aware history loading ─────────────────────

  /**
   * Load Session history in the LLM client's ChatMessage format.
   *
   * With a Compaction record, retain messages from firstKeptEntryId onward and
   * prepend the summary.
   *
   * toolResult records become user-role messages for the Anthropic API.
   */
  private loadHistory(sessionKey: string): ChatMessage[] {
    const records = this.sessionManager.getMessages(sessionKey);
    const lifecycleRecords = this.sessionManager.getAsyncToolRecords(sessionKey);

    // Read the latest Compaction record, if any.
    const compactionRecord = this.sessionManager.getLastCompactionRecord(sessionKey);

    let effectiveRecords = records;
    if (compactionRecord) {
      // Keep history from the recorded boundary onward.
      const keptIndex = records.findIndex((r) => r.id === compactionRecord.firstKeptEntryId);
      if (keptIndex >= 0) {
        effectiveRecords = records.slice(keptIndex);
      }
    }

    // Preserve old empty aborted-assistant records on disk but omit their invalid
    // content from Provider input.
    const acceptedByParent = new Map<string, typeof lifecycleRecords>();
    const completionsByParent = new Map<string, typeof lifecycleRecords>();
    for (const record of lifecycleRecords) {
      if (record.type === 'tool_execution_accepted' && record.parentId) {
        const current = acceptedByParent.get(record.parentId) ?? [];
        acceptedByParent.set(record.parentId, [...current, record]);
      } else if (record.type === 'host_task_completion' && record.parentId) {
        const current = completionsByParent.get(record.parentId) ?? [];
        completionsByParent.set(record.parentId, [...current, record]);
      }
    }

    const messages: ChatMessage[] = [];
    for (let index = 0; index < effectiveRecords.length; index++) {
      const record = effectiveRecords[index]!;
      if (isEmptyAbortedAssistant(record)) continue;
      if (record.message.role === 'toolResult') {
        messages.push({ role: 'user', content: record.message.content });
        this.appendPersistedHostCompletions(messages, completionsByParent.get(record.id));
        continue;
      }

      messages.push({
        role: record.message.role,
        content: record.message.content,
      });

      const accepted = acceptedByParent.get(record.id)?.filter(
        (candidate) => candidate.type === 'tool_execution_accepted',
      ) ?? [];
      if (accepted.length > 0 && record.message.role === 'assistant') {
        const next = effectiveRecords[index + 1];
        const immediateBlocks = next?.parentId === record.id
          && next.message.role === 'toolResult'
          && Array.isArray(next.message.content)
          ? next.message.content.filter(
              (block): block is Extract<ContentBlock, { type: 'tool_result' }> => (
                block.type === 'tool_result'
              ),
            )
          : [];
        const acceptedByCallId = new Map(accepted.map((candidate) => [
          candidate.callId,
          candidate,
        ]));
        const immediateByCallId = new Map(immediateBlocks.map((block) => [
          block.tool_use_id,
          block,
        ]));
        const toolUses = Array.isArray(record.message.content)
          ? record.message.content.filter(
              (block): block is Extract<ContentBlock, { type: 'tool_use' }> => (
                block.type === 'tool_use'
              ),
            )
          : [];
        const paired: ChatContentBlock[] = [];
        for (const toolUse of toolUses) {
          const acceptedRecord = acceptedByCallId.get(toolUse.id);
          if (acceptedRecord) {
            paired.push({
              type: 'execution_accepted',
              tool_use_id: toolUse.id,
              execution_id: acceptedRecord.executionId,
            });
            continue;
          }
          const immediate = immediateByCallId.get(toolUse.id);
          if (immediate) paired.push(immediate);
        }
        if (paired.length > 0) messages.push({ role: 'user', content: paired });
        if (immediateBlocks.length > 0) {
          index++;
          this.appendPersistedHostCompletions(messages, completionsByParent.get(next!.id));
        }
      }
      this.appendPersistedHostCompletions(messages, completionsByParent.get(record.id));
    }

    // Prepend the summary so the LLM retains compacted context.
    if (compactionRecord) {
      messages.unshift({
        role: 'user',
        content: `[Previous conversation summary]\n\n${compactionRecord.summary}\n\n[End of summary. The conversation continues below.]`,
      });
    }

    return messages;
  }

  private appendPersistedHostCompletions(
    messages: ChatMessage[],
    records: ReturnType<SessionManager['getAsyncToolRecords']> | undefined,
  ): void {
    const completions = records?.filter(
      (record) => record.type === 'host_task_completion',
    ) ?? [];
    if (completions.length === 0) return;
    messages.push({
      role: 'user',
      origin: 'host',
      content: completions
        .map((record) => record.type === 'host_task_completion'
          ? renderHostTaskCompletion(record.completion)
          : '')
        .join('\n\n'),
    });
  }

  // ── Internal methods ──────────────────────────────────────

  /**
   * Stream an LLM call while emitting events and collecting its result.
   *
   * Context-overflow API errors become ContextOverflowError for the outer retry.
   * Abort flushes buffered text and returns stopReason='aborted' for runAttempt's
   * partial-stream handling.
   *
   * AnthropicClient yields tool_use only at content_block_stop, after input is
   * parsed, so incomplete tool-use blocks never reach ModelStreamEvent.
   */
  private async callLLMStream(
    turnCtx: TurnContext,
    params: {
      system?: string;
      messages: ChatMessage[];
      tools?: ToolDefinition[];
    },
    resolvedModel: ResolvedModel,
    signal?: AbortSignal,
  ): Promise<{
    content: ChatContentBlock[];
    toolCalls: ToolCall[];
    stopReason: string;
    usage: TokenUsage;
  }> {
    const contentBlocks: ChatContentBlock[] = [];
    const toolCalls: ToolCall[] = [];
    const toolCallIds = new Set<string>();
    let currentText = '';
    let stopReason = 'end_turn';
    let usage: TokenUsage = { inputTokens: 0, outputTokens: 0 };

    try {
      for await (const event of resolvedModel.invocationPort.chatStream({
        model: resolvedModel.identity.modelId,
        system: params.system,
        messages: params.messages,
        tools: params.tools,
        ...(resolvedModel.invocationDefaults.outputTokenLimit === undefined
          ? {}
          : { outputTokenLimit: resolvedModel.invocationDefaults.outputTokenLimit }),
        signal,
      })) {
        switch (event.type) {
          case 'text_delta':
            currentText += event.text;
            this.emit(turnCtx, { type: 'text_delta', text: event.text });
            break;

          case 'tool_call':
            if (event.call.callId.trim() === '' || event.call.name.trim() === '') {
              throw new Error('Canonical Tool Call id and name must be non-empty.');
            }
            if (toolCallIds.has(event.call.callId)) {
              throw new Error(`Duplicate canonical Tool Call id "${event.call.callId}".`);
            }
            toolCallIds.add(event.call.callId);
            if (currentText) {
              contentBlocks.push({ type: 'text', text: currentText });
              currentText = '';
            }
            toolCalls.push(event.call);
            contentBlocks.push({
              type: 'tool_use',
              id: event.call.callId,
              name: event.call.name,
              input: event.call.input.state === 'ready' ? { ...event.call.input.value } : {},
            });
            break;

          case 'message_end':
            stopReason = event.stopReason;
            usage = event.usage;
            break;

          case 'error':
            throw event.error;
        }
      }
    } catch (err) {
      // Abort takes precedence over overflow and returns for partial persistence.
      if (this.isAbortError(err, signal)) {
        this.logIfSwallowedByAbortFallback(err, turnCtx.sessionId);
        // Flush buffered text; tool_use blocks are already complete by construction.
        if (currentText) {
          contentBlocks.push({ type: 'text', text: currentText });
        }
        return {
          content: contentBlocks,
          toolCalls,
          stopReason: 'aborted',
          usage, // Best effort: an abort before message_end may hide billed usage.
        };
      }
      throw err;
    }

    if (currentText) {
      contentBlocks.push({ type: 'text', text: currentText });
    }

    return { content: contentBlocks, toolCalls, stopReason, usage };
  }

  private async admitToolBatch(
    toolUses: readonly ToolCall[],
    params: RunParams,
    turnSignal: AbortSignal,
    framework: AsyncToolExecutionFramework,
    onSettled: (admission: ToolAdmission) => void,
  ): Promise<ToolAdmission[]> {
    const admissionTasks: Array<Promise<ToolAdmission>> = [];
    for (const toolUse of toolUses) {
      const prepared = await this.prepareToolAdmission(toolUse, params, turnSignal);
      const task = prepared.kind === 'immediate'
        ? Promise.resolve(prepared)
        : this.completeToolAdmission(prepared, params, turnSignal, framework);
      admissionTasks.push(task.then((admission) => {
        onSettled(admission);
        return admission;
      }));
    }

    return Promise.all(admissionTasks);
  }

  private async prepareToolAdmission(
    toolUse: ToolCall,
    params: RunParams,
    turnSignal: AbortSignal,
  ): Promise<ImmediateToolAdmission | PreparedToolAdmission> {
    if (turnSignal.aborted) {
      return {
        kind: 'immediate',
        toolUse,
        result: this.canonicalToolResult(
          toolUse.callId,
          'not_executed',
          `Tool "${toolUse.name}" was not executed because the Turn was aborted.`,
        ),
        effectiveInput: toolUse.input.state === 'ready' ? { ...toolUse.input.value } : {},
        implementationStarted: false,
      };
    }

    if (toolUse.input.state === 'invalid') {
      return {
        kind: 'immediate',
        toolUse,
        result: this.canonicalToolResult(
          toolUse.callId,
          'invalid_input',
          `Invalid input for tool "${toolUse.name}": ${toolUse.input.reason}.`,
        ),
        effectiveInput: {},
        implementationStarted: false,
      };
    }

    const resolvedTool = params.toolProjection.resolve(toolUse.name);
    if (!resolvedTool) {
      return {
        kind: 'immediate',
        toolUse,
        result: this.canonicalToolResult(
          toolUse.callId,
          'unknown_tool',
          `Unknown tool: "${toolUse.name}".`,
        ),
        effectiveInput: { ...toolUse.input.value },
        implementationStarted: false,
      };
    }

    let effectiveInput = { ...toolUse.input.value };
    try {
      const beforeResult = await runBeforeToolCall(params.hookProjection.beforeToolCall, {
        toolName: toolUse.name,
        input: effectiveInput,
        turnId: params.turnId,
        sessionId: params.sessionId,
        signal: turnSignal,
      });
      effectiveInput = beforeResult.input;
      if (beforeResult.action === 'deny') {
        return {
          kind: 'immediate',
          toolUse,
          result: this.canonicalToolResult(
            toolUse.callId,
            'denied',
            `Tool blocked: ${beforeResult.reason}`,
          ),
          effectiveInput,
          implementationStarted: false,
        };
      }
    } catch (error) {
      const outcome: ToolResultOutcome = this.isAbortError(error, turnSignal)
        ? 'aborted'
        : 'failed';
      return {
        kind: 'immediate',
        toolUse,
        result: this.canonicalToolResult(
          toolUse.callId,
          outcome,
          `Tool interceptor failed: ${error instanceof Error ? error.message : String(error)}`,
        ),
        effectiveInput,
        implementationStarted: false,
      };
    }

    return {
      kind: 'prepared',
      toolUse: { ...toolUse, input: toolUse.input },
      resolvedTool,
      effectiveInput,
    };
  }

  private async completeToolAdmission(
    prepared: PreparedToolAdmission,
    params: RunParams,
    turnSignal: AbortSignal,
    framework: AsyncToolExecutionFramework,
  ): Promise<ToolAdmission> {
    const { toolUse, resolvedTool } = prepared;
    const effectiveInput = prepared.effectiveInput;
    const validation = resolvedTool.validator.validate(effectiveInput);
    if (!validation.valid) {
      const details = validation.errors
        .map((error) => `${error.instancePath || '/'} ${error.message}`)
        .join('; ');
      return {
        kind: 'immediate',
        toolUse,
        result: this.canonicalToolResult(
          toolUse.callId,
          'invalid_input',
          `Invalid input for tool "${toolUse.name}": ${details}`,
        ),
        effectiveInput,
        implementationStarted: false,
      };
    }

    const permissionMode = params.getSessionPermissionMode?.() ?? 'manual';
    const policyDecision = params.toolPolicy.decide(
      toolUse.name,
      effectiveInput,
      params.approvalCapability !== undefined,
      permissionMode,
    );
    if (policyDecision === 'allow' && permissionMode === 'allow_all') {
      logger.info('tool authorized by Session Allow All', {
        sessionId: params.sessionId,
        turnId: params.turnId,
        toolName: toolUse.name,
      });
    }
    if (policyDecision === 'deny') {
      return {
        kind: 'immediate',
        toolUse,
        result: this.canonicalToolResult(
          toolUse.callId,
          'denied',
          `Tool "${toolUse.name}" is denied by Application policy.`,
        ),
        effectiveInput,
        implementationStarted: false,
      };
    }

    if (policyDecision === 'requires_approval') {
      try {
        const approval = await params.approvalCapability!.request({
          callId: toolUse.callId,
          toolName: toolUse.name,
          input: effectiveInput,
          sessionId: params.sessionId,
          turnId: params.turnId,
        }, turnSignal);
        if (approval.outcome !== 'approved') {
          const outcome: ToolResultOutcome = approval.outcome === 'aborted'
            ? 'aborted'
            : approval.outcome === 'unavailable'
              ? 'unavailable'
              : approval.outcome === 'failed'
                ? 'failed'
                : 'denied';
          const reason = approval.outcome === 'failed'
            ? approval.message
            : approval.reason;
          return {
            kind: 'immediate',
            toolUse,
            result: this.canonicalToolResult(
              toolUse.callId,
              outcome,
              `Tool approval ${approval.outcome}: ${reason}.`,
            ),
            effectiveInput,
            implementationStarted: false,
          };
        }
      } catch (error) {
        const outcome: ToolResultOutcome = this.isAbortError(error, turnSignal)
          ? 'aborted'
          : 'failed';
        return {
          kind: 'immediate',
          toolUse,
          result: this.canonicalToolResult(
            toolUse.callId,
            outcome,
            `Tool approval failed: ${error instanceof Error ? error.message : String(error)}`,
          ),
          effectiveInput,
          implementationStarted: false,
        };
      }
    }

    if (turnSignal.aborted) {
      return {
        kind: 'immediate',
        toolUse,
        result: this.canonicalToolResult(
          toolUse.callId,
          'not_executed',
          `Tool "${toolUse.name}" was not executed because the Turn was aborted.`,
        ),
        effectiveInput,
        implementationStarted: false,
      };
    }

    try {
      const receipt = await framework.submit({
        callId: toolUse.callId,
        toolName: toolUse.name,
        unitId: resolvedTool.unitId,
        input: effectiveInput,
        execute: resolvedTool.execute,
      }, {
        sessionId: params.sessionId,
        turnId: params.turnId,
        subagentDepth: params.subagentDepth ?? 0,
        signal: turnSignal,
      });
      return {
        kind: 'accepted',
        toolUse,
        executionId: receipt.executionId,
        effectiveInput,
      };
    } catch (error) {
      if (!(error instanceof ToolExecutionUnavailableError)) throw error;
      return {
        kind: 'immediate',
        toolUse,
        result: this.canonicalToolResult(
          toolUse.callId,
          'unavailable',
          error.message,
        ),
        effectiveInput,
        implementationStarted: false,
      };
    }
  }

  private async waitForToolProgress(
    framework: AsyncToolExecutionFramework,
    params: RunParams,
    turnSignal: AbortSignal,
    messages: ChatMessage[],
    turnCtx: TurnContext,
    allowSteering: boolean,
  ): Promise<boolean> {
    const hostCompletions: string[] = [];
    while (framework.hasUnsettledWork()) {
      const event = allowSteering && params.steeringSource
        ? await this.waitForFrameworkOrSteering(framework, params.steeringSource, turnSignal)
        : {
            type: 'framework' as const,
            event: await framework.waitForNextEvent(turnSignal),
          };

      if (event.type === 'steering') {
        const claimed = params.steeringSource?.claimReady() ?? [];
        if (claimed.length === 0) continue;
        this.appendHostCompletionBatch(messages, hostCompletions);
        const prepared = params.prepareSteeringMessages
          ? await params.prepareSteeringMessages(claimed)
          : claimed;
        await this.appendInjectedMessages(
          params.sessionId,
          params.turnId,
          messages,
          prepared,
        );
        return true;
      }

      hostCompletions.push(await this.handleFrameworkEvent(
        event.event,
        params,
        turnSignal,
        turnCtx,
      ));
    }

    this.appendHostCompletionBatch(messages, hostCompletions);
    return false;
  }

  private async recoverPersistedToolLifecycle(sessionId: string): Promise<void> {
    const activeMessageIds = new Set(
      this.sessionManager.getMessages(sessionId).map((record) => record.id),
    );
    const records = this.sessionManager.getAsyncToolRecords(sessionId);
    const accepted = records.filter(
      (record): record is ToolExecutionAcceptedRecord => (
        record.type === 'tool_execution_accepted'
        && record.parentId !== null
        && activeMessageIds.has(record.parentId)
      ),
    );

    for (const acceptance of accepted) {
      let terminal = records.find(
        (record) => record.type === 'tool_execution_terminal'
          && record.executionId === acceptance.executionId,
      );
      if (!terminal) {
        await this.sessionManager.appendToolExecutionTerminal(sessionId, {
          executionId: acceptance.executionId,
          outcome: 'outcome_unknown',
          reason: 'host_recovery',
          content: `Tool "${acceptance.toolName}" did not retain a terminal outcome across Host recovery.`,
        });
        terminal = this.sessionManager.getAsyncToolRecords(sessionId).find(
          (record) => record.type === 'tool_execution_terminal'
            && record.executionId === acceptance.executionId,
        );
      }
      if (!terminal || terminal.type !== 'tool_execution_terminal') {
        throw new Error(
          `Tool execution "${acceptance.executionId}" recovery did not persist a terminal fact.`,
        );
      }

      const hasCompletion = this.sessionManager.getAsyncToolRecords(sessionId).some(
        (record) => record.type === 'host_task_completion'
          && record.completion.executionId === acceptance.executionId,
      );
      if (hasCompletion) continue;
      await this.sessionManager.appendHostTaskCompletion(sessionId, {
        turnId: acceptance.turnId,
        completion: {
          executionId: acceptance.executionId,
          toolName: acceptance.toolName,
          status: terminal.outcome === 'success'
            ? 'success'
            : terminal.outcome === 'failed'
              ? 'failed'
              : 'aborted',
          content: terminal.content,
        },
      });
    }
  }

  private async waitForFrameworkOrSteering(
    framework: AsyncToolExecutionFramework,
    steeringSource: NonNullable<RunParams['steeringSource']>,
    turnSignal: AbortSignal,
  ): Promise<
    | { readonly type: 'framework'; readonly event: TurnExecutionEvent }
    | { readonly type: 'steering' }
  > {
    if (turnSignal.aborted) throw new DOMException('Aborted', 'AbortError');
    const frameworkController = new AbortController();
    const steeringController = new AbortController();
    const onTurnAbort = () => {
      frameworkController.abort(turnSignal.reason);
      steeringController.abort(turnSignal.reason);
    };
    turnSignal.addEventListener('abort', onTurnAbort, { once: true });
    try {
      const winner = await Promise.race([
        framework.waitForNextEvent(frameworkController.signal).then((event) => ({
          type: 'framework' as const,
          event,
        })),
        steeringSource.waitUntilPotentiallyReady(steeringController.signal).then(() => ({
          type: 'steering' as const,
        })),
      ]);
      if (winner.type === 'framework') steeringController.abort();
      else frameworkController.abort();
      return winner;
    } finally {
      turnSignal.removeEventListener('abort', onTurnAbort);
    }
  }

  private async handleFrameworkEvent(
    event: TurnExecutionEvent,
    params: RunParams,
    turnSignal: AbortSignal,
    turnCtx: TurnContext,
  ): Promise<string> {
    if (event.type === 'execution_persistence_failed'
      || event.type === 'execution_invariant_failed') {
      throw event.error;
    }

    const result = this.canonicalToolResult(event.callId, event.outcome, event.content);
    this.emit(turnCtx, {
      type: 'tool_result',
      callId: event.callId,
      executionId: event.executionId,
      name: event.toolName,
      result: this.toPublicToolResult(result, true),
    });
    if (params.hookProjection.afterToolCall.length > 0) {
      await runAfterToolCall(params.hookProjection.afterToolCall, {
        toolName: event.toolName,
        input: { ...event.input },
        result,
        durationMs: event.durationMs,
        implementationStarted: event.implementationStarted,
        turnId: params.turnId,
        sessionId: params.sessionId,
      }, turnSignal);
    }

    const completion = {
      executionId: event.executionId,
      toolName: event.toolName,
      status: event.outcome === 'success'
        ? 'success' as const
        : event.outcome === 'failed'
          ? 'failed' as const
          : 'aborted' as const,
      content: event.content,
    };
    await this.sessionManager.appendHostTaskCompletion(params.sessionId, {
      turnId: params.turnId,
      completion,
    });
    return renderHostTaskCompletion(completion);
  }

  private appendHostCompletionBatch(messages: ChatMessage[], completions: string[]): void {
    if (completions.length === 0) return;
    messages.push({
      role: 'user',
      origin: 'host',
      content: completions.join('\n\n'),
    });
    completions.length = 0;
  }

  private canonicalToolResult(
    callId: string,
    outcome: ToolResultOutcome,
    content: string,
  ): CanonicalToolResult {
    return Object.freeze({ callId, outcome, content });
  }

  private maxLlmCallsUnavailableContent(toolName: string): string {
    return `Tool "${toolName}" was not executed because the Model-call limit left no completion call.`;
  }

  private async drainToolFrameworkAfterAbort(
    framework: AsyncToolExecutionFramework,
    params: RunParams,
    turnCtx: TurnContext,
    turnSignal: AbortSignal,
  ): Promise<void> {
    const drainSignal = new AbortController().signal;
    await this.sessionManager.appendTurnAborted(params.sessionId, params.turnId);
    while (framework.hasUnsettledWork()) {
      const event = await framework.waitForNextEvent(drainSignal);
      if (event.type === 'execution_terminal') {
        await this.handleFrameworkEvent(event, params, turnSignal, turnCtx);
      } else {
        logger.error('Tool Framework failed while draining an aborted Turn', {
          sessionId: params.sessionId,
          executionId: event.executionId,
          error: event.error.message,
          failureType: event.type,
        });
        return;
      }
    }
  }

  private toPublicToolResult(
    result: CanonicalToolResult,
    admitted: boolean,
  ): ToolResult {
    const status = result.outcome === 'success'
      ? 'success' as const
      : result.outcome === 'denied'
        ? 'denied' as const
        : result.outcome === 'aborted'
          || result.outcome === 'outcome_unknown'
          || (admitted && result.outcome === 'not_executed')
          ? 'aborted' as const
          : 'error' as const;
    return {
      content: result.content,
      status,
    };
  }

  /** Extract plain text from content blocks. */
  private extractText(content: ChatContentBlock[]): string {
    return content
      .filter((b): b is Extract<ChatContentBlock, { type: 'text' }> => b.type === 'text')
      .map((b) => b.text)
      .join('');
  }

  private async appendInjectedMessages(
    sessionKey: string,
    turnId: string,
    targetMessages: ChatMessage[],
    injectedMessages: ChatMessage[],
  ): Promise<void> {
    for (const message of injectedMessages) {
      if (message.origin === 'host') {
        throw new TypeError('Trusted Host messages cannot enter through steering injection.');
      }
      targetMessages.push(message);
      await this.sessionManager.appendMessage(sessionKey, {
        turnId,
        role: message.role,
        content: message.content,
      });
    }
  }

  /**
  * Emit an AgentEvent with explicit Turn context so nested and concurrent runs
  * are tagged independently without instance-level current-run state.
   */
  private emit(turnCtx: TurnContext, event: AgentEventInput): void {
    if (!this.onEvent) return;
    const correlated = event.type === 'run_start'
      || event.type === 'run_end'
      || event.type === 'error';
    this.onEvent({
      ...event,
      sessionId: turnCtx.sessionId,
      turnId: turnCtx.turnId,
      ...(correlated ? { requestId: turnCtx.requestId } : {}),
    } as AgentEvent);
  }
}

/**
 * Internal emit input with event identity omitted. The distributive conditional
 * retains each variant's discriminator; emit injects identity from TurnContext.
 */
type AgentEventInput = AgentEvent extends infer E
  ? E extends AgentEvent
    ? Omit<E, 'sessionId' | 'turnId' | 'requestId'>
    : never
  : never;
