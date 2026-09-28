# ADR-017: One Session Message Queue with Turn-owned Claim Points

> Status: Accepted
> Decision date: 2026-09-28
> Owner: Project owner
> Related Plan/Specification: [Runner Steering Simplification Plan](../changes/archive/runner-steering-simplification/plan.md), [Runner Steering Simplification Specification](../changes/archive/runner-steering-simplification/runner-steering-simplification-specification.md)
> Supersedes: the dual normal-queue/steering-inbox and terminal-promotion decisions in the accepted Runtime Steering and Runner Configuration design

## Context

The current Runtime classifies busy-Session input into either a normal queue or
a steering inbox. Runner later drains the inbox at safe points, while Runtime
promotes unread steering back into the normal queue for selected terminal
outcomes. This duplicates message ownership and creates drained-but-uninjected
states.

The distinction needed by the product is smaller: steering controls whether an
active Turn may consume later user input. It does not require a second intake
authority.

## Decision drivers

- One FIFO acceptance order per Session.
- No accepted-message loss at Turn terminal boundaries or explicit call limits.
- Runner-owned Model/Tool safe points without Runner ownership of scheduling.
- FIFO-preserving Model and media compatibility without dequeue/requeue.
- Removal of promotion and duplicated lifecycle branches.
- No new scheduler module, compatibility layer, or policy matrix.

## Options considered

1. Keep the dual queue/inbox and fix individual terminal races. This preserves
   existing code but retains two ownership paths and future disposition cases.
2. Use one Session FIFO and let the active Turn atomically claim messages at
   Runner-owned safe points.
3. Introduce a dedicated coordinator with leased queue items and acknowledgments.
   This can model more failures but exceeds the needs of the in-process Runtime.

## Decision

Adopt option 2.

1. Every accepted Root user message enters one Runtime-owned per-Session FIFO.
2. `runtime.steeringEnabled` controls whether Runner asks Runtime to claim a
   ready batch.
3. Runner checks Abort, terminal state, and Model-call capacity before claim.
4. Runtime synchronously peeks from the FIFO head and atomically splices only
   the largest contiguous compatible prefix. It never dequeues and requeues an
   incompatible suffix or skips a blocking item.
5. An omitted Model reference is compatible. An explicit reference must match
   the active canonical `providerId` and `modelId`; clearly unsupported media
   also stops claim, while unknown capability remains fail-open.
   Explicit references are normalized at intake through the shared
   Model-resolution rule before storage and comparison.
6. Runner persists and injects the batch immediately; it keeps no pending batch
   across iterations and performs one continuation Model call.
7. An empty claim is the final steering boundary for that Turn. Later input
   remains queued and naturally starts a later Turn.
8. Claim is at-most-once. Persistence failure fails the active Turn and does
   not replay claimed input.
9. FIFO acceptance creates no Root request gate. A gate is created only when a
   message actually starts a standalone Root Turn.
10. Channel user messages and FIFO items do not carry `maxLlmCalls`;
    Model-call limits are execution policy. The internal per-Turn override
    remains for Root execution and Subagent effective-limit inheritance.
11. Explicit Abort and Shutdown remain the only operations that remove queued
   work without running it.
12. Intake records acceptance; `user_message_bound` records actual steering
    ownership without changing Transcript or the active Turn's origin route.
13. Intake rechecks Runtime phase immediately before FIFO append so Shutdown
    cannot accept late work.
14. The old steering inbox, promotion behavior, delivery classification, and
   compatibility paths are removed in the cutover.
15. The scheduler is the sole production Root user-message launch path. The
    public `RuntimeApplication.runTurn()` library API is removed as an
    intentional breaking change; the internal execution helper does not expose
    separate direct/queued semantics.
16. A successful `end_turn` response is a terminal candidate until the final
    eligible claim. A non-empty claim continues the Turn; an empty claim commits
    normal completion.
17. Non-cancelled accepted messages bind exactly once. Abort/Shutdown-dropped
    queued messages terminate through the existing request/message-correlated
    cancellation event without a Turn binding.

## Consequences

### Positive

- One ordering and ownership authority replaces two message paths.
- Terminal outcomes do not need steering-specific promotion or discard choices.
- Model-call limits cannot lose a batch drained on the prior iteration.
- Runtime and Runner retain a single narrow dependency: atomic claim at a safe
  point.
- Tests describe observable queue/claim behavior rather than internal handoff
  compensation.
- Different explicit Model selections preserve FIFO order and start their own
  Turns instead of changing Model inside an active Turn.

### Negative

- Public user-message correlation changes from predicted delivery mode to actual
  binding.
- A blocking incompatible message may end steering for the active Turn even if
  later FIFO items would otherwise be compatible.
- Claimed input is intentionally at-most-once if persistence or Turn execution
  fails after claim.
- Runtime, Runner, Channels, clients, tests, and authority documents must cut
  over together.
- Removing the public direct-Run library API is a breaking change; callers must
  submit Root user messages through a Channel.

### Rejected complexity

- No durable queue or broker.
- No claim lease or acknowledgment protocol.
- No new steering modes or priority.
- No steering batch-size setting.
- No compatibility alias for the old event field.
- No coordinator abstraction beyond the existing Runtime scheduler.
