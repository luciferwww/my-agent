import type { ChatMessage, ChatContentBlock, TokenUsage } from '../model-invocation/index.js';
import { AgentExecutionFailure } from './errors.js';
import type { ResolvedModel } from '../model-resolution/index.js';
import type { SessionManager } from '../session/SessionManager.js';
import type { ContentBlock, MessageRecord } from '../session/types.js';
import type {
  AgentRunnerConfig,
  RunParams,
  RunResult,
  AgentEvent,
  ToolResult,
  PendingMessageReader,
  TurnContext,
} from './types.js';
import type {
  CanonicalToolResult,
  ToolExecutionContext,
  ToolCall,
  ToolDefinition,
  ToolResultOutcome,
} from '../tools/types.js';
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
  private onEvent?: (event: AgentEvent) => void;

  constructor(config: AgentRunnerConfig) {
    this.sessionManager = config.sessionManager;
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

      const last = records[records.length - 1]!.message;
      let orphanIds: string[] = [];
      let hint: MessageRecord['message']['abortMeta'] | undefined;

      // Case A: every tool_use in a trailing assistant message is orphaned.
      if (last.role === 'assistant' && Array.isArray(last.content)) {
        orphanIds = last.content
          .filter((b): b is Extract<ContentBlock, { type: 'tool_use' }> => b.type === 'tool_use')
          .map((b) => b.id);
        hint = last.abortMeta;
      }
      // Case B: a trailing toolResult covers only part of the preceding tool_use set.
      // Persisted results are excluded naturally, including the R6' abort path.
      else if (last.role === 'toolResult' && Array.isArray(last.content) && records.length >= 2) {
        const prev = records[records.length - 2]!.message;
        if (prev.role === 'assistant' && Array.isArray(prev.content)) {
          const useIds = new Set(
            prev.content
              .filter((b): b is Extract<ContentBlock, { type: 'tool_use' }> => b.type === 'tool_use')
              .map((b) => b.id),
          );
          const resultIds = new Set(
            last.content
              .filter((b): b is Extract<ContentBlock, { type: 'tool_result' }> => b.type === 'tool_result')
              .map((b) => b.tool_use_id),
          );
          orphanIds = [...useIds].filter((id) => !resultIds.has(id));
          hint = prev.abortMeta;
        }
      }

      if (orphanIds.length === 0) return;

      // Keep synthetic content neutral. source is audit metadata and does not
      // alter user-visible content. See core-abort-spec.md section 7.3.
      const source: 'abort' | 'recovered' = hint?.partial === true ? 'abort' : 'recovered';
      const content = '[tool call interrupted; session recovered]';
      const blocks: ContentBlock[] = orphanIds.map((id) => ({
        type: 'tool_result',
        tool_use_id: id,
        content,
      }));

      await this.sessionManager.appendMessage(sessionKey, {
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
    let pendingSteeringMessages: ChatMessage[] = [];

    try {
      while (hasMoreToolCalls || pendingSteeringMessages.length > 0) {
        // Check for abort before every LLM call (core-abort-spec.md section 7.2).
        //
        // Drained but uninjected steering messages are discarded on abort. This
        // narrow window is logged rather than emitted because RuntimeApp cannot
        // observe this local queue.
        if (params.signal?.aborted) {
          if (pendingSteeringMessages.length > 0) {
            logger.info('dropped pending steering on abort', {
              sessionKey: params.sessionId,
              count: pendingSteeringMessages.length,
            });
          }
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

        // Inject steering after preceding tool results and before the next LLM call.
        if (pendingSteeringMessages.length > 0) {
          await this.appendInjectedMessages(params.sessionId, messages, pendingSteeringMessages);
          pendingSteeringMessages = [];
        }

        this.emit(turnCtx, { type: 'llm_call', round: llmCallCount });
        llmCallCount++;

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
              role: 'assistant',
              content: llmResult.content,
              abortMeta: { partial: true, stopReason: 'aborted' },
            });
          }
          return this.buildAbortedResult(lastContent, {
            usage: totalUsage,
            toolRounds: totalToolRounds,
          });
        }

        messages.push({ role: 'assistant', content: llmResult.content });

        await this.sessionManager.appendMessage(params.sessionId, {
          role: 'assistant',
          content: llmResult.content,
        });

        // Abort was handled above, so only a normal error can return here.
        if (lastStopReason === 'error') {
          const text = this.extractText(lastContent);
          return { text, content: lastContent, stopReason: lastStopReason, usage: totalUsage, toolRounds: totalToolRounds };
        }

        const toolUseBlocks = llmResult.toolCalls;

        if (toolUseBlocks.length === 0) {
          // Exit when the model requests no tools.
          hasMoreToolCalls = false;
        } else {
          // Execute requested tools.
          const toolResultBlocks: ChatContentBlock[] = [];
          const afterToolCallSettlements: Promise<unknown>[] = [];
          for (const toolUse of toolUseBlocks) {
            // Event schema migration is outside Slice 3; retain the existing event shape.
            const eventInput = toolUse.input.state === 'ready' ? toolUse.input.value : {};
            this.emit(turnCtx, { type: 'tool_use', name: toolUse.name, input: eventInput });

            const execution = turnSignal.aborted
              ? {
                  result: this.canonicalToolResult(
                    toolUse.callId,
                    'not_executed',
                    `Tool "${toolUse.name}" was not executed because the Turn was aborted.`,
                  ),
                  effectiveInput: eventInput,
                  implementationStarted: false,
                }
              : await this.executeCanonicalToolCall(toolUse, params, turnSignal);

            const legacyResult = this.toLegacyToolResult(execution.result);
            this.emit(turnCtx, { type: 'tool_result', name: toolUse.name, result: legacyResult });
            toolResultBlocks.push({
              type: 'tool_result',
              tool_use_id: toolUse.callId,
              content: execution.result.content,
            });

            if (params.hookProjection.afterToolCall.length > 0) {
              afterToolCallSettlements.push(runAfterToolCall(params.hookProjection.afterToolCall, {
                toolName: toolUse.name,
                input: execution.effectiveInput,
                result: execution.result,
                durationMs: execution.durationMs,
                implementationStarted: execution.implementationStarted,
                turnId: params.turnId,
                sessionId: params.sessionId,
              }, turnSignal));
            }
          }

          // Anthropic represents tool results as user-role messages.
          messages.push({ role: 'user', content: toolResultBlocks });

          try {
            await this.sessionManager.appendMessage(params.sessionId, {
              role: 'toolResult',
              content: toolResultBlocks,
            });
          } finally {
            await Promise.all(afterToolCallSettlements);
          }

          if (turnSignal.aborted) {
            pendingSteeringMessages = await this.readPendingMessages(params.getSteeringMessages);
            if (pendingSteeringMessages.length > 0) {
              logger.info('dropped pending steering on abort', {
                sessionKey: params.sessionId,
                count: pendingSteeringMessages.length,
              });
            }
            return this.buildAbortedResult(lastContent, {
              usage: totalUsage,
              toolRounds: totalToolRounds,
            });
          }

          // Reapply Layer 1 after appending new tool results.
          if (compaction.enabled) {
            messages = pruneToolResults(messages, compaction, inputBudgetTokens);
          }

          // Check the proactive threshold before relying on an LLM API error.
          if (compaction.enabled) {
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

          totalToolRounds++;
        }

        // Read steering after every round for injection before the next LLM call.
        pendingSteeringMessages = await this.readPendingMessages(params.getSteeringMessages);
        if (turnSignal.aborted) {
          if (pendingSteeringMessages.length > 0) {
            logger.info('dropped pending steering on abort', {
              sessionKey: params.sessionId,
              count: pendingSteeringMessages.length,
            });
          }
          throw new DOMException('Aborted', 'AbortError');
        }
      }

      const text = this.extractText(lastContent);
      return { text, content: lastContent, stopReason: lastStopReason, usage: totalUsage, toolRounds: totalToolRounds };
    } catch (err) {
      // Abort exit leaves orphan repair to the next Turn and returns gracefully.
      if (this.isAbortError(err, params.signal)) {
        // Preserve diagnostics when only the signal fallback classified the error.
        this.logIfSwallowedByAbortFallback(err, params.sessionId);
        return this.buildAbortedResult(lastContent, {
          usage: totalUsage,
          toolRounds: totalToolRounds,
        });
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
    const messages: ChatMessage[] = effectiveRecords
      .filter((record) => !isEmptyAbortedAssistant(record))
      .map((record: MessageRecord) => {
        if (record.message.role === 'toolResult') {
          return { role: 'user' as const, content: record.message.content };
        }
        return {
          role: record.message.role as 'user' | 'assistant',
          content: record.message.content,
        };
      });

    // Prepend the summary so the LLM retains compacted context.
    if (compactionRecord) {
      messages.unshift({
        role: 'user',
        content: `[Previous conversation summary]\n\n${compactionRecord.summary}\n\n[End of summary. The conversation continues below.]`,
      });
    }

    return messages;
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

  private async executeCanonicalToolCall(
    toolUse: ToolCall,
    params: RunParams,
    turnSignal: AbortSignal,
  ): Promise<{
    result: CanonicalToolResult;
    effectiveInput: Record<string, unknown>;
    implementationStarted: boolean;
    durationMs?: number;
  }> {
    if (toolUse.input.state === 'invalid') {
      return {
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
        result: this.canonicalToolResult(
          toolUse.callId,
          outcome,
          `Tool interceptor failed: ${error instanceof Error ? error.message : String(error)}`,
        ),
        effectiveInput,
        implementationStarted: false,
      };
    }

    const validation = resolvedTool.validator.validate(effectiveInput);
    if (!validation.valid) {
      const details = validation.errors
        .map((error) => `${error.instancePath || '/'} ${error.message}`)
        .join('; ');
      return {
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

    const startTime = Date.now();
    const toolContext: ToolExecutionContext = {
      sessionId: params.sessionId,
      subagentDepth: params.subagentDepth ?? 0,
      turnId: params.turnId,
      callId: toolUse.callId,
      signal: turnSignal,
    };
    try {
      const result = await resolvedTool.execute(effectiveInput, toolContext);
      return {
        result: this.canonicalToolResult(
          toolUse.callId,
          result.outcome,
          result.content,
        ),
        effectiveInput,
        implementationStarted: true,
        durationMs: Date.now() - startTime,
      };
    } catch (error) {
      const outcome: ToolResultOutcome = this.isAbortError(error, turnSignal)
        ? 'aborted'
        : 'failed';
      return {
        result: this.canonicalToolResult(
          toolUse.callId,
          outcome,
          `Error executing tool "${toolUse.name}": ${error instanceof Error ? error.message : String(error)}`,
        ),
        effectiveInput,
        implementationStarted: true,
        durationMs: Date.now() - startTime,
      };
    }
  }

  private canonicalToolResult(
    callId: string,
    outcome: ToolResultOutcome,
    content: string,
  ): CanonicalToolResult {
    return Object.freeze({ callId, outcome, content });
  }

  private toLegacyToolResult(result: CanonicalToolResult): ToolResult {
    return {
      content: result.content,
      isError: result.outcome !== 'success',
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
    targetMessages: ChatMessage[],
    injectedMessages: ChatMessage[],
  ): Promise<void> {
    for (const message of injectedMessages) {
      targetMessages.push(message);
      await this.sessionManager.appendMessage(sessionKey, {
        role: message.role,
        content: message.content,
      });
    }
  }

  private async readPendingMessages(reader?: PendingMessageReader): Promise<ChatMessage[]> {
    if (!reader) {
      return [];
    }

    const result = await reader();
    if (!Array.isArray(result)) {
      return [];
    }

    return result.filter((message): message is ChatMessage => {
      if (!message || typeof message !== 'object') {
        return false;
      }
      if (message.role !== 'user' && message.role !== 'assistant') {
        return false;
      }
      return Object.hasOwn(message, 'content');
    });
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
