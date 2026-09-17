# Standalone Service Host Specification

> Status: Stable Authority
> Contract status: Implemented and Validated
> Verified: 2026-09-16
> Authority: Canonical standalone process Host contract

## Scope

Own one service-first executable and composition root around `RuntimeApp.create()`: installed-package derivation and Agent Home selection; one Agent configuration snapshot; External Unit acquisition; optional builtin Channel selection; output compatibility; process liveness; shutdown; diagnostics; and exit status.

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

The Host follows `arguments -> paths -> configuration bootstrap -> one strict configuration read -> validation -> Extension Acquisition -> Runtime`. It uses the one immutable snapshot's Extension projection for acquisition, appends zero to two selected builtin Units, then calls `RuntimeApp.create()` with explicit `agentHome` and the Application projection. A bootstrap or load failure prevents acquisition and Runtime creation. Core Agent Context retains its independent Runtime-owned initialization.

WebSocket controls Host lifetime whenever selected; CLI controls only when selected without WebSocket. A controlling Channel's normal or failed completion initiates shared Runtime shutdown, and failure sets process exit status 1. With both selected, CLI closure leaves WebSocket active and CLI failure emits one bounded warning without failure status or shutdown. With `none`, the Host remains alive until a process signal or explicit Host shutdown; arbitrary Extension Channel completion is not a lifetime trigger. First signal starts cooperative shutdown; a second signal forces the conventional signal status; the Host deadline forces status 1. Runtime library code never exits the process.

Startup failures set process exit status 1 and emit bounded `stderr` diagnostics. Candidate-local acquisition failures remain isolated, bounded warnings. Diagnostics never expose secrets or raw configuration.

## Build and compatibility

The thin executable bootstrap is `src/hosts/standalone/entry.ts`; testable composition is owned by `src/hosts/standalone/standalone-host.ts`. The Host build emits `dist/host/hosts/standalone/entry.js` and audits a closed generic Extension boundary plus required Agent Context templates. The npm `bin` maps `my-agent` directly to that entry, and the package allowlist contains only `dist/host` besides npm-standard root metadata/README inclusion. Removed scripts-based, WebSocket-only, and prototype entries are not forwarding composition roots.

`prepack` rebuilds and audits the Host closure. Package verification audits `npm pack --json`, installs the tarball in an isolated temporary project on the current Node 22/npm platform, verifies the generated command and fatal entry boundary, and runs default and explicit Agent Home first-start scenarios. Both prove exact `{}\n` configuration creation without changing installation or startup-CWD trees; the explicit scenario forwards the Agent Home and `none` options. It also proves direct legacy-`host` rejection and omitted-selection startup at the fixed WebSocket endpoint. The compiled WebSocket verifier provisions the Relay fixture under `<installDir>/extensions`, completes a streamed Turn through that endpoint, and proves Runtime leaves the Extension tree unchanged. External registry publication, a cross-platform release matrix, a root wrapper, and a native/single-file executable are not part of this contract.

## Evidence

Source: [standalone entry](../../src/hosts/standalone/entry.ts), [standalone Host](../../src/hosts/standalone/standalone-host.ts), [standalone path context](../../src/hosts/standalone/path-context.ts), [Runtime Host wrapper](../../src/hosts/standalone/runtime-host.ts), [Agent configuration](../../src/platform/config/agent-config-loader.ts), [Extension acquisition](../../src/extension-acquisition/loader.ts), [package verifier](../../scripts/verify-npm-package.mjs), [WebSocket verifier](../../scripts/verify-websocket-host.mjs), and [package surface](../../package.json).

Tests: [standalone path-context tests](../../src/hosts/standalone/path-context.test.ts), [standalone Host tests](../../src/hosts/standalone/standalone-host.test.ts), [Runtime Host tests](../../src/hosts/standalone/runtime-host.test.ts), [Agent configuration tests](../../src/platform/config/agent-config-loader.test.ts), [Host build audit tests](../../scripts/audit-host-build.test.mjs), [package audit tests](../../scripts/audit-npm-package.test.mjs), and [package-verifier tests](../../scripts/verify-npm-package.test.mjs).

Decisions: [ADR-009](../decisions/adr-009-host-boundaries-and-standalone-npm-distribution.md) as refined by [ADR-010](../decisions/adr-010-install-and-agent-home-ownership.md), [ADR-011](../decisions/adr-011-standalone-agent-home-configuration-bootstrap.md), [ADR-012](../decisions/adr-012-agent-home-path-unification.md), and [ADR-013](../decisions/adr-013-standalone-host-arguments-and-channels.md).
