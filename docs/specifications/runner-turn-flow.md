# Runner Turn Flow Specification

> Status: Stable Authority
> Contract status: Implemented and Validated
> Verified: 2026-09-14
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
      -> repair orphan Tool Results
      -> load persisted branch
      -> prune / budget preflight
      -> persist current user
      -> Model / Tool / steering loop
      -> persist Assistant and Tool Result records
  -> emit run_end
```

On normalized context overflow, Runner performs blocking Compaction, commits through Session, settles bounded observers, and retries. Current implementation permits at most three Compaction retries.

## Invariants

- Preflight failure does not persist current user input; current user text is excluded from Compaction input.
- A failed attempt detaches its trailing user from the active in-memory branch; append-only JSONL remains unchanged.
- `sanitizeSessionTail()` runs at attempt and Compaction entry; a trailing Tool Result is preserved because side effects may have occurred.
- Persistence metadata such as `abortMeta` is omitted from Provider history.
- One Turn uses one Resolved Model binding through Tool rounds and Compaction retries; Runner never selects Providers or infers facts.
- Tool Calls execute sequentially in Provider order and each complete call receives one terminal correlated result.
- Abort prevents later Tool starts.
- Compaction keeps atomic Tool Call/Result exchange groups intact and must make measurable progress.
- Steering is consumed after each loop iteration according to configured mode.
- Nested and concurrent runs keep event correlation through explicit Turn context.

## Failure and events

Only normalized context overflow enters bounded Compaction recovery. Other non-Abort failures become `AgentExecutionFailure` with accumulated Usage and are rethrown after an `error` event. Provider `stopReason: 'error'` remains a normal Runner result. Abort returns an aborted result rather than an execution error.

Events include run/model-call lifecycle, Tool use/result, Compaction, sanitation, orphan repair, `run_end`, and `error`. Observer settlement is bounded and cannot mutate a settled result.

## Acceptance scenarios

Cover empty Session, normal Turn, preflight overflow, post-persistence overflow and sanitation, multiple bounded retries, trailing-user idempotence, trailing Tool Result preservation, Layer 1 and aggregate pruning, invalid/unknown/denied/unavailable/failed/aborted Tools, sequential multi-Tool calls, Abort at each phase, Usage after Abort/failure, Compaction persistence and next-Turn loading, and complete event correlation.

## Ownership and evidence

[Abort](abort.md) owns cross-cutting cancellation, [Tools and Hooks](tools-and-hooks.md) owns Tool/Hook contracts, [ADR-002](../decisions/adr-002-context-budgeting-and-compaction-recovery.md) owns budgeting/Compaction decisions, and [Session](../architecture/session.md) records current persistence behavior.

Evidence: [AgentRunner](../../src/core/runner/AgentRunner.ts), [Runner tests](../../src/core/runner/AgentRunner.test.ts), [Tool pipeline tests](../../src/core/runner/AgentRunner.tool-pipeline.test.ts), and [Compaction tests](../../src/core/runner/context/compaction.test.ts).
