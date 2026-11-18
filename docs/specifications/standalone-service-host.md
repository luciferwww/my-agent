# Standalone Service Host Specification

> Status: Stable Authority
> Contract status: Implemented and Validated
> Verified: 2026-10-16
> Authority: Canonical standalone process Host contract

## Scope

Own one service-first executable and composition root around `RuntimeApp.create()`: installed-package derivation and Agent Home selection; one Agent configuration snapshot; generic Runtime startup facts; optional Host-local CLI selection; output compatibility; process liveness; shutdown; fatal entry diagnostics; and exit status.

CLI is an optional Host-local Channel, not the architecture. Runtime remains the sole owner of Unit composition and lifecycle.

## Entry and path selection

The canonical package command is `my-agent`; repository development uses `npm run agent`. The standalone entry accepts at most one Agent Home option across `-ah <path>`, `--agent-home <path>`, and `--agent-home=<path>`, plus the optional boolean `--cli` flag, at most once. Short equals forms are unsupported. Missing Agent Home values, blank values, duplicate options, and unknown arguments fail with one `HOST_ARGUMENT_INVALID` diagnostic. The retired `--initialize`, `-bc`, and `--builtin-channels` forms are rejected as unknown arguments.

Standalone derives `installDir` from the nearest containing npm package named `my-agent`. Agent Home defaults to `<user-home>/.my-agent`; an explicit absolute value is normalized, while an explicit relative value resolves once against startup `process.cwd()`. No custom environment or configuration source selects either path. `installDir` owns immutable program content and pre-provisioned Extensions; `agentHome` owns configuration and mutable Agent state and is the Runtime path context. Startup CWD has no architectural role after resolving a relative CLI value.

After path resolution, ordinary startup loads the strict configuration snapshot.
Only `FILE_MISSING` invokes Platform's `ensureAgentConfigDocument()` to create the
Home recursively and exclusively write `{}\n`, followed by strict loading.
Concurrent/existing files are never overwritten. Other strict-loading failures
propagate unchanged. Existing configuration content is read once.

The initialization wizard, live verification prerequisite, and fixed named-Agent
profile installer are removed. A new Home can start without a Provider or default
Model, then use an available Channel's Settings to configure them.

## Host-local Channel selection

Standalone supplies no Host-local Channel when `--cli` is omitted. When
`--cli` is present, it supplies exactly one CLI Runtime Unit.

WebSocket is not a Host-local Channel. It is an independently installed
Extension, loaded by default unless its entry explicitly disables it.
Standalone does not import, configure,
identify, or observe that concrete Extension.

Standalone supplies fixed CLI values prompt `> ` and approval enabled. The CLI starts in a new-conversation state without a Session ID; its first ordinary message obtains a server-issued `sessionId`, and later messages reuse it until the user selects another or new Session. These values are not configurable in the global Agent document. The only top-level configuration namespaces are `agents`, `logger`, and `extensions`; retired `host` content is rejected directly. CLI selection and enabled Console Logger are incompatible because both own terminal presentation. The Host rejects the combination with `HOST_OUTPUT_CONFLICT`; File Logger is compatible.

## Composition and liveness

The ordinary Host follows `arguments -> paths -> strict load / missing-only bootstrap -> validation -> Runtime`. It passes generic `installDir`, the complete immutable configuration snapshot, and environment startup facts plus zero or one Host-local CLI Unit to `RuntimeApp.create()`. Runtime Bootstrap derives and invokes Extension Acquisition after Logger configuration; Runtime Builder combines acquired and Host-provided Units into the sole composition path. A configuration load failure prevents Runtime creation, while a fatal Runtime Bootstrap or discovery-root failure prevents composition. Individual optional Extension failures are diagnosed and isolated. Core Agent Context retains its independent Runtime-owned initialization.

CLI completion controls Host lifetime only when `--cli` is present. Its normal
or failed completion initiates shared Runtime shutdown, and failure sets process
exit status 1. Without `--cli`, the Host remains alive until a process signal
or explicit Host shutdown. Arbitrary Extension Channel completion is never a
Standalone lifetime trigger. Runtime Composition records a bounded ID/phase
warning for any successfully published Channel completion failure; Standalone
does not duplicate that warning. First signal starts cooperative shutdown; a
second signal forces the conventional signal status; the Host deadline forces
status 1. Runtime library code never exits the process.

Startup failures set process exit status 1 and emit bounded `stderr` diagnostics. Candidate-local acquisition failures remain isolated, bounded warnings. Diagnostics never expose secrets or raw configuration.

Runtime owns the held PID-file lock described by
[Runtime Composition](runtime-composition.md#agent-home-ownership). Host startup
must not delete that file or kill a reported owner. Incomplete cleanup may
retain ownership until the Host process exits; the Host preserves failure/
residual exit status rather than claiming a clean shutdown.

## Build and compatibility

The thin executable bootstrap is `src/hosts/standalone/entry.ts`; testable composition is owned by `src/hosts/standalone/standalone-host.ts`. The Host build emits `dist/host/hosts/standalone/entry.js` and audits a closed generic Extension boundary plus required Agent Context templates. The npm `bin` maps `my-agent` directly to that entry, and the package allowlist contains only `dist/host` besides npm-standard root metadata/README inclusion. Removed scripts-based, WebSocket-only, and prototype entries are not forwarding composition roots.

`prepack` rebuilds and audits the Host closure. Package verification must exercise the generated command from an installed tarball, preserve installation and startup-CWD trees, and cover default and explicit Agent Home first-start behavior. External registry publication, a cross-platform release matrix, a root wrapper, and a native/single-file executable are not part of this contract.
