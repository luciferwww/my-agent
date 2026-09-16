# Standalone Service Host Specification

> Status: Stable Authority
> Contract status: Implemented and Validated
> Verified: 2026-09-16
> Authority: Canonical standalone process Host contract

## Scope

Own one service-first executable and composition root around `RuntimeApp.create()`: installed-package derivation and Agent Home selection; one Agent configuration snapshot; External Unit acquisition; optional builtin Channel selection; output compatibility; process liveness; shutdown; diagnostics; and exit status.

CLI is an optional Channel mode, not the architecture. Runtime remains the sole owner of Unit composition and lifecycle.

## Entry and path selection

The canonical package command is `my-agent`; repository development uses `npm run agent`. The standalone entry accepts at most one Agent Home option, either `--agent-home <path>` or `--agent-home=<path>`. Missing, blank, duplicate, and unknown arguments fail with one `HOST_ARGUMENT_INVALID` diagnostic.

Standalone derives `installDir` from the nearest containing npm package named `my-agent`. Agent Home defaults to `<user-home>/.my-agent`; an explicit absolute value is normalized, while an explicit relative value resolves once against startup `process.cwd()`. No custom environment or configuration source selects either path. `installDir` owns immutable program content and pre-provisioned Extensions; `agentHome` owns configuration and mutable Agent state and is the Runtime path context. Startup CWD has no architectural role after resolving a relative CLI value.

After path resolution, standalone ensures Agent Home exists and exclusively creates a missing `<agentHome>/config.json` with exact UTF-8 bytes `{}\n`. Existing configuration is preserved byte-for-byte. The Host then performs one strict document-content read; a document missing at read time is fatal `FILE_MISSING`. Generating `{}` materializes physical default content but does not select a Provider/Model, provision credentials or Extensions, or guarantee a successful Turn.

## Host configuration and modes

The Host projection in `<agentHome>/config.json` selects exactly one mode:

- `websocket` (default): one builtin WebSocket Channel;
- `cli`: one builtin CLI Channel;
- `headless`: no builtin Channel; External Units may still contribute Channels.

WebSocket defaults are `127.0.0.1:8787`, path `/ws`, with approval enabled. CLI defaults are Session key `main`, prompt `> `, with approval enabled. Unknown fields, invalid mode, blank required strings, invalid path, and ports outside `1..65535` are fatal Agent configuration errors.

CLI mode and enabled Console Logger are incompatible because both own terminal presentation. The Host rejects the combination with `HOST_OUTPUT_CONFLICT`; File Logger is compatible.

## Composition and liveness

The Host follows `arguments -> paths -> configuration bootstrap -> one strict configuration read -> validation -> Extension Acquisition -> Runtime`. It uses the one immutable snapshot's Extension projection for acquisition, appends the selected builtin Unit, then calls `RuntimeApp.create()` with explicit `agentHome` and the Application projection. A bootstrap or load failure prevents acquisition and Runtime creation. Core Agent Context retains its independent Runtime-owned initialization.

Normal or failed completion of the selected WebSocket/CLI Channel initiates shared Runtime shutdown. Failure sets process exit status 1. Headless mode remains alive until process signal or externally initiated Host shutdown. First signal starts cooperative shutdown; a second signal forces the conventional signal status; the Host deadline forces status 1. Runtime library code never exits the process.

Startup failures set process exit status 1 and emit bounded `stderr` diagnostics. Candidate-local acquisition failures remain isolated, bounded warnings. Diagnostics never expose secrets or raw configuration.

## Build and compatibility

The thin executable bootstrap is `src/hosts/standalone/entry.ts`; testable composition is owned by `src/hosts/standalone/standalone-host.ts`. The Host build emits `dist/host/hosts/standalone/entry.js` and audits a closed generic Extension boundary plus required Agent Context templates. The npm `bin` maps `my-agent` directly to that entry, and the package allowlist contains only `dist/host` besides npm-standard root metadata/README inclusion. Removed scripts-based, WebSocket-only, and prototype entries are not forwarding composition roots.

`prepack` rebuilds and audits the Host closure. Package verification audits `npm pack --json`, installs the tarball in an isolated temporary project on the current Node 22/npm platform, verifies the generated command and fatal entry boundary, and runs default and explicit Agent Home first-start scenarios. Both prove exact `{}\n` configuration creation without changing installation or startup-CWD trees; the explicit scenario uses the CLI path option. A configured built-in WebSocket scenario proves Context and Memory state appear under Agent Home while startup CWD remains untouched and installed package paths and bytes remain unchanged through shutdown. The compiled WebSocket verifier additionally provisions the Relay fixture under `<installDir>/extensions`, completes a streamed Turn, and proves Runtime leaves the Extension tree unchanged. External registry publication, a cross-platform release matrix, a root wrapper, and a native/single-file executable are not part of this contract.

## Evidence

Source: [standalone entry](../../src/hosts/standalone/entry.ts), [standalone Host](../../src/hosts/standalone/standalone-host.ts), [standalone path context](../../src/hosts/standalone/path-context.ts), [Runtime Host wrapper](../../src/hosts/standalone/runtime-host.ts), [Agent configuration](../../src/platform/config/agent-config-loader.ts), [Extension acquisition](../../src/extension-acquisition/loader.ts), [package verifier](../../scripts/verify-npm-package.mjs), [WebSocket verifier](../../scripts/verify-websocket-host.mjs), and [package surface](../../package.json).

Tests: [standalone path-context tests](../../src/hosts/standalone/path-context.test.ts), [standalone Host tests](../../src/hosts/standalone/standalone-host.test.ts), [Runtime Host tests](../../src/hosts/standalone/runtime-host.test.ts), [Agent configuration tests](../../src/platform/config/agent-config-loader.test.ts), [Host build audit tests](../../scripts/audit-host-build.test.mjs), [package audit tests](../../scripts/audit-npm-package.test.mjs), and [package-verifier tests](../../scripts/verify-npm-package.test.mjs).

Decisions: [ADR-009](../decisions/adr-009-host-boundaries-and-standalone-npm-distribution.md) as refined by [ADR-010](../decisions/adr-010-install-and-agent-home-ownership.md), [ADR-011](../decisions/adr-011-standalone-agent-home-configuration-bootstrap.md), and [ADR-012](../decisions/adr-012-agent-home-path-unification.md).
