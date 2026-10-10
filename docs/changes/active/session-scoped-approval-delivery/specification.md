# Origin-Channel and Session-scoped Approval Delivery Specification

> Status: Implemented
> Date: 2026-10-10
> Owner: Project owner
> Related Plan: [Plan](plan.md)
> Related Decision: [ADR-019](../../../decisions/adr-019-origin-channel-and-session-scoped-approval-delivery.md)
> Acceptance: Owner accepted the design and explicitly authorized Delivery on 2026-10-10.

## 1. Purpose and scope

This Change has three outcomes:

1. Remove Origin Client from Approval delivery eligibility. An existing Origin
   Channel restricts delivery to that Channel; an absent Origin Channel imposes
   no Channel restriction.
2. Allow querying all current pending Approval requests, with optional Session
   filtering.
3. Adapt bundled chat UX to refresh the Session list and full pending data,
   deriving Session indicators locally without extending shared Session entries.

Existing Tool policy, Session identity, Approval results, Abort, Shutdown, and
first-settlement-wins remain in place. This Change does not implement Automation
scheduling, persistent Approval recovery, new grants, unread tracking, or a new
Channel presentation model.

## 2. Delivery rule

Runtime selects delivery candidates using only the Origin Channel rule:

```text
Origin Channel exists -> receiving Channel is the Origin Channel
Origin Channel absent -> no Origin Channel restriction
```

Requests retain `originClientId` and add optional `originChannelId` as source
context. Runtime does not use Origin Client as a candidate-selection,
response-validation, or disconnect-settlement condition. Channels decide
how to use source context in their own acceptance and presentation logic;
WebSocket removes the Origin Client restriction to support cross-client
Approval.

The Channel interaction interface becomes required on both Channel instances
and Runtime bindings:

```ts
// ChannelInstance
readonly interaction: ChannelInteractionTransport;
// ChannelRuntimeBinding
readonly interaction: ChannelRuntimeInteraction;
```

Runtime provides the existing Approval capability without a separate
"supports Approval" check. With an Origin Channel it attempts that Channel;
without one it attempts all Channels. This permits the no-Origin route without
implementing an Automation system.

A Channel that cannot support interaction returns the existing
`{ status: 'unavailable', reason: 'delivery_failed' }` for every request.
This is transport unavailability, not a user `denied` result. Such a Channel
does not emit decisions; closure has no presentation to update.

Eligibility makes a Channel a delivery candidate, not a mandatory recipient.
Each candidate decides whether it can handle the particular request using the
existing `sendInteractionRequest` result: `accepted` or `unavailable`.
Session presentation and concurrent interaction limits remain Channel-owned;
Runtime does not classify Channels as single-Session or multi-Session.
Acceptance means the Channel can make the request actionable through its own
interaction model, not merely that it received the message.

Admission to Approval is not Tool approval. Only an `approved` result permits
execution. If no Channel accepts delivery, use the existing unavailable result
and fail closed; do not leave an undeliverable request waiting.

Request and closure use the same Origin Channel rule. For no-Origin delivery,
one Channel rejecting or throwing does not prevent delivery to the others;
log adapter failures and accept the request if at least one Channel accepts.

Runtime validates a response against the pending request and the responding
Channel using this rule, not against an Origin Client. Preserve source Channel
in the existing Host callback path; no new Client authorization or view state
is introduced.

## 3. Pending Approval query

`TurnInteractionManager` remains the only canonical pending registry. Add a
read-only method that reuses the existing request type:

```ts
getPending(sessionId?: string): readonly ApprovalRequest[];
```

Supplying `sessionId` filters by exact Session identity. Omitting it returns
the current pending requests. Returned objects and nested input must not expose
mutable references to canonical pending state.

Extend the existing `ApprovalRequest` and `ApprovalInteractionRequest` with
optional Origin Channel identity and retain existing Origin Client identity:

```ts
originChannelId?: string;
originClientId?: string;
```

Runtime fills both from the Turn's route context when creating the canonical
request, not from Client-supplied Approval responses. Missing origins remain
absent. Pending queries and realtime interaction requests preserve the same
source fields; do not infer origin from the querying Client or current view.

Expose this query to Channels through the existing
`ChannelRuntimeCapabilities`, for example:

```ts
readonly approvals: {
  getPending(sessionId?: string): readonly ApprovalRequest[];
};
```

Runtime's query filters only by the optional Session ID, not by Channel.
Omitting Session ID returns Runtime-global pending requests. Channels receive
the same query capability rather than separate Channel-filtered wrappers.

Each Channel reuses a local, side-effect-free acceptance predicate for realtime
delivery and queried requests, for example:

```ts
getPending(sessionId).filter(request => this.isAcceptableRequest(request));
```

`sendInteractionRequest` uses the same predicate before attempting delivery.
The predicate does not send messages, open prompts, or register requests.
Actual delivery can still fail after the predicate succeeds, so the existing
delivery result remains authoritative. Unsupported Channels reject every
request. No new public predicate interface is required.

This query makes complete pending data available to Channel implementations;
it is not an authorization boundary. Runtime still validates decisions using
section 2's Origin Channel rule. Channel-local acceptance does not grant a
different Origin Channel's decision authority.

Channel-local query filtering excludes a request whose `originChannelId`
identifies another Channel, then applies the Channel's own acceptance logic.
An absent Origin Channel imposes no Channel restriction. Both origin fields
remain available for Channel-owned decisions without granting authority beyond
section 2's rule.

Reuse the existing Approval types and exports. No Snapshot, QueryInput,
QueryResult, or Closure wrapper type or type-location migration is required.
Channel wire envelopes remain owned by their respective modules.

## 4. Session presentation boundary

Keep the existing shared `SessionCapabilityEntry` unchanged. This Change does
not add a Runtime-global pending-event flag, Session metadata, or persisted
attention state.

Bundled chat derives Session indicators from its locally filtered pending
collection, as described in section 6. These indicate requests available through
this Channel, not pending work across other Origin Channels. Presentation
does not grant decision authority beyond section 2's rule.

Other Channels choose their own query and presentation behavior. No generic
event registry, read acknowledgements, or cross-Channel notification service
is introduced.

## 5. Settlement and lifecycle

Keep the existing pending Promise, Abort listener, first settlement, and
Shutdown behavior. Individual Client disconnection no longer settles
Approval or removes the Runtime pending request.

The old path was Client disconnect -> Channel unavailable notification ->
Runtime settlement with `unavailable/origin_disconnected`. That settlement
removed canonical pending state and completed the Approval Promise, preventing
reconnect recovery. Remove this path, including the dedicated
`onInteractionUnavailable` callback and its Host/lifecycle/builder forwarding;
do not retain a no-op compatibility callback or replace it with a generic
unavailability mechanism.

Disconnection cleans up connection and audience state only; it does not complete
the Approval Promise. Another eligible Client or a reconnecting Client can
query and decide the still-pending request. Initial delivery still fails closed
if no candidate Channel accepts. User decisions, Turn Abort, and Runtime
Shutdown still settle through the existing lifecycle. This does not redesign
whole-Channel stop or hot-reload behavior.

All settlements, including user Allow and Deny, notify closure so other Clients
can remove decision controls:

```ts
type ApprovalClosedResult = ApprovalResult;
```

Settlement removes canonical pending state before closure. A closure adapter
failure is logged and does not reverse settlement. Late competing responses
retain the existing ignored/logged behavior.

Each Channel decides how to update presentations it previously exposed.
Do not gate closure on the current request-acceptance predicate: a Channel
that is now busy or otherwise unable to accept new requests must still clear
an existing presentation for the matching Approval ID.

CLI must only cancel the prompt whose Approval ID matches the closure. Closure
for a different request, including a rejected concurrent request, must not
cancel the active prompt.

Approval remains process-local without elapsed-time expiry. Runtime restart
does not recover requests or suspended Turns. Channel hot-reload recovery and
new Channel lifecycle/result classifications are outside this Change.

## 6. Module-specific implementation changes

### Runtime and Core interfaces

- Change request, closure, and capability admission to section 2's rule.
- Make `ChannelInstance.interaction` and `ChannelRuntimeBinding.interaction`
  required, using their existing respective transport types. Update Channel
  implementations, factories, Extension callers, and test fixtures; do not
  silently inject an accepting adapter for unsupported Channels.
- Add the pending query, reusing `ApprovalRequest`.
- Add optional `originChannelId` to existing Approval request contracts, retain
  `originClientId`, and populate/preserve both for canonical and realtime data.
- Expose it through the existing Channel capability boundary and carry response
  source Channel through existing callbacks.
- Notify closure for all terminal results.
- Remove `onInteractionUnavailable` from the Channel transport and Runtime Host
  contracts, its Channel lifecycle/Runtime builder forwarding, and the Runtime
  `origin_disconnected` settlement handler. Adapt implementations and fixtures
  without a replacement callback.

### WebSocket Channel extension

- Remove Origin Client checks from request delivery and decision handling.
- Reuse the local acceptance predicate for delivery and pending-query results.
- Keep realtime `approval_requested`, using existing Session audience routing.
  Audience membership is not decision authority or a user-view assumption.
- Accept delivery even when no Client is connected; Runtime retains the request.
- Stop producing `origin_disconnected` on individual Client disconnection.
- Add module-owned `get_session_approvals` / `session_approvals` messages with
  `requestId` and optional `sessionId`; omission requests all locally acceptable
  pending requests. Responses reuse `ApprovalRequest[]`.
- If a Session is specified, validate it through the existing Session capability.
  For either query scope, recheck the socket after any async validation and
  read/send the pending snapshot without an intervening await.
  A snapshot precedes subsequent closure
  on that socket, rather than resurrecting a settled request.
- Remove the Origin Client restriction from existing `approval_closed`
  delivery so other Clients can close the same Approval ID. Include user
  Allow/Deny closures as specified in section 5, retaining the existing event
  and Client handling with only the required outcome support. Do not introduce
  a new notification event or shared payload.
- Ensure a Client receiving queried pending requests also receives their
  subsequent closures, even if it has not opened those Sessions. Session
  audience membership alone must not leave queried requests without closure.

### CLI Channel

Keep existing prompt presentation. Receive requests under the same delivery
rule and consume all-outcome closure with the matching-ID guard in section 5.
No WebSocket protocol or browser presentation requirement applies to CLI.

### Bundled chat Clients

The following refresh and presentation behavior is owned by the bundled chat
UX only. Its prerequisites are Runtime's existing Session-list and History
capabilities, the pending query in section 3, and
realtime request/closure delivery. Runtime does not coordinate refresh cycles,
manage Client caches, or prescribe polling and navigation for other Channels.

After the initial connection handshake, fetch the Session list and all
acceptable pending Approvals in the same refresh cycle. Repeat that cycle
periodically while connected; reconnect performs an immediate fresh cycle.
These remain separate existing-list and pending queries, not a combined API.
The polling interval is a Client implementation choice, not an Approval
contract parameter.

Keep one polling loop, prevent overlapping requests of the same kind, and
release in-flight state on failure or timeout so later cycles can proceed.
Report refresh errors through existing Client error handling and retain the
last successful data; a failed query is not an empty snapshot.
Stop the loop on disconnection or page disposal. Remove the manual Session
refresh button and `run_end`-triggered list refresh; periodic refresh must not
close menus, switch Sessions, reload History, or interrupt composition.
Preserve the existing `run_end` History-refresh behavior.

Store the fetched pending collection by Approval ID independently of whether
its Tool cards have loaded. Keep realtime request/closed handling between
refreshes. Each successful full pending response reconciles the collection,
including removals; it is not append-only. Request correlation and ordered
event handling must prevent a stale snapshot from resurrecting settled IDs.

On Session switching, request its History and filter the local pending
collection by Session ID. Associate requests with Tool cards using exact
Session, Turn, and Call identity; switching does not require another pending
query.

Do not discard a valid request just because its historical card is not yet
loaded. Integrate it with the existing History/presentation lifecycle. Stale
async responses must not overwrite another Session or reopen closed controls.

Derive a noticeable Session-list indicator, such as a red dot, from whether the
local pending collection contains a request for that Session. Recompute it
after successful snapshot reconciliation and realtime request/closure updates.
Opening a Session does not clear its pending indicator. The indicator clears
when no local pending requests remain for that Session; it is not an unread
marker or a Runtime-global summary. Styling and Session view topology remain
Client-owned; no shared Session field or red-dot protocol is added.

## 7. Acceptance and review gate

Validate the three outcomes with focused tests:

- Origin Client missing or disconnected does not prevent delivery.
- Disconnect after accepted delivery leaves the Approval Promise pending and
  the request queryable; a different eligible Client or a reconnecting Client
  can decide it. No accepting Channel still fails closed, and Abort/Shutdown
  still remove pending requests and complete their Promises.
- Origin Channel present restricts delivery; absent attempts all Channels.
  Unsupported Channels return unavailable; no accepting Channel fails closed.
- A rejection or failure of one fanout adapter does not defeat another
  accepting adapter; the first legal decision wins.
- Runtime query returns current requests globally or by Session, including
  no-Origin requests; settled requests disappear and query results cannot
  mutate canonical request inputs.
- Query and realtime requests preserve Runtime-supplied origin fields.
  Channel filtering excludes other Origin Channels without restricting
  no-Origin requests; WebSocket does not require a matching Origin Client.
- Channel query filtering and realtime delivery reuse the same side-effect-free
  acceptance predicate. Querying does not trigger presentation or delivery.
- Reconnect/query/closure and CLI concurrent prompt handling remain consistent.
  Queried requests receive closure without opening their Session; changed
  acceptance state does not prevent clearing an existing presentation.
- An idle connected chat Client refreshes lists and full pending state without
  relying on `run_end` or manual refresh. Reconnect does not duplicate polling.

Limit chat-page validation to focused checks and a small manual Session-switch,
reconnect, and indicator smoke. Follow the Plan for lint/build and affected
integration/fitness gates; do not create a broad browser test project.

Owner accepted Plan, ADR, and this Specification and explicitly authorized
Delivery on 2026-10-10. Implementation and validation remain separate gates;
acceptance alone does not mark the Change implemented or validated.

## 8. Delivery evidence

Implemented on 2026-10-10, preserving unrelated dirty-worktree changes:

- Required interaction, canonical global/Session pending query, origin fields,
  Origin Channel response validation, no-Origin fanout, all-outcome closure,
  and removal of Client-disconnect unavailable callbacks.
- CLI matching-ID cleanup and explicit unsupported delivery.
- WebSocket cross-client request/query/closure handling and both bundled
  Clients' local pending collection, periodic refresh, and indicators.

Validation:

- 250 focused Unit tests passed across Runtime, manager, CLI, Channel lifecycle,
  fixtures, and WebSocket (including light checks for both chat pages).
- WebSocket integration passed.
- Root and workspace lint passed; build, Host audit, and Relay verification
  passed.
- Selected Fitness tests: 18 passed, 2 failed on pre-existing gate assumptions.
  FT-09 scans a removed `clients` directory; FT-12 requires every architecture
  page's Verified date to equal `2026-09-18`, while HEAD's Channels page already
  has `2026-10-08`. Neither gate was modified by this Change.

Functional validation passed, but overall closeout remains In Review pending
owner acceptance of validation and disposition of the existing Fitness
failures. The Change is not archived or marked Validated.
