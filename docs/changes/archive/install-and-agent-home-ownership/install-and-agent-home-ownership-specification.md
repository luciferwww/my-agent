# Install and Agent Home Ownership Specification

> Status: Implemented and Validated
> Date: 2026-09-16
> Owner: Project owner
> Related Plan: [Install and Agent Home Ownership](plan.md)
> Decision: [ADR-010](../../../decisions/adr-010-install-and-agent-home-ownership.md)
> Replaces during validated delivery: path-selection and path-ownership portions of [Configuration](../../../specifications/configuration.md), [Standalone Service Host](../../../specifications/standalone-service-host.md), and [Extension Acquisition](../../../specifications/extension-acquisition.md)

## 1. Purpose and observable outcome

The application has two persistent path owners:

1. `installDir`: immutable installed program content, Builtin Units, packaged templates, and Extensions;
2. `agentHome`: writable configuration, Agent Context, Memory, Sessions, Subagents, logs, temporary files, and related Agent state.

Starting standalone `my-agent` from a project no longer creates `config.json`, Context files, databases, Session files, Subagent profiles, logs, or Extension storage in that project. Runtime owners place mutable application data under `agentHome`; Extension Acquisition reads pre-provisioned code from `installDir`.

The Host working directory remains a non-owning execution context for existing filesystem/search Tools and prompt rendering. It is not a third persistent owner.

## 2. Scope

- canonical `installDir` and `agentHome` ownership and derivation;
- location and single-read ownership of standalone `config.json`;
- explicit Runtime state root versus working context;
- Agent Context ownership and configuration terminology;
- External Extension discovery under `installDir`;
- Host/package verification for immutable install content and writable Agent state;
- direct migration from `workspaceDir` and the old Extension-oriented Agent Home semantics;
- stable/current authority transfer after validation.

## 3. Non-goals

- project-local my-agent configuration;
- project-scoped or project-loaded executable Extensions;
- Extension installation, copying, download, update, marketplace, signing, dependency, cache, or persistent-data support;
- automatic project-root detection or a persistent Project Directory owner;
- per-project state partitioning or multiple Runtime state roots;
- filesystem capability roots, external-path approval, authorization lifetime, or grant persistence;
- XDG platform-directory adoption;
- configuration or state format redesign beyond the `workspace` to `context` key rename;
- automatic migration, fallback reads, or deletion of old data;
- Runtime Unit lifecycle, Host mode, Channel, liveness, deadline, shutdown, or exit-policy changes.

## 4. Boundaries and dependency direction

### 4.1 Owners

- An installer or environment Host owns `installDir` selection and writes before Runtime operation.
- The standalone Host derives its installed npm package directory as `installDir`; no ordinary Runtime component or startup input overrides it.
- Each environment Host owns `agentHome` selection. Standalone uses `<user-home>/.my-agent`; embedding Hosts supply their own resolved value.
- The standalone configuration reader owns `<agentHome>/config.json` and publishes one immutable snapshot.
- Runtime composition receives `agentHome` and a distinct non-owning `workingDir`.
- Agent Context, Session, Memory, recall, Subagent, Logger, and temporary-data owners use `agentHome`.
- Existing filesystem/search Tools and working-directory prompt projection receive `workingDir` as execution context; this routing does not define their authorization policy.
- Extension Acquisition receives `<installDir>/extensions` as a narrow discovery input and resolves neither owned location.

### 4.2 Allowed direction

```text
installer / environment Host
    -> installDir (write only before Runtime operation)

environment Host
    -> select or derive agentHome
    -> select workingDir as non-owning execution context

standalone Host
    -> derive installDir from installed package
    -> derive agentHome from user home
    -> read one agentHome config snapshot
    -> acquire Extensions from installDir/extensions
    -> RuntimeApp.create({ agentHome, workingDir, ... })

Runtime
    -> Agent Context / Session / Memory / Subagent / Logger / temp (agentHome)
    -> existing Tools / working-directory prompt context (workingDir)

Runtime/Core/Extensions -X-> standalone Host
Runtime -X-> process.cwd(), homedir(), or standalone path environment variables
workingDir -X-> implicit configuration/state/Extension ownership
agentHome -X-> executable Extension discovery
```

## 5. Public and structural contracts

The following shapes express semantic contracts; final supporting type names may retain unrelated existing fields.

```ts
interface AgentPathContext {
  readonly installDir: string;
  readonly agentHome: string;
  readonly workingDir: string;
}

interface RuntimeAppOptions {
  readonly agentHome: string;
  readonly workingDir: string;
  readonly applicationConfig?: ApplicationConfigProjection;
  readonly loadedUnits?: readonly LoadedRuntimeUnit[];
}

interface AgentConfigSnapshot {
  readonly application: ApplicationConfigProjection;
  readonly extensions: ResolvedHostExtensionsConfig;
  readonly host: HostConfigProjection;
}

function loadAgentConfig(options: {
  readonly agentHome: string;
}): Promise<AgentConfigSnapshot>;

function acquireExtensions(options: {
  readonly extensionsDir: string;
  readonly extensionsConfig: ResolvedHostExtensionsConfig;
  readonly environment: Readonly<Record<string, string | undefined>>;
}): Promise<ExtensionAcquisitionResult>;
```

`RuntimeApp.create()` remains the only application composition path. Embedded callers supply `agentHome`, `workingDir`, an already validated application projection, and already acquired Units. Runtime never reads Agent configuration or resolves process-global paths.

The direct terminology migration removes:

- path-bearing Runtime/config/state uses of `workspaceDir`;
- `resolveAgentHome()` and `AgentHomeResolutionOptions` from Extension Acquisition;
- `WorkspaceConfigDocument`, `WorkspaceConfigSnapshot`, `WorkspaceConfigError`, and `loadWorkspaceConfig()` in favor of Agent configuration terminology;
- Agent Context budget key `agents.defaults.workspace` in favor of `agents.defaults.context`;
- Core Workspace naming where the module owns Agent Context initialization/loading.

The builtin `workspace` Tool source grouping may retain its capability label, but path-bearing contracts use `workingDir` and do not imply persistent ownership.

## 6. Path derivation and invariants

### 6.1 `installDir`

For standalone, `installDir` is the installed npm package directory containing the executable's published program resources. The owning Host/resource module derives it from module/package metadata. It is not a CLI option, environment input, configuration field, or Runtime state option.

Rules:

- `installDir` must identify the expected installed package directory before configuration and Extension acquisition;
- Runtime operation treats all content under it as read-only;
- program code, Builtin Units, packaged templates, and `extensions/` belong there;
- no configuration, database, log, Session, Memory, generated file, downloaded dependency, or temporary Runtime state is written there;
- test and embedding seams may inject a resolved `installDir` without adding standalone precedence.

The package's compiled Builtin Units remain Builtins. Only `<installDir>/extensions` is scanned as the External Extension source.

### 6.2 `agentHome`

Standalone derives:

```text
<user-home>/.my-agent
```

There is no standalone CLI, environment, or `config.json` override. `MY_AGENT_HOME` is retired; the draft-only `MY_AGENT_DATA_DIR` is not introduced. Tests and embedding Hosts may supply an explicit resolved `agentHome` through programmatic composition.

Rules:

- the derived path is absolute and normalized;
- a missing path may be created by the Agent Context/bootstrap owner;
- an existing path must identify a directory;
- derivation failures are fatal, bounded, and secret-free;
- `agentHome` never denotes program installation.

The direct layout is:

```text
<agentHome>/
├── config.json
├── IDENTITY.md
├── SOUL.md
├── AGENTS.md
├── TOOLS.md
├── MEMORY.md
├── memory/
├── memory.sqlite
├── memory.sqlite-wal
├── memory.sqlite-shm
├── memory-recalls/
├── sessions/
├── subagents/
├── logs/
└── temp/
```

The existing owners retain initialization timing and file formats. SQLite sidecars and `temp/` contents are conditional. `MEMORY.md` and `memory/` remain user-authored Memory inputs; `memory-recalls/` remains internal recall state. No hidden `.agent` directory or `extensions/` subtree exists under `agentHome`.

One `agentHome` represents one Agent profile. Reusing it with another Host working directory deliberately reuses configuration, Agent identity, Sessions, Memory, Subagents, and logs. This Specification defines no project identity or implicit state partition.

### 6.3 `workingDir`

`workingDir` is execution context, not persistent ownership. Standalone uses startup `process.cwd()`; embedding Hosts supply an existing directory explicitly. It is not selected by `--workspace`, `--project-dir`, `MY_AGENT_WORKSPACE`, or `MY_AGENT_PROJECT_DIR`.

This Change preserves its current uses as:

- the base for builtin filesystem/search Tools;
- the working-directory value rendered into the system prompt;
- the default working directory for existing project-oriented execution capabilities.

Those uses establish a path base, not an authorized-root model. The current `workingDirOnly` lexical switch remains an implementation fact and is neither endorsed nor stabilized by this Change. External-path approval and any replacement capability model require a separate decision.

It is not:

- a configuration source;
- an Agent Context, Session, Memory, Subagent, Logger, temp, or Extension storage root;
- initialized by startup merely because it is the working directory.

## 7. Configuration behavior

The sole Agent configuration document is `<agentHome>/config.json`. The standalone Host reads it at most once per startup attempt before Runtime composition and Extension acquisition.

The document retains the top-level namespaces:

```text
AgentConfigDocument
├── agents?
├── logger?
├── extensions?
└── host?
```

Existing strict missing/unreadable/malformed/unknown-namespace behavior, immutable projections, defaults, Agent selection, environment overrides unrelated to paths, and Host projection validation remain unchanged except for path location and terminology.

Within Agent defaults, this direct key migration applies:

```text
agents.defaults.workspace.maxFileChars   -> agents.defaults.context.maxFileChars
agents.defaults.workspace.maxTotalChars  -> agents.defaults.context.maxTotalChars
```

The old key is rejected rather than merged or mapped. Neither key selects a working directory.

## 8. Runtime behavior and invariants

Runtime routes paths according to this matrix:

| Capability | Required input |
|---|---|
| Agent Context initialization/loading/reload | `agentHome` |
| Session metadata and transcripts | `agentHome` |
| Memory inputs, SQLite database, and recall log | `agentHome` |
| Subagent profiles and Subagent Context | `agentHome` |
| File Logger output | `agentHome` |
| Temporary application files | `agentHome/temp` |
| External Extension discovery | Host-derived `<installDir>/extensions` |
| Filesystem/search Tool path base | `workingDir` |
| System prompt working-directory field | `workingDir` |
| Packaged default templates | `installDir`-owned immutable resource |

One Runtime instance has one immutable `agentHome` and one immutable `workingDir` for its lifetime. This Change adds no directory switching. Existing Runtime create/start/publish/retire/stop behavior and immutable generation ownership are unchanged.

Agent Context initialization may create a missing `agentHome` and missing default Context files without overwriting existing files. No equivalent startup initialization occurs in `workingDir` or `installDir`.

## 9. Extension Acquisition

The Host derives `extensionsDir = join(installDir, 'extensions')` and supplies that narrow path to acquisition.

Acquisition preserves current behavior:

- only direct child directories are candidates;
- locator names are not Extension identities;
- `extension.json`, contained regular `.js` entry, Descriptor schema, duplicate isolation, deterministic order, scoped configuration materialization, controlled import, Unit validation, diagnostics, and frozen uncreated-Unit handoff remain unchanged;
- global/per-entry enablement remains in the sole Agent Home configuration snapshot.

The installer/deployer pre-provisions Extensions before startup. Host, acquisition, and Runtime operation do not create, install, copy, update, or cache code under `installDir`. Read-only is an ownership rule and package invariant, not a new OS sandbox.

No persistent Extension data directory is introduced. An Extension requiring writable cross-version storage is unsupported by this contract and requires a future accepted design. Extension code must not write into its installation directory.

Neither `agentHome` nor `workingDir` is scanned for executable Extensions, manifests, plugins, or project declarations.

## 10. Lifecycle and resource ownership

- Installer/deployer writes `installDir` before Runtime startup and owns updates/removal.
- Environment Host selects or derives `agentHome` before configuration/acquisition/composition.
- Standalone captures startup CWD as `workingDir` without turning it into state ownership.
- The configuration snapshot is immutable startup input, not a live service.
- Runtime owners create `agentHome` files/directories at their existing eager/lazy lifecycle points.
- Working files change only through explicit existing Tool/capability operations, not startup initialization.
- Extension acquisition imports pre-provisioned code but does not create its Unit resources; Runtime remains the lifecycle owner.
- Existing Host shutdown and cleanup remain responsible for Runtime resources, Logger flush, Channels, signals, and deadlines.

## 11. Failure, Abort, deadline, and concurrency semantics

Path failures occur before Runtime creation:

- invalid installed package derivation: bounded fatal `installDir` error;
- invalid user-home or `agentHome` derivation: bounded fatal Agent Home error;
- invalid standalone configuration: renamed equivalent of existing strict configuration errors;
- invalid Extension discovery root: existing fatal/candidate-local behavior adapted to explicit `extensionsDir`.

No path failure falls back to a retired location. Errors do not include configuration contents, secrets, or unbounded paths.

Concurrent processes sharing one `agentHome` retain current storage concurrency guarantees and limitations; this Change does not add locking. Evidence that relocation makes supported concurrent service use unsafe is a stop condition rather than justification to invent partitioning or a lock protocol.

Abort, Channel completion, Host deadlines, signal handling, shutdown ordering, and process exit status do not otherwise change.

## 12. Security and capabilities

- `installDir` is read-only during Runtime operation and is not mutable dependency or Extension storage.
- `agentHome` is internal state ownership and is not automatically an executable Extension source.
- `workingDir` remains separate from both owners and cannot configure or inject executable Extensions in this Change.
- Filesystem authorization, external-path approval, capability roots, and grant persistence are not decided by this Change.
- External Extensions remain trusted executable code and load only when enabled by the Agent Home configuration snapshot.
- Configuration and diagnostics remain secret-safe and bounded.
- No new network fetch, package-manager execution, signing, or trust-store behavior is introduced.

## 13. Compatibility and migration

Migration is an atomic direct cutover. The following inputs and locations are retired:

```text
--workspace
--agent-home
MY_AGENT_WORKSPACE
MY_AGENT_HOME
<old-workspace>/config.json
<old-agent-home>/extensions
```

No alias, warning-only fallback, dual read, automatic move, or Feature Flag is authorized. Old CLI options fail as unknown arguments. Retired environment variables are not read.

An operator retaining current data performs an offline migration:

1. stop all processes using current state and SQLite files;
2. back up the current Workspace and old Agent Home;
3. move or copy `config.json`, Context files, `MEMORY.md`, `memory/`, the closed SQLite database and sidecars, `memory-recalls/`, `sessions/`, `subagents/`, and `logs/` into `<user-home>/.my-agent`, resolving every conflict manually;
4. provision required External Extensions under `<installDir>/extensions` through the installer/deployment process before startup;
5. rename configuration keys from `agents.defaults.workspace` to `agents.defaults.context`;
6. remove retired path arguments/environment from service invocation and set the service process working directory where needed;
7. start and validate the new layout before deleting old data.

Storage formats do not change. Rollback restores the complete prior executable and backed-up layout; production code carries no rollback branch.

Validated delivery transferred configuration/state authority from ADR-008 to ADR-010 because ownership moved from Workspace to `agentHome`. ADR-009 remains accepted for Host source and npm distribution, with its old path-input clauses refined by ADR-010.

## 14. Acceptance and validation

Delivery must prove:

1. exact standalone `installDir`, `agentHome`, and `workingDir` derivation and immutable values;
2. retired CLI options are rejected and retired environment variables are not read;
3. one Agent Home configuration read supplies application, Extension, and Host projections;
4. missing `agentHome`/config uses defaults and may initialize Agent Context without touching `workingDir` or `installDir`;
5. every state/resource owner uses the matrix in section 8;
6. filesystem/search Tools and prompt context receive `workingDir` as their current execution/path base without treating the existing containment switch as an authorization decision;
7. changing `workingDir` with fixed `agentHome` retains the same state root without implicit project partitioning;
8. changing programmatic `agentHome` with fixed `workingDir` isolates configuration and state;
9. Extension Acquisition uses only `<installDir>/extensions` and preserves candidate-local behavior;
10. Host and Runtime operation do not modify `installDir`;
11. no Extension install/update/cache/data path or project scan is introduced;
12. `agents.defaults.context` works and the retired `workspace` key is rejected;
13. no production path-bearing contract uses generic `workspaceDir` for persistent ownership;
14. package startup succeeds with isolated temporary Agent Home and working context and does not modify installed package files;
15. no `.agent` directory or second config source is introduced;
16. Runtime lifecycle, Host modes, liveness, shutdown, diagnostics, and package command remain behaviorally stable;
17. focused Unit/contract tests, affected Integration/Fitness tests, full regression, lint, clean build, Host/package/Relay checks, documentation diagnostics, links, and diff checks pass;
18. independent review reports no unresolved Critical or High issue.

## 15. Open questions

None within the accepted scope.

Follow [Development Workflow](../../../governance/development-workflow.md).