# Session-addressed Subagent Observation Specification

> Status: Validated
> Date: 2026-10-13
> Owner: Project owner
> Related Plan: [Session-addressed Subagent Observation Plan](plan.md)
> Related Decision: [ADR-020: Session-addressed Presentation Subscription and Ephemeral Child Observation](../../../decisions/adr-020-session-addressed-presentation-subscription-and-ephemeral-child-observation.md)
> Closeout: Owner accepted completed Delivery and validation and authorized archive on 2026-10-14.

## 1. Purpose and observable outcome

The bundled WebSocket client explicitly subscribes to the focused Chat Session
and may additionally subscribe to one opened Subagent Child Session. Both use
the existing WebSocket, Session History projection, and realtime presentation
events.

Closing or switching a view removes only its audience membership. It does not
cancel execution, delete History, or affect another client. A completed Parent
`task` Result preserves the Child Session handle so its read-only detail can be
reopened while the transient Transcript remains retained.

## 2. Scope

This Specification defines:

- explicit Session audience requests and acknowledgements;
- admission and event-routing behavior;
- History behavior for preparing, active, retained, and deleted Child Sessions;
- Child discovery through the Parent `task` Result;
- terminal Child retention and deletion;
- bundled-client subscription, recovery, and responsive-detail behavior.

## 3. Non-goals

- An observation WebSocket or execution-level subscription identity.
- A generic lifecycle registry or runtime snapshot.
- A Child-specific History endpoint or History response shape.
- Child message, resume, rename, archive, fork, or other Chat lifecycle
  operations.
- Approval delivery changes.
- Automation execution or UI.
- Cross-restart retention, tombstones, capacity limits, or configurable TTL.
- Remote multi-principal authorization.

## 4. Boundaries and dependency direction

Core Session owns Transcript access, preparing-Child existence, History
projection, retention, and physical deletion. Runtime exposes Channel-neutral
Session capabilities and owns Subagent orchestration. WebSocket owns wire
validation, requesting-connection acknowledgements, and audience routing. The
bundled client owns focus, opened-detail, merge, and responsive presentation
policy.

Parent task lifecycle remains the authority for the Child operation's
running/success/failed/aborted presentation. Child History is the authority for
persisted Child content. The observation path does not become a Subagent
execution owner.

## 5. Public and structural contracts

### 5.1 Identity

```text
sessionId -> subscription, routing, and History
turnId    -> Turn presentation within the Session
callId    -> Tool lifecycle within the Turn
```

No observation `executionId`, `resourceId`, `subscriberId`, or
`subscriptionId` is added.

### 5.2 Session resolution

Runtime capabilities separate Chat lifecycle management from cross-kind
observation:

```ts
interface ChannelRuntimeCapabilities {
  chatSessions: ChatSessionCapability;
  sessionObservation: SessionObservationCapability;
}
```

`ChatSessionCapability` owns creation, discovery, rename, archive/unarchive,
delete, fork, and permission mode for ordinary Chat Sessions only.
`SessionObservationCapability` resolves and reads History for every currently
addressable Session through:

```ts
resolveSession(sessionId: string): Promise<ResolvedSession>
getHistory(query: SessionHistoryQuery): Promise<SessionHistoryPage>
```

`ResolvedSession.kind` identifies the Session domain. The current values are
`chat` and `subagent`; future domains such as Automation extend the union
without changing subscription admission. Each kind owns its materialized
entry type:

```ts
type ResolvedSession =
  | { sessionId: string; kind: 'chat'; entry?: SessionEntry }
  | { sessionId: string; kind: 'subagent'; entry?: SubagentSessionEntry }
```

An omitted `entry` is the explicit Pending contract: the identity is
addressable but its Transcript has not materialized. A present `entry` is the
kind-specific materialized object. Callers do not infer this boundary from an
incidental metadata field. `getSession`, `PendingSessionEntry`, and
`SessionLookupEntry` are not part of the capability. Adding a new observable
Session kind does not add Chat lifecycle operations to that kind.

### 5.3 WebSocket messages

After the existing connection handshake, a client may send:

```json
{
  "type": "subscribe_session",
  "requestId": "subscription-1",
  "sessionId": "<session-id>"
}
```

Success is returned only to that connection:

```json
{
  "type": "session_subscribed",
  "requestId": "subscription-1",
  "sessionId": "<session-id>"
}
```

Unsubscribe uses the same correlation:

```json
{
  "type": "unsubscribe_session",
  "requestId": "subscription-2",
  "sessionId": "<session-id>"
}
```

```json
{
  "type": "session_unsubscribed",
  "requestId": "subscription-2",
  "sessionId": "<session-id>"
}
```

An unknown or physically deleted Session fails subscribe without creating
membership:

```json
{
  "type": "session_subscription_error",
  "requestId": "subscription-1",
  "sessionId": "<session-id>",
  "code": "SESSION_NOT_FOUND"
}
```

The wire adapter applies the existing request ID and Session ID validation
rules. Repeating subscribe or unsubscribe is idempotent and acknowledges the
resulting state.

### 5.4 Task Result Child handle

When delegation has created a Child and returns a `SubagentTerminalResult`,
the Host formats the Tool Result as:

```text
Subagent completed.
sessionId: <childSessionId>
Result:
<outcome-specific result text>
```

The Tool output's existing `outcome` remains authoritative for Tool success or
failure. The text following `Result:` preserves the current outcome-specific
content. Failures before a Child is created do not invent a Session ID or this
header.

This Host-generated header is persisted in the ordinary Parent Tool Result and
is visible to the Parent model. The bundled client parses it only for the
`task` Tool and only at the fixed header position. Missing, malformed, or old
results produce no detail entry. The Session ID is an address, not proof that
the retained Child still exists.

The Change does not extend generic Tool output, Transcript records, or History
messages with presentation metadata.

## 6. Subscription behavior and invariants

- A connection may hold memberships for its focused Parent and opened Child at
  the same time.
- Explicit `subscribe_session` records membership only when the Session is
  a Runtime-known ordinary Pending Session, persisted, preparing, active, or
  terminal-retained.
- `session_subscribed` means admission succeeded and live delivery is active.
- The client requests History only after receiving that acknowledgement.
- Live events arriving after acknowledgement remain buffered in the existing
  per-Session client state and are merged with the History response by stable
  identities.
- `unsubscribe_session(X)` removes only that connection's membership for X.
- Unsubscribe does not stop a Turn or Subagent, remove History, settle an
  Approval, affect another Session, or affect another connection.
- Parent unsubscribe does not imply Child unsubscribe. The client explicitly
  closes and unsubscribes its opened Child before switching Parent.
- Disconnect removes all memberships owned by that connection.
- `create_session` records membership for its creating connection before
  returning `session_created`; this does not materialize the Pending Session.
- Ordinary Pending Sessions resolve as `kind: "chat"` without `entry` and
  return empty History until first-message materialization. Materialized Chat
  results carry their persisted `SessionEntry` in `entry`.
- `run_turn(sessionId)` requires that the calling connection already has
  membership and does not modify audience state.
- History, permission, metadata, and pending Interaction operations do not add
  audience membership.

Session-scoped Agent and permission presentation events continue to use the
existing Session audience. Request/response messages and existing
connection-scoped messages do not become Session-scoped.

`subagent_start` and `subagent_end` remain Parent Session events. Ordinary
Child Runner, message, thinking, and Tool events remain Child Session events.

This Change does not modify `approval_requested`; until its separate Change,
an unsubscribed Session's missed request remains recoverable through the
existing global pending query.

## 7. Child lifecycle and History

The observable Child lifecycle is:

```text
preparing -> active -> terminal-retained -> physically deleted
```

Child creation obeys this ordering:

```text
generate Child identity
-> register preparing marker
-> publish subagent_start
-> create transient Transcript
-> remove preparing marker
-> execute Child
```

The preparing marker therefore exists before Parent observers can receive
`subagent_start`. Transcript creation success transfers existence to the
transient Transcript. Publication failure, route failure, Transcript failure,
Abort, and Runtime shutdown clear the marker.

The existing Session History capability has these results:

```text
persisted Chat Session         -> existing History behavior
preparing Child                -> successful empty History page
active Child                   -> existing Transcript History
terminal-retained Child        -> existing Transcript History
unknown or physically deleted  -> SESSION_NOT_FOUND
```

The History response shape, pagination, content projection, and
History/realtime merge remain unchanged. No lifecycle field or snapshot is
added.

An empty Child History does not distinguish preparing from active with no
persisted messages. While the Parent task is running, the detail presents both
as starting/running. Parent task terminal state presents completion, failure,
or Abort; Child History presents any persisted content.

Child Sessions do not appear in the ordinary Session list and do not acquire
ordinary Chat lifecycle operations.

## 8. Terminal retention and cleanup

Retention starts only after `subagent_end`:

```text
Child terminal History finalized
-> subagent_end published to the Parent audience
-> Subagent orchestration starts retention from subagent_end
-> SessionManager retains the transient Transcript
-> at most 24 hours in the current Runtime lifetime
-> physical deletion
```

Viewer subscription does not extend retention. After deletion, subscribe and
History return `SESSION_NOT_FOUND`; no public expired state, tombstone, or
`SESSION_EXPIRED` error is added.

Runtime shutdown or restart may end retention before 24 hours. Existing startup
orphan cleanup deletes leftover transient Child JSONL and does not recover its
outcome or remaining retention period.

SessionManager owns deletion because it already owns transient Transcript
creation and cleanup. The scheduling structure is not a public contract.
Cleanup failure is logged and does not change the Child's terminal outcome.

The first version intentionally has no retained-Child capacity limit. This is
an accepted local operational risk, not authorization to add a quota or
eviction subsystem within this Change.

## 9. Bundled client behavior

- The focused ordinary Session is explicitly subscribed.
- Switching Parent closes and unsubscribes the opened Child, unsubscribes the
  old Parent, subscribes the new Parent, waits for acknowledgement, then loads
  History.
- Opening a Child detail subscribes the Child, waits for acknowledgement, then
  loads Child History.
- Closing the detail unsubscribes only the Child.
- At most one Child detail is open. Opening another replaces the first and
  updates membership accordingly.
- A `task` card with a Child handle opens the detail when selected and shows a
  selected-card focus treatment while that Child remains open. It keeps the
  same content structure as other Tool cards and adds no detail footer.
- A layout with enough space to preserve the Theme's existing Chat working
  width renders the detail in a right-side panel and shifts the centered
  content left. A layout without that spare space uses a modal. Layout changes
  preserve the open detail and subscription.
- Reconnect restores the focused Parent and still-open Child independently,
  waiting for each acknowledgement before loading its History.
- If a retained Child was deleted, the detail remains available as a container
  and presents that its content is unavailable.
- Completed Parent `task` Results recover the detail entry after refresh.
  Running Child discovery is page-local and requires receipt of
  `subagent_start`; a client that missed that event waits for the terminal
  Parent Tool Result to provide the first persistent discovery entry.

The shared read-only viewer uses the existing History and live Tool/message
presentation. It does not persist every realtime activity event for later
replay.

## 10. Failure, Abort, and concurrency semantics

- Subscription failure and an unsubscribed `run_turn` do not create either
  side of the audience mapping.
- The bundled client permits sending to a non-empty focused Session only after
  `session_subscribed` or the create-time subscription acknowledgement.
- Duplicate requests converge to the requested membership state.
- A Child may finish while subscription or History loading is in flight.
  Parent task state and the next Child History response converge to terminal
  presentation without reopening execution.
- Parent or Child unsubscribe during execution affects delivery only.
- Existing Parent Abort cascade and Subagent terminal aggregation remain
  unchanged.
- Sibling Children retain independent Session IDs, Transcripts, memberships,
  and retention periods.

## 11. Security and capabilities

The first version preserves the current loopback, local single-trust-domain
deployment assumption. It does not add a Child-specific ACL.

Observation grants only History and presentation delivery. It does not grant
message, resume, rename, archive, fork, cancel, steering, Approval decision, or
other control capabilities.

## 12. Compatibility and migration

The Channel and bundled client migrate together from navigation/query-driven
implicit membership to explicit membership. `create_session` establishes the
creating connection's initial membership; existing Sessions require explicit
subscription before `run_turn`.

No legacy audience path or Feature Flag remains. Existing persisted Chat
History is unchanged. Existing `task` Results without the Child header remain
valid and render normally but have no recoverable detail action.

## 13. Acceptance and validation

- Focus switching stops old-Session presentation delivery and restores the new
  Session through acknowledgement-then-History ordering.
- Subscribe and unsubscribe are idempotent; disconnect clears all memberships.
- Unknown and deleted IDs fail without growing audience maps.
- `create_session` subscribes the creating connection to the Runtime-known
  Pending Session before acknowledging it.
- A known Pending Session remains addressable for unsubscribe, subsequent
  subscribe, empty History, and its first `run_turn`.
- An unsubscribed `run_turn` is rejected without invoking Runtime or creating
  membership.
- Successful `run_turn` callers receive their Turn events.
- History, permission, metadata, and pending queries do not mutate audiences.
- Parent and one Child receive their respective events on one connection.
- Child close affects neither Parent subscription nor Child execution.
- Preparing admission precedes `subagent_start`; immediate History is an empty
  page until the Transcript exists.
- Active and retained Child History uses the ordinary projection.
- Parent task lifecycle and Child content compose the displayed state.
- The terminal `task` header survives Parent History and is parsed only from
  its stable Host position.
- Retention starts at `subagent_end`, never deletes active Children, lasts no
  longer than 24 hours in one Runtime, and is not extended by viewers.
- Restart cleanup and TTL deletion produce `SESSION_NOT_FOUND`.
- Child Sessions stay absent from ordinary Session discovery and operations.
- Reconnect, wide/narrow presentation changes, and replacement of an opened
  Child preserve the defined subscription behavior.
- Focused unit, contract, integration, client, regression, lint, build,
  documentation-link, and independent-review gates pass.

## 14. Open questions

No contract question remains open. The project owner accepted this
Specification, its Plan, and ADR-020 on 2026-10-13, authorized delivery
through SSO-5, and accepted completed Delivery and validation on 2026-10-14.
