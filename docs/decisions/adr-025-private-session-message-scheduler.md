# ADR-025: Private Session Message Scheduler Ownership

> Status: Accepted
> Decision date: 2026-11-11
> Owner: Project owner
> Amends: only the no-new-scheduler-module restriction in [ADR-017](adr-017-session-message-queue-and-steering-claim.md)

## Context

ADR-017 established one Runtime-owned FIFO and rejected additional scheduling
machinery. Its original "No new scheduler module" driver required an explicit
amendment rather than treating an internal extraction as a mechanical change.

RuntimeApp currently owns FIFO storage, standalone busy state, and steering
waiters alongside execution, routing, generation ownership, and request
terminalization. These three scheduling collections have one concrete
production implementation and can be tested without constructing execution
resources.

## Options considered

1. Keep all scheduling state in RuntimeApp. This obeys ADR-017 unchanged and
   avoids a new boundary, but keeps scheduling-state tests coupled to Runtime
   construction.
2. Move only the existing scheduling state and operations into one private
   Runtime implementation. This permits direct FIFO/concurrency tests without
   introducing another scheduling layer or changing the algorithm.
3. Introduce a generic coordinator, launch framework, leases, or multiple
   interchangeable implementations. Reject: no demonstrated requirement
   justifies the extra lifecycle and abstractions.

## Decision

Adopt option 2.

- Permit one private Runtime Session scheduler to own FIFO storage, the
  standalone Root busy fact, and wake-only steering waiters.
- Remove the corresponding RuntimeApp collections in the same cutover. The
  extracted implementation replaces existing ownership; it does not coordinate
  another scheduler.
- RuntimeApp remains the sole execution orchestrator and retains phase
  admission, request terminalization, routing/events, cancellation, and
  generation/policy ownership.
- Preserve all ADR-017 observable semantics and the absence of a public direct
  Root execution API.
- Retain ADR-017's other rejected complexity, including no lease/ack protocol,
  broker, priority, extra steering mode, or compatibility path.

This amendment changes internal ownership only. It does not supersede the
single-FIFO decision or authorize broader Runtime decomposition.

## Consequences

Direct tests can exercise atomic dequeue/reservation, contiguous claim,
Session isolation, and waiter cleanup without a Provider or full Runtime.
The cost is one private boundary whose callers must not duplicate state or
release busy ownership on request terminalization.

## Validation

- Direct tests cover atomic standalone dequeue/reservation, same-Session
  exclusion, cross-Session independence, contiguous compatible claim, queue
  removal, and waiter cancellation/cleanup.
- Runtime regressions preserve intake identity, actual binding, queued
  followups, generation/policy admission, Abort/Shutdown, and serialization
  until actual worker convergence rather than request terminalization.
- Runner steering, affected architecture Fitness, lint, and build pass.
- Cutover removes the original scheduling collections without adding a public
  direct Root launch path or a second queue.

Acceptance of this decision authorizes the bounded ownership change; it is not
evidence that implementation or validation has completed.

## Migration and rollback

Cut over existing Runtime callers together, with no adapter or parallel queue.
If focused checks disprove the boundary, revise the design before expanding
implementation. Rollback restores the old owner and its callers as one unit;
it must not leave competing scheduling state.
