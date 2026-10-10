# Origin-Channel and Session-scoped Approval Delivery Plan

> Status: Accepted
> Date: 2026-10-10
> Owner: Project owner
> Type: Architecture Slice
> Specification: [Specification](specification.md)
> Decision: [ADR-019](../../../decisions/adr-019-origin-channel-and-session-scoped-approval-delivery.md)
> Acceptance: Owner accepted the design and explicitly authorized Delivery on 2026-10-10.

## 1. Outcome and scope

Deliver only these three changes:

1. Remove Origin Client from Approval delivery eligibility. With an Origin
   Channel, attempt only that Channel; without one, remove the Origin Channel
   restriction and attempt all Channels.
2. Add a current pending Approval query with optional Session filtering. Chat
   fetches all acceptable pending requests alongside the Session list at startup
   and periodically, then filters locally when loading a Session's History.
3. Derive chat Session-list indicators from local pending data. Keep shared
   Session entries unchanged; refresh, caching, and indicators are chat UX.

Reuse existing Approval types, interaction transport, pending lifecycle, Tool
policy, and Session capabilities. Make the existing interaction interface
required: unsupported Channels return unavailable instead of requiring a
separate capability check. Response and closure handling must follow
the changed delivery scope; individual Client disconnect does not end Approval.
Remove the dedicated `onInteractionUnavailable` callback and its forwarding
and `origin_disconnected` settlement path. Initial delivery failure, Turn
Abort, and Runtime Shutdown retain their existing settlement behavior.

## 2. Non-goals

- Automation scheduling, storage, or Run execution; the no-Origin delivery
  branch is included, but an Automation system is not.
- Persistent Approval, recovery across Runtime restart, timeout, or new grants.
- Unread messages, read acknowledgements, or a generic pending-event registry.
- An independent cross-Channel notification service.
- Channel view topology or server-side Client selection state.
- New Approval data wrappers, type-location migration, or a wire-protocol
  redesign beyond the required Channel adapters.
- Channel hot-reload recovery or new Channel lifecycle result classifications.

## 3. Ownership and module changes

| Owner | Bounded change |
|---|---|
| Runtime / TurnInteractionManager | Apply delivery rule, query canonical pending requests, notify all settlements |
| Core Channel interfaces | Expose pending query through existing capabilities; preserve response source; keep shared Session entries unchanged |
| WebSocket extension | Remove Origin Client restrictions/disconnect settlement, retain realtime delivery, reuse local acceptance for delivery and query filtering |
| CLI | Preserve prompts and close only the matching Approval ID |
| Bundled chat Clients | Fetch lists and full pending state at startup and periodically; filter pending locally on Session loading; replace manual/run-end list refresh and derive Session indicators locally |

Approval request/result shapes remain shared business data. Channel message
names, correlation IDs, serialization, and presentation remain Channel-owned.
Existing Approval requests add optional `originChannelId` and retain
`originClientId`, populated by Runtime and available to Channels in both
realtime and query paths for local acceptance and presentation decisions.
Chat indicators describe its locally available pending requests, not global
work across other Origin Channels. Runtime does not manage Client refresh
cycles, caches, or navigation.

## 4. Delivery slices

| Slice | Status | Outcome |
|---|---|---|
| SAD-0 Review | Completed | Owner accepted Plan, ADR, Specification and explicitly authorized Delivery on 2026-10-10 |
| SAD-1 Routing and query | In Review | Implemented and focused tests passed: Client-independent delivery, no-Origin fanout, canonical query, all-outcome closure; awaiting owner completion confirmation |
| SAD-2 Adapters and chat UX | In Review | Implemented and focused tests passed: WebSocket/CLI adaptations, bundled chat refresh, local pending collection and indicator; awaiting owner completion confirmation |
| SAD-3 Validation and closeout | In Review | Functional tests, lint/build, and stable docs complete; existing Fitness gate failures and owner validation acceptance remain outstanding |

Delivery is authorized within this Accepted Plan's scope. Validation and
closeout remain outstanding; acceptance does not imply implementation completion.

Delivery evidence is recorded in [Specification section 8](specification.md#8-delivery-evidence).
On 2026-10-10, 250 focused Unit tests, WebSocket integration, lint/build, Host
audit, and Relay verification passed. Selected Fitness checks had 18 passes
and 2 pre-existing failures (removed `clients` scan root and hard-coded
architecture verification date). No unrelated gate repair, commit, or archive
was included.

## 5. Validation

Focused Unit/contract tests cover:

- Origin Channel present/absent/unsupported and no accepting Channel.
- Client disconnect leaves accepted requests pending and queryable; reconnect
  or another eligible Client can decide them. Abort/Shutdown still settle.
- Legal competing decisions and partial fanout failure.
- Global or Session-filtered Runtime query; shared Channel-local acceptance
  logic for query results and realtime delivery, without query side effects.
- Consistent origin fields in queries and realtime delivery; Channel query
  filtering excludes other Origin Channels and permits no-Origin requests.
- WebSocket reconnect/replay/closure and CLI matching prompt ID.

Chat-page validation remains small: Session switch, reopen/reconnect, pending
request recovery, idle periodic refresh, timer cleanup, and visible Session
indicator.

Run affected integration tests when transport coverage changes, Fitness when
stable authority changes, and lint/build for the delivered public contract.
Documentation changes require links, code-fence checks, and `git diff --check`.
Do not repeatedly run full suites for document edits.

## 6. Exit conditions

- The three specified outcomes are verified.
- Existing behavior outside that scope is preserved.
- Stable Approval, Runtime, and Channel documentation is updated after delivery,
  not while the design remains Proposed/In Review.
- Unrelated dirty-worktree changes remain untouched.
- Owner accepts validation before archive.
