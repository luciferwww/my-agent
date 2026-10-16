# Approval Lifecycle Specification

> Status: Stable Authority
> Contract status: Implemented and Validated
> Verified: 2026-10-10
> Authority: Stable approval lifecycle contract

## Scope

This contract defines current-call Tool approval scoped to an existing Origin
Channel, or delivered to all candidate Channels when no Origin Channel exists.
It covers user decision, Turn Abort, Shutdown, delivery failure, and elevation
of the live Session to `allow_all`. Origin Client is source context, not Runtime
decision authority or a disconnect-settlement condition. It does not define
Automation scheduling, persistent authorization, approval expiry, retry, or
cross-process recovery.

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

`ApprovalRequest` and realtime interaction requests carry optional
`originChannelId` and `originClientId`, populated by Runtime from the Turn route.
`approval_requested` carries canonical Session, Turn, and Tool `callId`
correlation and no timeout. Clients do not infer association by Tool name or
latest pending position. Every settlement, including user Allow/Deny, notifies
Channel closure. WebSocket uses its existing event:

```ts
{ type: 'approval_closed'; id: string; sessionId: string; turnId: string; callId: string; outcome: ApprovalResult['outcome']; reason: string }
```

For an `approved` closure, `reason` is `session_allow_all` for policy elevation
or `user` for a current-call choice; other outcomes carry their terminal reason
or failure message. `ApprovalClosedResult` is the existing `ApprovalResult`.
Closure cleans up an already-exposed request even if the Channel cannot
currently accept new requests; CLI closes only its matching Approval ID.

## Delivery and pending query

Channel interaction is required. A Channel without interaction support returns
`unavailable/delivery_failed`, not user Deny. Runtime provides the Approval
capability without a separate static support check. At least one candidate
must accept delivery; per-adapter failures are logged without defeating a
sibling's accepted delivery. Only `approved` allows Tool execution.

`TurnInteractionManager.getPending(sessionId?)` returns detached current
requests, globally or filtered by exact Session ID, through shared Channel
capabilities. The manager is the only canonical registry. Each Channel reuses
its side-effect-free acceptance logic for realtime delivery and query results,
excluding a different Origin Channel. Querying does not create prompts or
deliver requests. Runtime validates responding Channel provenance against
canonical pending state; neither querying nor audience membership grants
additional decision authority.

Client caches and Session indicators are presentation state only. Shared
Session entries contain no pending flag.

## Session permission mode

Each live root Session has one Runtime-owned mode:

```ts
type SessionPermissionMode = 'manual' | 'allow_all';
```

`manual` uses normal deny, mandatory approval, allow-list, and current-call approval rules. `allow_all` automatically authorizes every registered Tool except an effective `tools.deny` match. The mode is process-local Runtime memory: it survives client disconnect, Turn completion, and later Turns, but it is not written to configuration, Session metadata, Transcript, Memory, Agent Context, or client storage. Runtime restart/resume, fork, and unarchive start in `manual`; archive and delete clear the state.

Root and Child executions read the root live Session mode at every Tool authorization. Revocation affects later Tool calls, not an implementation that already started. Changing from `manual` to `allow_all` settles only that Session's already-pending approvals as `{ outcome: 'approved', source: 'session_allow_all' }`; first settlement still wins.

## Lifecycle invariants

- Approval remains pending without a timer until a user choice or terminal lifecycle event.
- One pending entry retains source context and one Abort listener.
- Settlement removes the entry and cleans listeners before resolving or notifying.
- The first legal decision, Abort, Shutdown, or terminal delivery failure wins exactly once.
- Late responses are ignored and may be logged.
- Origin Channel scope is enforced for requests, responses, and closure;
  no-Origin requests permit decisions from candidate Channels.
- The active execution Turn's `AbortSignal` is passed directly; cancellation is not reconstructed from an ID lookup.
- Shutdown settles pending approvals as `aborted/shutdown` before Channels stop.
- Closure notification failure is contained after Promise settlement.
- A same-client socket replacement preserves the logical client route; a stale
  socket cannot decide. Client disconnection does not settle pending Approval.
  The dedicated unavailable callback/forwarding path is removed; another
  eligible Client or a reconnecting Client can query and decide the request.
- Tool-name deny remains final in both Session modes and never creates an approval request.
- Bundled chat stores pending data independently of loaded Tool cards and
  associates controls by exact Session, Turn, Call, and Approval identity.

## Failure mapping

| Condition | Result |
|---|---|
| Turn Abort | `aborted/turn` |
| Runtime Shutdown | `aborted/shutdown` |
| No delivery handler registered on the manager | `unavailable/origin_missing` |
| No candidate accepts, including zero Channels or all adapter failures | `unavailable/delivery_failed` |
| Individual Client disconnects | No settlement; request stays pending |
| Unhandled manager delivery-handler exception | `failed` |

Elapsed time alone has no state-transition meaning. Approval does not use Tool/Hook observer deadlines.
The existing result union retains `origin_disconnected`; Runtime no longer
produces it from Client connection loss.

## Acceptance scenarios

Validation covers indefinite waiting, all-outcome closure, legal competing
decisions, Origin Channel/no-Origin fanout, detached global/Session queries,
root and Child Abort, Shutdown, no accepting Channel, partial adapter failure,
disconnect retention, cross-client recovery, CLI matching-ID cancellation,
and WebSocket closure convergence. Chat validation remains small.

## Related authority

[Channels](../architecture/channels.md) owns current transport facts; [Runtime](../architecture/runtime.md) owns current routing and Shutdown facts; [Tools and Hooks](tools-and-hooks.md) owns Tool policy ordering; [Abort](abort.md) owns cross-cutting cancellation.
