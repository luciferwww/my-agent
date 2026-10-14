# Session-addressed Subagent Observation Plan

> Status: Accepted
> Date: 2026-10-13
> Owner: Project owner
> Type: Architecture Slice
> Specification: [Session-addressed Subagent Observation Specification](specification.md)
> Decision: [ADR-020: Session-addressed Presentation Subscription and Ephemeral Child Observation](../../../decisions/adr-020-session-addressed-presentation-subscription-and-ephemeral-child-observation.md)
> Research input: [Ephemeral Single-Turn Agent Session Observation and Retention Research](../../../research/ephemeral-single-turn-agent-session-design-draft.md)
> Authorization: Plan, Specification, and ADR accepted by the project owner on 2026-10-13. The project owner authorized delivery through SSO-5 on 2026-10-13.

## 1. Outcome

Allow the bundled WebSocket client to observe a running Subagent in a read-only
detail view and reopen its completed detail for a bounded period. Use explicit
Session subscription on the existing WebSocket so leaving a Session stops its
high-volume presentation events without changing execution or Approval state.

The user can:

- switch the focused Chat Session without retaining old Session audiences;
- open one Child detail alongside its Parent conversation;
- see Child History and subsequent live events in the existing presentation;
- close the detail without stopping the Subagent;
- reopen a completed Child from its Parent `task` Result while the retained
  Transcript still exists.

## 2. Scope

- Add explicit, idempotent `subscribe_session` and `unsubscribe_session`
  WebSocket operations with correlated acknowledgements.
- Validate Session existence before adding audience membership.
- Subscribe the creating connection before acknowledging `create_session`.
- Require existing membership for `run_turn`; keep History, permission, and
  metadata queries or mutations free of audience side effects.
- Add the minimum preparing-Child state required between `subagent_start` and
  transient Transcript creation.
- Read preparing, active, and terminal-retained Child Sessions through the
  existing Session History capability.
- Persist the Child `sessionId` in the Host-formatted terminal `task` Result.
- Add one responsive, read-only Child detail to the bundled Vue client.
- Retain terminal Child Transcripts for at most 24 hours within the current
  Runtime lifetime, then delete them.
- Update the owning specifications and Current Architecture after validation.

## 3. Non-goals

- A second WebSocket or an execution-addressed observation protocol.
- A generic observation registry, lifecycle snapshot, or Child-specific
  History API.
- Sending messages to, resuming, renaming, archiving, or forking a Child.
- Changing Subagent execution, Parent/Child isolation, depth, or Abort cascade.
- Changing Approval delivery. Connection-scoped `approval_requested` remains a
  separate Change.
- Implementing Automation Runs. A future Automation Change may reuse the
  accepted Session contracts.
- Cross-restart retention, tombstones, `SESSION_EXPIRED`, configurable TTL,
  capacity limits, quotas, or eviction policy.
- Remote multi-principal authorization or a new per-Session ACL.

## 4. Ownership and dependency direction

```text
Core Session / SessionManager
  -> Session existence for observation
  -> preparing Child marker
  -> transient Child History and terminal retention

Runtime
  -> Channel-neutral Session History and Subagent orchestration

Extension API
  -> immutable protocol-facing capability contracts

WebSocket Channel
  -> explicit audience membership and Session event routing

Bundled Vue client
  -> focus policy, Child detail policy, History/live merge, presentation
```

The WebSocket Extension continues to use public Runtime/Extension API
capabilities. It must not read Transcript files or import private Core Session
implementation.

## 5. Delivery items

| Item | Status | Outcome | Exit condition |
|---|---|---|---|
| SSO-1 Explicit Session audience | Complete | Explicit subscribe/unsubscribe replaces navigation-driven implicit audience accumulation | Focused WebSocket contract tests pass |
| SSO-2 Child observation and discovery | Complete | Preparing and active Child History/live events are observable; terminal `task` Result preserves the Child handle | Focused Core, Runtime, Tool, and protocol tests pass |
| SSO-3 Terminal retention | Complete | SessionManager retains terminal Child Transcripts for at most 24 hours in the current Runtime and deletes them afterward | Lifecycle and cleanup tests pass |
| SSO-4 Bundled client detail | Complete | One responsive Child detail composes Parent task state with Child History/live presentation | Focused client tests and desktop/narrow browser checks pass |
| SSO-5 Validation and authority | Complete | Contract, regression, build, documentation, and independent review gates complete | Validation record is complete and owner reviews acceptance |

Only one item may be `In Progress`.

## 6. Compatibility and migration

The WebSocket request and acknowledgement messages are additive, but Session
audience behavior changes. The bundled Channel and client therefore ship
together.

`create_session` subscribes its creating connection before acknowledging the
new Pending Session. Existing Sessions require explicit subscription before
`run_turn`. No Feature Flag, legacy implicit audience path, dual protocol, or
Transcript migration is introduced.

Old Parent `task` Results without the stable Child header remain readable but
do not make the `task` card selectable for Child detail.

## 7. Validation strategy

- Core Session tests for preparing, active, retained, deleted, and unknown
  History behavior.
- Subagent orchestration tests for marker ordering, every cleanup path,
  terminal retention start, and unchanged Parent completion.
- Task Tool tests for the stable Child header on delegated terminal outcomes
  and unchanged pre-delegation failures.
- WebSocket contract tests for subscribe admission, acknowledgement ordering,
  idempotence, unsubscribe isolation, disconnect cleanup, create-time Pending
  membership, Pending re-subscription, and rejection of unsubscribed `run_turn`.
- Client tests for Session switching, one Child detail, Parent/Child concurrent
  subscriptions, History/live merge, reconnect, terminal state, and unavailable
  retained detail.
- Regression checks for ordinary Session History, permissions, Abort, Tool
  presentation, and pending Approval recovery.
- Relevant unit and integration tests, lint, build, documentation links,
  desktop/narrow browser checks, and `git diff --check`.

## 8. Entry and exit gates

This Plan, its Specification, and ADR-020 are accepted. The project owner
authorized delivery through SSO-5.

The Change exits when:

- every Specification acceptance scenario passes or is explicitly blocked;
- no implicit navigation/query audience path remains;
- stable specifications and Current Architecture describe delivered behavior;
- the validation record documents focused and broad results;
- the project owner accepts closeout.

## 9. Validation record

Validated on 2026-10-13:

- 122 focused Session lifecycle, Runtime shutdown, intake, and Builder tests
  passed after moving resource cleanup back to Runtime Builder ownership.
- 109 focused WebSocket, client, Task Tool, and Subagent tests passed.
- All 23 integration tests passed.
- The full unit run passed 1424 of 1426 tests. The two remaining failures are
  pre-existing Windows process-test timeouts; both files pass when run in the
  focused 11-test selection.
- The directly affected Runtime composition fitness rule passes all 6 tests.
  The full fitness run passes 40 of 43 tests; the remaining failures are
  unrelated existing workspace drift: an unclassified `agent-home-lock.ts`,
  a missing legacy `clients/` directory, and the pre-existing Runtime
  architecture verification date.
- Repository lint, TypeScript, Vue type-check, full build, client asset
  verification, the 352-file Host build audit, and all 109 Relay tests pass.
- Relative links in the Plan, Specification, ADR-020, and updated Current
  Architecture pages resolve.
- Browser validation passed at 1440x900 and 700x900, including Child
  unsubscribe when the detail closes.
- Follow-up browser validation confirmed that selectable `task` cards retain
  the ordinary Tool-card structure, clear their selected treatment when the
  detail closes, and do not open from the expand control. At 1920px, Classic
  preserves the 1140px Conversation width while shifting the expanded
  application left for a docked panel; at 1500px it uses a modal. At 1700px,
  Botanical preserves the 930px Chat content width while shifting it left for
  a docked panel; at 1600px it uses a modal.
- Independent review raised one proposed reconnect edge for an unopened Child.
  It is not actionable under the accepted contract: reconnect restores the
  focused Parent and a still-open Child by its preserved
  `openedChildSessionId`; unopened running-Child discovery remains page-local
  and terminal Parent `task` History provides the persistent recovery handle.
