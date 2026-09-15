# Extension Acquisition

> Status: Current Authority
> Authority: Current implemented Extension acquisition behavior
> Verified: 2026-09-15
> Ownership: Agent Home resolution, Host Extension configuration, discovery, scoped configuration, controlled entry loading, acquisition diagnostics, and Host handoff
> Ownership key: extension-acquisition

---

## 1. Boundary

`src/extension-acquisition/` is a generic Host boundary. It resolves Agent Home, reads machine-level Extension configuration, discovers direct-child descriptors, validates and materializes scoped configuration, controls ESM entry loading, validates returned Unit metadata, and returns a frozen acquisition result.

Acquisition stops at not-yet-created `LoadedRuntimeUnit[]`. It never creates, starts, registers, publishes, retires, or stops Units. [Runtime](runtime.md) is the sole owner of those lifecycle and Registry-publication transitions.

`src/extensions/` contains concrete optional Extension implementations, currently including Copilot Relay. Generic acquisition does not import or identify a concrete Extension. [Providers](providers.md) owns concrete Provider protocol behavior.

Application/workspace configuration is separate and owned by [Configuration](configuration.md).

## 2. Agent Home and Host configuration

Agent Home precedence is:

1. explicit `--agent-home` input;
2. `MY_AGENT_HOME`;
3. `<user-home>/.my-agent`.

The path must be non-blank and absolute after `~` expansion. A missing path is returned as a normalized, non-created empty state. An existing path must canonically resolve to a directory.

`<agent-home>/config.json` is separate from `<workspace>/.agent/config.json`. It owns:

- `extensions.enabled`, the global boolean acquisition switch, defaulting to `true`;
- `extensions.entries.<descriptor-id>.enabled`, the required per-Descriptor boolean enablement switch;
- `extensions.entries.<descriptor-id>.config`, the Descriptor-scoped configuration value.

Missing Agent Home, Host config, or Extensions directory produces an empty non-creating state. An existing unreadable, malformed, or root-invalid Host config, and an invalid existing discovery root, are fatal Host configuration errors.

## 3. Scoped configuration

When global `extensions.enabled` is `false`, acquisition returns an empty result without discovery. Otherwise, only Descriptor entries with `enabled: true` are eligible to load. Before a factory receives its configuration, acquisition:

1. selects the Descriptor-owned namespace;
2. materializes generic `$env` and environment-backed `$secret` references from the Host process environment;
3. validates the materialized value against the Descriptor-owned Draft-07 schema;
4. defensively freezes the validated scoped value.

Environment variable names are deployment inputs selected by Host configuration, not centrally typed Extension fields. A disabled or invalid candidate gains no execution or lifecycle authority.

## 4. Discovery and loading

Discovery considers direct children of `<agent-home>/extensions`. It enforces canonical containment, validates Descriptor shape, isolates all candidates participating in a duplicate Descriptor ID, and orders valid candidates deterministically by Descriptor ID.

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

`scripts/server.ts` is the supported WebSocket Host composition root. It:

1. reads the atomic generic Model Reference environment override;
2. resolves Agent Home and acquires enabled External Units;
3. reports bounded acquisition diagnostics;
4. appends the statically configured WebSocket Channel Unit;
5. passes the combined `loadedUnits` to `RuntimeApp.create()`;
6. delegates process shutdown to the Runtime Host wrapper.

The Host owns process-level signal and exit policy; Runtime library code never calls `process.exit()`. The current wrapper shares cooperative shutdown, forces exit on a second signal or Host deadline, and removes its listeners after settlement. Those signal counts, exit codes, and Host deadlines are current implementation facts, not a stable contract; ADR-005 deliberately leaves Host signal mechanics unfrozen.

The Host does not import Relay-specific source. The first-class Host build starts from `scripts/server.ts`, follows its static TypeScript closure, and emits `dist/host`. That closure includes `src/extension-acquisition/` and excludes `src/extensions/**`; it is a verified Host code closure, not a self-contained deployment bundle. The aggregate repository build continues to build and audit declared Extension artifacts separately.

## 7. Failure boundaries

- Invalid explicit/environment Agent Home values are fatal before discovery.
- Missing optional roots are empty states; invalid existing roots are fatal.
- Candidate-level Descriptor, containment, duplicate, schema, environment-reference, import, export, or Unit-metadata failures are isolated diagnostics.
- No invalid candidate is passed to Runtime.
- Acquisition diagnostics are reported by the Host; Runtime warnings remain Runtime-owned.

## 8. Evidence

| Kind | Evidence |
|---|---|
| Source | [public boundary](../../src/extension-acquisition/index.ts), [entry contracts](../../src/extension-acquisition/contracts.ts), [Agent Home](../../src/extension-acquisition/agent-home.ts), [Host config](../../src/extension-acquisition/host-config.ts), [discovery](../../src/extension-acquisition/discovery.ts), [loader](../../src/extension-acquisition/loader.ts), [Host startup](../../scripts/server.ts), [Runtime Host wrapper](../../scripts/runtime-host.ts), [Host build audit](../../scripts/audit-host-build.mjs) |
| Tests | [Agent Home tests](../../src/extension-acquisition/agent-home.test.ts), [Host config tests](../../src/extension-acquisition/host-config.test.ts), [discovery tests](../../src/extension-acquisition/discovery.test.ts), [loader tests](../../src/extension-acquisition/loader.test.ts), [Runtime integration](../../src/extension-acquisition/acquisition-runtime.integration.test.ts), [Host startup tests](../../scripts/websocket-host-startup.test.ts), [Runtime Host policy tests](../../scripts/runtime-host.test.ts) |
| Controlling authority | [ADR-005](../decisions/adr-005-extension-registry-runtime-composition.md), [Extension Acquisition Specification](../specifications/extension-acquisition.md) |
| Delivery history | [B+ archived change](../changes/archive/extension-acquisition-source-layout/specification.md) |
