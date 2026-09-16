# Standalone Host Layout and npm Distribution Specification

> Status: Archived and Accepted
> Date: 2026-09-16
> Owner: Project owner
> Related Plan: [Standalone Host Source Layout and npm Distribution](plan.md)
> Decision: [ADR-009](../../../decisions/adr-009-host-boundaries-and-standalone-npm-distribution.md)
> Stable behavior authority: [Standalone Service Host Specification](../../../specifications/standalone-service-host.md)

## 1. Purpose and observable outcome

The installed `my-agent` command starts the existing service-first standalone Host from a production-owned source boundary. Repository development, the Host build, the npm package, and installed-package verification all converge on one executable bootstrap and one standalone composition root.

This Specification changed source, build, and package ownership only. Existing Workspace inputs, Host modes, Runtime composition, Channel behavior, diagnostics, liveness, signal policy, and exit semantics remain stable.

## 2. Scope

- production Host source ownership;
- separation of executable bootstrap from standalone Host composition;
- Host-specific TypeScript compilation and static asset placement;
- npm `bin` mapping and package file allowlist;
- package artifact and isolated-install verification;
- migration of Host tests, audit paths, smoke paths, Fitness rules, and authority links.

## 3. Non-goals

- VS Code Extension implementation;
- Runtime or Core redesign;
- standalone behavior changes;
- root wrapper or platform binary selection;
- single-file executable, bundled Node runtime, installer, container, or auto-update mechanism;
- public npm registry publication or package-name reservation;
- release credentials, signing, provenance, or release automation.

## 4. Boundaries and dependency direction

### 4.1 Ownership

`src/hosts/standalone/` owns the Node process environment adapter around the process-neutral Runtime:

- `entry.ts`: executable bootstrap and fatal startup boundary;
- `standalone-host.ts`: standalone inputs, configuration, acquisition, builtin Channel selection, Runtime composition invocation, and liveness coordination;
- `runtime-host.ts`: signal registration, shutdown deadline, forced exit, and process exit status caused by shutdown;
- `host-startup.ts`: Agent Home acquisition and bounded operator warning formatting.

Canonical argument parsing remains in `standalone-host.ts`. `WebSocketHostAcquisition` and `prepareWebSocketHostAcquisition()` were renamed to `StandaloneHostAcquisition` and `prepareStandaloneHostAcquisition()` because acquisition applies to every standalone mode. The startup helper's duplicate `parseAgentHomeArgument()` export and its isolated tests were deleted rather than renamed or carried into the new boundary. The remaining acquisition and warning tests moved to `host-startup.test.ts`.

`src/runtime/` remains the process-neutral application Runtime and sole Unit lifecycle owner. `src/core/` remains independent of environment Hosts. `scripts/` owns repository operations only.

### 4.2 Allowed direction

```text
standalone entry
    -> standalone Host
        -> Runtime public boundary
        -> Workspace configuration
        -> Extension acquisition
        -> selected builtin Channel Units

Runtime/Core -X-> standalone Host
External Extensions -X-> standalone Host
```

A future environment Host may invoke the same Runtime public boundary as a sibling, but it must not import the standalone bootstrap, process wrapper, or standalone composition module merely to reuse Runtime.

## 5. Executable contract

### 5.1 Source and emitted entry

The sole executable bootstrap source is:

```text
src/hosts/standalone/entry.ts
```

The Host build emits it as:

```text
dist/host/hosts/standalone/entry.js
```

The npm manifest maps `bin.my-agent` directly to that emitted JavaScript file.

The bootstrap:

1. contains the Node executable shebang;
2. invokes `runStandaloneHost()` exactly once;
3. catches fatal startup failure;
4. sets process exit status 1;
5. writes the same bounded fatal diagnostic behavior required by the stable standalone Host contract.

It does not parse Host arguments, read configuration, acquire Extensions, select Channels, construct Runtime, register signals, or define a second `main()` path elsewhere.

### 5.2 Development execution

The repository development command invokes the same bootstrap source through the TypeScript execution tool. It does not invoke `standalone-host.ts` directly and does not retain the old scripts-based executable.

### 5.3 General and Host-specific compilation

The Host-specific TypeScript configuration:

- has `src` as `rootDir`;
- has `dist/host` as `outDir`;
- has the standalone bootstrap as its explicit root file;
- follows the bootstrap's static TypeScript dependency closure;
- emits no tests or concrete External Extension implementation source.

Changing the compiler source root changed the runtime template destination from `dist/host/src/core/workspace/templates/` to `dist/host/core/workspace/templates/`. Asset copying, the Host artifact audit, and installed-package Workspace initialization all use that exact path.

The root `tsconfig.json` adds `src/hosts/standalone/entry.ts` to its `exclude` list. It continues to type-check and emit Host implementation modules and to type-check colocated tests, but it neither type-checks nor emits the executable bootstrap. `tsconfig.host.json` independently type-checks that entry and follows its static closure. Consequently, only the Host-specific output contains a supported executable entry, and the aggregate build still validates the bootstrap before packaging.

## 6. npm package contract

### 6.1 Runtime requirement

The npm distribution requires Node 22 according to the package engine contract. It does not embed Node or preflight Node through a custom wrapper.

npm remains responsible for platform command shims and installation of declared runtime dependencies. Native packages such as `better-sqlite3` and `sharp` remain ordinary npm runtime dependencies; this Change does not bundle, patch, extract, or replace them.

The acceptance Gate proved installation on Windows using the accepted Node 22 and npm environment. The installation ran normal dependency install scripts. A supported cross-platform release matrix and guarantees about prebuilt native artifacts are release concerns and are not inferred from this local Gate.

### 6.2 Package allowlist

The npm manifest's `files` allowlist is exactly `dist/host`. The permitted tarball root is exactly:

```text
package.json
README.md
dist/host/**
```

The package-content verifier consumes `npm pack --json` output and audits the reported file list. No license file or package license claim was introduced by this Change; legal/publication metadata must be decided before any external publication.

The package must not include:

- TypeScript source;
- source or emitted tests;
- repository-operation scripts;
- test fixtures or test workspaces;
- active or archived Change documents;
- unrelated general `dist/` output;
- concrete External Extension source or unrelated Extension artifacts;
- local configuration, credentials, logs, sessions, databases, or generated workspace state.

The emitted Host closure contains the Workspace Context templates required for new Workspace initialization.

### 6.3 Packaging lifecycle

The npm `prepack` lifecycle command is `npm run build:host && npm run verify:host-build`. `build:host` cleans only `dist/host` before compilation and asset copying. The separate package verifier invokes `npm pack --json` once per package Gate; the lifecycle does not call the verifier or `npm pack`, preventing recursion.

Actual registry publication is a separate release operation. This Specification does not choose public versus private registry access, reserve the current package name, or authorize `npm publish`.

## 7. Behavior and invariants

The migration preserved:

- command name `my-agent`;
- `--workspace` and `--agent-home` forms and precedence;
- `websocket`, `cli`, and `headless` modes;
- CLI/Console Logger conflict behavior;
- one immutable Workspace configuration snapshot;
- Agent Home Extension acquisition;
- one call to `RuntimeApp.create()`;
- Runtime Unit lifecycle and shutdown ownership;
- selected builtin Channel completion behavior;
- headless liveness;
- first/second signal behavior and overall Host deadline;
- exit statuses and bounded, secret-safe diagnostics.

Moving source and changing emitted paths introduced no forwarding modules, aliases, duplicate bootstraps, or compatibility fallbacks.

## 8. Lifecycle and resource ownership

The executable bootstrap transfers control to the standalone Host immediately. After Runtime creation, `runtime-host.ts` owns process signal listeners and shutdown deadline cleanup exactly as required by the stable standalone Host contract.

npm packaging and artifact auditing run before process startup and own no Runtime resources. Package-install smoke tests terminate child process trees with bounded platform-specific cleanup and delete temporary installation, Workspace, and Agent Home directories.

## 9. Failure, Abort, deadline, and concurrency semantics

Existing stable standalone failure, Abort, deadline, signal, and Channel completion semantics are unchanged. Rejection while observing non-headless Channel completion now also reaches the shared Runtime shutdown boundary before propagating.

Additional package verification failures are build/release failures, not Runtime failures. Verification fails if:

- the package `bin` target is absent from the tarball;
- the bin target lacks the expected executable bootstrap/shebang;
- the allowlist admits a forbidden file;
- a static Host import escapes the package closure or targets a missing file;
- a package runtime import is undeclared;
- required Workspace templates are missing;
- isolated tarball installation does not expose the `my-agent` command;
- the installed command cannot complete the selected startup smoke;
- temporary processes or directories cannot be cleaned up.

Package verification redacts temporary paths and sensitive environment values and uses bounded timeouts for subprocess trees, WebSocket attempts/replies, and network-loopback startup.

## 10. Security and capabilities

- No credential or registry token is added to source, configuration, scripts, tests, or package contents.
- Package verification uses only loopback networking and temporary filesystem roots.
- The package does not include local Agent Home or Workspace state.
- Existing diagnostic redaction and bounding remain mandatory.
- Registry authentication, provenance, package signing, and supply-chain publication policy require a separate release decision before actual publication.

## 11. Compatibility and migration

This was a direct internal source and emitted-path cutover:

```text
scripts/standalone-host.ts
scripts/runtime-host.ts
scripts/websocket-host-startup.ts
    -> src/hosts/standalone/
```

No old-path forwarding module, duplicate npm `bin`, compatibility alias, or second executable is retained. Repository callers, tests, scripts, build configuration, package manifest and lockfile, Fitness rules, and documentation evidence moved atomically.

The user-visible command remains `my-agent`; therefore no command-name compatibility layer is required. Rollback uses Git to restore the previous complete source/build state rather than keeping both layouts.

## 12. Acceptance and validation

Acceptance evidence establishes all of the following:

1. Host composition Unit tests pass from the new source boundary.
2. Runtime Host signal/deadline tests pass unchanged in behavior.
3. Host startup/acquisition warning tests pass with Host-neutral names.
4. The ordinary TypeScript check covers Host implementation and tests.
5. The Host-specific TypeScript build covers the executable entry; root compilation emits no second `dist/hosts/standalone/entry.js`.
6. A clean Host build emits the accepted entry and no old executable path.
7. Host build audit proves static closure, declared runtime packages, required assets, no tests, and no concrete External Extension source.
8. A focused compiled-entry subprocess check proves one fatal diagnostic, exit status 1, and no duplicate startup on invalid startup input; the artifact audit proves the shebang.
9. Existing real WebSocket Host smoke passes against the new emitted entry.
10. Package-content tests prove the exact allowlist, required npm `bin` target, and package manifest/lockfile agreement.
11. A tarball built from the current source installs into an isolated temporary project, exposes one working `my-agent` command, and starts the built-in WebSocket Channel against a previously nonexistent Workspace to prove packaged template initialization. This smoke does not require or imply that a concrete External Extension ships in the package.
12. Residual scans find no supported old source/emitted paths, forwarding modules, or duplicate executable bootstrap. The scan covers README, stable standalone and Extension acquisition Specifications, architecture overview/extensions/providers, build/package scripts, package metadata, FT-06, and FT-10.
13. Affected Architecture Fitness, Integration, full regression, lint, clean build, link, and diff checks passed at the final Gate.
14. Stable Specification and Current Architecture links changed only after implementation evidence confirmed the new paths.
15. Independent review reported no unresolved Critical or High finding.

## 13. Deferred decisions

Public registry identity, registry access, release version, license/legal metadata, signing/provenance, cross-platform release support, native executable packaging, and VS Code Extension packaging remain deferred and do not authorize implementation.

Follow [Development Workflow](../../../governance/development-workflow.md).
