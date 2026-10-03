# Install and Agent Home Ownership Plan

> Status: Archived and Validated
> Date: 2026-09-16
> Accepted: 2026-09-16
> Validated: 2026-09-16
> Archived: 2026-09-16
> Owner: Project owner
> Type: Architecture Slice
> Decision: [ADR-010](../../../decisions/adr-010-install-and-agent-home-ownership.md)
> Contract: [Install and Agent Home Ownership Specification](install-and-agent-home-ownership-specification.md)
> Validation record: [Validation](validation.md)
> Supersedes: the path-ownership portions of [ADR-008](../../../decisions/adr-008-workspace-configuration-authority.md)
> Refines: path-input clauses of [ADR-009](../../../decisions/adr-009-host-boundaries-and-standalone-npm-distribution.md)

## 1. Goal

Establish exactly two persistent path owners:

- `installDir` owns installed program code, Builtin Units, packaged templates, and Extensions and is read-only while the program runs;
- `agentHome` owns the sole `config.json`, Agent Context, Memory, Sessions, Subagents, logs, temporary files, and related mutable state.

For the standalone Host, `installDir` is derived from the installed npm package and `agentHome` defaults to `<user-home>/.my-agent`. Neither is a normal CLI or environment override. A Host working directory remains execution context only and owns no configuration or state.

The observable result is that starting `my-agent` in a source project no longer creates application configuration or state there, Extensions are no longer treated as user-state files, and no `.agent` directory is introduced.

> **NOTE:** Filesystem/search scope and external-path approval are separate future work. This Change preserves the current working-directory behavior only and does not define authorization or grant persistence.

The first IAH-1 implementation attempt proved that Host-only acquisition is not a valid completion boundary: passing `workingDir` through the legacy Runtime `workspaceDir` contract still initializes persistent Agent state in the source project. That bridge is rejected. The ownership decision and Specification remain unchanged; this Plan revises only the Delivery boundary so the Runtime path contract changes atomically before IAH-1 can complete.

## 2. Accepted direction

1. Use the canonical production names `installDir` and `agentHome`. Do not use Installation Root, User Data Directory, Data Directory, Project Directory, or generic `workspaceDir` for these roles.
2. Each environment Host supplies or derives both owned locations. The standalone Host derives `installDir` from its installed package and derives `agentHome` as `<user-home>/.my-agent`.
3. `installDir` owns program code, Builtins, packaged templates, and pre-provisioned Extensions under `extensions/`. Runtime operation never writes there.
4. `agentHome` directly owns `config.json`, Agent Context files, Memory and recall state, Sessions, Subagent profiles, logs, temporary files, and related mutable state.
5. The Host reads `<agentHome>/config.json` at most once per startup attempt and reuses its immutable application, Extension, and Host projections.
6. Runtime receives `agentHome` and the Host working directory as distinct inputs. State/resource owners use only `agentHome`; filesystem/search Tools and prompt working-directory context retain the Host working directory without treating it as persistent ownership.
7. Rename the Agent configuration `workspace` budget section to `context`, and rename Core Workspace initialization/loading ownership to Agent Context ownership.
8. Extension Acquisition receives `<installDir>/extensions` as a narrow input. It retains direct-child discovery and in-place loading only.
9. Remove `--agent-home`, `MY_AGENT_HOME`, `--workspace`, and `MY_AGENT_WORKSPACE` without fallback, alias, dual-read, or automatic migration behavior.
10. Preserve Runtime Unit lifecycle, Registry publication, Host modes, liveness, shutdown, diagnostics, and direct npm distribution.

## 3. Delivery sequence

| Item | State | Scope | Exit condition |
|---|---|---|---|
| IAH-0 | Completed | Revise ADR-010, this Plan, and the change-local Specification from the rejected three-path design | Owner accepted the two owners, canonical names, placement, direct cutover, and validation obligations on 2026-09-16 |
| IAH-1 | Completed | Introduce Host-owned `installDir`, `agentHome`, and non-owning `workingDir` acquisition; move the single configuration read to `agentHome`; remove retired arguments and environment inputs; remain open until the atomic IAH-2 Runtime cutover completes | Completed and owner-confirmed on 2026-09-16 after the atomic IAH-2 cutover; Host/config checks and the real standalone distinct-root smoke pass, and no temporary `workspaceDir` bridge remains |
| IAH-2 | Completed | Atomically replace the Runtime path contract with `agentHome` and `workingDir`; route Agent Context, Session, Memory and recall, Subagent, Logger, and temporary ownership to `agentHome`; route filesystem/search Tools and prompt execution context to `workingDir`; rename every affected production path-bearing `workspaceDir` symbol by role | Completed and owner-confirmed on 2026-09-16; focused and full regression, lint, clean build, real startup, residual scan, and independent review pass |
| IAH-3 | Completed | Move Extension discovery to `<installDir>/extensions` and retire Agent Home resolution from Extension Acquisition | Completed on 2026-09-16; acquisition tests prove unchanged descriptor/loading behavior, install containment, and a byte-for-byte unchanged installation tree through Runtime shutdown |
| IAH-4 | Completed | Complete the remaining direct terminology migration: rename the `workspace` configuration budget to `context` and Core Workspace ownership to Agent Context | Completed on 2026-09-16; direct-cutover tests, contract compilation, full Fitness, Current Architecture evidence, asset audits, and residual scans pass without aliases or duplicate Core ownership |
| IAH-5 | Completed | Update Host/package audits, isolated package smoke, stable Specifications, Current Architecture, README, and authority indexes | Completed on 2026-09-16; isolated generated-command and Relay smokes use derived `agentHome`/`workingDir`, provision Extensions under `installDir`, prove package/Extension/working trees unchanged through shutdown, and stable/current authority reflects the delivered ownership model |
| IAH-6 | Completed | Run the final Architecture Slice Gate, independent review, authority transfer, and Change closeout | Technical Gates, documentation checks, independent review follow-up, authority transfer, project-owner closeout, and archive passed on 2026-09-16 |

## 4. Acceptance criteria

- `installDir` and `agentHome` are the only persistent path owners introduced by this Change.
- The standalone `installDir` is derived from the installed package and is never selected as writable application data.
- The standalone `agentHome` is `<user-home>/.my-agent`; this Change exposes no CLI or environment override for it.
- `<agentHome>/config.json` is the sole standalone configuration document and is read at most once per startup attempt.
- `agentHome` directly owns Agent Context files, Sessions, Memory, recall state, Subagents, logs, temporary files, and related mutable state; no hidden `.agent` directory is introduced.
- `installDir` owns Builtins, packaged templates, and direct-child External Extensions under `extensions/`; Host and Runtime operation do not write, install, copy, update, or cache content there.
- The Host working directory owns no my-agent configuration or Runtime state and is not an Extension source.
- Runtime contracts distinguish `agentHome` from non-owning `workingDir` and do not resolve process-global paths.
- Filesystem/search Tools and the system prompt continue to use the Host working directory.
- `agents.defaults.context` replaces `agents.defaults.workspace` directly, without a compatibility alias or dual read.
- No active production symbol uses `workspaceDir` to mean configuration, state, or generic Runtime ownership.
- Extension Acquisition receives an explicit `extensionsDir` and does not resolve `agentHome`, `installDir`, or process-global paths.
- Production startup exposes no `--agent-home` or `--workspace` and reads neither `MY_AGENT_HOME` nor `MY_AGENT_WORKSPACE`.
- Current persisted data is migrated only by an explicit offline operator procedure; conflicts are never merged or overwritten automatically.
- Runtime Unit lifecycle, Registry publication, Host modes, liveness, shutdown, Channel completion, diagnostics, and npm distribution architecture remain unchanged except where path names and values are observable.

## 5. Non-goals

- implementing a VS Code Host;
- adding project configuration or project-local Extension declarations;
- adding Extension installation, marketplace, download, update, signing, cache, dependency management, or persistent data APIs;
- introducing XDG config/data/cache separation;
- adding a standalone override for `installDir` or `agentHome`;
- auto-detecting a Git root or introducing a persistent Project Directory owner;
- adding project identity, project-partitioned Runtime state, or multi-root Runtime state;
- changing Session, Memory, recall, or Extension storage formats;
- automatically migrating or deleting existing files;
- changing Runtime Unit lifecycle, Channel behavior, or standalone process policy.

## 6. Validation strategy

Delivery uses impact-driven focused checks after each item and reserves broad regression for IAH-6.

- IAH-1: standalone path acquisition, argument rejection, configuration reader, and startup composition tests; completion also requires the IAH-2 real-startup evidence.
- IAH-2: atomic Runtime public-contract compilation; Agent Context, Session, Memory, Subagent, Logger, temporary path, filesystem Tool, prompt projection, Runtime bootstrap, reload, and embedding tests; production `workspaceDir` residual scan; real standalone before/after filesystem check.
- IAH-3: Extension directory discovery, loader, acquisition integration, containment, Host startup, and installation immutability tests.
- IAH-4: public-contract compilation, Architecture Fitness, source/config residual scans, and direct-cutover tests.
- IAH-5: clean Host build, static closure/asset audit, npm tarball audit, isolated install, generated command, fatal boundary, separate-context startup, WebSocket smoke, and installed-package immutability check.
- IAH-6: affected Integration and Fitness suites, `npm run test:all`, `npm run lint`, clean `npm run build`, applicable Host/Relay/package verification, documentation diagnostics, links, `git diff --check`, and independent review.

No unchanged broad suite is repeated between intermediate items.

## 7. Stop conditions

Delivery stops for owner review if evidence requires:

- writing into `installDir` during Runtime operation;
- a second standalone configuration document or merge precedence;
- a project-local configuration or executable Extension path;
- configurable standalone `installDir` or `agentHome` precedence;
- project identity or state partitioning to preserve correctness;
- an Extension install/update/cache/data API;
- automatic migration, dual reads, forwarding APIs, or another Compatibility path;
- changing Runtime Unit lifecycle, Host process policy, or npm distribution boundaries;
- undocumented package-manager or platform-specific installation assumptions.

## 8. Completion and authority transfer

This Change completed IAH-6 and transferred authority as follows:

1. ADR-010 records the durable ownership decision and ADR-008 is marked Superseded rather than rewritten;
2. stable Configuration, Standalone Host, Extension Acquisition, Runtime Composition, Agent Context, and affected state-owner Specifications carry the delivered contracts;
3. Current Architecture is updated from validated implementation evidence;
4. this Change records final commands/results and is archived under `docs/changes/archive/`;
5. archived predecessor Changes remain unchanged provenance.

The project owner accepted the final evidence, authority transfer, and archive on 2026-09-16. No commit was created during closeout.

Follow [Development Workflow](../../../governance/development-workflow.md).