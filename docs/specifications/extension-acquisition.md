# Extension Acquisition Specification

> Status: Stable Authority
> Contract status: Implemented and Validated
> Verified: 2026-09-17
> Authority: Stable Runtime Bootstrap acquisition contract

## Scope

Own an explicit Runtime Bootstrap-derived `extensionsDir`, injected Agent Extension configuration semantics, direct-child package discovery, Descriptor and path validation, duplicate isolation, scoped configuration, unified Jiti loading, Unit metadata validation, diagnostics, and frozen handoff of uncreated Units.

Excluded: marketplace/install/update/signing; watchers/hot reload; sandboxing; Runtime dependency installation; and Unit creation, registration, publication, retirement, or stop.

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

## Installation root and discovery

Runtime Bootstrap derives exactly `<installDir>/extensions` from generic Host startup facts and passes that explicit root to Acquisition. Acquisition does not receive or derive `installDir`, `agentHome`, process Home, startup CWD, CLI input, or environment path precedence.

Discover only direct package directories of the injected `extensionsDir`. A missing directory is a non-creating empty state. An existing root and every candidate/entry must remain canonically contained in the installation-owned location. Descriptor ID matches `[A-Za-z0-9_-]{1,64}`; directory name is a locator only. Entry is a contained relative regular file and may not be a symlink/reparse point; no filename suffix is part of the contract. All duplicate-ID candidates are isolated; no winner is chosen. Valid candidates sort deterministically by ID.

Each Extension package owns its `package.json`, source or build output, and runtime dependencies. `extension.json` owns only Host loading metadata and configuration Schema. Deployment prepares package dependencies before startup; Acquisition never installs them.

Descriptor schema is Draft-07, root object, `additionalProperties: false`, with internal JSON Pointer references only.

## Agent Extension configuration and loading

Global `extensions.enabled` defaults true and short-circuits discovery when false. An installed candidate requires a matching `entries.<id>` object. Within that object, omitted `enabled` defaults to true and explicit `false` disables it.

Exact `$env` and environment-backed `$secret` references are materialized before strict Ajv validation. Defaults are allowed; coercion and unknown-property removal are not. The synchronous factory receives only defensively frozen scoped config and must not create resources. After all static checks, one Host-owned Jiti Loader loads source and built entries through the same path.

The returned Unit must match Descriptor ID, use source `external`, be optional and initially enabled, have no dependencies, and expose callable `create`. Loader never invokes `create`, `start`, `stop`, or registration.

## Failure semantics

An invalid existing discovery root or escaped installation candidate is a fatal Host failure. A missing `extensionsDir` is an empty state. Agent configuration errors fail before acquisition.

Descriptor, containment, duplicate, schema, environment, import/export, factory, and Unit metadata failures are candidate-local diagnostics. A bad candidate does not suppress valid neighbors. Configured IDs without installed candidates produce `stale_configured_id`. Diagnostics/results are frozen, deterministic, bounded, and secret-free.

## Observability

`acquireExtensions()` is the single loading-mechanism owner of progress and diagnostics. Runtime Bootstrap invokes it during startup. Through the `ExtensionAcquisition` Logger it records the injected root, one completion summary containing loaded IDs/count, and non-disabled bounded diagnostics. Concrete Hosts do not invoke Acquisition or duplicate loading and log traversal.

Logs describe Acquisition only, not Runtime creation or publication. Logged context is limited to bounded identifiers, locators, diagnostic classifications, reference paths, environment variable names, and counts; configuration values, environment values, secrets, source content, and thrown factory details are excluded. Fatal failures before Logger configuration remain process-entry errors.

## Runtime boundary

Acquisition ends at `LoadedRuntimeUnit[]`. [Runtime Composition](runtime-composition.md) exclusively owns `create -> stage -> start -> publish -> retire -> stop`. Generic acquisition never imports a concrete Extension.

## Acceptance scenarios

Cover explicit-root handoff, missing/invalid roots, installation containment and immutability, reparse rejection, Descriptor/schema validation, renamed-directory invariance, duplicate isolation, explicit/global enablement, environment/secret materialization and redaction, import/export/factory failure, Unit normalization, deterministic frozen output, bounded secret-free logs, bad-neighbor isolation, and Runtime publication integration.

## Related authority

[Extensions](../architecture/extensions.md) owns current implementation facts, [Runtime Composition](runtime-composition.md) owns Unit lifecycle after handoff, and [ADR-014](../decisions/adr-014-extension-packages-and-runtime-composition.md) owns the package/acquisition decision.
