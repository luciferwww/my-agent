# Channel Specification

> Status: Stable Authority
> Contract status: Implemented and Validated
> Verified: 2026-10-13
> Authority: Stable Channel contract

## Scope

This contract defines Channel contribution, instance, Runtime binding, lifecycle, completion, transport ingress, Fanout, and interaction capability. Builtin and External Channels use the same Unit staging and publication path.

## Core contracts

```ts
interface ChannelInstance {
  readonly id: string;
  readonly completion: Promise<ChannelCompletion>;
  send(event: AgentEvent): void | Promise<void>;
  onMessage(handler: (request: ChannelRunRequest) => Promise<void>): void;
  start(): Promise<void>;
  stop(): Promise<void>;
  readonly interaction: ChannelInteractionTransport;
  bindRuntimeCapabilities?(capabilities: ChannelRuntimeCapabilities): void;
}

type ChannelCompletion =
  | { outcome: 'closed'; reason: 'input_closed'|'transport_closed'|'stopped' }
  | { outcome: 'failed'; phase: 'startup'|'runtime'|'shutdown'; error: Error };
```

A `ChannelContribution` creates one instance per generation. Publication exposes
immutable narrow bindings with `id`, `send`, and required interaction; it never
exposes the factory, concrete instance, or stop authority. Unsupported Channels
explicitly return `unavailable/delivery_failed`. Missing interaction methods
are startup validation failures, not an implicitly accepting fallback.

`ChannelRunRequest` carries the server-issued `sessionId`, text or structured blocks, optional `modelReference`, optional `requestOverride`, optional LLM-call limit, and optional client ID. A Channel never treats an omitted or unknown ID as an implicit Session create.

## Lifecycle invariants

- Registration stages metadata only; it does not call `create()` or `start()`.
- Contribution, instance, and Runtime-visible IDs must match.
- `completion` exists before `start()` and settles once.
- `start()` resolves only after transport readiness; completion before readiness is startup failure.
- Create/start/pre-handoff failure rolls back all created siblings in the same Unit once; independent Units remain isolated.
- Cross-kind Unit contributions publish atomically.
- Only successfully handed-off instances enter a generation.
- After handoff, the lifecycle owner controls stop; RuntimeApp holds narrow bindings only.
- Natural close, runtime failure, and stop use first-terminal-wins semantics; Runtime does not restart a completed Channel.
- A root Turn keeps its captured generation's Channel bindings.
- Zero-Channel startup is valid and interaction fails closed.
- Shutdown settles pending approvals before Channel stop and reports stop failure under `channel:<id>`.

## Routing and Fanout

Runtime owns session queueing, origin routes, Abort, and target selection. Channel owns transport framing, connected-client audience, and presentation. Fanout failure is isolated per Channel/client and cannot change Runner outcome or sibling delivery.

The WebSocket Channel uses explicit per-connection Session audience
membership. `subscribe_session` validates a Runtime-known ordinary Pending or
persisted Session before returning its correlated `session_subscribed`
acknowledgement. `unsubscribe_session` is idempotent, removes only that
connection's named membership, and does not control execution or Session
lifecycle. Disconnect and same-client socket replacement clear all memberships
owned by the displaced connection.

`create_session` adds the creating connection's membership before returning
`session_created`; the Runtime Session may still be Pending and need not have
a Transcript yet. `run_turn` requires existing membership and does not modify
audience state. History, permission, metadata, and pending-state operations do
not join an audience.

`get_session` returns the Runtime `resolveSession` result for every addressable
Session. Its stable `kind` identifies the Session domain (`chat` or `subagent`
today), while an omitted kind-specific `entry` explicitly means the identity
is Pending and its Transcript has not materialized. A materialized Chat carries
`SessionEntry`; a materialized Child carries `SubagentSessionEntry`. Pending
Chat Sessions remain absent from `list_sessions` and have empty History. The
bundled client keeps send disabled for a non-empty focused Session until
subscription succeeds.

Thinking presentation uses the canonical `thinking_start`, `thinking_delta`,
and `thinking_end` Agent events. These events carry only local block identity,
readable text, and partial/complete status; Provider replay payload and
invocation source never cross the Channel boundary. Opaque-only internal blocks
produce no empty presentation lifecycle.

Model Catalog query, Abort, and Session management are narrow Runtime
capabilities; Channel does not own model facts or lifecycle state.
`chatSessions` exposes creation, persisted discovery, rename,
archive/unarchive, delete, fork, and permission mode for ordinary Chat
Sessions. `sessionObservation` separately exposes cross-kind Session
resolution and read-only paginated active-branch History for Chat, Subagent,
and future observable Session kinds. Runtime remains the lifecycle policy
owner. History queries are socket-local and do not join a Session audience.

The shared capabilities also expose
`approvals.getPending(sessionId?): readonly ApprovalRequest[]`. Omission returns
Runtime-global pending state; Channels filter with their own side-effect-free
acceptance logic. Requests carry Runtime-supplied optional `originChannelId`
and `originClientId`. Runtime response ingress retains the actual source
binding and validates Origin Channel scope. `onInteractionUnavailable` and its
Client-disconnect settlement forwarding no longer exist. Shared Session entries
are unchanged; Client polling/caching is not a Runtime capability contract.

Request delivery returns `accepted` or `unavailable`; closure accepts the full
`ApprovalResult`, including user choices. A changed acceptance state must not
prevent clearing an existing presentation. [Approval Lifecycle](approval-lifecycle.md)
owns the detailed delivery, query, and settlement rules.

Channel input may include a raw message-level reasoning preference containing
only `thinking` and `effort`. Channel and Runtime both reject unknown fields,
invalid values, non-plain objects, and universal conflicts before enqueue.
Accepted raw preferences are presentation metadata, while Runtime owns model
capability validation and the immutable resolved Turn policy.

Runtime normalizes owner-internal Session and attachment-ingress failures into
`ChannelOperationError` before they cross the Channel boundary. Its bounded
code preserves the presentation decision a Channel needs without exposing
concrete Session or Media error classes. Transport-specific limits and wire
errors remain owned by each Channel implementation.

Selecting a new conversation is client-local state. CLI creates a Pending Session only when the first ordinary message is submitted, then immediately sends with the returned ID. WebSocket clients perform the same explicit `create_session` -> `session_created` -> `run_turn` sequence; `session_created` confirms that the creating connection is already subscribed. WebSocket JSON properties use camelCase while `type` discriminator values use snake_case.

Completing WebSocket `hello` does not select a Session or trigger History.
After handshake or reconnect, the bundled client explicitly subscribes its
current persisted Session, waits for `session_subscribed`, then requests
History. Switching Sessions waits for the old Session's unsubscribe
acknowledgement before subscribing the new Session and loading its History.
The client prepends persisted History before page-local realtime state.
At handshake/reconnect it also fetches the Session list and all locally
acceptable pending approvals, then refreshes both periodically. These are
bundled chat UX choices, not requirements on other Channels.
It derives reasoning controls from the selected model's Catalog facts, orders
known values by the public UI order, hides dimensions with no explicit values,
and treats Default as no Provider-wire override. Model changes preserve each
still-supported explicit dimension and reset only unsupported dimensions.
Message and History summaries are rendered from structured preferences.

The Extension-delivered reference client is one prebuilt Vue 3 application.
Development and installed-package runtime both serve the same bounded
`client/dist` inventory; Extension load/start performs no Client dependency
installation or build. Generated HTML receives runtime WebSocket-path
configuration from the Extension, uses relative hashed assets so nested
`clientPath` values remain valid, and is not a second protocol authority.
Published packages include the generated inventory and exclude Client source,
source maps, Vite configuration, and build-only scripts.

Classic and Botanical are presentation-only Themes in the same component
tree. A valid origin-local preference is applied before Vue mount; otherwise
Classic is used. Only explicit selection writes preference. Theme changes do
not reconnect WebSocket or clear Session state. The retired `/chat2.html`
entry has no alias or redirect.

When Runtime reports `provider_unregistered` or `model_rejected`, Channel presentation preserves the classified failure. A catalog-capable interactive client refreshes the current Catalog for explicit reselection; it does not substitute a Provider/Model or resubmit the failed Turn. Other resolution and invocation failures remain ordinary reported failures and retain the user's selection for an explicit retry.

## Failure semantics

Create failure means no instance. Start rejection or pre-readiness completion is `failed/startup`. Unexpected post-handoff transport failure is `failed/runtime` and does not mutate the published Snapshot. Runtime Composition observes each successfully published Channel completion once and records failed outcomes with bounded Channel ID/phase fields rather than raw Error content. A rejected completion Promise is normalized at the Runtime boundary to `failed/runtime`; it does not reject Host or embedded-caller completion observation. Concrete Hosts do not duplicate that failure log. Explicit stop produces `closed/stopped` unless another terminal result won; stop rejection is `failed/shutdown`. Cleanup errors do not erase the root failure.

There is no Channel-specific wall-clock timeout. Bounded aggregate deadlines belong to Runtime Composition.

## Acceptance scenarios

Cover identical Builtin/External staging; invalid/duplicate IDs; staging without creation; mixed contribution atomicity; immutable narrow projections; readiness vs completion; create/start rollback; zero-Channel readiness; close-once; sibling failure isolation; completion-before-readiness; post-start failure; Origin Channel/no-Origin approval; Fanout isolation; and no direct script-owned Channel lifecycle.

## Related authority

[Channels](../architecture/channels.md) owns current facts and [ADR-014](../decisions/adr-014-extension-packages-and-runtime-composition.md) owns the composition decision. Related contracts: [Approval Lifecycle](approval-lifecycle.md), [Attachments](attachments-support.md), and [Multi-client User Messages](multi-client-user-messages.md).
