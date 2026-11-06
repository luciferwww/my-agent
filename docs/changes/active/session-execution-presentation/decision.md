# Decision: Ancestor Execution Presentation in Session Transcripts

> Status: Accepted
> Decision date: 2026-11-03
> Proposal date: 2026-11-03
> Owner: Project owner
> Related Plan/Specification: [Plan](plan.md), [Accepted Specification](specification.md)
> Supersedes: Partially supersedes the target design of [ADR-020](../../../decisions/adr-020-session-addressed-presentation-subscription-and-ephemeral-child-observation.md) for descendant presentation delivery and the bundled independent Child viewer; staged implementation remains tracked in the Plan

## Context

Child Sessions already isolate model Context and have independent identity and a transient Transcript. Independent observation currently requires explicit Child membership; the bundled viewer opens separate detail, and Child content eventually expires.

The desired Parent experience instead includes inline recursive Child content, concurrent task slots and historical review independent of Child TTL. A parent-only reference cannot meet that retention requirement.

## Decision drivers

- Preserve model isolation, existing identity, task ownership and control permissions.
- Reuse Session Transcript and History rather than add a second display database.
- Make every Session file independently explain its own descendant execution.
- Keep backwards History navigation with complete Turn boundaries and a target record count, accepting oversized pages for long Turns.
- Avoid switches, new observation IDs and parallel viewer paths.

## Options considered

1. Keep only task input/output in Parent history. Smallest change, but cannot preserve internal execution detail.
2. Keep Child references and read separate transcripts. Avoids copies, but depends on transient Child lifetime.
3. Keep a separate UI event list. Can preserve detail, but adds another storage and consistency boundary.
4. Persist display-only projections in every ancestor Transcript and deliver descendant events to ancestor observers. Reuses existing owners and survives Child cleanup, at the explicit cost of depth-dependent duplication.

## Decision

Choose option 4 for staged delivery:

- Explicit subscription remains connection-scoped, but subscribing to a Session observes all descendants by default, without a switch or implicit Child membership.
- Retain source identity and existing task/parent associations; deduplicate each target connection.
- Copy only safe presentation facts into all ancestor Transcripts, once per source fact per target. Never feed these copies into ancestor Context or re-propagate them as new facts.
- Render concurrent Children in stable task slots and recursive content inline. Replace the bundled separate Child viewer when the replacement is validated; retain read-only Child History capability.
- History accumulates whole local Turns, including descendant presentation, until it reaches the requested target count or exhausts history. Completed Turns retain whole-Turn replacement; running Turns reconcile committed messages by source Session and messageId while preserving uncommitted live content.
- Add an optional messageId reference to message records and their ancestor presentation projections without changing entry IDs or existing realtime message IDs. Every message that can appear through both realtime and History must carry the same identity, regardless of role, including applicable Tool-result and Host-generated presentation messages. Optionality accommodates legacy data and records without dual-path message presentation, not arbitrary omission in new flows. Do not use invocation ID as a universal message identity, add a separate mapping store, or restore message_committed notifications.
- Reuse existing Approval audience, pending and settlement paths; adjust matching using Root audience plus Child Turn/call identity.

This decision does not change Child execution, TTL, control rights, model replay or message generation policy. The Specification owns schema, write timing, routing metadata and reconciliation details.

## Consequences

### Positive

- One Session file contains retained details for its complete descendant scope.
- Root observation does not need discovery and subscription of every Child.
- Child cleanup does not break ancestor history.
- Runtime and SessionManager remain the owners; no display storage service is introduced.

### Negative

- Descendant presentation payloads are duplicated along ancestor depth.
- Session writes and History projection require coordinated changes and explicit partial-failure semantics.
- New record versions require a coordinated reader/client cutover; old binaries cannot read v3.
- A long Turn can produce an oversized response; the requested count is not a hard result or byte cap.
- Running snapshot/live overlap requires coordinated identity propagation and client changes; complete-Turn paging does not automatically solve it. Legacy records without messageId cannot be given an invented precise mapping.

## Validation

The Specification's routing, persistence, Context exclusion, concurrent slots, pagination, reconciliation and Approval cases must pass, including Child TTL cleanup and no connected observer.

The prior independent draft review corrected Approval field semantics. The concrete design review found two Medium concerns: input identity continuity for per-message reconciliation, and an incorrect claim about ordinary error partial persistence. The latter is corrected. Identity continuity was initially withdrawn with whole-Turn replacement, but controlled socket checks subsequently reproduced running overlap. The owner confirmed adding optional messageId correlation for both input and Assistant messages. A further independent review found no new blocker in whole-Turn target-count paging. A subsequent independent review of the identity revision also found no design blocker; its lifecycle, message-level merge, source isolation, terminal ordering and compatibility checks are implementation acceptance requirements recorded in the Plan. Implementation validation remains outstanding; this is not delivery acceptance.

## Migration and rollback

Only the affected target-design scope of ADR-020 is superseded; explicit membership, transient read-only Child and retention ownership remain unchanged. Current source still uses the previous observation/viewer path until those delivery stages replace it; acceptance is not evidence that routing has already changed.

Ship Channel/client/schema together. Do not retain both bundled viewer paths or add an observation switch. Preserve old message identities on upgrade. Rollback after writing v3 needs a compatible reader or explicit offline data migration, not silent record dropping.

## Follow-up

Owner accepted the reviewed design by confirming staged implementation. Message identity foundations are implemented; descendant persistence/routing and viewer replacement remain pending. Synchronize Current Architecture and stable Specifications only for behavior actually delivered.

Process authority: [Development Workflow](../../../governance/development-workflow.md).
