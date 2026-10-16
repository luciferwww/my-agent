# WebSocket Client Vue 3 + Vite Migration Plan

> Status: Completed and Archived
> Date: 2026-10-12
> Owner: Project owner
> Type: Architecture Slice with prerequisite Spike
> Specification: [Accepted Specification](specification.md)
> Research input: [Design Draft](../../../research/websocket-client-vite-migration-design-draft.md)
> Acceptance: Owner selected the Active Change plus prerequisite Spike path, accepted the Specification, authorized WVC-1 through WVC-4 Delivery, accepted final validation after manual testing, and authorized archive on 2026-10-12.

## 1. Outcome and scope

Migrate the bundled WebSocket reference client from two large inline HTML
applications to one lightweight Vue 3, TypeScript, and Vite application.
Preserve current protocol and user behavior, merge the existing pages through
runtime Theme selection, and ship one prebuilt `client/dist` with every
loadable WebSocket Channel Extension.

The Change owns:

1. Client source and build output boundaries under the WebSocket Extension.
2. Source-loaded and Built staging consumption of the same Client dist.
3. Root build/prepack, package inventory, and installed-package verification.
4. Controlled HTTP serving of generated HTML, JavaScript, CSS, and other
   build assets.
5. One component tree with two initial Themes and an in-page Theme selector.
6. A lightweight split of transport, protocol, per-Session state, History
   merge, attachments, Theme, and coarse UI components.

## 2. Authorization boundary

This Accepted Plan authorized WVC-0 only. The completed disposable Architecture
Spike tested build output, configurable resource paths, runtime JSON
configuration injection, package inventory, and Source-loaded preparation.

WVC-0 confirmed that no new ADR is required while Delivery remains within
ADR-015 ownership. The Specification was accepted on 2026-10-12. The owner separately authorized
WVC-1, WVC-2, WVC-3, and WVC-4 on 2026-10-12.

Research text, this Plan, and WVC-0 do not authorize edits to production
Client, Extension runtime, root build, package manifests, or stable authority.

## 3. Non-goals

- WebSocket protocol redesign or REST/SSE migration.
- Subagent Observation, Automation Detail, explicit Session subscription, or
  ephemeral Session retention.
- A general frontend platform, design system, Router, Pinia, dependency
  injection framework, or feature-store architecture.
- Built Extension server compilation, descriptor rewrite, or output-layout
  design beyond consuming prebuilt Client assets.
- Public-network authentication, TLS, CSP, or production website hardening.
- Changing Runtime, Session, Approval, Permission, Attachment, Model, or
  reasoning semantics.

## 4. Ownership and boundaries

| Owner | Bounded change |
|---|---|
| WebSocket Extension | Client source, Vite config, build script, static asset map, runtime Client config, Theme hint |
| Root product build | Invoke Extension Client build before verification/pack; include and audit generated assets |
| Bundled Client | Typed wire projection, WebSocket lifecycle, per-Session UI state, History merge, Theme preference |
| Existing Runtime/Application | No behavioral or ownership change |
| Built Extension staging | Continue to own server compilation and layout; consume the same Client dist |

The Client remains part of `websocket-channel`; it is not a separate package
or independently installed application. Client source remains in the
development repository; published packages contain only `client/dist`.

## 5. Delivery slices

| Slice | Status | Outcome |
|---|---|---|
| WVC-0 Build and asset Spike | Completed | Owner accepted the bounded Provisional Pass on 2026-10-12 |
| WVC-1 Build foundation | Completed | Added explicit dependencies, Vite build, root build/prepack integration, dist inventory, and controlled static serving |
| WVC-2 Behavior-equivalent migration | Completed | Coarse component and typed-module ownership boundaries implemented; focused, root build, package, and desktop/mobile gates pass |
| WVC-3 Theme convergence | Completed | One component tree provides Classic/Botanical selection and persistence; production points to `client/dist`, and the parallel legacy pages are removed |
| WVC-4 Validation and authority closeout | Completed | Full validation and independent review passed within the documented baseline; stable authority converged; owner manually tested and accepted archive |

All slices were separately authorized and completed.

## 6. WVC-0 decision outputs

The Spike must provide evidence for:

1. Asset URL strategy under `/`, `/chat`, `/nested/chat`, and the then-candidate
   compatibility alias.
2. Whether controlled recursive dist inventory is sufficient or a Vite
   manifest is necessary.
3. Whether `__MY_AGENT_CLIENT_CONFIG_JSON__` survives Vite build unchanged and
   can be safely replaced per HTML entry request.
4. The exact root build/prepack and Source-loaded development preparation
   dependency chain.
5. The package audit and installed-package smoke changes required to prove all
   referenced assets are present and retrievable.
6. Whether current ADR-015 and the WebSocket Extension stable contract can be
   extended by Specification alone or require a durable Decision.

## 7. Compatibility and removal

The owner chose direct migration with no `/chat2.html` compatibility alias.
Botanical is available through the Theme selector. After the new Client passes
behavior, package, and installed-host validation:

- remove both old implementation files;
- serve the new Client only at configured `clientPath`;
- return bounded 404 for `/chat2.html` unless it is itself the configured
  `clientPath`;
- retain no second template, route hint, redirect, or Feature Flag.

## 8. Validation strategy

WVC-0 uses disposable fixtures and records bounded Results. Production slices,
if later authorized, require:

- Client type-check and focused pure-logic/component tests;
- existing WebSocket Channel unit and integration tests;
- configurable Client-path and static-asset HTTP tests;
- package inventory and installed-package smoke that fetches referenced
  assets;
- root lint/build and relevant package/Host audits;
- focused browser validation for Session state, History/live merge, Approval,
  Attachment, Model/Reasoning, responsive UI, and Theme switching.

Documentation-only edits require link review and `git diff --check`.

## 9. Exit conditions

- WVC-0 evidence resolves the listed decision outputs.
- An Accepted Specification defines the production contract before Delivery.
- One generated Client application replaces the parallel HTML implementations.
- Source-loaded and Built staging consume the same verified dist.
- Extension install/load/start performs no Client build and writes no
  installation files.
- Existing behavior is preserved and old paths are removed under the accepted
  compatibility rule.
- Owner accepts validation before archive.

## 10. WVC-1 delivery evidence

At the WVC-1 checkpoint, Delivery deliberately built and packaged an unserved
foundation Client while the production entry still used `chat.html` and
`chat2.html`. The later WVC-3 production switch and legacy-page removal
supersede that temporary state.

Validation used Node 22.23.3:

- root `npm run build` passed, including Client build and asset verification,
  root TypeScript, Host build audit, and 109 Relay tests;
- root `npm run lint` passed, including Extension TypeScript and `vue-tsc`;
- focused WebSocket and package-audit tests passed, 69 tests total;
- `npm run verify:package` passed against a real 378-file tarball and installed
  package, including explicit WebSocket Extension acquisition and Client
  serving;
- `git diff --check` passed;
- the generated dist contains one HTML entry and referenced hashed JavaScript
  and CSS assets, with no source maps;
- package auditing excludes Client source and build configuration while
  retaining both legacy HTML files during WVC-1 and including `client/dist`;
- the newly used vulnerable `source-map-js` 1.2.1 transitive dependency was
  updated to 1.2.2. Remaining audit findings belong to existing production
  dependencies or the existing Vitest/Vite 6 test toolchain and are not
  expanded by WVC-1.

## 11. WVC-2 rework status

WVC-2 is ready for owner review. An interim implementation preserved behavior
and passed its build, package, and browser gates, but its external template and
Options API `*-methods.js` buckets did not match the accepted component and
module architecture. That interim structure is not accepted delivery evidence
and has been removed.

The coarse components are now present with explicit props and business-intent
emits. The Sidebar ownership slice is complete: responsive/open state, picker
presentation, search and keyboard navigation, permission placement, Session
menu positioning, and focus trapping now live with `SidebarPanel.vue`.
Model, Reasoning, Session, and Permission business state remains outside the
component. The Conversation ownership slice is also complete: the chat DOM,
scroll-follow threshold and scheduling, and History anchor capture/restore now
live with `ConversationPanel.vue`; `App.vue` calls only its exposed intent-level
operations. The socket ownership slice is complete: `socket.ts` now owns the
WebSocket instance, connection status authority, reconnect timer and backoff,
online/pagehide lifecycle, shutdown, and JSON send boundary. `App.vue`
receives transport callbacks and retains only protocol hello/message routing
and business cleanup. The History ownership slice is complete: request
bookkeeping, queued latest refreshes, retry/failure settlement, pagination
merge, persisted-to-presentation projection, and disconnect interruption now
live in `history.ts`. The Conversation ownership slice is complete:
`conversation.ts` owns server-event reduction and User, Turn, Thinking, Tool,
Approval, terminal, and continuation transitions. `App.vue` routes the
resulting scroll, History refresh, catalog refresh, and event-feed effects.

All ownership slices in the accepted matrix are now implemented. Final
validation on Node 22.23.3 passed:

- 7 focused Client tests and 90 focused Client/WebSocket/package tests;
- root lint and root build, including 109 Relay verification tests;
- bounded Client asset verification and the real 378-file npm package audit;
- installed-package command, Host startup, explicit WebSocket Extension
  acquisition, and Client serving;
- desktop Model/Session/History/permission presentation with a live mock
  WebSocket protocol peer;
- mobile Sidebar open/close, inert/ARIA state, and focus restoration.

The following independently verified fixes remain requirements during rework:

- safe Assistant Markdown rendering;
- attachment ingestion bound to its initiating Session with commit-time limit
  revalidation;
- permission-picker bounded overflow and upward placement;
- History/realtime presentation identity;
- bounded Client build and installed-package verification.

The owner separately authorized and later accepted WVC-2 and WVC-3.
Implementation uses a small typed Theme module and the existing Sidebar picker
presentation, points the production entry at `client/dist`, removes both
legacy HTML implementations from source and package inventory, and leaves
`/chat2.html` unregistered.

WVC-3 validation used Node 22.23.3:

- Client `vue-tsc`, focused Client/WebSocket/package/architecture tests, Client
  build, and bounded asset verification passed;
- root lint and root build passed, including the 352-file Host build audit and
  109 Relay tests;
- real npm package verification passed with 376 files and proved installed
  Client runtime-config injection plus bounded `/chat2.html` 404;
- browser validation proved Classic fallback, explicit Botanical persistence,
  reload restoration, invalid-preference fallback without rewriting storage,
  Theme switching without remount or draft loss, and a 390px Botanical layout
  without horizontal overflow.

WVC-3 was accepted as Completed after the final owner manual test.
