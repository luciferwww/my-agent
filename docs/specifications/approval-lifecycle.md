# Approval Lifecycle Specification

> Status: Stable Authority
> Contract status: Implemented and Validated
> Verified: 2026-09-14
> Authority: Stable approval lifecycle contract

## Scope

This contract defines current-call, origin-bound Tool approval from request delivery through user decision, Turn Abort, Shutdown, origin failure, or elevation of the live Session to `allow_all`. It also defines the process-local Session permission switch. It does not define persistent authorization, approval expiry, retry, or cross-process recovery.

## Result contract

```ts
type ApprovalResult =
  | { outcome: 'approved' }
  | { outcome: 'approved'; source: 'session_allow_all' }
  | { outcome: 'denied'; reason: 'user' | 'user_cancelled' }
  | { outcome: 'aborted'; reason: 'turn' | 'shutdown' }
  | { outcome: 'unavailable'; reason: 'origin_missing' | 'delivery_failed' | 'origin_disconnected' }
  | { outcome: 'failed'; message: string };
```

Only `approved` authorizes execution. `source: 'session_allow_all'` records policy authorization and must not be represented as a user review of the specific Tool input. Every other outcome fails closed and retains its own classification; Abort or unavailability is not represented as user denial.

`approval_requested` carries no timeout. A non-user terminal outcome sends:

```ts
{ type: 'approval_closed'; id: string; outcome: 'approved' | 'aborted' | 'unavailable' | 'failed'; reason: string }
```

For an `approved` closure, `reason` is `session_allow_all`; otherwise it carries the existing terminal reason or bounded failure message. An `approved` closure is emitted only when a pending request is settled by a Session changing to `allow_all`. Approved and denied current-call choices are already visible to the submitting UI and do not emit `approval_closed`.

## Session permission mode

Each live root Session has one Runtime-owned mode:

```ts
type SessionPermissionMode = 'manual' | 'allow_all';
```

`manual` uses normal deny, mandatory approval, allow-list, and current-call approval rules. `allow_all` automatically authorizes every registered Tool except an effective `tools.deny` match. The mode is process-local Runtime memory: it survives client disconnect, Turn completion, and later Turns, but it is not written to configuration, Session metadata, Transcript, Memory, Agent Context, or client storage. Runtime restart/resume, fork, and unarchive start in `manual`; archive and delete clear the state.

Root and Child executions read the root live Session mode at every Tool authorization. Revocation affects later Tool calls, not an implementation that already started. Changing from `manual` to `allow_all` settles only that Session's already-pending approvals as `{ outcome: 'approved', source: 'session_allow_all' }`; first settlement still wins.

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
- Tool-name deny remains final in both Session modes and never creates an approval request.

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

## Related authority

[Channels](../architecture/channels.md) owns current transport facts; [Runtime](../architecture/runtime.md) owns current routing and Shutdown facts; [Tools and Hooks](tools-and-hooks.md) owns Tool policy ordering; [Abort](abort.md) owns cross-cutting cancellation.
