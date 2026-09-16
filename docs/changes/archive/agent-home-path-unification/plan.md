# Agent Home Path Unification Plan

> Status: Completed and Accepted
> Date: 2026-09-16
> Owner: Project owner
> Type: Architecture Slice
> Decision: [ADR-012](../../../decisions/adr-012-agent-home-path-unification.md)
> Contract: [Agent Home Path Unification Specification](agent-home-path-unification-specification.md)
> Validation record: [Validation](validation.md)
> Corrects: the working-context split delivered by [ADR-010](../../../decisions/adr-010-install-and-agent-home-ownership.md)
> Preserves: [ADR-011](../../../decisions/adr-011-standalone-agent-home-configuration-bootstrap.md)

## 1. Goal

Make `installDir` and `agentHome` the only architecture paths. The former Workspace is unified under Agent Home rather than split into persistent `agentHome` and non-owning `workingDir` roles.

Standalone defaults to `<user-home>/.my-agent` and supports one explicit `--agent-home` override. Configuration, Agent-owned state, prompt path context, and Subagent-owned state use the selected Agent Home. Environment Tool targets remain dynamic resources rather than architecture paths: relative paths use Agent Home, structured external targets require call-scoped Approval, and Exec remains Tool-name-governed arbitrary Shell execution. No Workspace, Project Directory, second Runtime path, environment-variable path precedence, or compatibility alias remains.

The observable outcome is that:

```text
my-agent
my-agent --agent-home <path>
my-agent --agent-home=<path>
```

all compose one Runtime with one selected Agent Home, while installed code and Extensions remain under immutable `installDir`.

## 2. Proposed direction

1. Deliver under accepted ADR-012 and the change-local Specification.
2. Replace `AgentPathContext { installDir, agentHome, workingDir }` with `{ installDir, agentHome }`.
3. Parse only optional `--agent-home` in split or equals form; retain no Workspace or environment alias.
4. Default to `<user-home>/.my-agent`; resolve relative overrides against startup CWD once; preserve missing-directory and symlink/junction behavior needed by configuration bootstrap.
5. Atomically remove `workingDir` from Runtime options, resources, events, builders, Tool contribution options, Prompt inputs, and Subagent execution dependencies.
6. Route structured filesystem and Search paths from Agent Home by default, add optional call-level Search `path`, and require existing call-scoped Approval for declared lexically external targets even when the Tool name is allowed.
7. Default Exec `cwd` to Agent Home while governing Exec only by Tool-name deny/allow/per-call Approval; do not infer command effects or treat `cwd` as confinement.
8. Replace the Prompt `# Workspace` section with `# Agent Home`.
9. Rename the Builtin Workspace capability package to the concise Environment identity (`environment`, `createEnvironmentContribution()`, `EnvironmentContributionOptions`, and `builtin-environment`).
10. Remove `tools.fs.workingDirOnly` and the now-empty `tools.fs` group without replacement, alias, or dual read.
11. Preserve `installDir`, Extension Acquisition, strict one-read configuration, ADR-011 bootstrap, Core Agent Context ownership, Unit lifecycle, Channel behavior, and shutdown.
12. Update package/default/override startup scenarios and prove installation plus unrelated process-CWD trees remain unchanged.
13. Transfer stable/current/README authority only after implementation evidence passes.

## 3. Delivery sequence

| Item | State | Scope | Exit condition |
|---|---|---|---|
| AHPU-0 | Completed | Resolve Environment Tool path policy, then review and accept ADR-012, this Plan, and the change-local Specification | Owner accepted the two-path model, CLI/default/relative semantics, Environment identity, structured external-path Approval, Exec semantics, direct config removal, concurrency limit, risks, and validation obligations on 2026-09-16 |
| AHPU-1 | Completed | Perform the atomic Host/Runtime/Tool/Prompt/Subagent/config path cutover, including events and every maintained Runtime caller | Completed 2026-09-16: clean TypeScript compile plus 261 focused Host/bootstrap, Runtime/caller, Policy/Runner, Environment Tool, Prompt/Subagent, and configuration tests prove the accepted cutover; detailed evidence is recorded in `validation.md` |
| AHPU-2 | Completed | Complete current production terminology/source-layout convergence, Unit-ID cutover, Fitness baselines, and package scenarios | Completed 2026-09-16: Environment source/symbol/Unit identity and FT-13 converge without aliases; bounded current-source residuals contain only FT-13 negative evidence; installed default/explicit Agent Home first starts and configured WebSocket Host checks pass with installation/startup-CWD immutability |
| AHPU-3 | Completed | Transfer stable Specification, Current Architecture, README, ADR/index authority | Completed 2026-09-16: Current Architecture, stable Specifications, README, ADR supersession headers, and decision index now record the implemented two-path Agent Home, Environment Tool, structured Approval, and Exec contracts; FT-09 and FT-12 pass |
| AHPU-4 | Completed | Run final Gate, independent review, owner closeout, and archive | Completed 2026-09-16: 1,060-test full regression, complete Fitness, lint, clean build/audits, package and WebSocket Host verification, residual/whitespace checks, and independent review pass with no unresolved finding; owner-authorized automatic closeout proceeds to archive, commit, and push |

## 4. Acceptance criteria

- `installDir` and `agentHome` are the only Host/Runtime architecture paths.
- Standalone accepts zero arguments or one `--agent-home` in split/equals form.
- Omitted override selects `<user-home>/.my-agent`.
- Relative override resolves against startup CWD; CWD is not retained or injected into Runtime.
- A missing selected Agent Home is created through Platform Configuration bootstrap and receives exact `{}\n` config bytes.
- Existing Agent Home and configuration canonicalization/preservation remain unchanged.
- Blank, duplicate, retired, and unknown arguments fail before bootstrap/acquisition/Runtime.
- Runtime state owners, Prompt, and Subagent-owned state receive the same selected `agentHome`; structured Environment Tool paths resolve from Agent Home and declared lexically external targets require call-scoped Approval.
- File Search and Grep Search accept an optional call-level `path` and default it to Agent Home.
- Tool-name allow does not bypass structured external-path Approval; Tool-name deny remains final; missing Approval fails closed.
- Exec defaults and resolves relative `cwd` from Agent Home but `cwd` is not treated as confinement or used to infer command effects.
- Allowing Exec means arbitrary Shell commands run without prompts under host authority; otherwise each call requires Approval and missing Approval fails closed.
- `tools.fs.workingDirOnly` and the now-empty `tools.fs` group are removed without replacement, alias, or dual read.
- Current production source and maintained authority contain no Workspace or Working Directory path concept except OS child-process `cwd`, negative compatibility evidence, and historical archives.
- The Builtin capability package uses the Environment identity for its source directory, contribution symbols, Unit ID, imports, and Fitness baselines; Environment is not represented as a path, state owner, or authorization boundary, and individual Tool names remain stable.
- Agent-owned configuration/state is not falsely documented as isolated from path-capable Tools.
- Coordinated concurrent use of one Agent Home is explicitly unsupported; no process lock is introduced.
- `installDir`, Extension Acquisition, ADR-011 bootstrap, Core Agent Context, Runtime Unit lifecycle, Channel behavior, and shutdown remain unchanged.
- Default and explicit package startup scenarios prove no writes under `installDir` or unrelated process CWD.
- No Compatibility layer, Feature Flag, Workspace alias, environment path override, second Approval type, command-pattern grant, sandbox, or new project root is added.

## 5. Non-goals

- restoring `--workspace`, `MY_AGENT_WORKSPACE`, or `MY_AGENT_HOME`;
- introducing Workspace, Project Directory, project-local configuration, or layered configuration;
- adding an installer, setup wizard, profile manager, or Agent Home registry;
- protecting selected Agent-owned files through a new denylist, canonical/symlink authorization, or sandbox;
- adding Shell command parsing, command-pattern grants, persistent Approval, or Client Approval presentation rules;
- adding process-wide Agent Home locks or same-home multi-process support;
- changing Extension provisioning, acquisition, or immutable `installDir` ownership;
- changing Context templates, Memory/Session formats, Runtime Unit lifecycle, Channels, shutdown, or Model selection;
- adding config migration, aliases, dual reads, or Feature Flags;
- rewriting historical archived documents merely to remove old terminology.

## 6. Validation strategy

Use focused checks immediately after the first atomic cutover, with broad checks reserved for AHPU-4.

- AHPU-1: Host argument/path tests; Runtime public-contract and resource tests; structured internal/external Tool policy, call-level Search root, and Exec policy tests; Prompt and Subagent tests; configuration schema/direct-rejection tests; focused event and bootstrap tests.
- AHPU-2: source-layout and residual scans; affected Architecture Fitness; package default and explicit-override first starts; configured WebSocket Host verification; installation/CWD immutability snapshots.
- AHPU-3: stable/current authority diagnostics, relative-link checks, decision/index status checks, and `git diff --check`.
- AHPU-4: affected Integration and full Fitness suites, `npm run test:all`, `npm run lint`, clean `npm run build`, `npm run verify:package`, applicable WebSocket Host verification, residual scans, links, diagnostics, independent review, and owner closeout.

The existing uncommitted ADR-011 delivery remains in the worktree. Its bootstrap implementation is reused, but no commit is created until the corrective path model and combined Gate are accepted.

## 7. Stop conditions

Stop for owner review if evidence requires:

- retaining `workingDir` as a second Runtime path;
- weakening structured external-path Approval, treating Exec `cwd` as confinement, or making Exec allow narrower than arbitrary unprompted Shell execution without an explicit new decision;
- introducing Workspace, Project Directory, project config, or another path owner;
- adding an environment path override or precedence source;
- creating a second Agent Home bootstrap/configuration path;
- adding Tool-specific protected subtrees, sandbox roots, canonical/symlink authorization, command-pattern grants, persistent Approval, or a second Approval type;
- changing Extension Acquisition, Context ownership, Runtime Unit lifecycle, Host modes, Channel behavior, or shutdown;
- adding Compatibility aliases or automatic migration;
- claiming coordinated same-Agent-Home multi-process safety.

## 8. Completion and authority transfer

After AHPU-4:

1. ADR-012 becomes the durable two-path decision;
2. ADR-010 remains accepted for immutable `installDir`, Extensions, and mutable `agentHome` ownership but is marked superseded by ADR-012 for separate `workingDir` and fixed standalone selection;
3. ADR-011 remains accepted and applies to the selected Agent Home;
4. stable Runtime Composition, Configuration, and Standalone Service Host Specifications carry the delivered contract;
5. Current Architecture and README contain no active Workspace/Working Directory architecture concept;
6. this Change moves to `docs/changes/archive/` after owner closeout.

Follow [Development Workflow](../../../governance/development-workflow.md).
