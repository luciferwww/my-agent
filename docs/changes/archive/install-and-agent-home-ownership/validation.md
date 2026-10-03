# Install and Agent Home Ownership Validation

> Status: Archived and Validated
> Date: 2026-09-16
> Owner: Project owner
> Related Plan: [Install and Agent Home Ownership](plan.md)
> Contract: [Install and Agent Home Ownership Specification](install-and-agent-home-ownership-specification.md)

## 1. Gate policy

This record is initialized during design and will be populated with executed evidence during Delivery. Planned checks are not reported as passing. Broad regression is reserved for the final Gate unless cross-boundary evidence requires it earlier.

The earlier three-path draft was rejected before implementation. Its prior design-stage acceptance does not apply to this revision.

## 2. Planned evidence matrix

| Boundary | Evidence | Status |
|---|---|---|
| Host path derivation | Focused standalone Host/path-context tests | Pass — IAH-1/IAH-2 |
| Agent Home configuration | Configuration reader/default/error/immutability/single-read tests | Pass — IAH-1/IAH-2 |
| Runtime ownership routing | Runtime bootstrap/resource tests plus state-owner focused tests | Pass — IAH-2 |
| Non-owning working context | Filesystem/search/exec Tool and prompt projection tests | Pass — IAH-2 |
| Agent Context terminology | Initialization/loading/config-key migration tests | Pass — IAH-4 |
| Extension install ownership | Discovery/loader/acquisition integration, containment, and Host startup tests | Pass — IAH-3 |
| Installation immutability | Before/after package-tree verification around Runtime startup | Pass — IAH-3 integration fixture |
| Direct cutover | Retired argument, environment, symbol, config-key, and path residual checks | Pass — IAH-1 through IAH-4; old config keys remain only in direct rejection and negative-test evidence |
| Architecture boundaries | Affected Architecture Fitness tests | Pass — IAH-1/IAH-2 affected and full suites; IAH-4 full suite |
| npm distribution | Clean Host build, closure audit, tarball audit, isolated install, startup smoke | Pass — IAH-5; 155-file tarball, generated command, fatal boundary, derived-root startup, and package-tree immutability |
| Runtime integration | Affected Integration suite | Pass — included in full regression |
| Regression | `npm run test:all` | Pass — final IAH-6 Gate, 113 files and 1,029 tests |
| Static/build | `npm run lint` and clean `npm run build` | Pass — final IAH-6 Gate |
| Environment Host | Applicable WebSocket/Host/package/Relay verification | Pass — final package and compiled WebSocket Relay smokes |
| Documentation | diagnostics, links, authority/residual scan, `git diff --check` | Pass — post-archive link check covered 49 current/decision/archived-Change files; diagnostics, active-path residuals, diff integrity, Current Architecture metadata, and ADR-008-to-ADR-010 transfer pass |
| Review | independent Critical/High review | Pass after authority-transfer follow-up — no implementation, ownership, package, filesystem-scope, or test-portfolio blocker remains |

## 3. Revision-stage checks

| Check | Result |
|---|---|
| Specification, ADR, Plan, and validation record exist | Pass — 2026-09-16; ownership contracts remain Accepted and the Delivery-boundary revision is Proposed |
| Change and decision indexes link the revised artifacts | Pass — 2026-09-16 |
| Markdown diagnostics and links | Pass — 2026-09-16; no diagnostics and all relative links in the six revised/index documents resolve |
| `git diff --check` | Pass — 2026-09-16; unrelated line-ending warning only |
| Independent design review | Original ownership design: Pass — 2026-09-16; atomic Delivery-boundary revision: Pass — 2026-09-16; neither review found a Critical or High issue |
| Owner acceptance | Ownership decision, Specification, and revised atomic Delivery boundary accepted — 2026-09-16; IAH-2 authorized |

## 4. Delivery evidence

### IAH-1 — Host path acquisition and Agent Home configuration, completed through IAH-2

The initial Host/config implementation and focused checks ran on 2026-09-16. Completion was withdrawn after a real startup disproved the narrowed phase boundary. The rejected result below is retained as the evidence that required the atomic Runtime cutover; it is superseded by the passing IAH-2 evidence in the next section.

| Evidence | Result |
|---|---|
| Host path and configuration Unit tests | Pass — 55 tests across standalone path context, Host composition/startup, and configuration loading |
| Runtime injected-projection regression | Pass — affected `RuntimeApp` test |
| Architecture Fitness | Pass — 6 tests across FT-06 and FT-08 |
| Static analysis | Pass — `npm run lint` |
| Standalone Host artifact | Pass — `npm run build:host`; Host build audit passed with 153 files |
| Compiled path derivation smoke | Pass — compiled Host resolved the package root, `<user-home>/.my-agent`, and startup CWD exactly |
| Retired production inputs | Pass — no production reference to `--workspace`, `--agent-home`, `MY_AGENT_WORKSPACE`, or `MY_AGENT_HOME`; argument rejection cases remain only in tests |
| Diff integrity | Pass — `git diff --check`; unrelated line-ending warning only |
| Independent review | The initial review found no blocker inside the narrowed Host/config boundary; subsequent Runtime smoke evidence invalidated that boundary as an IAH-1 completion point |
| Real standalone startup | Fail against accepted ownership — `npm run agent` reported the repository under the observed legacy Runtime label `workspaceDir`, initialized Memory there, loaded four Context files there, and used `<repository>/memory.sqlite` |

The Host now owns one immutable `AgentPathContext`. Configuration is read once from `<agentHome>/config.json` and the same snapshot supplies application, Extension, and Host projections. Extension Acquisition no longer resolves Agent Home or reads its retired environment input.

The attempted bridge that passed `workingDir` through the existing Runtime `workspaceDir` contract is rejected. It preserved Tool context only by also directing Agent Context, Memory, Sessions, Subagents, and logs to the source project. IAH-2 replaced that bridge atomically, so IAH-1 is completed and owner-confirmed on 2026-09-16.

Extension discovery still consumes `agentHome` until IAH-3. This is a known intermediate nonconformance with the Accepted Specification, which requires `<installDir>/extensions`; it does not justify retaining the rejected Runtime bridge.

One combined Unit/Fitness invocation hit default five-second scheduling timeouts in FT-06 and FT-08; both suites passed when rerun under their own configuration. Two timing-sensitive, unaffected Runtime lifecycle cases also passed when rerun directly. Those historical reruns did not override the original ownership failure; the later atomic cutover and distinct-root smoke do.

### IAH-2 — Atomic Runtime path cutover, completed

Executed on 2026-09-16 after the direct `agentHome`/`workingDir` contract migration and removal of the rejected bridge.

| Evidence | Result |
|---|---|
| Production residual scan | Pass — no non-test TypeScript occurrence of `workspaceDir`, `workspaceOnly`, `fsWorkspaceOnly`, `workspaceRoot`, `resolveWorkspacePath`, `listWorkspaceFiles`, or `WorkspacePathError` |
| Distinct-root Runtime and working-context tests | Pass — Runtime, filesystem search, process contribution/exec, and Memory suites; 7 files and 76 tests across the two focused invocations |
| Runtime ownership contract | Pass — `agentHome` owns Context, Sessions, Memory/recall, Subagents, and logs; `workingDir` reaches filesystem/search, prompt, Subagent prompt, and default exec context |
| Memory ownership containment | Pass — Manager reads and writes reject lexical traversal outside `agentHome` without adding a permission system |
| Full regression | Pass — `npm run test:all`; 113 files and 1024 tests |
| Static analysis | Pass — `npm run lint` |
| Clean build and artifacts | Pass — `npm run build`; Host audit 153 files, Relay error-boundary audit 7 production JavaScript files, Relay artifact audit 7 files |
| Real standalone startup | Pass — compiled standalone entry started with isolated Home and empty `workingDir`; startup created the four Context templates only under `<home>/.my-agent`, retained `config.json`, and left `workingDir` empty |
| Current Architecture evidence | Pass — FT-12 passed after replacing stale removed Agent Home resolver links with the Host path-context owner |
| Diff integrity | Pass — `git diff --check`; unrelated line-ending warning only |
| Independent review | Pass — initial review findings for exec default CWD and Memory lexical traversal were accepted and fixed; follow-up found no unresolved Critical or High issue in IAH-1/IAH-2 |
| Owner confirmation | IAH-1 and IAH-2 accepted as complete on 2026-09-16 |

The first isolated smoke harness attempt used a relative compiled-entry path while setting the child CWD to the temporary working directory, so Node rejected the harness path before production startup. The corrected absolute-entry invocation passed; the harness error is not product evidence.

### IAH-3 — Extension installation ownership, completed

Executed on 2026-09-16 using the direct `extensionsDir` contract with no Agent Home fallback or alias.

| Evidence | Result |
|---|---|
| Focused Unit | Pass — discovery, loader, standalone path context, Host startup, and standalone composition; 5 files and 63 tests |
| Runtime Integration | Pass — 2 acquisition-to-Runtime tests with distinct `installDir`, `agentHome`, and `workingDir` |
| Installation immutability | Pass — installation file paths and byte content remained identical after acquisition, Runtime startup, publication, and shutdown |
| Contract residual | Pass — production Extension Acquisition contains no Agent Home or working-directory root input/resolution |
| Standalone composition | Pass — Host passes exactly `join(installDir, 'extensions')`; config and Runtime state continue using `agentHome` |
| Clean build | Pass — Relay artifact relocation/invocation audit consumes `extensionsDir`; Host and Relay audits pass |
| Independent review | Pass — no Critical or High issue; the sole Medium request for explicit installation immutability evidence was implemented and passed |

### IAH-4 — Agent Context and configuration terminology, completed

Executed on 2026-09-16 using the approved direct-convergence scope: remove obsolete Core Workspace duplication, converge source/config terminology, and update only directly coupled Fitness, Current Architecture, and template-asset audits. Full package smoke and stable Specification/README authority transfer remain IAH-5.

| Evidence | Result |
|---|---|
| Agent Context, Agent Config, Runtime, and prompt tests | Pass — 6 files and 119 tests covering initialization, allowlisted loading, `context` projection, old-key rejection, Runtime bootstrap/reload, and prompt projection |
| Contract and Current Architecture Fitness | Pass — focused FT-08/FT-12, 2 files and 8 tests |
| Full Architecture Fitness | Pass — `npm run test:fitness`; 12 files and 38 tests |
| Sole Core owner | Pass — `src/core/workspace` implementation, tests, types, and templates removed; Runtime and asset publication use `src/core/agent-context` |
| Direct config cutover | Pass — `AgentConfigDocument`, `AgentConfigSnapshot`, `AgentConfigError`, `loadAgentConfig({ agentHome })`, and `agents.defaults.context` are the active contracts; the renamed `tools.fs.workingDirOnly` switch preserves an implementation fact rather than establishing a permission decision; no compatibility alias or dual read exists |
| Residual scan | Pass — no active source or Current Architecture reference to `src/core/workspace`, `ensureWorkspace`, `WorkspaceConfig*`, or `loadWorkspaceConfig`; old `agents.defaults.workspace` appears only in direct rejection, its negative test, and the Current Architecture removal statement |
| Current Architecture | Pass — Agent Context owns initialization/loading; Configuration records the sole Agent Home document, immutable projections, Context budget, and working-directory Tool policy; FT-12 evidence and links pass |
| Coupled asset audits | Pass — Host and npm audit tests, 2 files and 8 tests, require `core/agent-context/templates`; full package smoke remains IAH-5 |
| Public-contract compilation | Pass — `npm run lint` |
| Clean build | Pass — `npm run build`; Host audit 153 files, Relay error-boundary audit 7 production JavaScript files, Relay artifact audit 7 files |
| Diff integrity | Pass — `git diff --check`; unrelated `tsconfig.json` line-ending warning only |

### IAH-5 — Package ownership and authority transfer, completed

Executed on 2026-09-16 after package and WebSocket verifiers were migrated away from retired path inputs. Test setup provisions executable Extension content before startup; Runtime operation remains read-only against installation content.

| Evidence | Result |
|---|---|
| Package boundary tests | Pass — Host build audit, npm package audit, and package-verifier helpers; 3 files and 13 tests |
| Tarball surface | Pass — `npm pack --json` invoked `prepack`, Host build/audit passed, and the allowlisted npm tarball contained 155 files |
| Isolated install and generated command | Pass — tarball installed into a temporary npm project on Node 22; generated `my-agent` command existed and ran from a separate empty working directory |
| Fatal entry boundary | Pass — unknown input returned exit 1, empty stdout, and exactly one complete `HOST_ARGUMENT_INVALID` stderr diagnostic |
| Derived path ownership | Pass — standard process Home derived `<home>/.my-agent`; startup CWD became `workingDir`; no standalone path arguments or custom path environment inputs were used |
| Agent Home state | Pass — package smoke found `config.json`, four Agent Context files, and `memory.sqlite` under derived Agent Home after shutdown |
| Package immutability and startup isolation | Pass — before/after snapshots retained every directory, regular-file byte sequence, and symlink target under the installed package; the separate working directory remained unchanged because startup performed no Agent-state writes or explicit filesystem Tool calls; unsupported entry types fail the verifier |
| Compiled WebSocket Host | Pass — dynamic-port WebSocket hello and complete Relay-backed Turn returned `smoke ok`; model discovery and invocation each occurred exactly once with valid authorization and no secret in Host output |
| Extension installation ownership | Pass — verifier provisioned the Relay artifact under repository `installDir/extensions` before startup; Runtime left every Extension-tree entry and byte unchanged and cleanup removed the fixture afterward |
| Stable authority transfer | Pass — Configuration, Extension Acquisition, Runtime Composition, and Standalone Service Host Specifications carry `installDir`, `agentHome`, `workingDir`, one Agent Home config, direct cutover, and package immutability contracts while explicitly excluding filesystem authorization decisions |
| Current authority and README | Pass — affected Current Architecture topics and root README describe install-owned Extensions, Agent Home state, non-owning working context, current Tool path-base facts, and argument-free service startup without presenting the coarse containment switch as a permission design |
| Architecture Fitness | Pass — `npm run test:fitness`; 12 files and 38 tests, including FT-09 documentation governance and FT-12 Current Architecture evidence/link checks |
| Static and clean build | Pass — `npm run lint` and `npm run build`; Host audit 153 files, Relay error-boundary audit 7 production JavaScript files, Relay artifact audit 7 files |
| Residual scan | Pass — active production, verifier, README, stable Specification, and Current Architecture surfaces contain no retired generic path contract, old config loader/type, old Core owner, Agent Home Extension path, or retired standalone path input |
| Diff integrity | Pass — `git diff --check`; unrelated `tsconfig.json` line-ending warning only |
| Independent review | Pass — no Critical or High finding; accepted Medium cleanup-independence and complete-tree-snapshot findings were fixed; the transient Specification-status observation is resolved by this evidence, and redundant retired-input package cases remain covered by IAH-1 direct-cutover tests |

Owner clarification after IAH-5 separated the retained code from architectural authority: `workingDir` remains the non-owning execution context required by the ownership cutover, while `workingDirOnly` is recorded only as pre-existing coarse behavior. Package smoke proves startup ownership isolation, not filesystem Tool authorization. No production code changed for this clarification.

### IAH-6 — Final Gate, review, and authority transfer, in owner review

Executed on 2026-09-16 against the retained dirty worktree. No intermediate commit or filesystem-authorization change was introduced.

| Evidence | Result |
|---|---|
| Integration | Pass — `npm run test:integration`; 6 files and 17 tests |
| Architecture Fitness | Pass — `npm run test:fitness`; 12 files and 38 tests in the final Gate and again after archive |
| Full regression | Pass — `npm run test:all`; 113 files and 1,029 tests |
| Static analysis | Pass — `npm run lint` |
| Clean build and artifacts | Pass — `npm run build`; Host audit 153 files, Relay error-boundary audit 7 production JavaScript files, Relay artifact audit 7 files |
| Isolated npm package | Pass — `npm run verify:package`; 155-file package installed and its generated command passed |
| Compiled WebSocket Host | Pass — `npm run verify:websocket-host`; install-owned Relay acquisition, complete Turn, and installation immutability passed |
| Direct-cutover residuals | Pass — no production retired generic ownership symbol or standalone path input; remaining `resolveAgentHome` names are Agent Home-specific local containment/derivation helpers rather than the retired Extension Acquisition API |
| Documentation diagnostics and links | Pass — no editor diagnostics; all relative links across 49 active/current authority Markdown files resolve |
| Diff integrity | Pass — `git diff --check`; only the existing `tsconfig.json` LF-to-CRLF working-copy warning was reported |
| Independent review | Pass — the initial closeout review found the expected unresolved authority-transfer status plus stale final counts/overview metadata, and no implementation defect or material duplicate test. Those findings were accepted and corrected; follow-up confirmed no unresolved Critical or High finding and classified owner closeout/archive as the only remaining governance dependency. |
| Authority transfer | Pass — ADR-008 is Superseded by ADR-010; the decision index, Current Architecture metadata, and Change-local Specification status agree |
| Owner closeout | Pass — project owner accepted the final evidence and authorized IAH-6 completion and archive on 2026-09-16; no commit was authorized or created |

## 5. Completion and retained evidence

Runtime state no longer uses the startup working directory, executable Extensions come only from `<installDir>/extensions`, Agent Context/configuration terminology has converged without duplicate ownership or compatibility aliases, and the final Gate plus stable/current authority prove the delivered model. The project owner accepted closeout and archive on 2026-09-16. Post-archive Fitness, links, diagnostics, active-path residuals, and diff integrity passed; no Change scope remains.

The repository-level `memory.sqlite` and Context files created by the rejected earlier startup remain historical worktree evidence. This Change does not automatically delete or migrate them.

Follow [Development Workflow](../../../governance/development-workflow.md).