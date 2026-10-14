# ADR-020: Session-addressed Presentation Subscription and Ephemeral Child Observation

> Status: Accepted
> Decision date: 2026-10-13
> Owner: Project owner
> Related Plan/Specification: [Plan](../changes/active/session-addressed-subagent-observation/plan.md) and [Specification](../changes/active/session-addressed-subagent-observation/specification.md)
> Supersedes: none

## Context

The WebSocket Channel already routes Agent events by Session audience, but
ordinary navigation and several Session operations only add membership. A
long-lived client therefore continues receiving high-volume events for
Sessions it no longer displays.

Each Subagent already has an independent Child `sessionId`, `turnId`, and
transient Transcript. Its ordinary Runner events route to the Child Session,
but the bundled client cannot subscribe to that audience or read the transient
History. Terminal cleanup immediately deletes the Transcript, so completed
detail cannot be reopened.

The design needs read-only observation without creating another transport,
execution identity, lifecycle owner, or durable Child Session product.

## Decision drivers

- Reuse the existing Session, History, event, and WebSocket boundaries.
- Stop presentation delivery when a client no longer observes a Session.
- Preserve Subagent execution and Parent Tool ownership.
- Support live observation and bounded terminal review.
- Keep the first delivery local and small.

## Options considered

1. Keep implicit, connection-lifetime Session audiences. This avoids protocol
   changes but continues stale event delivery and cannot express Child detail
   lifetime.
2. Add an execution-addressed observation API or a second WebSocket. This can
   isolate observation but duplicates identities, transport lifecycle, and
   History/event projection already owned by Session.
3. Use explicit Session membership on the existing WebSocket and expose
   transient Child Sessions through the existing History capability.

## Decision

Choose option 3.

`sessionId` is the observation address. `turnId` groups Turn presentation and
`callId` correlates Tool lifecycle; no additional observation identity is
introduced.

Session audience membership is explicit and connection-scoped. Subscribe and
unsubscribe are idempotent. `create_session` subscribes the creating
connection before acknowledging its Runtime-known Pending Session.
`run_turn` requires existing membership and has no audience side effect.
History, permission, metadata, and pending-state operations likewise have no
audience side effect. Unsubscribe affects delivery only.

Pending Sessions are addressable by ID but remain absent from persisted
discovery. Runtime resolution uses a Session-domain `kind` and an optional
kind-specific materialized `entry`; an omitted `entry` is the explicit Pending
contract. Known Pending History is empty until materialization.

Subagent Child Sessions remain transient and read-only. The Parent `task`
lifecycle owns the operation state, while Child History and live events own its
content presentation. The Parent terminal Tool Result carries a stable,
model-visible Child `sessionId` header, following the existing Tool-result
handle pattern rather than adding generic presentation metadata.

The existing WebSocket and Session History capability serve ordinary and Child
Sessions. A minimum preparing marker bridges the interval before the Child
Transcript exists; no generic lifecycle snapshot or Child-specific History API
is added.

Terminal Child Transcripts receive bounded retention owned by SessionManager.
The initial policy is at most 24 hours within the current Runtime lifetime.
Restart may end retention earlier.

## Consequences

### Positive

- Clients receive high-volume presentation events only for explicitly observed
  Sessions.
- Parent and Child observation share one connection and one identity model.
- Existing History projection and merge behavior are reused.
- Completed Child detail can be reopened for a bounded period.
- Subagent execution, control, and Parent aggregation remain separate from
  observation.

### Negative

- The Channel and bundled client require a coordinated audience migration.
- The stable textual `task` header becomes a compatibility contract.
- Retained detail can disappear before 24 hours on Runtime restart.
- The first version accepts uncapped retained-Child storage within the bounded
  time window.

## Validation

The related Specification defines admission, ordering, History, retention,
client, failure, regression, and build acceptance. In particular, validation
must prove that unknown subscriptions do not allocate membership, preparing
state precedes `subagent_start`, unsubscribe never controls execution, and
ordinary Session behavior remains intact.

## Migration and rollback

The bundled Channel and client migrate together. The create acknowledgement
establishes initial membership, and existing Sessions require explicit
subscription before `run_turn`; no Feature Flag or legacy implicit audience
path is retained.

Before closeout, rollback removes the new wire messages and restores the
previous client behavior. Retained Child Transcripts can use the existing
transient cleanup path. After acceptance and closeout, changing this decision
requires formal supersession.

## Follow-up

- SSO-1 Delivery began after project-owner authorization on 2026-10-13.
- Update stable Session, Channel, and Subagent specifications plus Current
  Architecture only after implementation is validated.
- Handle connection-scoped `approval_requested` in its separate Change.

The project owner accepted this decision, the related Plan, and Specification
on 2026-10-13, then separately authorized SSO-1 Delivery.

Process authority: [Development Workflow](../governance/development-workflow.md).
