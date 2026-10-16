# WebSocket Client Vue 3 + Vite Migration Validation

> Status: Accepted and Archived
> Date: 2026-10-12
> Plan: [WebSocket Client Vue 3 + Vite Migration Plan](plan.md)
> Specification: [Accepted Specification](specification.md)

## Outcome

WVC-1 through WVC-4 replaced the two inline HTML applications with one
lightweight Vue 3, TypeScript, and Vite Client. The Extension now serves one
prebuilt `client/dist` inventory in source-loaded and installed-package
execution. The legacy pages and `/chat2.html` entry are removed, while Classic
and Botanical remain available in the same component tree through an
origin-local Appearance preference.

The implementation and required gates were accepted by the project owner on
2026-10-12, and the Change was authorized for archive.

The project owner completed an additional manual Client test pass on
2026-10-12 after the final Theme-picker consistency and Botanical User-message
contrast fixes. The manual test passed.

## Final implementation boundary

- `App.vue` owns top-level lifecycle, business state, protocol routing, and
  genuine cross-owner coordination.
- Sidebar, Conversation, and Composer components own their local DOM and
  transient presentation state.
- Typed socket, Session-state, History, and conversation modules own their
  respective state transitions without Vue DOM access.
- Theme is one small typed module plus a Sidebar control that reuses the
  existing picker presentation and bounded CSS overrides; there is no Router,
  store, provider hierarchy, event bus, or second component tree.
- Production Extension entry, root packaging, and installed verification use
  `client/dist`. Runtime never installs Client dependencies or runs Vite.
- Generic legacy-file serving remains an explicit `WebSocketChannel` option
  covered by small test fixtures; production does not configure it.

## Automated validation

Validation used Node 22.23.3 on Windows:

| Gate | Result |
|---|---|
| Client `vue-tsc` | Passed |
| Focused Client/WebSocket/package/architecture suite | 80 tests passed |
| Full Unit suite | 115 files / 1,408 tests passed with one worker |
| Full Integration suite | 7 files / 23 tests passed with one worker |
| Architecture Fitness | 10 files passed; 40 tests passed; 3 pre-existing workspace-baseline failures documented below |
| Root lint | Passed |
| Root build | Passed |
| Client asset verification | Passed; one HTML entry and two hashed assets |
| Host build audit | Passed; 352 files |
| Copilot Relay verification | 109 tests passed |
| Real npm package verification | Passed; 376 files |
| Installed Client | Runtime configuration injected; referenced assets retrievable; no Client source/build dependency required |
| Retired entry | Installed `/chat2.html` returned bounded 404 without redirect |
| Independent final review | One unused test import found and removed; WebSocket lint and 62 focused tests passed afterward |
| Project-owner manual Client test | Passed after final Theme-picker and Botanical contrast fixes |
| `git diff --check` and active legacy-path scan | Passed |

The native `better-sqlite3` dependency initially retained a Node 20 ABI in the
shared workspace. Rebuilding the existing dependency for the required Node 22
runtime resolved that environment mismatch; the complete Unit suite then
passed.

## Architecture Fitness baseline

The three Fitness failures are unrelated existing workspace-baseline drift and
were not changed as part of this migration:

1. FT-01 reports the existing unclassified
   `src/runtime/agent-home-lock.ts`.
2. FT-09 expects an existing `clients/` directory, which is absent.
3. FT-12 locks all Current Architecture pages to `2026-09-18`, while an
   existing page is already verified as `2026-10-10`.

All migration-coupled Fitness coverage, including runtime-composition deletion
and source-layout convergence, passed.

## Browser validation

Focused browser validation covered:

- live Model Catalog, Session list, History rendering, permission controls,
  Session action menu, and mobile Sidebar behavior through a mock WebSocket
  protocol peer;
- Classic default and invalid-preference fallback;
- explicit Botanical selection, storage, and reload restoration;
- Theme switching without application remount or draft loss;
- Botanical layout at 390 px without horizontal overflow;
- `/chat2.html` returning 404 without redirect.

The final owner pass also confirmed that the Theme control now uses the same
picker presentation as the existing Sidebar controls and that Botanical User
messages retain readable foreground/background contrast.

Expected connection-retry console errors occurred only in the Theme-only smoke
server, which intentionally served HTTP assets without a WebSocket peer.

## Independent review

The final independent review found one medium-confidence cleanup regression:
removing the legacy inline-Client tests left an unused `readFile` import in
`WebSocketChannel.test.ts`. The import was removed. The WebSocket Extension
TypeScript/Client lint and its 62 focused unit/integration/entry tests passed
after the fix. No unresolved migration finding remains.

## Authority convergence

[Channels](../../../architecture/channels.md) and the stable
[Channel Specification](../../../specifications/channel.md) now own the
implemented Client delivery, package, runtime-configuration, Theme, and
retired-entry facts. No new ADR is required because Channel and Extension
ownership from ADR-015 is unchanged.

## Archive

The project owner manually tested the final Client, accepted this validation,
confirmed WVC-1 through WVC-4 as Completed, and authorized archive on
2026-10-12.
