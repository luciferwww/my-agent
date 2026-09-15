# Extension Acquisition Specification

> Status: Stable Authority
> Contract status: Implemented and Validated
> Verified: 2026-09-14
> Authority: Stable Host acquisition contract

## Scope

Own Agent Home resolution, Host config, direct-child discovery, Descriptor and path validation, duplicate isolation, scoped configuration, controlled ESM loading, Unit metadata validation, diagnostics, and frozen handoff of uncreated Units.

Excluded: marketplace/install/update/signing; watchers/hot reload; sandboxing; Unit creation, registration, publication, retirement, or stop; Extension dependencies; public SDK packaging; and self-contained deployment bundling.

## Contracts

```ts
interface ExtensionDescriptorV1 {
  readonly manifestVersion: 1;
  readonly id: string;
  readonly version: string;
  readonly entry: string;
  readonly configSchema: Readonly<Record<string, unknown>>;
}
interface ExtensionLoadContext { readonly config: Readonly<Record<string, unknown>> }
interface ExternalExtensionModule { createExtension(context: ExtensionLoadContext): LoadedRuntimeUnit }
interface ExtensionAcquisitionResult {
  readonly loadedUnits: readonly LoadedRuntimeUnit[];
  readonly diagnostics: readonly ExtensionAcquisitionDiagnostic[];
}
```

## Agent Home and discovery

Agent Home precedence is explicit path, `MY_AGENT_HOME`, then `<home>/.my-agent`. Missing paths are normalized but not created. Existing paths must canonically resolve to directories.

Discover only direct children of `<agent-home>/extensions`. Descriptor ID matches `[A-Za-z0-9_-]{1,64}`; directory name is a locator only. Entry is a contained relative `.js` regular file and may not be a symlink/reparse point. All duplicate-ID candidates are isolated; no winner is chosen. Valid candidates sort deterministically by ID.

Descriptor schema is Draft-07, root object, `additionalProperties: false`, with internal JSON Pointer references only.

## Host configuration and loading

Global `extensions.enabled` defaults true and short-circuits discovery when false. A candidate loads only when `entries.<id>.enabled === true`; config presence alone does not enable it.

Exact `$env` and environment-backed `$secret` references are materialized before strict Ajv validation. Defaults are allowed; coercion and unknown-property removal are not. The synchronous factory receives only defensively frozen scoped config and must not create resources.

The returned Unit must match Descriptor ID, use source `external`, be optional and initially enabled, have no dependencies, and expose callable `create`. Loader never invokes `create`, `start`, `stop`, or registration.

## Failure semantics

Invalid explicit/environment Agent Home, invalid existing Host config, and invalid existing discovery root are fatal Host failures. Missing Agent Home/config/extensions roots are empty states.

Descriptor, containment, duplicate, schema, environment, import/export, factory, and Unit metadata failures are candidate-local diagnostics. A bad candidate does not suppress valid neighbors. Configured IDs without installed candidates produce `stale_configured_id`. Diagnostics/results are frozen, deterministic, bounded, and secret-free.

## Runtime boundary

Acquisition ends at `LoadedRuntimeUnit[]`. [Runtime Composition](runtime-composition.md) exclusively owns `create -> stage -> start -> publish -> retire -> stop`. Generic acquisition never imports a concrete Extension.

## Acceptance scenarios and evidence

Cover precedence, missing/invalid roots, containment/reparse rejection, Descriptor/schema validation, renamed-directory invariance, duplicate isolation, explicit/global enablement, environment/secret materialization and redaction, import/export/factory failure, Unit normalization, deterministic frozen output, bad-neighbor isolation, and Runtime publication integration.

Evidence: [acquisition source](../../src/extension-acquisition), [acquisition tests](../../src/extension-acquisition/loader.test.ts), [discovery tests](../../src/extension-acquisition/discovery.test.ts), [Runtime integration](../../src/extension-acquisition/acquisition-runtime.integration.test.ts), and [Host startup tests](../../scripts/websocket-host-startup.test.ts). Decision: [ADR-005](../decisions/adr-005-extension-registry-runtime-composition.md).
