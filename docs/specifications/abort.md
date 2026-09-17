# Abort Specification

> Status: Stable Authority
> Contract status: Implemented and Validated
> Verified: 2026-09-14
> Authority: Stable cross-cutting Abort contract

## Scope

This contract defines session-local Turn Abort across Runtime, Runner, Model Invocation, Tools, approval, observers, and blocking Children. Abort is distinct from ordinary failure and does not promise a fixed wall-clock stop time.

## Runtime command

`abortTurn(sessionKey)` synchronously signals the active tree, removes normal queued requests, discards pending steering, and returns `{ aborted, dropped }`. It is idempotent and isolated by session. `dropped` counts normal queued requests only.

Each dropped request settles once with `request_end` outcome `cancelled` and reason `abort_queue_drop`. Runtime emits `messages_dropped` only when at least one normal queued request was removed. Subscriber failure cannot make `abortTurn` throw.

## Runner behavior

- Abort before execution emits `run_start` then `run_end` with `stopReason: 'aborted'`, without Session append or Model invocation.
- Streaming Abort flushes non-empty buffered Assistant text and persists it with `abortMeta: { partial: true, stopReason: 'aborted' }`.
- Empty partial Assistant content is not persisted or sent later to a Provider.
- Abort prevents new Model calls and later Tool implementations from starting.
- Complete Tool Calls receive terminal correlated results before settlement: real completion wins; confirmed cancellation is aborted; unstarted calls are `not_executed`.
- Unknown/crash/persistence repair remains a next-Turn safety net. It synthesizes only missing Provider-facing Tool Result pairings with neutral recovery content, does not claim cancellation or execution failure, and never replays a Tool.
- Completed Usage and Tool-round counts survive an aborted result.

## Propagation and Child Turns

Runtime owns one active tree signal per root Turn. Accepted blocking Children share Parent cancellation through the delegation contract. Parent Abort during setup, resolution, or execution yields one terminal Child result and one terminal event; no accepted Child remains detached.

## Channel surfaces

CLI Ctrl+C aborts the active Turn; a second Ctrl+C within the configured exit window terminates the host, while Ctrl+C with no active Turn reports that state. WebSocket accepts `{ type: 'abort_turn', sessionKey }`; completion remains observable through normal events.

## Shutdown and deadlines

Shutdown closes admission, attempts graceful drain, signals Abort after the graceful boundary, classifies nonconverged work, and performs cleanup under one monotonic Runtime deadline budget. The report outcome is `completed` or `deadline-exhausted`. A sealed request outcome cannot be rewritten by late worker completion, and generation pins are not released before actual worker convergence.

Signal state changes synchronously, but Provider SDKs, Tools, observers, event-loop load, and OS process behavior determine convergence time.

## Acceptance scenarios

Cover Abort before start; during streaming with and without partial content; between multiple Tools; active-only, queue-only, and mixed active/queued state; no-op Abort; cross-session isolation; steering discard; event-subscriber failure; CLI/WebSocket commands; Parent Abort during Child stages; graceful Shutdown; Abort convergence; deadline exhaustion; and unknown orphan repair.

## Related authority

[ADR-001](../decisions/adr-001-tool-result-closure-and-recovery.md) owns Tool closure/recovery; [Runner Turn Flow](runner-turn-flow.md) owns loop/persistence detail; [Subagent Model Resolution](subagent-model-resolution.md) owns Child terminalization.
