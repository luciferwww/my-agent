# Approval Lifecycle Specification

> Status: Stable Authority
> Contract status: Implemented and Validated
> Verified: 2026-09-14
> Authority: Stable approval lifecycle contract

## Scope

This contract defines current-call, origin-bound Tool approval from request delivery through user decision, Turn Abort, Shutdown, or origin failure. It does not define persistent authorization, “allow all”, approval expiry, retry, or cross-process recovery.

## Result contract

```ts
type ApprovalResult =
  | { outcome: 'approved' }
  | { outcome: 'denied'; reason: 'user' | 'user_cancelled' }
  | { outcome: 'aborted'; reason: 'turn' | 'shutdown' }
  | { outcome: 'unavailable'; reason: 'origin_missing' | 'delivery_failed' | 'origin_disconnected' }
  | { outcome: 'failed'; message: string };
```

Only `approved` authorizes execution. Every other outcome fails closed and retains its own classification; Abort or unavailability is not represented as user denial.

`approval_requested` carries no timeout. A non-user terminal outcome sends:

```ts
{ type: 'approval_closed'; id: string; outcome: 'aborted' | 'unavailable' | 'failed'; reason: string }
```

Approved and denied choices are already visible to the submitting UI and do not emit `approval_closed`.

## Lifecycle invariants

- Approval remains pending without a timer until a user choice or terminal lifecycle event.
- One pending entry has one origin binding and one Abort listener.
- Settlement removes the entry and cleans listeners before resolving or notifying.
- The first user decision, Abort, disconnect, or delivery/adapter failure wins exactly once.
- Late responses are ignored and may be logged.
- Turns and origins are isolated.
- The active execution Turn's `AbortSignal` is passed directly; cancellation is not reconstructed from an ID lookup.
- Shutdown settles pending approvals as `aborted/shutdown` before Channels stop.
- Closure notification failure is contained after Promise settlement.
- A same-client socket replacement preserves the logical client route; a stale socket cannot decide, while loss of the current socket produces `origin_disconnected`.

## Failure mapping

| Condition | Result |
|---|---|
| Turn Abort | `aborted/turn` |
| Runtime Shutdown | `aborted/shutdown` |
| Missing route/capability | `unavailable/origin_missing` |
| Request delivery rejection | `unavailable/delivery_failed` |
| Current origin disconnects | `unavailable/origin_disconnected` |
| Adapter exception | `failed` |

Elapsed time alone has no state-transition meaning. Approval does not use Tool/Hook observer deadlines.

## Acceptance scenarios

Validation must cover indefinite waiting, allow/deny exactly once, late-response suppression, root and Child Abort, bounded Shutdown, missing capability, delivery failure, disconnect, same-client replacement, CLI cancellation, WebSocket `approval_closed`, and absence of timeout/expiry behavior.

## Ownership and evidence

[Channels](../architecture/channels.md) owns current transport facts; [Runtime](../architecture/runtime.md) owns current routing and Shutdown facts; [Tools and Hooks](tools-and-hooks.md) owns Tool policy ordering; [Abort](abort.md) owns cross-cutting cancellation.

Evidence: [Approval types](../../src/core/approval/types.ts), [TurnInteractionManager](../../src/runtime/turn-interaction/TurnInteractionManager.ts), [manager tests](../../src/runtime/turn-interaction/TurnInteractionManager.test.ts), [CLI tests](../../src/builtins/channels/cli/CliChannel.test.ts), and [WebSocket tests](../../src/builtins/channels/websocket/WebSocketChannel.test.ts).
