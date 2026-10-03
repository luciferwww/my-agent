# Runner Steering Simplification Specification

> Status: Implemented, Validated, Accepted, and Archived
> Date: 2026-09-28
> Owner: Project owner
> Related Plan: [Runner Steering Simplification Plan](plan.md)
> Related Decision: [ADR-017](../../../decisions/adr-017-session-message-queue-and-steering-claim.md)
> Validation: [Runner Steering Simplification Validation](validation.md)
> Authorization: Accepted after independent design review.

## 1. Purpose

All accepted Root user messages enter one per-Session FIFO. Steering is not a
second delivery path. It is the active Turn's optional ability to claim queued
messages at safe points.

## 2. Ownership

Runtime owns:

- the per-Session FIFO;
- intake identity and origin route metadata;
- Session serialization and scheduling;
- atomic claim mutation;
- actual message-to-Turn binding events;
- Abort and Shutdown queue removal.

Runner owns:

- whether execution has reached a safe claim point;
- whether another Model call may start;
- ordered persistence and injection of a claimed batch;
- the subsequent continuation Model call.

Runner does not inspect Runtime maps or schedule later Turns. Runtime does not
choose a point inside the Model/Tool loop.

## 3. Canonical queue

Runtime has one Root-message collection:

```ts
messageQueueBySession: Map<string, QueuedUserMessage[]>
```

Each accepted item retains:

- request and message identity;
- Session identity;
- canonical text or multimodal content;
- origin Channel/client route;
- optional explicit Model reference;
- FIFO acceptance order.

There is no `steeringInboxBySession`, `PendingSteeringInput`, promotion state,
compatibility adapter, or per-message `maxLlmCalls`.

The optional explicit Model reference is normalized at intake with the same
shared rule used by `ModelResolver`: trim and validate `providerId`, preserve
the opaque `modelId`, and reject an invalid reference. Runtime must extract or
reuse one shared normalization helper rather than duplicate rules in claim.

## 4. Intake

After media normalization and validation, Runtime:

1. rejects degenerate input;
2. allocates one message identity;
3. rechecks that Runtime still accepts intake;
4. synchronously appends one queue item;
5. emits one intake event without predicting final delivery;
6. invokes the existing Session scheduler.

The intake event does not contain `deliveryMode`. Intake means accepted, not
that the message has already become a standalone Turn or steering input.

FIFO intake does not create a `RequestCompletionGate`. A gate belongs to a
standalone Root Turn and is allocated only if the queued message actually
starts one.

## 5. Starting a Turn

When a Session is idle, the existing scheduler removes the FIFO head, allocates
the Root request gate and Turn identity, binds origin routing, and starts one
Root Turn.

The binding is observable through the existing `run_start.originMessageId`.
No second intake event is emitted.

The scheduler is the sole production path for starting a Root user-message
Turn. This Change intentionally removes the public
`RuntimeApplication.runTurn()` library API and updates authority documentation
that advertises direct execution. Its replacement for user-message submission
is Channel intake. The remaining internal Root execution helper is not an
intake API and does not need a `direct`/`queued` source flag. Focused unit tests
may exercise that internal execution boundary without making it public.

## 6. Steering claim

When `runtime.steeringEnabled` is false, Runner does not request a claim.

When it is true, Runner may request one claim only after:

- the preceding Model response and any Tool Results are persisted;
- Abort has not been observed;
- another Model call is permitted by `maxLlmCalls`;
- no failure, Abort, or other non-Model terminal result has already been chosen.

A successful Model response with `end_turn` and no pending Tool work is only a
terminal candidate until this final claim runs. Runner persists the response,
checks the call limit, and then claims. A non-empty batch continues the Turn;
an empty claim commits normal completion. Runner never claims after a failure,
Abort, denied required interaction, or exhausted call limit has selected the
terminal path.

Claim is a synchronous Runtime-owned peek-and-splice operation with no `await`:

1. inspect the FIFO without removing an item;
2. walk from the head while each item is compatible with the active Turn;
3. stop at the first incompatible item;
4. remove the compatible prefix with one synchronous splice;
5. bind every removed message to the active Turn.

The claimed batch is the largest contiguous compatible prefix visible when
claim starts. Runtime does not remove all messages and push an incompatible
suffix back. It does not skip an incompatible head, wait for later intake, or
apply an arbitrary batch-size cap.

A queued message is compatible when:

- its `modelReference` is omitted, or both its `providerId` and `modelId` equal
  the active Turn's canonical resolved Model identity; and
- every media kind is supported by the active Model, or the relevant capability
  is unknown.

An explicitly unsupported media kind is incompatible. Capability uncertainty
is fail-open, matching initial Model resolution. Compatibility checks use the
already resolved active Model facts and queue metadata; claim performs no Model
resolution or other asynchronous work.

Runner immediately persists each claimed message separately into the active
Turn, appends it to Provider context, and performs one continuation Model call
for the batch. Multiple claimed messages remain separate `ChatMessage` entries;
they are not concatenated into one user message. Runner does not retain a batch
across loop iterations.

An empty claim is the active Turn's final steering boundary. Runner performs no
later claim for that Turn. Input accepted after this linearization point remains
queued for a later standalone Turn.

Claim is at-most-once. Once removed, later Abort or failure does not return a
message to the queue. If ordered persistence of a claimed message fails, the
active Turn fails explicitly and the claimed batch is not replayed.

## 7. Actual binding event

Claiming emits one `user_message_bound` event per message:

```ts
{
  type: 'user_message_bound';
  messageId: string;
  sessionId: string;
  turnId: string;
  binding: 'steering';
}
```

Standalone binding continues to use `run_start.originMessageId`; no duplicate
binding event is required for a new Turn.

Clients use the binding fact to associate the previously displayed user
message with the active Turn. The obsolete intake-time
`user_message.deliveryMode` field is removed without an alias.

The event records ownership only. It does not assert that persistence or a
later Model call succeeded, and it is not written into Transcript. Existing
`MessageRecord` persistence remains `{ turnId, role, content }`.

Claim does not replace the active Turn's origin route. Approval requests,
interaction prompts, and origin-scoped output continue to use the client that
started the active Turn.

## 8. Terminal behavior

Turn completion has no steering handoff.

Runtime:

1. clears the active Turn;
2. releases the Session serialization gate;
3. asks the existing scheduler to start the next FIFO head.

Messages remaining in the queue are unaffected by normal completion,
`max_llm_calls`, a returned Provider error, or a thrown Turn failure. They
remain accepted work and may start later Turns.

Explicit Abort removes queued Session work under the Abort contract. Shutdown
removes queued work under the Shutdown contract. Neither requires a steering
special case.

## 9. Launch options

A queue item's explicit Model reference applies if that item starts its own
Turn. If it matches the active Turn, it may instead be claimed. A different
explicit Model reference stops claim and remains at the FIFO head so it can
start the next Turn with that Model.

An omitted Model reference imposes no steering constraint. If such a message
starts a standalone Turn, normal Runtime default Model resolution applies.

User messages do not carry `maxLlmCalls`. The effective call limit comes from
Runner configuration or another execution-policy surface outside message
intake. The active Turn's Model binding and effective call limit remain
immutable.

The internal Root execution contract retains a per-Turn `maxLlmCalls` execution
override because Runner policy and Subagent effective-limit inheritance use it.
It is removed only from `ChannelRunRequest`, FIFO item, and Channel launch
metadata; it is not removed from internal Runner execution parameters.

## 10. Multimodal input

The canonical queue stores the already validated message shape. The claim
boundary does not create a second text-only representation. A claimed image
uses the active Turn's immutable Model capability decision. A message whose
media is clearly unsupported remains in FIFO order and blocks later items.

No new attachment policy or image conversion is introduced by this Change.

## 11. Concurrency invariants

- Queue append, claim, and scheduler dequeue are synchronous Runtime-owned
  mutations.
- Intake rechecks Runtime phase immediately before append; Shutdown cannot
  accept work after transitioning out of an intake-accepting phase.
- `inFlightSessions` prevents the scheduler from starting another Turn while a
  claim is possible.
- One queue item is removed by exactly one of claim, scheduler start, Abort, or
  Shutdown.
- A claim after Runner has selected a terminal path is forbidden.
- Input appended after a claim remains queued until a later safe point or Turn.
- Input appended after an empty final claim cannot join the ending Turn.
- Different Session queues never share items or claim operations.

## 12. Error semantics

- Compatibility failure before mutation leaves the queue unchanged.
- Persistence or injection failure after mutation fails the active Turn;
  claimed messages are not replayed as new Turns.
- Invalid queue state fails explicitly and does not silently drop an item.
- Subscriber failure cannot undo queue mutation or Turn binding.

## 13. Required removal

Delivery removes:

- `steeringInboxBySession`;
- `PendingSteeringInput`;
- `enqueueSteeringInput()`;
- `promoteUnreadSteering()`;
- terminal promotion flags and branches;
- Runner-local `pendingSteeringMessages`;
- intake-time route divergence;
- message-level `maxLlmCalls` in Channel, queue, and launch contracts;
- `user_message.deliveryMode`;
- the public `RuntimeApplication.runTurn()` API and direct-library authority
  documentation;
- any production Root user-message launch path that bypasses Channel FIFO;
- tests and documentation that encode dual-path or promotion behavior.

No deprecated aliases, compatibility readers, or parallel execution paths
remain.

## 14. Acceptance scenarios

1. With steering disabled, three accepted messages produce three FIFO Turns.
2. With steering enabled, messages ready at one safe point are persisted
   separately and produce one continuation Model call.
3. Claim removes only the largest contiguous compatible FIFO prefix; a
   different explicit Model or unsupported media item stops claim without
   removal, requeue, or skipping.
4. A message arriving after the final empty claim starts a later Turn.
5. The Runner Model-call limit is checked before claim; queued work is not
   drained and lost.
6. FIFO intake creates no Root request gate; standalone scheduling creates one,
   while steering claim creates none.
7. Abort removes active and queued Session work exactly once.
8. A thrown Turn failure does not silently discard unclaimed messages, while a
   claimed message is never replayed.
9. Shutdown racing with asynchronous intake cannot append after the final phase
   check.
10. Every accepted message not dropped by Abort or Shutdown receives exactly
    one actual Turn binding and appears once in clients. A dropped message
    instead receives exactly one request/message-correlated cancellation event.
11. An `end_turn` response performs its final eligible claim before normal
    completion; a non-empty claim continues and an empty claim completes.
12. Explicit Model references use the shared Model-resolution normalization
    rule before FIFO storage and compatibility comparison.
13. Multi-Session execution remains concurrent and isolated.
14. Source search finds no obsolete steering inbox, promotion, pending type,
    Channel message-level call-limit field, public direct-Run API, or
    compatibility path.
