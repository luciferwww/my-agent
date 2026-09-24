# Runner Execution

> Status: Current Authority
> Authority: Current implemented Runner behavior
> Verified: 2026-09-18
> Ownership: Turn loop, context budgeting, Compaction, Tool and Hook invocation, recovery, and Runner events
> Ownership key: runner-execution-and-context

## 1. Boundary

`src/core/runner/` is the Agent execution engine and owns `RunnerConfig` plus the Compaction leaf contract, immutable defaults, and semantic validation. For one Turn it consumes a resolved Provider-neutral invocation Port, immutable Tool and Hook projections, application Tool policy, and optional current-call approval capability. It joins [Session persistence](session.md), [Tool execution](tools.md), streaming Model invocation, context management, and steering into the conversation loop.

Runner does not load configuration, read environment variables, discover or register Units, select Providers, infer Model facts, manage Channel transport, or own root request-tree admission. Those responsibilities belong to [Runtime](runtime.md), [Model Resolution](model-resolution.md), and [Channels](channels.md).

## 2. Inputs and result

Runtime supplies Session and request identity, normalized input, one Turn-bound `ResolvedModel`, immutable Tool/Hook projections, Tool policy, optional Approval/steering capabilities, optional `maxLlmCalls`, Compaction policy, and Abort signal. Runner neither calls configuration loaders nor reads `process.env`. Omitted `maxLlmCalls` means no Model-call count limit.

`RunResult` contains final text, complete final Assistant blocks, stop reason, cumulative usage for completed Model calls, Tool-round count, and whether any Compaction retry occurred. Detailed Compaction statistics are events and persisted records rather than additional result fields.

## 3. Top-level lifecycle and recovery

`run()` builds an immutable `TurnContext`, emits lifecycle events, invokes `runAttempt()`, and routes normalized context overflow through `compactHistory()` before retry. `TurnContext` carries `sessionId`, `turnId`, and the effective `requestId` explicitly; Runner stores no mutable "current run" field.

An already-aborted Turn still emits the `run_start`/`run_end` pair but performs no Session append or Model call. Context recovery may perform at most three Compactions; each retry reloads persisted history.

## 4. Attempt preflight

Each `runAttempt()` performs these steps before Model invocation:

1. If the active Session branch ends in an isolated `user` message from a failed attempt, `sanitizeSessionTail()` branches back to its parent and emits `session_tail_sanitized`.
2. `repairOrphanToolUses()` inspects persisted tail state and appends synthetic Tool Results for incomplete Tool Use/Result pairs.
3. Runner reloads the current Session branch and applies Layer 1 in-memory Tool Result pruning.
4. Layer 2 estimates System prompt, history, and the current prompt separately.
5. If Tool-only reduction can cover overflow, Layer 1.5 aggregate pruning runs; if summary Compaction is required, preflight throws before persisting the current message.
6. After preflight succeeds, Runner persists and appends the current user message.

This delayed append keeps the current prompt out of summary input and prevents preemptive retries from duplicating it. Overflow later in an attempt can leave a trailing user; `compactHistory()` and the next attempt sanitize it before loading and re-appending.

### 4.1 Tail sanitation

Only a trailing `user` record is removed from the active branch. The JSONL record remains on disk because `branch()` changes only the in-memory leaf. A trailing `toolResult` is not discarded: Tool side effects may already have happened, so Runner logs and preserves it.

### 4.2 Orphan Tool Use repair

Runner repairs two tail forms:

- an Assistant tail containing Tool Uses and no Tool Result batch;
- an Assistant/Tool Result tail whose result IDs cover only some of the preceding Tool Uses.

Missing IDs receive `[tool call interrupted; session recovered]`. The event source is `abort` when the Assistant has partial-abort metadata and `recovered` otherwise. Repair is best-effort: persistence failure is logged and does not block the new Turn, so a later attempt can retry. Clean tails are unchanged.

## 5. Model and Tool loop

Each loop iteration must check Abort before quota, steering injection, event emission, and invocation. `AgentRunner` streams through the bound invocation Port, persists Assistant blocks, executes complete canonical Tool Calls in Provider order, persists one correlated Tool Result batch, settles observers, applies in-memory pruning, and then consumes steering for the next call.

An explicit positive quota counts actual Model calls, including a final call without Tools. The check occurs before each invocation, so Abort before a call consumes neither quota nor an `llm_call` event. Reaching it returns the last Assistant content with `stopReason='max_llm_calls'`; it does not throw. With no quota, Runner has no hidden numeric cutoff. Usage is summed from `message_end` records; if a later execution error occurs, `AgentExecutionFailure` carries usage already accumulated.

Steering is read after every completed loop iteration, not only Tool-producing ones. The reader uses consume-and-clear semantics. Runner filters malformed entries and accepts only messages with `user` or `assistant` role plus a `content` property. Every accepted item is persisted and appended separately in FIFO order; one ready batch produces one continuation Model call. Locally pending steering is dropped and logged on Abort or an explicit limit.

## 6. Tool and Hook semantics

Runner implements the pipeline described by [Tools and Hooks](../specifications/tools-and-hooks.md): one terminal correlated result per complete canonical Tool Call, sequential interceptors, isolated bounded observers, and whole-batch persistence. Approval remains a separate capability rather than a Hook.

## 7. Context management

`resolveInputTokenBudget`, `pruneToolResults`,
`pruneToolResultsAggregate`, `checkContextBudget`, and `compactMessages`
implement the current context-management stages. A known Prompt limit is the
input budget directly. Otherwise, a known total Context limit reserves the
smallest of configured headroom, ten percent of Context, and known maximum
output. If neither raw limit is known, Runner uses the Provider effective
fallback directly. Budgeting runs before current-message persistence; only
summary Compaction makes another Model call.

A `ContextOverflowError` can come from preflight (`preemptive`), the inner 90% threshold (`overflow`), or a Provider-neutral invocation Port that canonicalizes a Provider context overflow. Other Provider failures are not treated as context overflow.

## 8. Compaction

`compactHistory()` sanitizes a trailing user, reloads history, runs bounded pre-Compaction Observers, emits `compaction_start`, and calls `compactMessages()` through the same resolved invocation Port and Model identity.

Runtime supplies resolved Compaction policy. A direct Runner call that omits it uses the same Runner-owned `DEFAULT_COMPACTION_CONFIG`; there is no Platform copy of those literals.

The implementation protects Tool Use/Result pairing, writes a Compaction marker without deleting history, and reloads only the retained range on retry. [Runner Turn Flow](../specifications/runner-turn-flow.md) owns retry, persistence, and fallback semantics.

## 9. Abort and errors

`signal` reaches Model invocation, Tool execution, Interceptors, and Observer settlement. Runner stops scheduling new work, preserves completed Usage, and normalizes non-Abort execution failures as `AgentExecutionFailure`; [Abort](../specifications/abort.md) owns cancellation and closure semantics.

## 10. Events

Runner emits Turn-scoped Run, stream, Tool, context, and recovery events. Runtime emits queue, input, and Subagent lifecycle members of the same `AgentEvent` union; `request_end` closes a queued request that never started and carries request identity only.

## 11. Evidence

| Kind | Evidence |
|---|---|
| Source | [AgentRunner](../../src/core/runner/AgentRunner.ts), [Runner config](../../src/core/runner/config.ts), [context budget](../../src/core/runner/context/context-budget.ts) |
| Tests | [Runner tests](../../src/core/runner/AgentRunner.test.ts), [Tool pipeline tests](../../src/core/runner/AgentRunner.tool-pipeline.test.ts) |
| Controlling authority | [Runner Turn Flow](../specifications/runner-turn-flow.md), [Tools and Hooks](../specifications/tools-and-hooks.md), [Abort](../specifications/abort.md) |
