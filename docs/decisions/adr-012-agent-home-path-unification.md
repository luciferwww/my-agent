# ADR-012: Agent Home Path Unification

> Status: Accepted
> Decision date: 2026-09-16
> Owner: Project owner
> Related Plan/Specification: [Agent Home Path Unification](../changes/archive/agent-home-path-unification/plan.md) and [Agent Home Path Unification Specification](../changes/archive/agent-home-path-unification/agent-home-path-unification-specification.md)
> Supersedes on acceptance: the non-owning working-context, standalone Agent Home selection, and related direct-cutover clauses of [ADR-010](adr-010-install-and-agent-home-ownership.md)
> Preserves: ADR-010 `installDir` and `agentHome` ownership; [ADR-011](adr-011-standalone-agent-home-configuration-bootstrap.md) configuration bootstrap

## Context

Before ADR-010, one selected `workspaceDir` carried configuration, Agent Context, mutable state, filesystem/search Tool scope, default command execution, and prompt path context. ADR-010 correctly moved installed Extensions to immutable `installDir` and mutable Agent content to `agentHome`, but it interpreted the old overloaded path as two Runtime concepts: persistent `agentHome` and non-owning `workingDir`.

That split conflicts with the intended terminology migration. Workspace was to be renamed to Agent Home, not retained as a second execution-path concept under a different name. Calling `workingDir` non-owning does not remove it from the architecture: Host, Runtime, Tools, Prompt, Subagents, events, configuration, and tests all carry it as a third path.

The target has only two architecture paths:

- `installDir`: immutable installed program publication, including Builtins, templates, assets, and Extensions;
- `agentHome`: the selected writable Agent-owned state root for configuration, Context, Memory, Sessions, logs, temporary state, and Subagent profiles.

Environment Tool targets supplied per invocation are resources, not additional Host/Runtime architecture paths. Structured-path Tools use Agent Home as their relative anchor and require the existing call-scoped Approval for declared lexically external targets. Exec remains arbitrary Shell execution governed by Tool-name policy rather than inferred path effects.

Standalone remains service-first. It needs the common Agent behavior of a default home with an explicit command-line override, without restoring a Workspace, project-root authority, layered configuration, or multiple path-precedence systems.

## Decision drivers

- Make “only `installDir` and `agentHome`” true in contracts and execution, not only in persistent-ownership wording.
- Complete the intended direct terminology migration from Workspace to Agent Home.
- Preserve immutable installation ownership and one writable Agent root.
- Let operators select independent Agent instances without depending on startup CWD.
- Keep configuration bootstrap, one strict read, Core Agent Context ownership, and Runtime Unit lifecycle unchanged.
- Delete misleading path aliases and dual contracts rather than preserve Compatibility indefinitely.
- Reuse the existing Approval system for structured external paths without introducing a Workspace, Project Directory, tool sandbox, second authorization system, or environment-variable precedence.

## Options considered

1. **Keep `agentHome` plus non-owning `workingDir`.** This preserves current behavior but retains a third architecture path and the rejected Workspace concept under another name.
2. **Use only `installDir` and `agentHome`, with optional `--agent-home`.** Agent-owned state uses Agent Home; the default remains `<user-home>/.my-agent` and operators may override it explicitly. Environment Tool targets do not become architecture paths; Agent Home anchors relative Tool paths while structured external targets require call-scoped Approval.
3. **Restore both Workspace and Agent Home.** This reintroduces two writable roots, path precedence, and split ownership that the unification is intended to remove.
4. **Keep one Agent Home but add a protected project/tool subroot.** This creates a new sandbox or Project Directory decision and is outside the current requirement.

## Decision

Choose option 2.

### Path model

`installDir` and `agentHome` are the only architecture path roles.

`installDir` retains ADR-010 ownership and behavior: an environment Host selects or derives it, External Extensions are pre-provisioned under `<installDir>/extensions`, and Runtime operation does not write there.

`agentHome` is the sole writable Agent root. It owns and anchors:

- `<agentHome>/config.json`;
- Agent Context files;
- Memory and recall state;
- Sessions and Subagent profiles;
- logs and temporary Agent state;
- Agent Home prompt context;
- Subagent-owned state and Context.

There is no current Workspace, Project Directory, or `workingDir` Host/Runtime path. Process CWD is not injected into Runtime and owns no application content.

Environment Tool path inputs and explicit command `cwd` values are invocation resources rather than architecture path roles. Agent Home anchors their relative resolution, but `cwd` is not a confinement boundary for arbitrary Shell commands.

### Standalone selection

The supported command is:

```text
my-agent [--agent-home <path>]
my-agent [--agent-home=<path>]
```

Selection is:

1. a supplied `--agent-home` value;
2. otherwise `<user-home>/.my-agent`.

No `MY_AGENT_HOME`, `MY_AGENT_WORKSPACE`, `--workspace`, configuration key, or additional path source participates.

Arguments are parsed left-to-right. The split form consumes exactly its next token as a nonblank value; absence, a blank token, or another option token in that position is a missing-value failure. The equals form requires nonblank content after `=`. Any second occurrence, positional token, retired option, or unknown option fails at the first invalid token with a bounded `HOST_ARGUMENT_INVALID` diagnostic.

An absolute argument is normalized directly. A relative argument resolves once against startup `process.cwd()`. This resolution use does not make process CWD a Runtime path. The option may occur at most once.

A missing selected Agent Home is valid and its normalized lexical path remains available for Platform Configuration bootstrap. Before bootstrap, an existing directory is canonicalized under the current symlink/junction behavior. A broken/inaccessible link, existing non-directory, or inaccessible path fails as `AGENT_HOME_INVALID`; parent/create failures for an absent path retain ADR-011 bootstrap classification. No fallback directory is attempted.

### Runtime and capability contracts

`AgentPathContext` contains only `installDir` and `agentHome`. `RuntimeApp.create()` and `RuntimeResourceSet` contain `agentHome` and no `workingDir`. Runtime events do not publish a second path. Dynamic Environment Tool targets remain invocation resources and do not become Runtime path roles.

The prompt path section becomes `# Agent Home` and renders only `agentHome`. Subagents inherit the same Agent Home execution context while their profiles and Context continue to use their existing Agent-owned locations.

### Environment capability package

The Builtin Tool capability package currently named Workspace becomes Environment:

```text
src/builtins/tools/environment/
createEnvironmentContribution()
EnvironmentContributionOptions
builtin-environment
```

Environment means the Builtin Tool capability package for filesystem, search, web, command-execution, and process interaction. It is not a third architecture path, a Runtime Environment object, an Agent state owner, or by itself a Tool authorization boundary. Individual Tool names remain unchanged.

### Terminology and direct cutover

After validated delivery, current production code, public contracts, stable/current documentation, maintained fixtures, and active tests do not use Workspace or Working Directory as an architecture path concept.

The source package, contribution factory/options, and Unit ID move directly from their current Workspace identity to the Environment identity above; no identity alias is retained.

`tools.fs.workingDirOnly`, the now-empty `tools.fs` group, and Working Directory-specific path helpers do not remain. No replacement containment field, alias, dual read, fallback, Feature Flag, or automatic configuration migration is introduced.

Ordinary operating-system terms such as a child process `cwd`, and historical/archived documents describing prior designs, are not prohibited. Direct rejection tests may retain retired literal names as negative evidence.

### Configuration bootstrap and ownership

ADR-011 remains valid for the selected Agent Home. Platform Configuration creates a missing Agent Home and exclusively creates exact `{}\n` configuration bytes before one strict configuration read. Existing configuration remains unchanged.

Core Agent Context retains ownership of its four Markdown files. Moving the Tool path anchor to Agent Home does not move Context creation into Host or Platform Configuration.

### Environment Tool path and Approval policy

Environment filesystem and Search Tools whose validated inputs declare target paths are structured-path Tools. Their relative paths resolve from Agent Home. File Search and Grep Search each accept an optional call-level `path`; omission searches Agent Home, while a relative value resolves from Agent Home.

For structured-path Tools, Tool-name deny is final. A declared normalized lexical target outside Agent Home requires the existing call-scoped Approval even when the Tool name is allowed. An internal target follows ordinary Tool-name allow/deny/approval policy. A required Approval with no Approval Capability fails closed. Approval creates no persistent resource grant.

The Application Tool Policy therefore receives schema-validated effective Tool input. This is one input-aware trigger in the current Approval mechanism, not a new Resource Approval type. V1 retains lexical path classification; canonical and symlink-aware authorization remain deferred.

Exec is explicitly different. It defaults `cwd` to Agent Home and resolves a relative explicit `cwd` from Agent Home, but neither value constrains command effects. Exec can access arbitrary host paths, networks, subprocesses, and operating-system facilities, so policy does not infer effects from command text or `cwd`.

Tool-name deny blocks Exec. Tool-name allow executes any Exec command without Approval. Otherwise each Exec call requires Approval and fails closed when Approval is unavailable. The Approval authorizes the exact full command in the validated effective input. Client presentation is outside this ADR. Without a sandbox, allowing Exec means unprompted arbitrary Shell execution under host-process authority.

Process can only observe or terminate registered Exec runs. It follows ordinary Tool-name policy and receives no ability to initiate commands.

Path-capable Tools and Exec can address Agent configuration and state according to these rules. This decision adds no protected internal subtree, command-pattern grant, canonical authorization grant, persistent Approval, sandbox, or second Tool root. Documentation must not claim that configuration, databases, Sessions, logs, or profiles are isolated from Agent Tools.

### Concurrency

Separate processes can select separate Agent Homes. Coordinated concurrent operation against one Agent Home is not supported. Existing capability-specific file/database behavior and ADR-011's bounded exclusive-create race semantics remain, but no Agent Home process lock or universal concurrent-success guarantee is added.

## Consequences

### Positive

- Runtime and Host expose exactly the two intended architecture paths.
- Workspace is removed rather than renamed indirectly to Working Directory.
- Operators can select an Agent instance explicitly while retaining a conventional default home.
- Configuration, state, prompts, and Subagent-owned state agree on one Agent Home without creating a second Runtime path.
- ADR-011 bootstrap and immutable `installDir` ownership remain reusable.

### Negative

- Runtime, Host, Tool, Prompt, event, configuration, and test contracts require a broad atomic cutover.
- Input-aware structured-path policy and call-level Search roots add implementation and test scope.
- Environment Tools may be able to access Agent-owned configuration and state when the accepted target policy permits it.
- Existing `tools.fs.workingDirOnly` configuration must be removed rather than renamed.
- Allowing Exec has the broad meaning of unprompted arbitrary host Shell execution until a separate sandbox decision exists.
- Existing embedded callers must remove `workingDir` and use `agentHome` as their path context.
- Same-Agent-Home multi-process safety remains unsupported.

## Compatibility and migration

This is a direct cutover. Production retains no `workingDir`, Workspace path, `--workspace`, `MY_AGENT_WORKSPACE`, `MY_AGENT_HOME`, or `workingDirOnly` compatibility route.

Existing standalone users who accept the default continue to use `<user-home>/.my-agent`. Operators who need another Agent Home use `--agent-home`. Embedded callers remove `workingDir`; their existing `agentHome` remains the sole Agent-owned state path. Configuration authors remove `tools.fs.workingDirOnly` and any now-empty `tools.fs` object.

ADR-010 remains historical authority for moving Extensions to `installDir` and mutable state to `agentHome`; on acceptance, ADR-012 supersedes only its separate working-context and fixed standalone Agent Home selection clauses. ADR-011 remains accepted and is refined only to bootstrap the selected Agent Home.

## Validation

Delivery must prove:

1. Host and Runtime path contracts expose only `installDir` and `agentHome`;
2. omitted `--agent-home` selects `<user-home>/.my-agent`;
3. both accepted argument forms select the same absolute/canonical Agent Home;
4. relative input resolves once against startup CWD without passing CWD to Runtime;
5. missing Agent Home proceeds to exact ADR-011 bootstrap;
6. blank, duplicate, retired, and unknown arguments fail before bootstrap;
7. configuration, Context, Memory, Sessions, Subagent-owned state, logs, prompt context, and events use the selected Agent Home, while structured Tool targets use Agent Home-relative defaults and input-aware external-path Approval;
8. `tools.fs.workingDirOnly` and the obsolete `tools.fs` group are removed without a compatibility alias or replacement containment field;
9. no production path-bearing `workspaceDir`, `workingDir`, Workspace Tool contribution, or `# Workspace` remains;
10. installation and unrelated process-CWD trees remain unchanged;
11. package verification covers default and explicit Agent Home startup separately;
12. embedded Runtime remains free of process-global path resolution and physical configuration reads;
13. affected Unit, Contract, Integration, Architecture Fitness, full regression, lint, clean build, package/Host checks, residual scans, links, and independent review pass.

## Follow-up

Canonical/symlink-aware authorization, protected Agent-owned files, Shell command-pattern grants, persistent Approval, sandboxing, multi-process Agent Home coordination, environment-variable path selection, installer-driven Agent Home selection, and multi-profile layout require separate accepted decisions.

Process authority: [Development Workflow](../governance/development-workflow.md).
