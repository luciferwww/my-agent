# WebSocket Client Vue 3 + Vite Migration Specification

> Status: Implemented and Archived
> Date: 2026-10-12
> Owner: Project owner
> Related Plan: [Plan](plan.md)
> Prerequisite Spike: [WVC-0 Specification](wvc-0-spike-specification.md)
> Research input: [Design Draft](../../../research/websocket-client-vite-migration-design-draft.md)
> Acceptance: Owner accepted the production contract on 2026-10-12.
> Delivery: WVC-1 through WVC-4 were separately authorized, implemented, validated, and owner-accepted on 2026-10-12.

## 1. Purpose and scope

Define the candidate production contract for one lightweight, Extension-owned
Vue 3 Client that replaces the current `chat.html` and `chat2.html`
implementations while preserving their product behavior.

The Client remains a bundled resource of `websocket-channel`. Every loadable
Extension form contains prebuilt browser assets; installation, Extension
loading, and Channel startup never compile Client source.

WVC-0 evidence resolved the build and resource-path decisions in section 12.
The owner accepted this production contract on 2026-10-12. Acceptance alone
does not authorize Delivery; the Plan requires separate explicit
authorization.

## 2. Current facts and migration baseline

The current Extension:

- loads server source through `entry.ts`;
- serves two full HTML files;
- replaces one WebSocket-path token at Channel startup;
- returns only `text/html`;
- packages both HTML files through explicit root allowlists and audits.

The two pages represent one product application with different Themes, but
their physical implementations are not byte-equivalent. The second page also
contains responsive and permission-picker presentation adjustments. Migration
uses the behavioral union:

- visual differences become Theme tokens or scoped presentation overrides;
- shared interaction fixes become one component implementation;
- protocol and state behavior do not vary by Theme.

## 3. Source and output layout

Candidate layout:

```text
extensions/websocket-channel/
├── client/
│   ├── index.html
│   ├── src/
│   │   ├── main.ts
│   │   ├── App.vue
│   │   ├── components/
│   │   │   ├── SidebarPanel.vue
│   │   │   ├── ConversationPanel.vue
│   │   │   ├── ComposerPanel.vue
│   │   │   └── MessageItem.vue
│   │   ├── client/
│   │   │   ├── protocol.ts
│   │   │   ├── socket.ts
│   │   │   ├── session-state.ts
│   │   │   ├── history.ts
│   │   │   └── conversation.ts
│   │   ├── attachments.ts
│   │   ├── markdown.ts
│   │   ├── theme.ts
│   │   └── styles/
│   └── dist/
│       ├── index.html
│       └── assets/
├── vite.config.ts
├── entry.ts
└── WebSocketChannel.ts
```

`client/dist` is generated and never manually edited. Runtime and packaged
Extensions require dist but do not require `client/src`, source `index.html`,
Vite config, or Client build tools.

## 4. Build and deployment modes

The same Client build serves both deployment forms:

```text
Source-loaded Extension = server source + prebuilt client/dist
Built Extension         = built server  + prebuilt client/dist
```

This Change owns Client build integration only. Built server compilation,
descriptor entry rewriting, and its output layout remain owned by Built
Extension staging.

Candidate command dependencies:

```text
root build/prepack
  -> websocket-channel build:client
  -> verify:client
  -> existing Host build and verification

source-loaded development/staging
  -> build:client
  -> verify:client
  -> start or copy server source + client/dist

Extension install/load/start
  -> no build
```

The root development command must prepare dist before starting a clean
checkout. This preparation may be an npm pre-command or explicit orchestration,
but it runs before the Host process and outside Extension runtime.

## 5. Dependencies

The WebSocket Extension workspace explicitly declares every direct Client
build input and tool as development dependencies:

- `vue`;
- `marked`;
- `vite`;
- `@vitejs/plugin-vue`;
- `vue-tsc`.

It must not rely on Vitest or another package to provide transitive build
tools. Vue and marked are bundled into browser assets and are not resolved by
the installed Extension runtime. `ws` remains the Extension's Node runtime
dependency. Production Delivery must select current mutually compatible
versions, update the lockfile through the normal package-manager flow, and run
the root dependency-closure and vulnerability audits.

## 6. Runtime Client configuration

Build output contains exactly one non-executable JSON placeholder:

```html
<script id="my-agent-client-config" type="application/json">
  __MY_AGENT_CLIENT_CONFIG_JSON__
</script>
```

For each HTML entry response, the Extension replaces it with a script-safe JSON
object:

```ts
interface ClientConfig {
  readonly webSocketPath: string;
}
```

Production `ThemeId` is:

```ts
type ThemeId = 'classic' | 'botanical';
```

The server serializes with `JSON.stringify` and escapes `<` as `\u003c`.
It rejects missing or repeated placeholders before readiness. It never injects
credentials, filesystem paths, or private Extension configuration.

Client bootstrap requires the configuration element, parses its text as JSON,
and validates `webSocketPath`. Missing, malformed, or invalid configuration is an
explicit bootstrap failure, not a fallback to a hard-coded path.

## 7. Static asset serving

The Extension builds a bounded in-memory resource map before readiness. It
does not concatenate request paths into filesystem reads. The final map is
derived either from:

1. validated recursive inventory of regular files below `client/dist`; or
2. an explicitly enabled Vite manifest including imported chunks, CSS, fonts,
   and images.

WVC-0 selects the simpler sufficient strategy.

Vite uses `base: './'`. For every configured HTML route, the Extension
registers each dist asset at the URL obtained by resolving
`./<dist-relative-path>` against that HTML route. This supports `/`, `/chat`,
and `/nested/chat` without a new public asset prefix or per-route bundle.

The Extension recursively inventories regular files below the canonical dist
root and preloads them before readiness. It rejects symlinks, unsupported
entries, source maps, path escape, and collisions. Duplicate URL registration
is allowed only for identical bytes. A Vite manifest is not required while the
complete bounded dist is inventoried.

Resource behavior:

- only known GET and HEAD paths are served;
- unknown paths and methods receive bounded not-found responses;
- HTML uses `text/html; charset=utf-8` and `no-store`;
- hashed JavaScript, CSS, and other immutable assets use correct Content-Type
  and may use immutable caching;
- HEAD returns headers without a body;
- source maps are rejected from production inventory unless explicitly approved;
- missing or invalid build assets fail Channel startup.

## 8. Lightweight Client boundary

The candidate Client uses one `App.vue`, coarse components, and a small set of
typed modules:

- `App.vue`: top-level shared state, lifecycle, WebSocket message routing, and
  coordination between the three UI regions;
- `SidebarPanel.vue`: Model, Reasoning, Sessions, Permission, and sidebar-local
  picker, menu, focus, and responsive state;
- `ConversationPanel.vue`: header, History controls, message and Turn
  presentation, chat scrolling, and History scroll anchors;
- `ComposerPanel.vue`: draft input, attachment picker/drop/paste, Send/Steer,
  Reset, and Stop presentation;
- `MessageItem.vue`: optional extraction only if `ConversationPanel.vue`
  remains materially too large; it is not required merely to reduce line
  counts;
- `protocol.ts`: wire types, validation, message helpers;
- `socket.ts`: connection, reconnect, send, and status;
- `session-state.ts`: per-Session UI state and selected Session;
- `history.ts`: History/realtime merge and stable presentation identity;
- `conversation.ts`: server event dispatch and Turn/Segment state transitions,
  with no Vue DOM access;
- `attachments.ts`: file validation and encoding;
- `markdown.ts`: safe Assistant Markdown rendering;
- `theme.ts`: Theme IDs, preference validation, and root Theme application.

Shared protocol and per-Session state remain owned by `App.vue`. Each coarse
component owns only its local DOM references and transient presentation state.
Components receive explicit domain props and emit business intents; they do
not receive the parent component proxy, use provide/inject as a hidden store,
or depend on a generic event bus.

The accepted source layout does not use an external `app-template.html` or
Options API `*-methods.js` buckets. A different directory or state-ownership
model requires a Specification update and owner acceptance before
implementation.

The WVC-2 ownership matrix is:

| Owner | Owned state | Owned operations |
|---|---|---|
| `SidebarPanel.vue` | `sidebarOpen`, responsive layout, picker open state, picker search/active option, permission placement, Session action-menu presentation | open/close/focus/trap, picker keyboard navigation, popup placement, menu positioning; emit Model, Reasoning, Session, and Permission intents |
| `ConversationPanel.vue` | chat DOM reference and scroll-follow/anchor presentation state | scroll to bottom, capture/restore History anchor, card presentation intents |
| `ComposerPanel.vue` | file-input reference, drag depth, drag hover | paste/drop/select files and emit draft, file, send, reset, and abort intents |
| `socket.ts` | socket instance, connection status, reconnect timer/attempt, shutdown state | connect, listener binding, reconnect scheduling/cancellation, online recovery, close, JSON send |
| `session-state.ts` | per-Session draft, attachments, permission state, Turn map, active Turn, History request/result state | construct and access isolated Session state |
| `history.ts` | no Vue or DOM state | History request bookkeeping, page merge, record-to-presentation projection, History/realtime identity preservation |
| `conversation.ts` | no Vue or DOM state | server event dispatch; Turn, text, Thinking, Tool, Approval, and terminal state transitions; stable presentation helpers |
| `App.vue` | selected Session ID, Session/catalog collections, pending cross-owner requests, selected Model/Reasoning values | initialize owners, route protocol messages and component intents, coordinate Session selection/creation and owner boundaries |

Ownership rules:

- component-local state never participates in WebSocket payloads;
- per-Session values do not move into a component merely because that
  component edits them;
- typed domain modules do not access Vue refs or browser DOM;
- components do not construct or send protocol messages;
- `App.vue` retains a method only when it coordinates at least two owners or
  routes an external protocol/component intent;
- state and the operations that mutate it migrate in the same delivery step.

The first migration does not add Pinia, Vue Router, feature-store layers,
dependency injection, a generic Transport abstraction, or an Observation
framework. `App.vue` may coordinate top-level state and message dispatch.

## 9. Theme and compatibility

One component tree and one JS/CSS bundle provide Classic (`classic`) and
Botanical (`botanical`).
Semantic CSS tokens are primary; `data-theme`-scoped spacing, density,
sidebar, card, composer, picker, and responsive overrides are allowed to
preserve visual behavior. Theme must not change product capability, protocol,
or state semantics.

Theme selection:

```text
valid saved origin-local preference
  > Classic
```

Only an explicit user selection writes preference. Theme is applied before Vue
mount to avoid initial flash. Invalid or unavailable saved IDs fall back to
Classic. Switching Theme does not remount the application, reconnect
WebSocket, or clear Session state.

The migration removes `/chat2.html` directly. Botanical is selected in the
Client. No alias, redirect, route hint, second template, or Feature Flag is
retained. `/chat2.html` returns bounded 404 unless the operator explicitly
configures it as `clientPath`.

## 10. Package contract

Production Delivery must:

- replace root package `files` entries for the two HTML files with Client dist;
- include `client/dist` but exclude `client/src`, source `client/index.html`,
  Vite configuration, and Client build-only scripts from the published package;
- update package allowlist and required/inventory validation;
- verify every asset referenced by packaged HTML exists in the tarball;
- update installed-package smoke to request HTML and all referenced runtime
  assets;
- verify runtime JSON token replacement and absence of residual tokens;
- prove the installed Host starts without Client source or Client build tools.

Client build failure, missing dist, missing referenced assets, or package
inventory mismatch blocks build, staging, and publishing. Runtime never falls
back to CDN, old HTML, automatic install, or automatic Vite build.

## 11. Behavior and validation

Migration preserves:

- WebSocket connect, hello, reconnect, and event routing;
- Session create/list/switch/rename/delete and per-Session isolation;
- History pagination and History/realtime identity merge;
- text, thinking, Tool Call, Result, Approval, and terminal presentation;
- Permission, Attachment, Model, Thinking, and Effort behavior;
- responsive and keyboard behavior from the two-page behavioral union.

Validation includes focused pure-logic/component tests, existing WebSocket
unit and integration tests, Client-path/static-asset tests, package and
installed-host verification, root lint/build, and focused browser scenarios.
This Change does not add a browser E2E runner or make Playwright a product
dependency.

Client unit tests remain intentionally small and protect stable invariants:
History/realtime identity, per-Session isolation, protocol/socket boundaries,
attachment limits, Markdown safety, the accepted coarse source layout, and
runtime configuration/build locality. They do not snapshot complete templates,
compare full legacy CSS or markup, enforce source line counts, or assert
incidental internal strings. Frequently changing presentation is covered by
type/build gates and focused browser validation instead.

## 12. Evidence and owner decisions

WVC-0 resolved:

1. `base: './'` plus route-directory asset derivation;
2. recursive bounded dist inventory without Vite manifest;
3. root `prepare:websocket-client` used by clean-checkout development,
   build, and prepack;
4. package HTML-reference inventory and installed-smoke asset fetch;
5. Client build inputs/tools as Extension dev dependencies;
6. no new ADR while ADR-015 ownership remains unchanged.

The owner confirmed the bounded [WVC-0 Results](wvc-0-spike-results.md) on
2026-10-12.

The owner also selected:

- stable Theme names Classic (`classic`) and Botanical (`botanical`);
- direct removal of `/chat2.html` without alias or redirect;
- Client source excluded from published packages;
- no new browser E2E runner; Vitest, existing integration tests, and focused
  browser validation remain the required portfolio.

No design decision remains open in this Specification.

## 13. Future compatibility

This Change does not implement Subagent Observation, Automation Detail,
explicit Session subscription, or ephemeral Session caches. A future accepted
Change may extract read-only Turn presentation from actual reuse evidence.
This migration must not add those abstractions speculatively.
