# Channel Specification

> Status: Stable Authority
> Contract status: Implemented and Validated
> Verified: 2026-11-04
> Authority: Stable Channel contract

## Scope

This contract defines Channel contribution, instance, Runtime binding, lifecycle, completion, transport ingress, Fanout, and interaction capability. Builtin and External Channels use the same Unit staging and publication path.

## Core contracts

```ts
interface ChannelInstance {
  readonly id: string;
  readonly completion: Promise<ChannelCompletion>;
  send(event: AgentEvent, routing?: ChannelEventRouting): void | Promise<void>;
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

`ChannelInstance.send` and its Runtime binding accept optional
`ChannelEventRouting { rootTurnId, ancestorSessionIds }`. Runtime derives this
immutable metadata from the existing live delegation route; the AgentEvent
retains its real source session/turn/message identities. Descendant events use
the captured Root Turn's Channel projection, not the current generation.
The optional observer still receives the original event, without a second
event stream or extra observer identity.

The WebSocket Channel uses explicit per-connection Session audience
membership. `subscribe_session` validates a Runtime-known ordinary Pending or
persisted Session before returning its correlated `session_subscribed`
acknowledgement. `unsubscribe_session` is idempotent, removes only that
connection's named membership, and does not control execution or Session
lifecycle. Disconnect and same-client socket replacement clear all memberships
owned by the displaced connection.

An explicit Session subscription also observes all its live descendants.
WebSocket sends each event to the union of its source and ancestor Session
audiences, once per connected client, and includes `rootTurnId` and
`ancestorSessionIds` when Runtime supplied them. Subagent start/end use the
same source-plus-ancestors rule as ordinary Child content. Delivery does not
add any memberships or grant Child send, approval or cancellation authority.
Unsubscribe and reconnect use the current explicit memberships, not a cached
recipient list. Events without a source session, such as request_end, retain
the existing origin-message routing path.

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
message identity, readable text, and partial/complete status; Provider replay payload and
invocation source never cross the Channel boundary. Opaque-only internal blocks
produce no empty presentation lifecycle.

Current Runner Assistant events carry the messageId shared with the stored
message and History: llm_call, text_delta, Thinking lifecycle, and
tool_call_requested. The field is optional in the event contract for
compatibility, but generated Assistant presentation uses it throughout.
Input messageId remains unchanged through persistence. The bundled client
uses message identity to reconcile committed History with incomplete live
text/Thinking, keeps uncommitted messages, and retains per-message boundaries
inside a Turn. Legacy records without identity retain compatible best-effort
presentation rather than an invented mapping. Tool execution updates still
use callId/executionId; a history-only card can receive a live overlay so
later results remain visible across History rebuilds.

Model Catalog query, Abort, and Session management are narrow Runtime
capabilities; Channel does not own model facts or lifecycle state.
`chatSessions` exposes creation, persisted discovery, rename,
archive/unarchive, delete, fork, and permission mode for ordinary Chat
Sessions. `sessionObservation` separately exposes cross-kind Session
resolution and read-only paginated active-branch History for Chat, Subagent,
and future observable Session kinds. Runtime remains the lifecycle policy
owner. History queries are socket-local and do not join a Session audience.

History `limit` remains an input threshold of 1–100 (default 50), not a
response-size cap. Pages accumulate complete local Turns, including retained
descendant messages; output may exceed 100. `beforeEntryId` names a Turn's
first candidate, never an interior record. Descendant items carry
`sourceSessionId`/`sourceEntryId`, while `scopes` supplies their lifecycle links
and known terminal state. These fields survive WebSocket History responses.

The bundled client renders descendant content recursively inside the actual
Parent Tool Call, in the Parent's Tool Call order. Native per-Session live
states are reused; copied History messages are projected by source before
messageId reconciliation. A lifecycle link may wait for its real Parent card;
the client does not invent a call or flatten Child content into Parent text.
The independent Child viewer and its extra subscriptions are removed; the
read-only Child History API and lifecycle policy remain.

Running snapshots preserve uncommitted live messages. Terminal Root takeover
requires a post-terminal snapshot with all involved descendant scopes terminal;
Child run_end alone cannot retire Root content. Explicit expansion choices
survive running refresh and terminal takeover. Whole-Turn pages are not sliced
again in the client, and loading earlier Turns preserves the reading anchor.
Tools are grouped by actual per-source LLM-call boundaries, expanded by default
and never automatically collapsed on completion. Every realtime `llm_call`
starts a new group; History uses each Assistant entry marked with `llmRound`.
Round is only a display hint and may repeat after retries. Missing historical
call facts are not guessed. Adjacent Tools in the same group share a wrapper
without moving text or Thinking, and explicit group expansion survives History
refresh and terminal takeover.

Root-addressed pending approvals use the actual Child turnId/callId and
delegation links to update their nested Tool status. Approval actions appear only
in a non-modal deck above the composer, independently of whether the nested card
is loaded. Multiple requests show one at a time with previous/next navigation
and a position/count. New requests do not replace the current selection or
force conversation scrolling. Closure updates all matching presentations and
advances the deck without reactivating historical requests; an empty deck is
hidden and disconnected actions are disabled. Submissions still use approvalId
and the existing Channel authority.

The CLI's bounded recent-history view renders local messages only; it does not
discard the retained source facts from the History API.
The CLI does not use a routed Child run_start/run_end to lock or unlock Root
input, or to display a Root Model-call-limit notice.

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

## Bundled WebSocket tool readability

These are presentation rules for the bundled WebSocket client, not requirements
on other Channels or changes to Tool, AgentEvent, or Transcript contracts.
Titles are deterministic projections of existing Tool Calls. Root, recursive
Child, realtime, and History use the same rules; titles never replace call
identity, change execution, or reorder content. No model-generated summaries,
Tool registration metadata, or new configuration is required.

### Group titles

Replace `LLM call N` with neutral operation counts, such as
`5 file reads, 1 command, 2 searches, 2 other operations`.

| Tool names | Singular / plural count unit |
|---|---|
| `read_file`, `memory_get` | `file read` / `file reads` |
| `file_search`, `grep_search`, `memory_search` | `search` / `searches` |
| `exec` | `command` / `commands` |
| `write_file`, `edit_file`, `apply_patch`, `memory_write` | `file change` / `file changes` |
| `web_fetch` | `web fetch` / `web fetches` |
| `list_dir` | `directory listing` / `directory listings` |
| `process` | `process operation` / `process operations` |
| `task` | `subagent task` / `subagent tasks` |

Count calls in the existing reconciled group, not distinct resources, returned
matches, command fragments, or Child-internal calls. Keep the first three known
operation types in first-occurrence order. Combine all remaining calls and
unknown tools into one `N other operation(s)` phrase, omitted when zero.
An unknown-only group shows just that phrase. Counts account for every call
once. New calls update counts without changing group identity or disclosure.

Do not vary tense with execution state or imply success. Remove the redundant
`N tools` badge; retain approval notices and disclosure controls. Do not invent
group membership for old records lacking it.

### Single Tool titles

Select meaningful parameters before applying width truncation. File and
directory operations use the basename, supporting both path separators and
preserving a recognizable root. Full paths remain in details. Search titles
use the query, not all filters; commands exclude separately supplied cwd and
environment fields.

| Tool / mode | Title |
|---|---|
| `read_file` | `Read <filename>`, optionally followed by a range |
| `list_dir` | `List <directory name>` |
| `file_search` | `Find files matching "<query>"` |
| `grep_search` | `Search for "<query>"` |
| `write_file` | `Write <filename>`, without inferring creation versus replacement |
| `edit_file` | `Edit <filename>` |
| `apply_patch` | `Apply patch`, without parsing the patch body |
| `web_fetch` | `Fetch <host><short path>` |
| `exec` | `Run <command>` |
| `process:list` | `List background processes` |
| `process:status` | `Check process status · <runId>` |
| `process:log` | `Read process logs · <runId>` |
| `process:kill` | `Stop process · <runId>` |
| `memory_search` | `Search memory for "<query>"` |
| `memory_get` | `Read memory <filename>`, optionally followed by a range |
| `memory_write:append` or omitted mode | `Append to memory <filename>` |
| `memory_write:overwrite` | `Write memory <filename>` |
| `task` | Original `description` as the main title, with a separate Agent-type label |

URL titles accept HTTP(S) only and show host plus the first two non-empty path
segments, adding `/...` when more remain. Omit protocol, user information,
query, and fragment from the title; preserve the original URL in details.
Do not translate or rewrite Task descriptions or promote the full prompt to
the title. Prefer the actual type from the existing Subagent scope, then the
requested type, then General purpose. This is display selection, not a change
to Agent resolution. Status remains a separate badge.

For `read_file`, two bounds produce `lines 10–20`; a start alone produces
`from line 10`; an end alone produces `lines 1–20`; equal bounds produce
`line 10`. No explicit range means no range suffix, not a claim to have read
the entire file. For `memory_get`, `from=10, lines=5` produces `lines 10–14`;
from alone produces `from line 10`. Without from, omit the suffix even if
lines was supplied, matching current memory-read semantics.

Only valid positive safe-integer ranges are formatted, including safe
calculated ends. Titles describe the input range, not EOF-clipped results.
Missing, empty, or wrongly typed title parameters, invalid or reversed ranges,
unknown action/mode values, and invalid or non-HTTP(S) URLs fall back to the
original tool name. Non-list process actions require a non-empty runId.
Unknown tools keep their original names. Optional missing fields follow
existing tool defaults; presentation fallback does not hide execution errors
or replace execution validation.

### Width and status

Titles remain the same short summary when collapsed and expanded. Use one
line with ellipsis, constrained by both the available container and a uniform
maximum; semantic selection is not fixed-character truncation of raw input.
Current title and Agent-label maxima are `32ch` and `14ch`. Titles may shrink,
while Agent labels, status badges, and disclosure controls remain visible.
Long content must not cause horizontal overflow in narrow or nested cards.
Expansion exposes complete description/input details, not a longer title.
Original input is unchanged, and all generated text is rendered as text.

Tool and Subagent badges use the existing status facts. `aborted` is amber,
visually distinct from the existing green success treatment in Classic and
Botanical; no success or cancellation state is inferred from color.

When adding a tool, explicitly select a verified operation category and title
parameter pattern, with singular/plural and fallback tests. Until mapped, its
group contribution is `other operations` and its single title is the raw name;
never guess semantics from name substrings.

Delivery, checks, and owner acceptance are retained in the archived
[Tool Use Readability Change](../changes/archive/tool-use-readability/plan.md).

## Failure semantics

Create failure means no instance. Start rejection or pre-readiness completion is `failed/startup`. Unexpected post-handoff transport failure is `failed/runtime` and does not mutate the published Snapshot. Runtime Composition observes each successfully published Channel completion once and records failed outcomes with bounded Channel ID/phase fields rather than raw Error content. A rejected completion Promise is normalized at the Runtime boundary to `failed/runtime`; it does not reject Host or embedded-caller completion observation. Concrete Hosts do not duplicate that failure log. Explicit stop produces `closed/stopped` unless another terminal result won; stop rejection is `failed/shutdown`. Cleanup errors do not erase the root failure.

There is no Channel-specific wall-clock timeout. Bounded aggregate deadlines belong to Runtime Composition.

## Acceptance scenarios

Cover identical Builtin/External staging; invalid/duplicate IDs; staging without creation; mixed contribution atomicity; immutable narrow projections; readiness vs completion; create/start rollback; zero-Channel readiness; close-once; sibling failure isolation; completion-before-readiness; post-start failure; Origin Channel/no-Origin approval; Fanout isolation; and no direct script-owned Channel lifecycle.

## Related authority

[Channels](../architecture/channels.md) owns current facts and [ADR-014](../decisions/adr-014-extension-packages-and-runtime-composition.md) owns the composition decision. Related contracts: [Approval Lifecycle](approval-lifecycle.md), [Attachments](attachments-support.md), and [Multi-client User Messages](multi-client-user-messages.md).
