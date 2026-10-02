# Runner Turn Flow Specification

> Status: Stable Authority
> Contract status: Implemented and Validated
> Verified: 2026-10-02
> Authority: Stable Runner Turn-flow contract

## Scope

Runner owns one Turn's Provider-neutral execution loop, delayed current-user persistence, Tool/Hook execution, steering consumption, context budgeting, Compaction recovery, Usage accumulation, and correlated Runner events. Runtime owns admission, queues, routes, generation capture, and Shutdown.

## Flow

```text
run
  -> create TurnContext and emit run_start
  -> early Abort check
  -> runAttempt
      -> sanitize trailing user
      -> recover accepted/terminal/Host-completion lifecycle
      -> load persisted branch
      -> prune / budget preflight
      -> persist current user
      -> Model / Tool / steering loop
      -> persist Assistant and ordered accepted/immediate pairing
      -> supervise concurrent executions and wakeable steering
      -> persist terminal facts and trusted Host completions
  -> emit run_end
```

On normalized context overflow, Runner performs blocking Compaction, commits through Session, settles bounded observers, and retries. Current implementation permits at most three Compaction retries.

## Invariants

- Preflight failure does not persist current user input; current user text is excluded from Compaction input.
- A failed attempt detaches its trailing user from the active in-memory branch; append-only JSONL remains unchanged.
- `sanitizeSessionTail()` runs at attempt and Compaction entry; a trailing Tool Result is preserved because side effects may have occurred.
- Persistence metadata such as `abortMeta` is omitted from Provider history.
- One Turn uses one Resolved Model binding through Tool rounds and Compaction retries; Runner never selects Providers or infers facts.
- Every actual Model call receives a fresh invocation identity. Runner uses the
  shared stream collector to preserve text/Tool/Thinking order, persists the
  internal replay envelope, and projects only safe Thinking text/status in
  public results.
- Complete before-hook chains execute sequentially in Provider order. Calls then pass validation/policy/Approval and enter the Framework independently; implementation Promises may settle out of order.
- The original response is a Provider-order pairing barrier. Accepted ownership closes an admitted call once; its real terminal outcome is a later trusted Host completion, not a second result for the original call ID.
- Abort prevents later Tool starts and waits for Framework terminalization or quarantine isolation before the Turn returns.
- Compaction keeps atomic Tool Call/accepted-or-immediate-result exchanges intact, retains undelivered Host completions, and must make measurable progress.
- Runtime places every accepted Channel user message in one per-Session FIFO.
- At an eligible safe point Runner synchronously claims the largest contiguous
  compatible FIFO prefix, persists each message separately, and performs one
  continuation Model call for the batch.
- Runner checks Abort and Model-call capacity before claim. An empty claim is
  the final steering boundary for that Turn; claimed input is at-most-once.
- `maxLlmCalls` is an optional positive integer. Omission means no Model-call
  count limit; there is no hidden fallback. Active Tool work holds one shared
  completion reserve. Tool Calls returned by the last available call are paired
  unavailable without running Hook, Approval, or Tool work, and return with
  `stopReason='max_llm_calls'`.
- Nested and concurrent runs keep event correlation through explicit Turn context.
- Complete Provider replay makes local token sizing unavailable rather than
  falsely fitting at zero. Runner records a content-free warning and lets the
  Provider enforce the first request; normalized overflow continues through the
  existing bounded Compaction retry path.

## Failure and events

Only normalized context overflow enters bounded Compaction recovery. Other non-Abort failures become `AgentExecutionFailure` with accumulated Usage and are rethrown after an `error` event. Provider `stopReason: 'error'` remains a normal Runner result. Abort returns an aborted result rather than an execution error. There is no Runner-local drained steering buffer.

Events include run/model-call lifecycle, `thinking_start/delta/end`,
call-correlated Tool requested/accepted/terminal presentation, Compaction,
sanitation, recovery, `run_end`, and `error`. Public Thinking events contain a
stable local ID and readable text/status only. Opaque-only blocks emit no public
card lifecycle. Observer settlement is bounded and cannot mutate a settled
result.

## Acceptance scenarios

Cover empty Session, normal Turn, omitted and explicit Model-call limits with completion reserve, preflight overflow, post-persistence overflow and sanitation, multiple bounded retries, trailing-user idempotence, lifecycle recovery without replay, Layer 1 and aggregate pruning, compatible-prefix steering batches, invalid/unknown/denied/unavailable/failed/aborted Tools, ordered hooks plus concurrent multi-Tool settlement, pending sibling Approval, Abort at each phase, quarantine/late settlement, Usage after Abort/failure, Compaction persistence and next-Turn loading, and complete call/execution correlation.

## Related authority

[Abort](abort.md) owns cross-cutting cancellation, [Tools and Hooks](tools-and-hooks.md) owns Tool/Hook contracts, [ADR-002](../decisions/adr-002-context-budgeting-and-compaction-recovery.md) owns budgeting/Compaction decisions, and [Session](../architecture/session.md) records current persistence behavior.
