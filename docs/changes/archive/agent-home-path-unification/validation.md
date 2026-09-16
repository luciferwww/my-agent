# Agent Home Path Unification Validation

> Status: Implemented, Validated, and Accepted
> Date: 2026-09-16
> Owner: Project owner
> Related Plan: [Agent Home Path Unification](plan.md)
> Contract: [Agent Home Path Unification Specification](agent-home-path-unification-specification.md)

## 1. Gate policy

This record is initialized during design. Planned checks are not reported as passing. Delivery starts only after ADR-012, the Plan, and the Specification are accepted. Focused checks follow the atomic implementation cutover; full regression, lint, clean build, environment verification, and independent review are reserved for the final Gate.

## 2. Current evidence

| Observation | Current evidence |
|---|---|
| Old Workspace was overloaded | ADR-008 and ADR-010 record configuration, state, Tool scope, command execution, and prompt context under one prior `workspaceDir` |
| Previous implementation had a third architecture path | Before AHPU-1, `AgentPathContext`, Runtime options/resources/events, Tools, Prompt, and Subagents carried `workingDir` separately from `installDir` and `agentHome` |
| AHPU-1 removes the third path contract | Host and Runtime boundaries now carry only `installDir` and selected `agentHome`; Prompt, Subagents, and Tool factories receive that Agent Home |
| Standalone selection is restored without a Runtime CWD path | the parser accepts zero arguments or one split/equals `--agent-home`; relative input uses startup CWD only during path resolution |
| Configuration bootstrap is reusable | the uncommitted ADR-011 delivery already bootstraps a supplied `agentHome` and does not depend on `workingDir` |
| Tool/state relationship is resolved | Agent Home anchors relative structured paths and Search defaults; declared lexically external targets require existing call-scoped Approval; Exec remains Tool-name-governed arbitrary Shell execution |
| Environment identity is implemented | the physical package is `src/builtins/tools/environment/`, the public entry is `createEnvironmentContribution()` with `EnvironmentContributionOptions`, and the Unit ID is `builtin-environment`; no source alias remains |

These observations justify an Architecture Slice. They do not authorize Workspace restoration, project configuration, filesystem authorization, protected state paths, environment precedence, or same-home process locking.

## 3. Planned evidence matrix

| Boundary | Evidence | Status |
|---|---|---|
| CLI grammar | left-to-right first-failure behavior plus default, split/equals, blank, missing, option-as-value, duplicate, retired, positional, and unknown argument tests | Pass — AHPU-1 focused Host tests |
| Path selection | absolute/relative/default/missing/existing/symlink/junction/non-directory/inaccessible tests | Pass — AHPU-1 focused Host tests |
| Two-path contract | compile/runtime tests prove only `installDir` and `agentHome` cross Host/Runtime boundaries; every maintained caller and `app_start`/`app_ready` event is migrated | Pass — clean TypeScript compile and focused Runtime tests |
| Configuration | removal and direct rejection of `tools.fs.workingDirOnly` and the obsolete `tools.fs` group, with no replacement containment field | Pass — type removal plus direct defaults/list-entry rejection tests |
| State routing | Agent Context, Session, Memory, Subagent, Logger, and temp paths use selected Agent Home | Pass — focused Runtime and Subagent tests |
| Structured Tool routing | filesystem and Search tests prove Agent Home-relative defaults, optional Search `path`, internal allow, external Approval despite allow, deny precedence, Approval-unavailable failure, and lexical classification | Pass — focused Tool Policy, Runner, filesystem, Patch, and Search tests |
| Exec routing | tests prove Agent Home default/relative `cwd`, deny, allow-without-prompt, exact-command per-call Approval, and Approval-unavailable failure without using `cwd` as confinement | Pass — focused Exec, Tool Policy, and Runner Approval tests |
| Prompt/Subagent | `# Agent Home` projection and same-root Child execution context | Pass — focused Prompt and Subagent tests |
| Bootstrap | selected missing Agent Home receives exact `{}\n`; existing content and ADR-011 failures remain unchanged | Pass — 45 combined Host/bootstrap tests, including the preserved ADR-011 suite |
| Failure short-circuit | argument/path/bootstrap/load failure invokes neither acquisition nor Runtime | Pass — focused Host startup tests |
| Terminology | bounded residual allowlist excludes retired path concepts outside historical archives, superseded ADR text, OS `cwd`, and explicit negative evidence | Pass — current source/scripts/fixtures retain only FT-13 negative-removal literals; current authority uses Agent Home and Environment terminology |
| Source/Unit identity | Environment package (`environment`, `createEnvironmentContribution()`, `EnvironmentContributionOptions`, and `builtin-environment`), imports, fixtures, and Fitness baselines cut over without alias | Pass — package move, Runtime assembly, Unit assertion, and FT-13 |
| Package behavior | default and explicit Agent Home installed-command scenarios plus configured WebSocket Host smoke | Pass — installed package default and split-form explicit first starts plus configured WebSocket verification |
| Path immutability | `installDir` and unrelated startup CWD remain unchanged | Pass — package checks snapshot both scenarios; explicit selection also leaves fallback home unchanged; WebSocket Host preserves installation and startup CWD |
| Architecture boundaries | affected Fitness tests and authority links | Pass — all 38 Fitness tests pass after AHPU-3 authority transfer |
| Regression | `npm run test:all` | Pass — 114 files and 1,060 tests |
| Static/build | `npm run lint` and clean `npm run build` | Pass — TypeScript, 154-file Host audit, Relay error boundary, and 7-file Relay artifact audit |
| Environment Host | package and WebSocket Host verification | Pass — 156-file installed package with default/explicit first starts and compiled WebSocket streamed Turn |
| Documentation | diagnostics, links, status/residual scans, `git diff --check` | Pass — Fitness link/governance checks, authoritative filesystem residual scan, changed-document diagnostics, and whitespace |
| Review | independent Critical/High review and owner closeout | Pass — no Critical, High, Medium, or Low implementation/authority finding after final evidence; automatic completion/commit/push authorization supplies closeout |

## 4. Design-stage checks

| Check | Result |
|---|---|
| ADR, Plan, Specification, and validation record exist | Pass — 2026-09-16 |
| Decision and Change indexes link the proposal | Pass — 2026-09-16 |
| Relative Markdown links resolve | Pass — six proposal/index documents; four revised proposal documents rechecked 2026-09-16 |
| Editor diagnostics | Pass — no diagnostics in proposal/index documents |
| Whitespace and final newlines | Pass — direct check of four revised untracked proposal documents, 2026-09-16; ordinary `git diff --check` does not inspect untracked files |
| Independent design review | Pass — focused post-decision review found no Critical, High, or Medium issue; two Low wording/evidence observations dispositioned 2026-09-16 |
| Owner acceptance | Pass — two-path, Environment path, structured external Approval, Exec, and config-removal decisions accepted 2026-09-16 |

The initial review classified current implementation mismatches as blockers even though ADR-012 and the Draft Specification intentionally describe a not-yet-delivered target. Those findings were rejected as category errors rather than implementation defects. Its useful completeness observations were accepted: parser grammar, path validation/bootstrap ordering, Runtime event and maintained-caller migration, Builtin Unit/source identity, and residual authority scoping were clarified before follow-up review.

The focused post-decision review found no blocking issue. Its first Low observation about design-review wording is resolved by this recorded review result. Its second Low observation requested an explicit residual-scan allowlist criterion; no edit was needed because the Specification already requires a bounded allowlist limited to historical and negative cases.

## 5. AHPU-1 implementation evidence

| Check | Result |
|---|---|
| TypeScript compile | Pass — `npx tsc --noEmit --pretty false` |
| Core/Runtime/Tool/config focused tests | Pass — 199 tests across Tool Policy and Runner, Environment filesystem/Search/Exec, Prompt/Subagent, configuration, Runtime Builder, and RuntimeApp |
| Host/bootstrap focused tests | Pass — 45 tests across standalone parsing/path/startup/runtime-host and Agent Configuration bootstrap |
| Maintained integration callers | Pass — 17 tests across Extension Acquisition Runtime integration and Runtime intake |
| Editor diagnostics | Pass — no diagnostics under `src` |
| Whitespace | Pass — `git diff --check` |
| Bounded residual check | Pass for AHPU-1 architecture contracts — Runtime, Runtime events, Prompt, and Subagent production surfaces contain no `workingDir`; retired `tools.fs` remains only as explicit negative compatibility evidence |

The 261 focused tests are the unique current AHPU-1 set. Two affected files were rerun after the final assertion additions (20 tests, all passing). Full regression, Fitness, clean build, package verification, terminology/source identity convergence, and independent closeout remain unclaimed and follow AHPU-2 through AHPU-4.

## 6. AHPU-2 implementation evidence

| Check | Result |
|---|---|
| Environment package and identity | Pass — source moved directly to `src/builtins/tools/environment/`; `createEnvironmentContribution()`, `EnvironmentContributionOptions`, and `builtin-environment` are the only current identities |
| Focused Environment/Runtime/Fitness/script tests | Pass — 77 tests |
| Process-tree operating-system integration | Pass — 1 test under `vitest.integration.config.ts`; the generic editor runner used the wrong test configuration and timed out before the dedicated configuration passed |
| Renamed maintained callers | Pass — 241 tests across Memory, Session, Runner, Runtime, Host, configuration, and acquisition; 236 passed in the editor runner and the five native SQLite tests then passed under the repository Node 22 terminal after the editor runner exposed a Node ABI 115/127 mismatch |
| TypeScript compile | Pass — `npx tsc --noEmit --pretty false` |
| Source-layout Fitness | Pass — FT-13, 3 tests |
| Complete Fitness observation | 37/38 pass; the sole FT-12 failure is the expected set of deleted Workspace evidence links in Current Architecture. Updating those current-authority pages is AHPU-3 scope, so complete Fitness is not claimed yet |
| Installed package | Pass — 156-file package, default first start, explicit `--agent-home <path>` first start, exact `{}\n`, installation/startup-CWD immutability, and unchanged explicit fallback home |
| Configured WebSocket Host | Pass — generic Host, install-owned Relay acquisition, and immutable installation contents |
| Bounded residual scan | Pass — current source, scripts, and maintained fixtures contain retired identities only in FT-13 negative evidence; the old package directory is absent |
| Whitespace | Pass — `git diff --check` |

AHPU-2 deliberately does not edit Current Architecture, stable Specifications, README authority, or supersession wording. Their now-stale source evidence links make FT-12 fail visibly until the accepted AHPU-3 authority-transfer step. Full regression, lint, clean build, package re-verification, complete Fitness, independent review, and closeout remain AHPU-4 obligations.

## 7. AHPU-3 authority-transfer evidence

| Check | Result |
|---|---|
| Current Architecture | Pass — Runtime, Builtin Tools, Prompt, Agent Context, Configuration, Extensions, Overview, and Session pages record implemented Agent Home/Environment behavior and resolve current source evidence |
| Stable Specifications | Pass — Runtime Composition, Standalone Service Host, Configuration, and Extension Acquisition carry the delivered path and Approval contracts |
| Durable decisions | Pass — ADR-007 and ADR-010 identify their clauses partially superseded by ADR-012; ADR-011 identifies selected Agent Home refinement; the decision index reflects each relationship |
| Operator entry | Pass — README documents default/explicit Agent Home, relative selection, exact config bootstrap, Environment roots, external Approval, and arbitrary Exec authority |
| Fitness | Pass — 12 files and 38 tests, including FT-09 documentation governance, FT-12 Current Architecture, and FT-13 source convergence |
| Diagnostics and whitespace | Pass — no editor diagnostics in changed documentation or README; `git diff --check` passes |
| Independent review | Pass after disposition — no Critical/High findings; one Medium index inconsistency and one Low verification-date issue accepted and fixed; the reported Application-config omission conflict was rejected because the cited accepted requirement governs mandatory `agentHome`, not optional `applicationConfig`; historical ADR-007 body remains preserved under its explicit partial-supersession header |

## 8. AHPU-4 final Gate and closeout

| Check | Result |
|---|---|
| Full regression | Pass — `npm run test:all`: 114 test files, 1,060 tests |
| Fitness | Pass — 12 test files, 38 tests |
| Static analysis | Pass — `npm run lint` |
| Clean build | Pass — `npm run build`; Host build audit covers 154 files, Relay error-boundary audit covers 7 production JavaScript files, and Relay artifact audit covers 7 files |
| Installed package | Pass — `npm run verify:package`; 156 files, generated command, default and explicit Agent Home first starts, exact `{}\n`, and immutable installation/startup-CWD trees |
| Compiled WebSocket Host | Pass — `npm run verify:websocket-host`; install-owned Relay acquisition, streamed Turn, and immutable installation contents |
| Residuals and whitespace | Pass — authoritative filesystem scan found only five explicit FT-13/configuration negative references; retired Workspace Tool directory is absent; `git diff --check` passes |
| Diagnostics | Pass with environment note — changed documentation has no diagnostics and terminal TypeScript/tests pass; the editor diagnostics service retains prior execution failures from its Node ABI 115 runner against repository ABI 127 and a prior process-test timeout, neither reproduced by the authoritative Node 22 full suite |
| Independent final review | Pass — no Critical, High, or Low findings; its sole Medium observation was that Gate records were still pending during review and is resolved by this section and archive transition |
| Closeout | Accepted — the project owner explicitly authorized automatic completion, commit, and remote push; all accepted criteria are implemented and no stop condition or unresolved finding remains |

## 9. Known risk and deferred scope

Agent-owned files are exposed to path-capable Tools and Exec under the accepted policy. Structured declared targets outside Agent Home require call-scoped Approval, but V1 keeps lexical classification and does not add canonical/symlink enforcement. Protected internal paths remain separate future work.

The capability package is named Environment because it publishes filesystem, search, web, command-execution, and process interaction rather than managing Agent Home. This name is not a new path or Runtime object. Agent Home is the relative-path anchor, not a hard filesystem boundary: structured external targets use Approval, while Exec cannot be bounded by `cwd` or inferred command paths.

Adding Exec to `tools.allow` deliberately suppresses Approval for arbitrary Shell commands and subprocesses under host authority. No sandbox, command-pattern allow, or persistent Approval is included in this Change.

Relative CLI selection depends on startup CWD only during path resolution. CWD must not survive as Runtime state or silently become a configuration source.

Same-Agent-Home concurrent processes remain unsupported. Tests cover deterministic configuration bootstrap races but do not claim Memory, Session, Logger, Tool, or lifecycle coordination.

The direct config and API cutover deliberately has no alias. Delivery must update maintained callers and fixtures atomically and reject retired input rather than add fallback paths.

The existing ADR-011 implementation is uncommitted but validated. It remains reusable under the selected Agent Home; its archived Change must not be rewritten as an alternative active path decision.

Follow [Development Workflow](../../../governance/development-workflow.md).
