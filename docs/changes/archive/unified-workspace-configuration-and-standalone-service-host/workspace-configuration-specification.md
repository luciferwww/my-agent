# Workspace Configuration and State Layout Specification Amendment

> Status: Archived Change Contract
> Date: 2026-09-15
> Accepted: 2026-09-15
> Validated: 2026-09-16
> Archived: 2026-09-16
> Owner: Project owner
> Authority: Completed Change contract; stable authority transferred to [Configuration](../../../specifications/configuration.md) and [Standalone Service Host](../../../specifications/standalone-service-host.md)
> Related Plan: [Unified Workspace Configuration and Standalone Service Host](plan.md)
> Decision: [ADR-008](../../../decisions/adr-008-workspace-configuration-authority.md)

## 1. Scope

This amendment defines one Workspace-root configuration document, one startup snapshot shared by application configuration, Extension Acquisition, and the Standalone Service Host, and a root-level Workspace state layout with no `.agent` directory.

The `host` namespace was added through the accepted SSH-0 design Gate. Its mode, liveness, output-compatibility, executable, and process contracts are owned by the related [Standalone Service Host Specification](standalone-service-host-specification.md).

## 2. Authoritative location

The only configuration document is:

```text
<workspace>/config.json
```

The document owns these top-level namespaces:

```text
WorkspaceConfigDocument
├── agents?
├── logger?
├── extensions?
└── host?
```

These are the only accepted top-level namespaces. An unknown top-level namespace is rejected as a document error so misspellings cannot silently disable configuration. Any future owner must explicitly amend the document contract and common reader before adding another namespace.

The following are not configuration sources after cutover:

```text
<workspace>/.agent/config.json
<agent-home>/config.json
```

They are not read, merged, migrated automatically, or used as fallback.

## 3. Path ownership

- `workspaceDir` is explicit caller input and directly contains the configuration document, Context, Session storage, Memory state, recall state, Subagent profiles, logs, and user-authored Memory inputs.
- Agent Home remains an independently resolved Host input and supplies Extension installation/discovery artifacts under `<agent-home>/extensions/`.
- Workspace configuration controls which discovered Extensions are enabled and the scoped configuration supplied to each eligible Extension.
- No production component creates, reads, migrates, or deletes `<workspace>/.agent/`. A pre-existing directory at that path is unmanaged obsolete data.

This permits several Workspaces to share installed Extension artifacts while retaining independent Agent, Logger, Extension enablement, and Extension scoped configuration.

### 3.1 Workspace layout

```text
<workspace>/
├── config.json
├── IDENTITY.md
├── SOUL.md
├── AGENTS.md
├── TOOLS.md
├── MEMORY.md
├── memory/
│   └── <user-memory>.md
├── memory.sqlite
├── memory-recalls/
│   └── recall-log.jsonl
├── sessions/
│   ├── sessions.json
│   └── <session-id>.jsonl
├── subagents/
│   └── <id>/
└── logs/
```

Path ownership is:

- `config.json`: the only configuration document;
- `IDENTITY.md`, `SOUL.md`, `AGENTS.md`, and `TOOLS.md`: root Agent Context files initialized without overwriting an existing file;
- `MEMORY.md` and direct files under `memory/`: user-authored Memory inputs, unchanged from current behavior;
- `memory.sqlite` plus SQLite-owned `memory.sqlite-wal` and `memory.sqlite-shm` sidecars: internal Memory database state;
- `memory-recalls/recall-log.jsonl`: internal recall-tracking state, deliberately separate from indexed user Memory inputs;
- `sessions/`: Session metadata and transcripts;
- `subagents/<id>/`: named Subagent profile and Context ownership;
- `logs/`: File Logger output under its existing adapter policy.

Workspace bootstrap creates `workspaceDir` when it does not exist, then exclusively creates missing root Context files without overwriting existing content. Configuration loading occurs first; an absent Workspace therefore has no config document, uses defaults, and can then be initialized.

Other state remains owner-initialized rather than being created eagerly:

- `sessions/` is created when the first Session is persisted;
- `memory.sqlite` and its parent Workspace are initialized when Memory is enabled;
- `memory-recalls/` is created lazily on the first recall-log write;
- `subagents/` and profile directories are user-owned inputs and are not created merely because Subagents are enabled;
- `logs/` is created only when File Logger is enabled.

A path whose existing filesystem kind conflicts with the required file or directory produces the owning module's existing classified startup/operation failure. Existing reserved paths have these rules:

- an existing `config.json` is treated as the my-agent Workspace document and must satisfy this contract;
- an existing root Context file is preserved as authoritative user content;
- owned modules inspect only their defined files inside `sessions/`, `memory-recalls/`, and `subagents/` and do not clean unrelated entries;
- the Change introduces no new symlink/reparse-point behavior beyond the existing owning module and filesystem rules;
- selecting a Workspace whose reserved names conflict with another application is an operator error; the Host does not rename, overwrite, or merge those paths.

## 4. Single-read snapshot

The outer composition boundary exposes this conceptual contract:

```ts
interface ApplicationConfigProjection {
  readonly agents: AgentsConfig;
  readonly logger: LoggerModuleConfig;
}

interface WorkspaceConfigSnapshot {
  readonly application: ApplicationConfigProjection;
  readonly extensions: ResolvedHostExtensionsConfig;
  readonly host: StandaloneHostConfigProjection;
}

function loadWorkspaceConfig(options: {
  readonly workspaceDir: string;
}): Promise<WorkspaceConfigSnapshot>;
```

`workspaceDir` remains separate explicit runtime context and is not stored in the document or projection. The outer composition boundary reads `<workspace>/config.json` at most once for a startup attempt. A successful read produces narrow projections:

- application projection: Agent defaults/list and Logger configuration;
- Extension projection: global enablement and Descriptor-keyed entries;
- Host projection: selected standalone mode and validated WebSocket/CLI settings, as accepted by the Standalone Service Host contract.

Runtime options gain `applicationConfig?: ApplicationConfigProjection`; omission means hardcoded application defaults and never triggers filesystem loading. Runtime combines the explicit `workspaceDir` with this projection to construct its existing internal `AppConfig`, then `resolveAgentConfig()` continues to apply the matching Agent entry, environment overrides, and caller/CLI overrides.

Extension Acquisition continues to receive `ResolvedHostExtensionsConfig`, but that projection comes from the common snapshot rather than an acquisition-owned file reader. Runtime and Acquisition must not reread the file or resolve a configuration path.

The raw parsed object is not retained or exposed. The two projections may be distinct objects derived from the same single parse; object identity or shared nested references between projections is not required. Every object and array reachable from either projection is frozen before publication. Tests must prove attempted mutation throws in strict mode or otherwise cannot alter observed values. “Same snapshot” means one file read and one parsed document version, not cross-projection object identity.

The snapshot is startup input, not a live configuration service. Dynamic reload is outside this amendment.

## 5. File and structural failure behavior

| Condition | Required result |
|---|---|
| File does not exist | Produce defaults |
| Existing file cannot be inspected or read | Fail startup with a classified configuration error |
| Invalid JSON | Fail startup with a classified configuration error |
| Root is not an object | Fail startup with a classified configuration error |
| Known namespace has an invalid structure defined below | Fail startup with `NAMESPACE_INVALID` and namespace attribution |
| Optional known namespace is absent | Use that namespace's defaults |
| Unknown top-level namespace | Fail startup with `UNKNOWN_NAMESPACE` and bounded key attribution |

Errors must not include secret values or unbounded file content.

The common reader throws `WorkspaceConfigError` with exactly one of these document-level codes:

```text
FILE_UNREADABLE
INVALID_JSON
ROOT_INVALID
UNKNOWN_NAMESPACE
NAMESPACE_INVALID
```

The error exposes a bounded namespace or field path when applicable and a secret-free operator message. It does not reuse `HOST_CONFIG_INVALID`, which is retired with the Agent Home reader. If a failure is surfaced through Runtime startup classification, it maps to the existing fatal `CONFIG_INVALID`; direct Host/embedding callers may inspect `WorkspaceConfigError.code`.

This intentionally replaces the old application behavior that silently degraded malformed or unreadable configuration to defaults. A missing file remains a valid default state.

### 5.1 Namespace structural validation

This amendment adds bounded structural validation, not a new full JSON Schema for every `AgentDefaults` leaf:

- `agents`, `agents.defaults`, and `logger` must be plain objects when present;
- `agents.list` must be an array; every item must be a plain object with a non-empty string `id`, and `default` must be boolean when present;
- `logger.minLevel`, `logger.console.minLevel`, and `logger.file.minLevel` must be `debug`, `info`, `warn`, or `error` when present;
- `logger.console` and `logger.file` must be plain objects when present, and their `enabled` values must be boolean when present;
- `extensions` must be a plain object when present; `extensions.enabled` must be boolean when present; and `extensions.entries` must be a plain object when present;
- `host` must be a plain object when present and accepts only the bounded mode-specific fields defined by the Standalone Service Host contract;
- Descriptor-keyed Extension entry values remain unknown at document projection time so existing per-candidate isolation and Descriptor-owned validation remain intact;
- structured Model Reference validation and removed-field rejection continue through the existing application validation boundary;
- other `AgentDefaults` leaf semantics remain governed by the existing Configuration contract and consuming module validation rather than being expanded in this Change.

Unknown fields inside a known namespace retain their existing behavior unless they violate one of the structural or removed-field rules above. Tightening every nested application field is outside scope.

## 6. Application projection

Application semantics remain:

```text
hardcoded defaults
  -> file agents.defaults and logger
  -> matching agents.list entry
  -> environment overrides
  -> caller/CLI overrides
```

The existing deep-merge behavior, structured default Model Reference, Logger defaults/adapters, Tool policy, Subagent policy, and removed-field rules do not change in this phase.

`workspaceDir` remains runtime context and is not derived from the document.

## 7. Extension projection

The `extensions` namespace retains its current meaning:

- `extensions.enabled` is the global acquisition switch and defaults to `true`;
- `extensions.entries.<descriptor-id>.enabled` controls Descriptor eligibility;
- `extensions.entries.<descriptor-id>.config` is the Descriptor-scoped value materialized and validated before factory invocation.

Agent Home discovery, containment, Descriptor validation, `$env`/`$secret` materialization, candidate isolation, diagnostics, and the `LoadedRuntimeUnit[]` handoff remain unchanged. Acquisition still returns uncreated Units; Runtime remains the sole lifecycle and Registry-publication owner.

## 8. Embedding contract

The generic Runtime must not resolve Workspace or Agent Home from `process.cwd()` or process-global environment. An embedding composition explicitly supplies:

- `workspaceDir`;
- the application configuration projection;
- any acquired `loadedUnits`;
- existing optional Runtime overrides and observers.

An embedding composition may use the common Workspace loader. It may also omit `applicationConfig` to request hardcoded defaults without filesystem access. Constructing arbitrary objects and asserting that they are validated is not a separate supported path; any future public programmatic validation API requires an explicit contract. An embedding composition is not required to use the standalone process Host.

## 9. Migration and Compatibility

Migration is atomic within this Change:

1. introduce the common reader and projection contract;
2. migrate Runtime and Extension Acquisition consumers;
3. move Context, Session, Memory database, recall, and Subagent path owners to the root-level layout without changing their stored formats;
4. atomically move maintained fixtures/examples, delete old production readers and `.agent` path construction, and update stable Configuration, Workspace, Session, Memory, Subagent, and Extension Acquisition Specifications plus Current Architecture;
5. validate that no production or active-authority path retains either old configuration location or treats `.agent` as current Workspace state.

No fallback, dual read, merge precedence, forwarding API, deprecation window, automatic file rewrite, or automatic `.agent` migration/deletion is authorized.

### 9.1 Manual deployment migration

Retaining old state is an explicit operator operation, not Runtime behavior. The documented migration procedure is:

1. stop every process using the Workspace and its SQLite database;
2. back up the Workspace and Agent Home configuration;
3. create `<workspace>/config.json` by manually combining the old Workspace `agents`/`logger` namespaces with the old Agent Home `extensions` namespace; when several Workspaces shared one Agent Home, copy or customize that Extension projection for each Workspace;
4. move Context files to the Workspace root only where the destination does not exist;
5. move `.agent/sessions/` to `sessions/`, the closed `memory.sqlite` database and its sidecars to the root, `.agent/memory/.recalls/` to `memory-recalls/`, and `.agent/subagents/` to `subagents/`;
6. treat every existing destination as a conflict requiring backup and explicit operator resolution; do not merge Session stores, SQLite files, recall logs, or Subagent directories mechanically;
7. start and validate the new layout, then manually remove obsolete `.agent` and Agent Home `config.json` data if no rollback is required.

Skipping this procedure intentionally starts from defaults/new state where root destinations are absent. The application does not silently import old state, report old state as current, or delete it.

## 10. Acceptance scenarios

At minimum, tests must prove:

1. missing document produces application and Extension defaults;
2. one valid document supplies Agent, Logger, and Extension projections;
3. malformed, unreadable, and non-object documents fail startup;
4. invalid known namespaces are attributed and rejected;
5. unknown top-level namespaces are rejected with bounded attribution;
6. projections and nested values are immutable;
7. application precedence and existing policy scenarios remain unchanged;
8. Extension global/per-entry enablement and scoped configuration remain unchanged;
9. two Workspaces sharing one Agent Home can select different Extension configuration;
10. neither Runtime nor Extension Acquisition reads either retired configuration path;
11. Context initialization and loading use only the approved root files and preserve existing content;
12. Session storage uses only `<workspace>/sessions/` with unchanged metadata/transcript formats;
13. Memory database state uses the root SQLite paths while user Memory inputs remain unchanged;
14. recall state uses `<workspace>/memory-recalls/` and is not indexed as user Memory input;
15. Subagent paths use only `<workspace>/subagents/<id>/`;
16. a nonexistent Workspace uses default configuration, is created, and receives missing root Context files;
17. owned state directories retain their current eager/lazy initialization behavior;
18. reserved-name type conflicts fail through the owning boundary without deleting unrelated data;
19. a pre-existing `.agent` tree remains untouched and has no effect on loaded configuration, Context, Session, Memory, recall, or Subagent state;
20. no production component creates, reads, migrates, or deletes `<workspace>/.agent/`.