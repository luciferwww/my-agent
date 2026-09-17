# Standalone Service Host Specification

> Status: Stable Authority
> Contract status: Implemented and Validated
> Verified: 2026-09-17
> Authority: Canonical standalone process Host contract

## Scope

Own one service-first executable and composition root around `RuntimeApp.create()`: installed-package derivation and Agent Home selection; one Agent configuration snapshot; generic Runtime startup facts; optional builtin Channel selection; output compatibility; process liveness; shutdown; fatal entry diagnostics; and exit status.

CLI is an optional Builtin Channel, not the architecture. Runtime remains the sole owner of Unit composition and lifecycle.

## Entry and path selection

The canonical package command is `my-agent`; repository development uses `npm run agent`. The standalone entry accepts at most one Agent Home option across `-ah <path>`, `--agent-home <path>`, and `--agent-home=<path>`, plus at most one Builtin Channel option across `-bc <list>`, `--builtin-channels <list>`, and `--builtin-channels=<list>`. Short equals forms are unsupported. Missing, blank, duplicate, and unknown arguments fail with one `HOST_ARGUMENT_INVALID` diagnostic.

Standalone derives `installDir` from the nearest containing npm package named `my-agent`. Agent Home defaults to `<user-home>/.my-agent`; an explicit absolute value is normalized, while an explicit relative value resolves once against startup `process.cwd()`. No custom environment or configuration source selects either path. `installDir` owns immutable program content and pre-provisioned Extensions; `agentHome` owns configuration and mutable Agent state and is the Runtime path context. Startup CWD has no architectural role after resolving a relative CLI value.

After path resolution, standalone ensures Agent Home exists and exclusively creates a missing `<agentHome>/config.json` with exact UTF-8 bytes `{}\n`. Existing configuration is preserved byte-for-byte. The Host then performs one strict document-content read; a document missing at read time is fatal `FILE_MISSING`. Generating `{}` materializes physical default content but does not select a Provider/Model, provision credentials or Extensions, or guarantee a successful Turn.

## Builtin Channel selection

Standalone process arguments select zero, one, or both Builtin Channels. Omission selects WebSocket. Exact accepted values are:

- `websocket` (default): one builtin WebSocket Channel;
- `cli`: one builtin CLI Channel;
- `websocket,cli` or `cli,websocket`: both in canonical WebSocket-then-CLI order;
- `none`: no builtin Channel; External Units may still contribute Channels.

Whitespace is not normalized. Empty segments, duplicate names, unknown/case-variant names, and mixed `none` are invalid. Selection is immutable for the process lifetime.

Standalone supplies fixed WebSocket values `127.0.0.1:8787`, path `/ws`, approval enabled, and fixed CLI values Session key `main`, prompt `> `, approval enabled. These are not configurable in the global Agent document. The only top-level configuration namespaces are `agents`, `logger`, and `extensions`; retired `host` content is rejected directly. CLI selection and enabled Console Logger are incompatible because both own terminal presentation. The Host rejects the combination with `HOST_OUTPUT_CONFLICT`; File Logger is compatible.

## Composition and liveness

The Host follows `arguments -> paths -> configuration bootstrap -> one strict configuration read -> validation -> Runtime`. It passes generic `installDir`, the complete immutable configuration snapshot, and environment startup facts plus zero to two selected builtin Units to `RuntimeApp.create()`. Runtime Bootstrap derives and invokes Extension Acquisition after Logger configuration; Runtime Builder combines acquired and Host-provided Units into the sole composition path. A configuration bootstrap or load failure prevents Runtime creation, while a Runtime Bootstrap or acquisition failure prevents composition. Core Agent Context retains its independent Runtime-owned initialization.

WebSocket controls Host lifetime whenever selected; CLI controls only when selected without WebSocket. A controlling Channel's normal or failed completion initiates shared Runtime shutdown, and failure sets process exit status 1. With both selected, CLI closure or failure leaves WebSocket active without changing process status or initiating shutdown. Runtime Composition records a bounded ID/phase warning for any successfully published Channel completion failure; Standalone does not duplicate that warning or observe secondary completion only for logging. With `none`, the Host remains alive until a process signal or explicit Host shutdown; arbitrary Extension Channel completion is not a lifetime trigger. First signal starts cooperative shutdown; a second signal forces the conventional signal status; the Host deadline forces status 1. Runtime library code never exits the process.

Startup failures set process exit status 1 and emit bounded `stderr` diagnostics. Candidate-local acquisition failures remain isolated, bounded warnings. Diagnostics never expose secrets or raw configuration.

## Build and compatibility

The thin executable bootstrap is `src/hosts/standalone/entry.ts`; testable composition is owned by `src/hosts/standalone/standalone-host.ts`. The Host build emits `dist/host/hosts/standalone/entry.js` and audits a closed generic Extension boundary plus required Agent Context templates. The npm `bin` maps `my-agent` directly to that entry, and the package allowlist contains only `dist/host` besides npm-standard root metadata/README inclusion. Removed scripts-based, WebSocket-only, and prototype entries are not forwarding composition roots.

`prepack` rebuilds and audits the Host closure. Package verification must exercise the generated command from an installed tarball, preserve installation and startup-CWD trees, and cover default and explicit Agent Home first-start behavior. External registry publication, a cross-platform release matrix, a root wrapper, and a native/single-file executable are not part of this contract.
