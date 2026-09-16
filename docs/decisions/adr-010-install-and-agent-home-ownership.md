# ADR-010: Install and Agent Home Ownership

> Status: Accepted
> Decision date: 2026-09-16
> Owner: Project owner
> Related Plan/Specification: [Install and Agent Home Ownership](../changes/archive/install-and-agent-home-ownership/plan.md) and [Install and Agent Home Ownership Specification](../changes/archive/install-and-agent-home-ownership/install-and-agent-home-ownership-specification.md)
> Supersedes: [ADR-008](adr-008-workspace-configuration-authority.md)
> Refines: path-input clauses of [ADR-009](adr-009-host-boundaries-and-standalone-npm-distribution.md); its Host source and npm distribution decisions remain accepted
> Partially superseded by: [ADR-012](adr-012-agent-home-path-unification.md) for the separate `workingDir` Runtime path and fixed standalone Agent Home selection; install ownership, mutable Agent Home ownership, and configuration/state placement remain accepted

## Context

The current standalone Host uses one selected `workspaceDir` for the sole configuration document, Agent Context, Session state, Memory state, Subagent profiles, logs, filesystem Tools, and working-directory prompt context. It separately resolves a writable Agent Home for External Extension discovery. Starting the service in a source project can therefore populate that project with application databases and state, while Agent Home has the opposite of its intended long-term meaning.

The installed npm package is a distinct authority. It contains immutable program code and templates. The project owner requires Extensions to belong to that installed program publication and requires one Agent-owned writable home for configuration and state, with no hidden `.agent` directory.

The working directory still matters to existing Tools and prompt context, but it is transient execution context rather than a persistent data owner.

A durable decision is required because the correction supersedes Workspace-root configuration/state authority, changes the meaning of Agent Home, relocates Extension discovery, and changes Runtime path contracts.

## Decision drivers

- Treat the installed program, Builtins, templates, and Extensions as immutable Runtime content.
- Keep writable application data out of source projects by default.
- Give one Agent one explicit writable home without reintroducing `.agent`.
- Preserve one standalone configuration snapshot and one Runtime composition path.
- Use `installDir` and `agentHome` consistently across environment Hosts.
- Keep working-directory context independent from persistent ownership.
- Preserve state formats, Extension acquisition behavior, Unit lifecycle, and Host process behavior where ownership does not require change.
- Avoid project-identity, marketplace, update, cache, and multi-root systems without a present requirement.
- Delete old path inputs directly instead of creating permanent precedence or Compatibility behavior.

## Options considered

1. **Keep current Workspace and Extension-oriented Agent Home ownership.** This is mechanically small but continues writing application state into projects and leaves Extensions separate from installed program ownership.
2. **Use `installDir` and `agentHome` as the two persistent owners.** `installDir` contains read-only program publication including Extensions; `agentHome` contains all mutable Agent configuration/state; the Host working directory remains non-owning execution context. This corrects ownership without a project-identity system.
3. **Add Project Directory as a third persistent owner.** This explicitly models current Tool scope, but incorrectly elevates transient work context into storage architecture and creates path selection that is not needed to relocate application state.
4. **Layer user and project configuration with project-local Extensions.** This adds precedence, trust, executable project content, unattended-service policy, and physical Extension store/cache decisions beyond the ownership correction.
5. **Use full platform config/data/cache separation.** Platform-native folders can improve OS integration, but multiple new mutable roots add migration and deployment complexity without a current requirement.

## Decision

Choose option 2.

### `installDir`

`installDir` is selected by an installer or derived by an environment Host and is read-only while the program runs. It owns:

- compiled application code;
- Builtin Units;
- packaged templates and immutable assets;
- pre-provisioned External Extensions under `extensions/`.

Standalone derives `installDir` from its installed npm package. It has no ordinary CLI, environment, configuration, or Runtime override. Test and embedding seams may provide a resolved value without adding standalone precedence.

Host, acquisition, and Runtime operation do not write, install, copy, update, or cache content under `installDir`. Installer/deployment tooling owns provisioning and updates before startup.

### `agentHome`

`agentHome` is the writable home for one Agent. It owns:

- the sole standalone `config.json`;
- Agent Context files;
- user-authored Memory inputs and internal Memory/recall state;
- Session state;
- Subagent profiles;
- logs;
- temporary files and related mutable Runtime state.

Standalone derives `agentHome` as `<user-home>/.my-agent`. This decision adds no standalone CLI, environment, or configuration override. Embedding Hosts explicitly provide their own resolved `agentHome`.

The layout is direct: no `.agent` directory and no executable Extension subtree exists under `agentHome`.

### Non-owning working context

The Host working directory is not a persistent path owner. Standalone captures startup CWD; embedding Hosts supply an existing directory explicitly. Runtime receives it separately from `agentHome` for existing filesystem/search Tools, prompt rendering, and project-oriented execution behavior.

The working directory is not a configuration, Agent Context, Session, Memory, Subagent, Logger, temp, or Extension source. This decision neither broadens nor redesigns filesystem access.

### Configuration and terminology

`<agentHome>/config.json` is the only standalone configuration document and is read once into immutable application, Extension, and Host projections.

Path-bearing contracts use `installDir`, `agentHome`, or `workingDir` according to role. Generic `workspaceDir` is retired from Runtime/configuration/state ownership. The Agent Context budget configuration currently named `workspace` becomes `context`, and the Core module currently using Workspace to mean Agent Context is renamed accordingly.

The builtin `workspace` Tool grouping may retain that capability label, but it does not own application data.

### External Extensions

External Extension discovery uses direct children of `<installDir>/extensions`. Existing descriptor validation, candidate isolation, controlled in-place loading, scoped configuration, and uncreated Unit handoff remain unchanged.

Extension code is trusted executable program content and read-only by ownership during operation. This decision does not add installer enforcement, download, copy, update, marketplace, cache, signing, dependency management, project-local Extensions, or persistent Extension data.

### Direct cutover

`--workspace`, `--agent-home`, `MY_AGENT_WORKSPACE`, and `MY_AGENT_HOME` are removed. No replacement path option or environment precedence is added for standalone. There is no fallback, alias, dual read, automatic migration, or Feature Flag.

Current data is moved offline by operators with backup and explicit conflict handling. External Extensions are provisioned into `installDir` through deployment tooling before startup.

Validated delivery superseded ADR-008. ADR-009 remains accepted for Host source/build/npm ownership; this decision replaces only its preserved old path-input clauses.

## Consequences

### Positive

- Installed program content and mutable Agent state have distinct owners.
- Starting in a source project no longer populates it with application configuration/state.
- `agentHome` has one consistent meaning across Hosts.
- Working context remains available without becoming a third persistent owner.
- One config snapshot and one Runtime composition path are preserved.
- External Extension acquisition remains small and does not become a package manager.
- Terminology supports a future sibling Host without making standalone layout universal.

### Negative

- This is a broad public/structural rename affecting Host inputs, configuration, Runtime options/resources, Core path owners, tests, audits, and documentation.
- Existing deployments must perform an offline migration and update service invocation/working-directory setup.
- Runtime operation cannot install or update Extensions because `installDir` is immutable.
- Fixed standalone `agentHome` means multiple standalone Agent profiles are not introduced by this decision.
- A future platform-native layout or per-project state model requires another decision and migration.

## Validation

The related Specification and Plan must establish:

1. exact `installDir`, `agentHome`, and non-owning `workingDir` derivation/failure behavior;
2. one Agent Home configuration read and immutable projections;
3. complete state-owner versus working-context routing;
4. no working-directory startup initialization or configuration/Extension scan;
5. unchanged External Extension descriptor/loading and Runtime Unit lifecycle behavior;
6. removal of old arguments, environment reads, generic path contracts, and Agent Context `workspace` key without Compatibility aliases;
7. installed package immutability under isolated Agent Home startup;
8. focused Unit/contract tests, affected Integration/Fitness tests, full regression, lint, clean build, Host/package checks, documentation diagnostics, and independent review;
9. stable/current authority transfer only after validated implementation.

## Migration and rollback

Migration is operator-controlled and offline: stop processes, back up old roots, move configuration/state to `<user-home>/.my-agent`, provision Extensions under `installDir` through deployment tooling, rename the Context budget key, remove retired path inputs, set the service process working directory where required, validate, then remove old data manually. Existing state formats remain unchanged and conflicts are never automatically merged or overwritten.

Rollback restores the previous complete executable and backed-up directory layout. Production code contains no rollback branch.

## Follow-up

- Design Extension installation/data, platform-native config/data/cache roots, per-project state partitioning, and any VS Code Host separately when requirements justify them.

Process authority: [Development Workflow](../governance/development-workflow.md).