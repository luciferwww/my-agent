# Standalone Host Source Layout and npm Distribution Plan

> Status: Archived and Validated
> Date: 2026-09-16
> Accepted: 2026-09-16
> Validated: 2026-09-16
> Archived: 2026-09-16
> Owner: Project owner
> Type: Architecture Slice
> Decision: [ADR-009](../../../decisions/adr-009-host-boundaries-and-standalone-npm-distribution.md)
> Accepted contract: [Standalone Host Layout and npm Distribution Specification](standalone-host-layout-and-npm-distribution-specification.md)
> Predecessor: [Unified Workspace Layout and Standalone Service Host](../unified-workspace-configuration-and-standalone-service-host/plan.md)

## 1. Goal

Move the canonical standalone Host from the generic development/build `scripts/` directory into an explicit production Host boundary, separate executable bootstrap mechanics from reusable standalone Host composition, and make the emitted Host a validated npm package executable.

The Change preserves existing standalone behavior and prepares the source tree for a future sibling VS Code Host without implementing that Host.

## 2. Proposed direction

1. Production Host code is owned by `src/hosts/standalone/`.
2. `entry.ts` is the sole standalone executable bootstrap. It owns the shebang, top-level invocation, fatal diagnostic, and process exit status for startup failure.
3. `standalone-host.ts` owns argument parsing, Workspace snapshot loading, composition validation, Extension acquisition, builtin Channel selection, Runtime creation, and Host lifetime coordination.
4. `runtime-host.ts` owns standalone process signals, cooperative shutdown, forced exit, and the overall Host deadline.
5. `host-startup.ts` owns Agent Home acquisition and bounded operator warning formatting; stale WebSocket-specific names are removed.
   `WebSocketHostAcquisition` and `prepareWebSocketHostAcquisition()` become `StandaloneHostAcquisition` and `prepareStandaloneHostAcquisition()`. The duplicate startup-only `parseAgentHomeArgument()` helper is deleted because canonical standalone argument parsing already owns that input.
6. Runtime remains under `src/runtime/` and must not import standalone or future environment Hosts.
7. The npm `bin` maps `my-agent` directly to the compiled TypeScript entry. No root JavaScript wrapper is introduced.
8. The first supported distribution is a Node 22 npm package. A platform-native or single-file executable is deferred.
9. The package is made structurally packable and installable, but registry publication, credentials, final registry/package identity, signing, and release automation are outside this Change.
10. `scripts/` retains only build, audit, packaging verification, smoke, and other repository-operation tools.

## 3. Target layout

```text
src/hosts/standalone/
├── entry.ts
├── standalone-host.ts
├── runtime-host.ts
├── host-startup.ts
├── standalone-host.test.ts
├── runtime-host.test.ts
└── host-startup.test.ts
```

The Host-specific compiler uses `src` as its source root and emits the executable at:

```text
dist/host/hosts/standalone/entry.js
```

Workspace initialization templates are copied to the matching source-root-relative location:

```text
dist/host/core/workspace/templates/
```

The root `tsconfig.json` excludes only `src/hosts/standalone/entry.ts` from ordinary compilation, so the general `dist/` tree does not contain a second executable bootstrap. Host implementation and tests remain covered by ordinary type checking and Unit discovery; `tsconfig.host.json` type-checks and emits the excluded entry with its static closure.

## 4. Delivery sequence

| Item | State | Scope | Exit condition |
|---|---|---|---|
| HNP-0 | Complete | Accept ADR-009, this Plan, and the standalone layout/distribution Specification | Owner accepted on 2026-09-16; source ownership, executable boundary, package surface, compatibility, and validation are explicit |
| HNP-1 | Complete | Move and rename Host production modules and colocated tests under `src/hosts/standalone/` | Scripts-based production modules/tests are absent; focused Host tests passed |
| HNP-2 | Complete | Split the thin executable bootstrap from standalone composition and update source-relative imports | One bootstrap invokes one composition root; focused behavior tests and installed fatal-entry smoke passed |
| HNP-3 | Complete | Update Host compiler root/output, asset copying, package manifest and lockfile `bin`, development command, artifact audit, and WebSocket smoke paths | Host audit passed with 152 files; real Relay/WebSocket smoke passed; package metadata agrees |
| HNP-4 | Complete | Define the npm package allowlist and add package-content plus installed-tarball verification | Package audit tests passed; a 154-file tarball installed and its generated command, fatal boundary, templates, and built-in WebSocket startup passed on Windows/Node 22/npm |
| HNP-5 | Complete | Update FT-06, FT-10, the stable standalone and Extension acquisition Specifications, architecture overview/extensions/providers, README entry, and Change/decision indexes | Focused Fitness checks passed; residual matches are limited to migration records and a negative audit fixture |
| HNP-6 | Complete | Run final validation and independent review, transfer authority, and archive the Change | Technical Gates and authority transfer passed; owner accepted closeout and archive on 2026-09-16 |

## 5. Acceptance criteria

- The canonical standalone bootstrap source is `src/hosts/standalone/entry.ts`.
- The bootstrap has no Workspace, Extension, Channel, Runtime composition, or shutdown policy beyond invoking the standalone Host and reporting fatal startup failure.
- Standalone composition remains testable without executing the bootstrap.
- Runtime and Core do not depend on `src/hosts/`.
- A future VS Code Host can become a sibling under `src/hosts/` and invoke `RuntimeApp.create()` directly rather than spawning the standalone executable.
- `websocket`, `cli`, and `headless` behavior remains unchanged.
- CLI remains an optional standalone Channel and retains its Console Logger conflict rule.
- Workspace configuration, Agent Home resolution, warning redaction/bounding, signal handling, shutdown deadline, and exit semantics remain unchanged.
- The old `scripts/standalone-host.ts`, `scripts/runtime-host.ts`, and `scripts/websocket-host-startup.ts` paths are deleted without forwarding modules.
- The old emitted executable is absent.
- Root compilation emits no `dist/hosts/standalone/entry.js`; only `tsconfig.host.json` emits the accepted bootstrap.
- `package.json.bin.my-agent` points directly to the accepted compiled entry.
- The package declares an explicit file allowlist and does not ship source tests, repository scripts, fixtures, concrete external Extension source, documentation history, or unrelated build output.
- The manifest `files` allowlist contains only `dist/host`; the accepted tarball root is `package.json`, `README.md`, and `dist/host/**`.
- This Change does not add or claim a license. Legal/publication metadata remains a release blocker outside this local package-readiness Change.
- `prepack` runs `npm run build:host && npm run verify:host-build`; `build:host` first cleans `dist/host`, and `prepack` does not invoke package verification recursively.
- Runtime npm dependencies, native addons, and Workspace template assets required by the emitted Host are present or declared.
- Packaging does not introduce a root launcher, platform selector, bundled Node runtime, Bun executable, Node SEA image, or second composition path.
- Actual `npm publish` is not performed by this Change.
- Isolated installation is validated on the current OS/CPU with the repository's accepted Node 22 and npm environment. A cross-platform release matrix and guarantees about prebuilt native artifacts versus local build-tool requirements are deferred to an actual release decision.

## 6. Non-goals

- changing observable standalone Host behavior;
- implementing a VS Code Extension Host;
- splitting the repository into packages or a monorepo;
- changing Runtime public APIs or Unit lifecycle;
- changing Workspace, Session, Memory, Agent Home, or Extension artifact ownership;
- adding multiple simultaneous builtin Channels;
- adding `--help`, `--version`, subcommands, a package manager abstraction, or release updater;
- creating a root JavaScript wrapper;
- producing a Windows executable, native executable, portable Node runtime bundle, container image, or installer;
- selecting a public npm scope/name, publishing credentials, registry access, provenance/signing policy, or release cadence.

## 7. Validation strategy

Delivery used focused validation after each implementation item and reserved broad validation for HNP-6.

- HNP-1/HNP-2: moved Host Unit tests, argument/composition tests, warning-format tests, signal/deadline tests, and TypeScript diagnostics.
- HNP-3: Host build audit tests, clean Host build, emitted-entry/template audit, package manifest/lockfile agreement, and existing real WebSocket smoke verification.
- HNP-4: one `npm pack --json` operation per package Gate, exact tarball-root/content audit, isolated local tarball installation (including ordinary native dependency install scripts), npm-generated executable discovery, compiled-entry fatal-startup subprocess check, and built-in WebSocket Channel startup against a previously nonexistent Workspace without relying on a packaged External Extension.
- HNP-5: affected Architecture Fitness tests, documentation diagnostics, link/residual scans, and old-path absence checks.
- HNP-6: relevant Integration and Fitness suites, `npm run test:all`, `npm run lint`, clean aggregate build, Host/Relay/package artifact audits, WebSocket smoke, independent review, and `git diff --check`.

The final Gate did not repeatedly rerun an unchanged full suite between intermediate items.

## 8. Stop conditions

Delivery required owner review if evidence required any of the following:

- a wrapper or second executable bootstrap to make npm installation work;
- a second Runtime composition path;
- Runtime or Core importing an environment Host;
- bundling or rewriting native dependencies for package installation;
- changing standalone arguments, configuration, liveness, shutdown, or diagnostics;
- shipping concrete External Extension implementation source in the standalone package;
- changing the accepted Workspace-root or Agent Home ownership model;
- selecting or publishing to a registry, introducing credentials, or making compatibility promises to an external package name;
- introducing a VS Code API or a separate package before a VS Code Host design is accepted.

No stop condition was reached.

## 9. Completion

The accepted source and emitted paths are the only supported standalone executable path, the npm tarball and installed command are verified, old paths are absent, stable/current authorities reflect the implemented layout, final validation passed, and the project owner accepted closeout on 2026-09-16.

## 10. Validation evidence

- Focused Host tests passed after relocation; final focused coverage includes standalone composition, Runtime Host policy, Host startup, Channel-observer rejection cleanup, package redaction, WebSocket-attempt deadlines, and descendant process-tree termination.
- Architecture Fitness passed after classifying `src/hosts/` as Composition and assigning Current Architecture ownership.
- The final broad Gate passed 112 files and 1,016 tests before the last review-only cleanup additions; the four subsequently added/changed behavior tests passed focused validation without rerunning unrelated regression tests.
- TypeScript lint passed after the final production Host change.
- Clean aggregate build passed; the final Host closure audit passed with 152 files.
- Relay error-boundary and seven-file artifact audits passed.
- Real Relay/WebSocket Host smoke passed against the relocated entry.
- npm packaging repeatedly passed after final verifier changes: the exact 154-file tarball installed on Windows with Node 22/npm, exposed the generated `my-agent` command, preserved one fatal diagnostic/exit 1, initialized Context templates, and completed the built-in WebSocket handshake.
- Stable Specifications, Current Architecture, README, package metadata, Fitness rules, and operational scripts point to the new source/emitted paths. Residual old-path matches are migration statements or a negative package-audit fixture.
- Documentation diagnostics and `git diff --check` passed. Git reports only the repository's existing LF-to-CRLF working-copy warning for `tsconfig.json`.
- Independent review found no Critical issue. Initial High/Medium findings were accepted or scope-adjusted and resolved with bounded sockets, bounded process-tree termination, diagnostic redaction, Runtime cleanup on Channel-observer rejection, and deterministic tests. The final follow-up found no Critical/High issue; its remaining test-race observation was resolved with a bounded disappearance check.
