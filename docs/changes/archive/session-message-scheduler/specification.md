# Session Message Scheduler Specification

> Status: Validated
> Date: 2026-11-11
> Owner: Project owner
> Related Plan/Decision: [Plan](plan.md), [Proposed decision](decision.md)

## Purpose and boundaries

Provide one private Runtime owner for existing Session message scheduling
state, with no public behavior change. Use one concrete implementation in
`src/runtime/session-message-scheduler.ts`; do not add a generic scheduling
interface, factory, or new public barrel export.

| Owner | Responsibilities |
|---|---|
| Session scheduler | FIFO storage, Root busy/reservation fact, synchronous standalone dequeue, compatible-prefix claim, pending-message removal, wake-only waiters, read-only work queries |
| RuntimeApp | Intake validation and phase checks, actual launch, request gates, Turn IDs, routing, events, Abort controllers, generation pins, Agent policy selection, Shutdown budget and worker tracking |
| Runner | Eligible safe-point timing, Abort/capacity checks, persistence/injection of claimed input, final empty-claim boundary |

The scheduler may use the existing queued payload type and accept a synchronous
compatibility predicate. It must not import RuntimeApp, execute Turns, own
Provider resources, or emit Runtime/Channel events. RuntimeApp must not retain
shadow FIFO, busy, or waiter collections.

## Scheduling and queries

1. Every accepted Root user message enters the same per-Session FIFO. Preserve
   intake validation, canonical model references, reasoning-policy resolution,
   acceptance identity, and the phase recheck immediately before append.
2. Standalone selection atomically removes the FIFO head and reserves that
   Session as busy before any asynchronous work or externally reentrant launch
   event. A busy Session cannot select a second standalone message.
3. RuntimeApp checks Runtime phase before selection and starts only the selected
   message through the existing private launch path. Do not retain the old
   pre-reservation busy guard as a competing authority or accidentally reject
   the reservation just created by selection.
4. Release busy ownership at actual Root execution convergence, preserving the
   existing release-and-schedule-next ordering. A terminal request gate alone
   cannot release it. A failure before worker admission must unwind any new
   reservation without replaying the selected message or masking the failure.
5. Same-Session standalone Turns serialize; different Sessions remain
   concurrent. There is no global execution queue.
6. Expose read-only busy/pending-count queries and a snapshot of Sessions with
   pending input. SessionCoordinator considers active or pending work busy.
   Abort-availability discovery remains the union of active Abort controllers
   and pending Sessions, not a new interpretation of all busy reservations.
7. Queries must not expose mutable queue arrays or permit a second owner.
   Removing messages transfers those payloads to the Runtime caller for
   existing cancellation handling.

## Steering and waiters

- Claim synchronously removes only the largest contiguous media-compatible
  prefix. Never skip an incompatible head or dequeue/requeue a suffix.
- Preserve the current media rule: clearly unsupported media blocks claim;
  unknown capability remains fail-open. Message model/reasoning preferences
  do not restrict claim or change the active Turn.
- RuntimeApp keeps correlated `user_message_bound` fanout and maps claimed
  payloads to Runner input. The scheduler does not own Turn binding events.
- Claim is at-most-once. Persistence failure never restores claimed messages.
  Runner, not the scheduler, owns safe-point eligibility and the final
  empty-claim boundary; add no second per-Turn steering state machine.
- Enqueue wakes that Session's waiters. Waking does not grant ownership:
  messages accepted in the same synchronous burst remain claimable together.
- Preserve immediate resolution when the FIFO is already nonempty, including
  the current precedence over checking an already-aborted waiter signal.
  Waiting on an empty FIFO with an aborted signal rejects; subsequent Abort
  removes that waiter's listener and registry entry. Never wake another Session.

## Abort, Shutdown, and resources

RuntimeApp retains the active-signal, queue-removal, and cancellation-fanout
ordering defined by the [Abort Specification](../../../specifications/abort.md).
Drop only unclaimed messages; claimed input belongs to the active Turn.
Preserve `{ aborted, dropped }`, one correlated `request_end` per dropped
request, `messages_dropped` only for a nonzero drop count, idempotency, and
subscriber-failure containment.

Shutdown closes Runtime admission before draining pending Sessions. Preserve
deterministic Session traversal and cancellation reporting, then the existing
shared-budget convergence/Abort sequence. Do not clear busy state, release
generation pins, or pretend noncooperative workers have converged.

Queued work must not acquire a Turn ID, request gate, generation pin, or
captured Agent profile early. Preserve Root generation capture at actual start
and Agent policy selection at its existing admission boundary. Child selection,
parent/Child generation inheritance, origin routing, and live Settings policy
publication remain unchanged.

## Compatibility and migration

Migrate intake, standalone launch/release, Session busy checks, pending Abort
discovery, steering claim/waiting, queue-length logging, explicit Abort, and
Shutdown together. Delete the superseded collections/helpers rather than
maintaining forwarding state.

No public API, wire/event shape, configuration, dependency, or compatibility
alias changes are permitted. In particular, do not restore
`RuntimeApplication.runTurn()`.

## Acceptance and validation

1. After the first extraction, run direct scheduler tests immediately:
   FIFO order, atomic busy reservation under reentrant selection, independent
   Sessions, release and next selection, blocked/unknown media, contiguous
   prefix claim without replay, queue transfer/drop, and waiter wake/Abort cleanup.
2. Run existing Runtime intake and lifecycle suites. Preserve same-Session
   serialization, cross-Session concurrency, acceptance/binding identity,
   queued followups after failures, incompatible media, latest admission policy,
   Abort drops, Shutdown cancellation, early gate terminalization, and
   nonresponsive-worker pin retention. Add focused regressions where the new
   boundary is not already covered, including reservation unwind on start failure.
3. Run relevant Runner steering tests in `AgentRunner.test.ts` and
   `AgentRunner.tool-pipeline.test.ts`; no Runner algorithm change is planned.
4. Run affected architecture Fitness checks, lint, and build on supported
   Node.js 22. Use existing tools; do not increase timeouts or add dependencies.
   Add Fitness coverage only if an existing durable dependency rule requires
   extension, not to freeze file names or incidental source text.
5. Directly review all migrated scheduling consumers and the absence of a
   second Root launch/state path. Record review limits; do not claim independent
   review unless one actually occurred.
6. Synchronize verified Runtime architecture, the accepted decision amendment,
   Change status, and index. Check local links and whitespace. Stable behavior
   specifications remain unchanged unless an actually affected contract needs
   clarification under the same approved scope.

## Open decisions

No unresolved design decision remains. The owner accepted the bounded ADR-017
amendment, authorized Delivery, and subsequently accepted delivery/validation
and authorized archive on 2026-11-11. Source evidence and focused tests resolved
the extraction's concurrency boundary without a separate Spike. Validation
results and limits are retained in the Plan; this archived design does not
replace current authority.
