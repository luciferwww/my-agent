# Extension Acquisition

> Status: Current Authority
> Authority: Current implemented Extension acquisition behavior
> Verified: 2026-09-16
> Ownership: Host-injected Extension root, Extension configuration, discovery, scoped configuration, controlled entry loading, acquisition diagnostics, and Host handoff
> Ownership key: extension-acquisition

---

## 1. Boundary

`src/extension-acquisition/` is a generic Host boundary. It consumes an explicit `extensionsDir` and injected Extension configuration, discovers direct-child descriptors, validates and materializes scoped configuration, controls ESM entry loading, validates returned Unit metadata, and returns a frozen acquisition result.

Acquisition stops at not-yet-created `LoadedRuntimeUnit[]`. It never creates, starts, registers, publishes, retires, or stops Units. [Runtime](runtime.md) is the sole owner of those lifecycle and Registry-publication transitions.

`src/extensions/` contains concrete optional Extension implementations, currently including Copilot Relay. Generic acquisition does not import or identify a concrete Extension. [Providers](providers.md) owns concrete Provider protocol behavior.

Agent configuration loading is owned by [Configuration](configuration.md); acquisition owns the semantics of its injected Extension projection.

## 2. Installation and Extension configuration

The standalone Host derives `installDir` from its installed package and injects exactly `<installDir>/extensions` into Extension Acquisition. Acquisition does not receive or resolve `installDir`, `agentHome`, startup CWD, process-global paths, or Agent Home CLI precedence. A missing Extensions directory is a non-creating empty discovery state; an invalid existing discovery root is fatal.

The Host-injected `<agentHome>/config.json` snapshot owns:

- `extensions.enabled`, the global boolean acquisition switch, defaulting to `true`;
- `extensions.entries.<descriptor-id>.enabled`, the required per-Descriptor boolean enablement switch;
- `extensions.entries.<descriptor-id>.config`, the Descriptor-scoped configuration value.

Configuration failures are classified before acquisition.

## 3. Scoped configuration

When global `extensions.enabled` is `false`, acquisition returns an empty result without discovery. Otherwise, only Descriptor entries with `enabled: true` are eligible to load. Before a factory receives its configuration, acquisition:

1. selects the Descriptor-owned namespace;
2. materializes generic `$env` and environment-backed `$secret` references from the Host process environment;
3. validates the materialized value against the Descriptor-owned Draft-07 schema;
4. defensively freezes the validated scoped value.

Environment variable names are deployment inputs selected by Host configuration, not centrally typed Extension fields. A disabled or invalid candidate gains no execution or lifecycle authority.

## 4. Discovery and loading

Discovery considers direct children of the injected install-owned `extensionsDir`. It enforces canonical containment, validates Descriptor shape, isolates all candidates participating in a duplicate Descriptor ID, and orders valid candidates deterministically by Descriptor ID.

Controlled loading imports the declared ESM entry only after enablement, containment, and configuration checks. `contracts.ts` owns exactly the Host-facing `ExtensionLoadContext` and `ExternalExtensionModule` contracts; acquisition data shapes remain in `types.ts`.

A successful entry factory returns a `LoadedRuntimeUnit`. Acquisition validates Unit identity and metadata, freezes the result, and continues independently across candidates. One rejected candidate does not remove other valid Units. Diagnostics preserve bounded deployment information without granting rejected code execution.

A configured Descriptor ID with no installed candidate produces a `stale_configured_id` diagnostic. Discovery diagnostics contribute their Descriptor IDs to the installed set, so an installed but otherwise invalid candidate is not misreported as stale configuration.

## 5. Runtime handoff

`ExtensionAcquisitionResult` contains:

```text
loadedUnits: readonly LoadedRuntimeUnit[]
diagnostics: readonly ExtensionAcquisitionDiagnostic[]
```

The returned Units have not been created. Runtime combines them with required and Host-provided Units, then owns creation, registration staging, validation, immutable publication, retirement, and stop. This keeps discovery/import failures outside Runtime lifecycle state and prevents acquisition from becoming a second composition path.

## 6. Supported Host and build boundary

`src/hosts/standalone/standalone-host.ts` is the supported service-first Host composition root. The thin executable bootstrap is `src/hosts/standalone/entry.ts`. The composition root:

1. derives `installDir` and selects `agentHome`;
2. reads the atomic generic Model Reference environment override and acquires enabled External Units from `<installDir>/extensions`;
3. reports bounded acquisition diagnostics;
4. appends the argument-selected WebSocket and/or CLI Channel Units in canonical order, or none for `none`;
5. passes `agentHome` and the combined `loadedUnits` to `RuntimeApp.create()`;
6. delegates process shutdown to the Runtime Host wrapper.

The Host owns process-level signal and exit policy; Runtime library code never calls `process.exit()`. The current wrapper shares cooperative shutdown, forces exit on a second signal or Host deadline, and removes its listeners after settlement. The canonical standalone Host's signal counts, exit codes, and Host deadline are governed by the [Standalone Service Host Specification](../specifications/standalone-service-host.md); ADR-005 remains limited to Runtime and Extension lifecycle ownership.

The Host rejects any CLI selection with an enabled Console Logger because both own terminal presentation. Builtin selection and fixed Channel construction values come only from Standalone arguments/code, never the Agent configuration snapshot. The Host does not import Relay-specific source. The first-class Host build starts from `src/hosts/standalone/entry.ts`, follows its static TypeScript closure, and emits `dist/host`; npm maps `my-agent` directly to `dist/host/hosts/standalone/entry.js`. That closure includes `extension-acquisition/` and excludes `extensions/**`; it is a verified Host code closure plus required Agent Context templates, not a bundled Node runtime or concrete External Extension. The aggregate repository build continues to build and audit declared Extension artifacts separately.

Package verification installs the tarball into an isolated project, runs the generated command from a separate startup directory with isolated default and explicit Agent Homes, and compares every installed package file path and byte after shutdown. The compiled WebSocket smoke provisions the Relay artifact under `installDir` before startup and likewise proves Runtime does not alter that Extension tree.

## 7. Failure boundaries

- Invalid Host-derived path context is fatal before discovery.
- Missing optional roots are empty states; invalid existing roots are fatal.
- Candidate-level Descriptor, containment, duplicate, schema, environment-reference, import, export, or Unit-metadata failures are isolated diagnostics.
- No invalid candidate is passed to Runtime.
- Acquisition diagnostics are reported by the Host; Runtime warnings remain Runtime-owned.

## 8. Evidence

| Kind | Evidence |
|---|---|
| Source | [public boundary](../../src/extension-acquisition/index.ts), [entry contracts](../../src/extension-acquisition/contracts.ts), [discovery](../../src/extension-acquisition/discovery.ts), [loader](../../src/extension-acquisition/loader.ts), [standalone path context](../../src/hosts/standalone/path-context.ts), [standalone entry](../../src/hosts/standalone/entry.ts), [standalone Host](../../src/hosts/standalone/standalone-host.ts), [Runtime Host wrapper](../../src/hosts/standalone/runtime-host.ts), [Host build audit](../../scripts/audit-host-build.mjs) |
| Tests | [standalone path-context tests](../../src/hosts/standalone/path-context.test.ts), [discovery tests](../../src/extension-acquisition/discovery.test.ts), [loader tests](../../src/extension-acquisition/loader.test.ts), [Runtime integration](../../src/extension-acquisition/acquisition-runtime.integration.test.ts), [Host startup tests](../../src/hosts/standalone/standalone-host.test.ts), [Runtime Host policy tests](../../src/hosts/standalone/runtime-host.test.ts), [package verifier tests](../../scripts/verify-npm-package.test.mjs), [package smoke](../../scripts/verify-npm-package.mjs), [WebSocket Host smoke](../../scripts/verify-websocket-host.mjs) |
| Controlling authority | [ADR-005](../decisions/adr-005-extension-registry-runtime-composition.md), [ADR-010](../decisions/adr-010-install-and-agent-home-ownership.md), [ADR-012](../decisions/adr-012-agent-home-path-unification.md), [Extension Acquisition Specification](../specifications/extension-acquisition.md) |
| Delivery history | [B+ archived change](../changes/archive/extension-acquisition-source-layout/specification.md) |
