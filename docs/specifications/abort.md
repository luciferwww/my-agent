# Abort Specification

> Status: Stable Authority
> Contract status: Implemented and Validated
> Verified: 2026-10-02
> Authority: Stable cross-cutting Abort contract

## Scope

This contract defines session-local Turn Abort across Runtime, Runner, Model Invocation, Tools, approval, observers, and blocking Children. Abort is distinct from ordinary failure and does not promise a fixed wall-clock stop time.

## Runtime command

`abortTurn(sessionId)` synchronously signals the active tree, removes every unclaimed message from the Session FIFO, and returns `{ aborted, dropped }`. It is idempotent and isolated by Session. Claimed messages already belong to the active Turn and are not counted as queued drops.

Each dropped request emits one `request_end` outcome `cancelled` with reason `abort_queue_drop`. Runtime emits `messages_dropped` only when at least one FIFO item was removed. Subscriber failure cannot make `abortTurn` throw.

## Runner behavior

- Abort before execution emits `run_start` then `run_end` with `stopReason: 'aborted'`, without Session append or Model invocation.
- Streaming Abort flushes non-empty buffered Assistant text and persists it with `abortMeta: { partial: true, stopReason: 'aborted' }`.
- Empty partial Assistant content is not persisted or sent later to a Provider.
- Abort prevents new Model calls and later Tool implementations from starting.
- Accepted Tool executions are cancelled through the Framework. Real completion wins; confirmed cancellation is aborted; unstarted calls are `not_executed`.
- If an implementation ignores Abort beyond the fixed grace period, Framework persists `outcome_unknown`, transfers the Promise and slot to quarantine, disables new admission for that Tool registration, and lets the Turn converge without claiming that side effects stopped.
- Root Abort persists `turn_aborted`, starts no later Model call, and waits until every accepted execution has terminalized or been isolated. Any trailing trusted Host completion is consumed by the next non-aborted Turn.
- Unknown/crash/persistence repair remains a next-Turn safety net. Accepted-without-terminal becomes `outcome_unknown`; terminal-without-Host-delivery is delivered once; neither path replays a Tool.
- Completed Usage and Tool-round counts survive an aborted result.

## Propagation and Child Turns

Runtime owns one active tree signal per root Turn. The Framework derives one execution-local signal per accepted Tool and propagates Root Abort into each signal. Subagent delegation validates the original Parent signal as authority but runs each Child with its Task execution signal, so targeted cancellation affects only that Child while Parent Abort reaches all siblings. Parent Abort during setup, resolution, or execution yields one terminal Child result and one terminal event; no accepted Child remains detached.

## Channel surfaces

CLI Ctrl+C aborts the active Turn; a second Ctrl+C within the configured exit window terminates the host, while Ctrl+C with no active Turn reports that state. WebSocket accepts `{ type: 'abort_turn', sessionId }`; completion remains observable through normal events.

## Shutdown and deadlines

Shutdown closes admission, attempts graceful drain, signals Abort after the graceful boundary, classifies nonconverged work, and performs cleanup under one monotonic Runtime deadline budget. The report outcome is `completed` or `deadline-exhausted`. A sealed request outcome cannot be rewritten by late worker completion, and generation pins are not released before actual worker convergence.

Signal state changes synchronously, but Provider SDKs, Tools, observers, event-loop load, and OS process behavior determine convergence time.

## Acceptance scenarios

Cover Abort before start; during streaming with and without partial content; between multiple Tools; active-only, queue-only, and mixed active/queued state; no-op Abort; cross-session isolation; unclaimed FIFO removal; event-subscriber failure; CLI/WebSocket commands; Parent Abort during Child stages; graceful Shutdown; Abort convergence; deadline exhaustion; and unknown orphan repair.

## Related authority

[ADR-001](../decisions/adr-001-tool-result-closure-and-recovery.md) owns Tool closure/recovery; [Runner Turn Flow](runner-turn-flow.md) owns loop/persistence detail; [Subagent Model Resolution](subagent-model-resolution.md) owns Child terminalization.
