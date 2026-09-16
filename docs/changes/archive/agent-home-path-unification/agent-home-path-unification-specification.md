# Agent Home Path Unification Specification

> Status: Accepted
> Date: 2026-09-16
> Owner: Project owner
> Related Plan/Decision: [Agent Home Path Unification Plan](plan.md) and [ADR-012](../../../decisions/adr-012-agent-home-path-unification.md)
> Amends on validated delivery: [Runtime Composition](../../../specifications/runtime-composition.md), [Configuration](../../../specifications/configuration.md), and [Standalone Service Host](../../../specifications/standalone-service-host.md)

## Purpose and observable outcome

The application exposes exactly two architecture paths: immutable `installDir` and writable `agentHome`. Agent Home is the direct successor to the former Workspace path and is not split into persistent and non-owning path contracts.

Standalone uses `<user-home>/.my-agent` by default and accepts one explicit `--agent-home` override. The selected Agent Home is the sole Agent-owned state root for configuration, Context, Memory, Sessions, logs, temporary state, and Subagent profiles. Environment Tools resolve relative paths from Agent Home while explicit lexically external structured-path targets use the existing Approval mechanism.

## Scope

- standalone `--agent-home` parsing and deterministic selection;
- relative, absolute, missing, existing, symlink/junction, and invalid-path behavior;
- removal of `workingDir` from Host and Runtime contracts;
- unified Agent Home routing through Runtime-owned state, Prompt, and Subagent-owned state;
- removal of Working Directory-specific Tool configuration;
- input-aware external-path Approval for structured-path Environment Tools;
- call-level Search roots and Agent Home-relative defaults;
- current production Workspace/Working Directory terminology and source convergence;
- package default/override first-start behavior;
- stable/current authority correction after validation.

## Non-goals

- Workspace, Project Directory, project-local configuration, or a third path;
- `--workspace`, `MY_AGENT_WORKSPACE`, `MY_AGENT_HOME`, or layered path precedence;
- installer/setup/profile management;
- a second Resource Approval type, protected internal paths, sandbox roots, or new Tool deny rules;
- Shell command-effect inference, command-pattern grants, or persistent Approval;
- canonical/symlink authorization hardening beyond the current lexical path model;
- same-Agent-Home multi-process coordination;
- Extension ownership or acquisition changes;
- Context ownership or template changes;
- state-format migration;
- Runtime Unit lifecycle, Host mode, Channel, shutdown, Model, or Provider changes;
- historical archive rewriting.

## Boundary and dependency direction

```text
standalone Host
    -> parse optional --agent-home
    -> resolve { installDir, agentHome }
    -> Platform Configuration bootstrap(agentHome)
    -> Platform Configuration load(agentHome/config.json) once
    -> Extension Acquisition(installDir/extensions)
    -> RuntimeApp.create(agentHome, immutable application projection)
         -> Agent Context / Session / Memory / Subagent / Logger state under agentHome
         -> Environment contribution (Agent Home defaults, input-aware external-path Approval)
         -> Prompt Agent Home context from agentHome

Runtime -X-> process.cwd() / user home resolution / physical config read
agentHome -X-> installed Extensions
installDir -X-> mutable Agent state
```

Process CWD is an input only while resolving a relative command argument. It is discarded before `AgentPathContext` and Runtime composition.

## Standalone command contract

Accepted forms:

```text
my-agent
my-agent --agent-home <path>
my-agent --agent-home=<path>
```

Rules:

- zero arguments selects `normalize(join(homeDirectory, '.my-agent'))`;
- split and equals forms are equivalent;
- parsing proceeds left-to-right and fails at the first invalid token;
- the split form consumes exactly its next token, which must exist, be nonblank, and not be another option token;
- the equals form requires nonblank content after the first `=`;
- exactly one override occurrence is allowed, regardless of form;
- absolute input is normalized;
- relative input resolves against the captured startup CWD and is then normalized;
- trailing or leading positional tokens, `--workspace`, any second `--agent-home`, missing/blank values, and unknown arguments fail as `HOST_ARGUMENT_INVALID`;
- no environment or configuration source selects Agent Home.

The parser returns an optional Agent Home argument rather than mutating process state. Path resolution receives explicit `moduleUrl`, `homeDirectory`, `startupCwd`, and parsed override inputs for deterministic tests.

## Agent Home path contract

The selected lexical path may be absent. Platform Configuration bootstrap owns creating a missing Agent Home after Host path resolution. Path selection and validation complete before configuration bootstrap.

For an existing selected path:

- a directory is accepted;
- a directory symlink/junction is canonicalized with the current `realpath` behavior;
- a non-directory, broken/inaccessible link, or inaccessible path fails with `AGENT_HOME_INVALID`;
- no alternate path or fallback is attempted.

For an absent selected path, the Host returns the normalized lexical path without calling `realpath`; ADR-011 bootstrap owns recursive creation. Parent access and creation failures therefore retain `AGENT_HOME_CREATE_FAILED` rather than being collapsed into `AGENT_HOME_INVALID`.

`AgentPathContext` is deeply immutable and contains only:

```ts
interface AgentPathContext {
  readonly installDir: string;
  readonly agentHome: string;
}
```

`WORKING_DIR_INVALID` is removed because no working-directory path is resolved.

## Runtime contract

`RuntimeAppOptions`, `RuntimeResourceSet`, bootstrap results, Runtime Builder options, Runtime events, and testing seams expose `agentHome` but no `workingDir`. In particular, `app_start` and `app_ready` publish `agentHome` only. Every maintained in-repository Runtime caller is migrated in the same cutover; no wrapper or deprecated overload remains.

Runtime never resolves Agent Home from `process.cwd()`, `homedir()`, environment, or configuration. Every embedding Host supplies an already resolved Agent Home. Omission is a type/contract error, not a default.

Every current state owner continues to use `agentHome`:

- Agent Context;
- Session storage;
- Memory database, inputs, and recall state;
- Subagent profiles and Context;
- Logger files;
- temporary Agent state.

## Environment Tool and execution contract

The Builtin Tool capability package currently described as Workspace becomes Environment. Its source package, contribution symbols, Unit ID, imports, Architecture Fitness baselines, maintained fixtures, and tests move atomically to:

```text
src/builtins/tools/environment/
createEnvironmentContribution()
EnvironmentContributionOptions
builtin-environment
```

Environment is the Builtin Tool capability package for filesystem, search, web, command-execution, and process interaction. It is not a third architecture path, a Runtime Environment object, an Agent state owner, or by itself a Tool authorization boundary. Individual Tool names remain unchanged.

The contribution supplies:

```ts
interface EnvironmentContributionOptions {
  readonly agentHome: string;
  readonly webFetchEnabled: boolean;
  readonly execEnabled: boolean;
  readonly processEnabled: boolean;
}
```

There is no containment boolean in this contract. The current `fsWorkingDirOnly` contribution option and `tools.fs.workingDirOnly` configuration field are removed without replacement.

### Structured-path Tools

Structured-path Tools are Environment Tools whose validated input declares the filesystem targets of the operation. They include filesystem read, listing, write, edit, and patch operations plus File Search and Grep Search roots. Their path contract is:

- omitted call-level Search `path` defaults to `agentHome`;
- every other relative filesystem path, including a relative Search `path`, resolves from `agentHome`;
- absolute paths remain absolute;
- a normalized lexical target inside `agentHome` follows ordinary Tool-name policy;
- a normalized lexical target outside `agentHome` requires the existing Approval mechanism even when the Tool name matches `tools.allow`;
- a Tool-name deny remains final and cannot be overridden by Approval;
- when Approval is required but no Approval Capability exists, the call is denied;
- approved access applies only to the current Tool call and creates no persistent resource grant.

File Search and Grep Search each add an optional `path` input naming the directory to search. Match patterns remain filters below that selected root and are not architecture paths. Results keep their existing relative-path presentation, relative to the selected search root.

The Application Tool Policy receives the schema-validated effective Tool input so it can classify declared targets before execution. Its decision order for a structured-path call is:

```text
if tool-name deny matches:
  deny
else if any declared target is lexically outside agentHome:
  requires_approval when Approval Capability exists, otherwise deny
else if tool-name allow matches:
  allow
else:
  requires_approval when Approval Capability exists, otherwise deny
```

This reuses the current call-scoped, origin-bound, fail-closed Approval request. It does not add a Resource Approval type. V1 classification uses normalized lexical paths consistently with the current resolver; canonical target and symlink-aware authorization are deferred and must not be claimed as delivered protection.

### Exec and Process

Exec defaults `cwd` to Agent Home and resolves a relative explicit `cwd` from Agent Home. Existing absolute explicit `cwd`, environment, timeout, yield, background, Process registry, cancellation, and process-tree behavior are otherwise unchanged.

Exec is not a structured-path Tool. Its command can use absolute paths, parent traversal, scripts, subprocesses, network access, or operating-system facilities that cannot be bounded by its initial `cwd`. The policy therefore does not infer command effects, classify command text as inside or outside Agent Home, or treat `cwd` as a filesystem authorization boundary.

Exec follows Tool-name policy only:

```text
if exec deny matches:
  deny
else if exec allow matches:
  allow without Approval
else:
  requires_approval when Approval Capability exists, otherwise deny
```

An Exec Approval authorizes the exact full command in that call's validated effective input. Approval presentation is a Client concern and is not specified here. Adding `exec` to `tools.allow` explicitly permits arbitrary Shell commands and their subprocesses to run without prompts under the host process's operating-system authority; V1 has no sandbox that narrows those effects.

The Process Tool only observes or terminates executions already registered by Exec. It cannot start an arbitrary command and does not inherit Exec's special arbitrary-execution meaning; it follows ordinary Tool-name policy.

Dynamic filesystem paths, search roots, URLs, and explicit command `cwd` values are Tool invocation resources and do not become additional Host/Runtime architecture paths. Tools may address Agent-owned configuration and state according to existing visibility, approval, allow, and deny policy. This Specification adds no implicit protected paths.

## Prompt and Subagent contract

The path section is:

```text
# Agent Home
Your agent home directory is: <agentHome>
```

There is no `# Workspace` or “working directory” architecture section. Prompt build parameters use `agentHome`.

Subagent execution receives the selected root as `agentHome`. Named Subagent profiles retain `<agentHome>/subagents/<id>` for their configuration and optional Context. The unified root does not create a Child-specific project path.

## Configuration contract

The current `workingDirOnly` name and any Workspace path/configuration field are retired. `tools.fs.workingDirOnly` and the now-empty `tools.fs` group are removed without replacement; `agentHomeOnly` is not introduced. There is no alias, migration, warning period, or dual read.

External structured-path targets reuse the existing Approval model. A second Approval type, canonical/symlink grants, capability roots, command-pattern authorization, and persistent authorization remain out of scope.

## Configuration bootstrap

`ensureAgentConfigDocument({ agentHome })` remains the Platform Configuration bootstrap operation. For the selected Agent Home it:

1. creates the missing parent recursively;
2. exclusively creates `config.json` as exact UTF-8 bytes `{}\n`;
3. preserves every existing path and byte;
4. performs no document-content read;
5. returns to the Host for one strict `loadAgentConfig()` read.

Existing ADR-011 failure, race, partial-write, no-rollback, and bounded-diagnostic semantics remain unchanged.

## Naming and source convergence

After delivery, current production path-bearing symbols use Agent Home terminology. Required direct replacements include the semantic equivalents of:

- `workingDir` -> `agentHome`;
- `workingDirectory` -> `startupCwd` only at relative CLI resolution, otherwise removed;
- Working Directory-specific Tool policy names -> removed without replacement;
- Workspace Tool contribution/source ownership -> Environment contribution/source ownership;
- `# Workspace` -> `# Agent Home`.

Individual Tool command names and ordinary child-process `cwd` remain unchanged. Historical documents under `docs/changes/archive/`, superseded ADR text, and negative rejection/compile tests may retain retired terms when their historical or negative role is explicit. Stable Specifications, Current Architecture, README, production source, positive maintained fixtures, and positive tests may not use them as current path concepts. Residual checks use an explicit bounded allowlist for historical and negative cases rather than treating an unrestricted text match as completion evidence.

## Lifecycle, failure, and concurrency

Startup order remains:

1. parse arguments;
2. resolve `installDir` and selected `agentHome`;
3. bootstrap configuration;
4. strictly load one config document;
5. validate Host composition;
6. acquire Extensions;
7. create Runtime;
8. initialize existing Runtime-owned resources.

Argument/path/bootstrap/load failures short-circuit acquisition and Runtime. No Runtime cleanup is required before Runtime construction.

One Agent Home may be selected by one supported process. Coordinated concurrent operation by multiple processes against the same Agent Home is unsupported. No global lock, lease, profile arbitration, or cross-process lifecycle is introduced.

## Security consequences

Path-capable Tools and Exec can read or mutate Agent-owned files permitted by existing Tool policy. Structured Tools require call-scoped Approval for declared lexically external targets unless denied; Tool allow does not waive that external-path check. Lexically internal paths reached through symlinks are not upgraded to canonical authorization checks in this Change.

Exec `cwd` is execution context, not confinement. Allowing Exec bypasses per-call Approval for arbitrary Shell execution under host authority; approving one Exec call authorizes that exact command but does not technically constrain its subprocess effects.

Generated configuration contains no secrets. Existing secret-safe diagnostics remain. This Change adds no ACL, chmod, umask, symlink hardening, protected filenames, or secret store.

## Compatibility and migration

This is a direct source and contract cutover:

- standalone callers may add `--agent-home` but cannot use `--workspace` or environment path inputs;
- embedded callers remove `workingDir` and continue supplying `agentHome`;
- configuration authors remove `tools.fs.workingDirOnly` and any now-empty `tools.fs` object;
- current source/tests/docs remove active Workspace/Working Directory path concepts;
- no compatibility adapter is shipped.

Existing data under `<user-home>/.my-agent` remains in place. A custom Agent Home is selected explicitly and is not copied, merged, or migrated. Pointing `--agent-home` at a former Workspace uses that directory directly; conflicts are never merged or overwritten automatically.

## Acceptance and validation

Delivery covers:

1. default, split-form, equals-form, absolute, relative, missing, existing, symlink/junction, invalid, blank, duplicate, retired, and unknown Host inputs;
2. exact selected-path bootstrap and one strict config read;
3. immutable two-field `AgentPathContext`;
4. Runtime public-contract compile checks with no `workingDir`;
5. Agent Context, Session, Memory, Subagent, Logger, and temp state under Agent Home;
6. filesystem/search default, relative, internal, external, deny, allow, Approval-unavailable, and lexical-path behavior under the accepted Environment policy;
7. Exec default/relative `cwd`, deny, allow-without-prompt, per-call Approval, and Approval-unavailable behavior without treating `cwd` as confinement;
8. Prompt `# Agent Home` rendering and absence of `# Workspace`;
9. removal and direct rejection of `tools.fs.workingDirOnly` and the obsolete `tools.fs` group;
10. current production residual scan for Workspace/Working Directory path concepts;
11. default and explicit package first starts, configured WebSocket Host operation, and installation/unrelated-CWD immutability;
12. unchanged ADR-011 bootstrap creation/preservation/error/race tests;
13. affected Unit, Contract, Integration, Fitness, full regression, lint, clean build, Host/package verification, diagnostics, links, diff checks, and independent review.

## Accepted design status

The owner accepted the two-path model and Environment Tool policy on 2026-09-16. No design question blocks Delivery. Implementation evidence may still reopen the decision only under the stop conditions in the Plan and Development Workflow.

Follow [Development Workflow](../../../governance/development-workflow.md). Stable delivered amendments belong in Runtime Composition, Configuration, and Standalone Service Host Specifications; this change-local Specification remains delivery provenance after closeout.
