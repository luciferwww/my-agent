# Extension Acquisition

> Status: Current Authority
> Authority: Current implemented Extension acquisition behavior
> Verified: 2026-09-18
> Ownership: Extension packages, public API, Runtime-Bootstrap-derived Extension root, configuration, discovery, Jiti loading, acquisition diagnostics, and Runtime handoff
> Ownership key: extension-acquisition

---

## 1. Boundary

`src/extension/acquisition/` is the generic loading boundary invoked by Runtime Bootstrap. It consumes an explicit `extensionsDir` and injected Extension configuration, discovers direct-child descriptors, validates and materializes scoped configuration, loads module entries through Jiti, validates returned Unit metadata, and returns a frozen acquisition result.

Acquisition stops at not-yet-created `LoadedRuntimeUnit[]`. It never creates, starts, registers, publishes, retires, or stops Units. [Runtime](runtime.md) is the sole owner of those lifecycle and Registry-publication transitions.

`extensions/*` contains independently owned npm workspace packages, currently including Copilot Relay. Each package owns its metadata, source, tests, runtime dependencies, and optional build process. `src/extension/api/` exposes the minimum stable Host contract used by those packages through `my-agent/extension-api`. Generic acquisition does not import or identify a concrete Extension. [Providers](providers.md) owns concrete Provider protocol behavior.

Agent configuration loading is owned by [Configuration](configuration.md); acquisition owns the semantics of its injected Extension projection.

## 2. Installation and Extension configuration

The standalone Host derives `installDir` from its installed package and passes it to Runtime as a generic startup fact. Runtime Bootstrap derives exactly `<installDir>/extensions` and injects that root into Extension Acquisition. Acquisition does not receive or resolve `installDir`, `agentHome`, startup CWD, process-global paths, or Agent Home CLI precedence. A missing Extensions directory is a non-creating empty discovery state; an invalid existing discovery root is fatal.

The Host-loaded `<agentHome>/config.json` snapshot owns:

- `extensions.enabled`, the global boolean acquisition switch, defaulting to `true`;
- `extensions.entries.<descriptor-id>.enabled`, an optional per-Descriptor boolean that defaults to `true` when the entry exists;
- `extensions.entries.<descriptor-id>.config`, the Descriptor-scoped configuration value.

Configuration failures are classified before acquisition.

## 3. Scoped configuration

When global `extensions.enabled` is `false`, acquisition returns an empty result without discovery. An installed Extension without a matching configured entry remains disabled. For an existing entry, omitted `enabled` defaults to `true` and explicit `false` disables it. Before a factory receives its configuration, acquisition:

1. selects the Descriptor-owned namespace;
2. materializes generic `$env` and environment-backed `$secret` references from the Host process environment;
3. validates the materialized value against the Descriptor-owned Draft-07 schema;
4. defensively freezes the validated scoped value.

Environment variable names are deployment inputs selected by Host configuration, not centrally typed Extension fields. A disabled or invalid candidate gains no execution or lifecycle authority.

## 4. Discovery and loading

Discovery considers direct children of the injected install-owned `extensionsDir`. It enforces canonical containment, validates Descriptor shape, isolates all candidates participating in a duplicate Descriptor ID, and orders valid candidates deterministically by Descriptor ID.

Controlled loading passes the declared module entry to the single Jiti Loader only after enablement, containment, and configuration checks. The entry is a contained relative regular file; its source or output suffix is not a public constraint. `my-agent/extension-api` owns the supported Extension-facing contract surface; acquisition data shapes remain private in `types.ts`.

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
2. passes generic `installDir`, configuration snapshot, and environment startup facts to Runtime;
3. lets Runtime Bootstrap derive `<installDir>/extensions` and invoke the shared Acquisition boundary after Logger configuration;
4. appends the argument-selected WebSocket and/or CLI Channel Units in canonical order, or none for `none`;
5. passes `agentHome` and Host-constructed Channel Units to `RuntimeApp.create()`;
6. delegates process shutdown to the Runtime Host wrapper.

The Host owns process-level signal and exit policy; Runtime library code never calls `process.exit()`. The current wrapper shares cooperative shutdown, forces exit on a second signal or Host deadline, and removes its listeners after settlement. The canonical standalone Host's signal counts, exit codes, and Host deadline are governed by the [Standalone Service Host Specification](../specifications/standalone-service-host.md); ADR-014 owns Extension package/loading and Runtime Unit lifecycle decisions.

The Host rejects any CLI selection with an enabled Console Logger because both own terminal presentation. Builtin selection and fixed Channel construction values come only from Standalone arguments/code, never the Agent configuration snapshot. The Host does not import Relay-specific source. The first-class Host build starts from `src/hosts/standalone/entry.ts`, follows its static TypeScript closure, and emits `dist/host`; npm maps `my-agent` directly to `dist/host/hosts/standalone/entry.js`. That closure includes `extension/acquisition/` and the public `extension/api/`, while concrete `extensions/**` packages remain outside the Host closure.

The npm package carries the public Extension API and selected official Extension packages under its installation root.

## 7. Failure boundaries

- Invalid Host-derived path context is fatal before discovery.
- Missing optional roots are empty states; invalid existing roots are fatal.
- Candidate-level Descriptor, containment, duplicate, schema, environment-reference, import, export, or Unit-metadata failures are isolated diagnostics.
- No invalid candidate is passed to Runtime.
- Acquisition logs and diagnostics are reported through the shared `ExtensionAcquisition` Logger; Runtime warnings remain Runtime-owned.

## 8. Evidence

| Kind | Evidence |
|---|---|
| Source | [acquisition boundary](../../src/extension/acquisition/index.ts), [Extension API](../../src/extension/api/index.ts) |
| Tests | [discovery tests](../../src/extension/acquisition/discovery.test.ts), [loader tests](../../src/extension/acquisition/loader.test.ts) |
| Controlling authority | [Extension Acquisition Specification](../specifications/extension-acquisition.md) |
