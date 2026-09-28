# Runner Steering Simplification Plan

> Status: Implemented; pending closeout
> Date: 2026-09-28
> Owner: Project owner
> Type: Architecture Slice
> Specification: [Runner Steering Simplification Specification](runner-steering-simplification-specification.md)
> Decision: [ADR-017: One Session Message Queue with Turn-owned Claim Points](../../../decisions/adr-017-session-message-queue-and-steering-claim.md)
> Authorization: Accepted after independent design review; Delivery completed.

## 1. Outcome

Replace the separate normal queue and steering inbox with one per-Session FIFO.
Every accepted user message enters that queue. When steering is enabled, the
active Turn may atomically claim queued messages at Runner-owned safe points;
messages not claimed remain queued and later start ordinary Turns.

The result has one intake path, one ordering authority, and no terminal
promotion or unread-steering disposition state machine.

## 2. Problem

The current implementation decides at intake whether a busy-Session message
enters `messageQueueBySession` or `steeringInboxBySession`. It then needs:

- separate queue item types and ownership rules;
- normal-terminal promotion from the steering inbox to the normal queue;
- special handling for Abort, explicit Model-call limits, failures, and
  Shutdown;
- a Runner-local pending steering buffer after Runtime has already removed the
  messages from its inbox.

The Runner currently drains steering at the end of a loop iteration but checks
`maxLlmCalls` before injecting that drained batch on the next iteration. A
drained message can therefore leave Runtime ownership without becoming
persisted input or later queued work.

## 3. Scope

- Use one per-Session FIFO for every accepted Root user message.
- Keep one Runtime-owned per-Session serialization gate and scheduler.
- Let Runner decide safe claim points inside the Model/Tool loop.
- Claim only after Runner knows another Model call may start.
- Claim the largest contiguous compatible prefix from the FIFO head without
  removing and requeueing an incompatible suffix.
- Persist a claimed batch into the active Turn before observing later terminal
  conditions.
- Leave unclaimed messages in FIFO order for later Turns.
- Create a Root request completion gate only when a queued message actually
  starts a standalone Turn.
- Remove per-message `maxLlmCalls`; the effective limit is Runner execution
  policy, not Channel user-message metadata. Preserve the internal per-Turn
  execution override used by Root execution and Subagent limit inheritance.
- Remove the steering inbox, pending steering type, terminal promotion, and
  Runner-local drained-but-uninjected buffer.
- Replace intake-time delivery classification with an event that records the
  actual binding of a message to a Turn.
- Update Runtime, Runner, Abort, multi-client, client presentation, Current
  Architecture, and stable Specifications in the same cutover.

## 4. Non-goals

- Refactoring Runner Compaction, Tool execution, Hooks, Usage, or error mapping.
- Adding a Turn Coordinator, scheduler framework, queue class hierarchy, lease
  protocol, or durable broker.
- Adding more steering modes, per-Channel policy, priority, reordering, or
  fairness configuration.
- Adding a steering batch-size setting or skipping an incompatible FIFO head.
- Interrupting an in-flight Model request or Tool call.
- Preserving obsolete queue/inbox types, event fields, or compatibility aliases.
- Maintaining a separate direct Root user-message path that bypasses the FIFO.
- Preserving the public `RuntimeApplication.runTurn()` library API; its removal
  is an intentional breaking change in this cutover.
- Changing Subagent scheduling.

## 5. Design constraints

1. One accepted message has one queue identity and one final Turn binding.
2. Runtime owns queue mutation; Runner receives one atomic claim callback.
3. A claimed message is never scheduled as another Turn.
4. An unclaimed message is never discarded merely because the active Turn
   ended, reached `maxLlmCalls`, or failed.
5. Claim is synchronous peek-and-splice: only the compatible FIFO prefix is
   removed, and no unclaimed item is ever pushed back.
6. An explicit Model reference is compatible only when its `providerId` and
   `modelId` match the active resolved Model; an omitted reference imposes no
   steering constraint.
7. A clearly unsupported media kind stops claim at that item; unknown Model
   capability remains fail-open, matching initial Model resolution.
8. Explicit Abort retains authority to cancel the active Turn and remove queued
   work for that Session.
9. Different Sessions remain independently serialized and may run concurrently.
10. No compatibility path keeps the old steering inbox or promotion behavior.
11. `RunTurnParams.maxLlmCalls` remains an internal execution-policy input after
    the public direct-Run API is removed; it is not accepted from Channel
    messages or retained in FIFO items.
12. Every non-cancelled accepted Channel message binds to exactly one Turn.
    Abort/Shutdown-dropped messages instead receive their existing
    request/message-correlated cancellation terminal event.

## 6. Delivery slices

| Slice | Status | Outcome | Exit condition |
|---|---|---|---|
| RSS-0 Contract acceptance | Complete | Plan, ADR, and Specification are accepted | Project owner accepted all three and authorized Delivery |
| RSS-1 Unified queue cutover | Complete | Intake and scheduling use one FIFO; obsolete inbox/promotion code is removed | Focused Runtime queue and lifecycle tests pass |
| RSS-2 Runner claim cutover | Complete | Runner claims only at safe points with no local pending buffer | Focused Runner steering, limit, Abort, Tool, and persistence tests pass |
| RSS-3 Event/client and authority cutover | Complete | Clients consume actual binding events and authority matches implementation | Channel/client tests, docs, lint, build, Unit, Integration, and Fitness gates pass |

Only one Slice may be `In Progress`.

## 7. Readiness gates

- [x] Current normal queue, steering inbox, promotion, and Runner drain paths
  were traced from source and focused tests.
- [x] The dual-path loss window before `maxLlmCalls` injection was identified.
- [x] A separate Spike is unnecessary; the concurrency boundary is the existing
  single-process Session scheduler and can be specified and tested directly.
- [x] ADR-017 is accepted.
- [x] The Module Specification is accepted.
- [x] Current public event replacement is accepted.
- [x] Delivery is explicitly authorized.

## 8. Validation strategy

Focused tests must prove:

- steering disabled: every message starts one FIFO Turn;
- steering enabled: a ready message is claimed once at the next safe point;
- all currently visible compatible messages form one claimed batch and one
  continuation Model call;
- an explicit different-Model or unsupported-media FIFO head returns an empty
  claim, while a later incompatible item stops the claimed prefix;
- an incompatible item is never removed, requeued, or skipped;
- a message arriving after the final claim remains queued and starts later;
- reaching `maxLlmCalls` before claim leaves messages queued;
- a claimed batch is persisted in order and triggers one continuation call;
- queued intake creates no request gate until standalone Turn launch;
- claimed input never creates a standalone Root request gate;
- persistence failure after claim fails the active Turn without replay;
- explicit Abort removes the active and queued Session work without duplicates;
- intake racing with Shutdown is rejected by a phase check immediately before
  FIFO append;
- thrown failure leaves unclaimed FIFO work schedulable;
- multiple Sessions remain isolated;
- actual message-to-Turn binding is presented once to every observing client;
- an Abort/Shutdown-dropped queued message emits one correlated cancellation
  terminal event and is not required to bind to a Turn;
- no steering inbox, pending steering type, promotion, or compatibility branch
  remains.
- source and authority search finds no public direct `RuntimeApplication.runTurn`
  API or documentation that advertises it.

Final validation includes focused Runtime/Runner/Channel tests, Unit,
Integration, Fitness, lint, build, Host audit, and `git diff --check`.

## 9. Exit condition

The Change is complete when the single FIFO is the only Root-message intake
authority, Runner safe-point claim is lossless, obsolete steering paths are
deleted, public presentation reflects actual binding rather than intake-time
prediction, all gates pass, and the project owner accepts closeout.
