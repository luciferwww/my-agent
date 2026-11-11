# Runtime Composition and Policy Layout

> Status: Accepted
> Date: 2026-11-11
> Owner: Project owner
> Classification: Architecture Slice
> Design: [Specification](specification.md)

## Outcome and rationale

Extend the existing composition directory to represent overall Runtime assembly,
startup and component lifecycle. Group the existing applied Agent policy and
Tool authorization implementations in a new private policy directory. Directory
membership does not transfer state ownership or logical Fitness classification.

The owner agreed to this direction after reviewing narrow and broad composition
meanings. This Change makes the exact scope explicit before Delivery. It is not
an instruction to clear the Runtime root or extract additional responsibilities.

## Exact move scope

Keep basenames and colocated tests. All paths below are relative to `src/runtime/`.

| Destination | Production files | Tests |
|---|---|---|
| Existing `composition/` | `runtime-builder.ts`, `bootstrap.ts`, `agent-home-lock.ts`, `channel-lifecycle.ts` | `runtime-builder.test.ts`, `agent-home-lock.test.ts`, `channel-lifecycle.test.ts`, `external-test-channel.test.ts` |
| New `policy/` | `agent-policy-state.ts`, `tool-approval-policy.ts`, `glob-match.ts` | `agent-policy-state.test.ts`, `tool-approval-policy.test.ts` |

This is 13 moves: 7 production files and 6 tests. The Runtime root changes from
27 files (15 production, 12 tests) to 14 (8 production, 6 tests). Counts verify
scope, not the architectural value of the grouping.

Retain RuntimeApp and its two tests, Subagent orchestration and its test,
prompt factory and its test, assembled-message summary and its test, shared
deadlines and their test, public index, types and errors at the root.
Keep existing settings, scheduling, session and interaction groups unchanged.

## Boundaries and non-goals

- Composition means assembly and startup/component lifecycle, not all runtime
  execution. Subagent delegation remains RuntimeApp/Builder-connected runtime
  orchestration; do not move it merely because it exposes a factory.
- Policy means applied Agent execution policy and Tool authorization decisions.
  Settings retains admission, editing/persistence transactions and revisions.
  Session permission state and interaction approval lifecycle remain unchanged.
- Preserve the Agent Home lock's Infrastructure classification, AgentPolicyState
  and Builder/bootstrap/Channel lifecycle Composition classifications, and
  existing Mixed entries for Tool policy and glob matching.
- No behavior, contracts, public export names, dependencies, state owners,
  configuration, new classes, compatibility shims or directory barrels.
- Translate Chinese comments in relocated files and directly affected source
  callers/tests into English, preserving meaning and all executable strings.
- Update Current Architecture and live Markdown source targets invalidated by
  these moves only. Historical prose and prior Change scope remain historical.
  Existing research edits must be preserved; source-link repairs there require
  explicit narrow permission and do not authorize staging research documents.

A Plan/Specification bounds the path migration. No ADR or Spike is proposed:
public boundaries and accepted behavioral decisions are unchanged. Pause if
implementation requires a new owner or dependency direction.

## Work items

| Item | Status | Exit criterion |
|---|---|---|
| CPL-1: Accept design and Delivery | Completed | Owner accepted exact Plan/Specification, Delivery and narrow research source-link repairs on 2026-11-11 |
| CPL-2: Relocate and migrate callers | Completed | All 13 Runtime files moved, callers and colocated tests migrated; first 31 policy tests passed; owner accepted delivery |
| CPL-3: Verify and review | Completed | Semantic, behavioral, Fitness, lint/build/artifact and document checks passed; owner accepted validation |
| CPL-4: Accept and close | Completed | Owner accepted delivery/validation and authorized archive on 2026-11-11, explicitly without commit, push or merge |

CPL-2 depends on CPL-1; CPL-3 depends on CPL-2; CPL-4 depends on CPL-3.

## Validation and authorization

Follow the [acceptance checks](specification.md#acceptance-and-validation).
Proposal preparation uses link and whitespace checks only; prior build/test
results are not proof for this migration.

## Delivery evidence

Checks ran on Node.js 22.22.2 against the relocated implementation:

| Check | Result |
|---|---|
| First coherent move group | 31 policy tests passed immediately after the five policy moves |
| Runtime/Runner/WebSocket regression selection | 535 tests in 30 files passed, including every relocated Runtime test |
| Acquisition-to-Runtime integration | 3 cases passed |
| FT-01/03/12/13 | 8 checks in 4 files passed after migrating synthetic FT-01 fixture paths |
| Root/workspace lint | Passed, including Vue Client type checking |
| Full build | TypeScript/Client build passed; 62 Client assets verified, Host audit passed with 390 files, 121 Relay tests passed |
| Exact layout | 13 Runtime old paths absent/new paths present; Runtime root has 14 files: 8 production and 6 tests |
| Syntax and module comparison | 21 changed/relocated language files, including Fitness tests and fixture, match `b589364` after resolved module-target, exact Fitness-path and comment normalization; import bindings and executable syntax preserved |
| English comments | No Chinese comments remain in moved or directly affected source/test files; runtime strings/test names unchanged; synthetic source/diagnostic paths migrated separately |
| Emitted artifacts | Both standard and Host output trees have relocated production JS/declarations, no old root artifacts, unchanged public Runtime/Extension declaration surfaces and resolving facade targets |
| Stale source references | No old Runtime-root paths remain in production/test/script/config references, including synthetic fixtures |
| Documentation | 13 live source targets repaired in 9 documents; 343 local targets across 13 affected documents checked, preserving historical line suffixes and prose |
| Whitespace | `git diff --check` passed |

Migration used a temporary TypeScript AST/module-resolution tool, preparing all
edits before each group's writes and preserving resolved imports, re-exports,
import types, dynamic imports and mock references. No dependencies or repository
tooling were added.

The first Fitness run exposed old synthetic paths in the FT-01 negative tests,
not new production boundary violations. The existing miniature Bootstrap fixture
and its synthetic Runner import were relocated consistently, and Agent policy
diagnostic inputs/expectations were updated to the policy path. No new test or
permanent migration-inventory gate was added. A temporary comparison initially
reported quote-style differences in rewritten Fitness literals; canonicalizing
quotes in that tool confirmed path-only edits without changing production code.

Direct review confirmed the Agent Home lock remains Infrastructure; Builder,
Bootstrap, Channel lifecycle and AgentPolicyState remain Composition. Existing
Mixed inventory membership, including the Bootstrap inventory entry, was
preserved at new paths without extra entries/exemptions. FT-01 negative cases
still reject Application-to-Composition imports; no dependency rule was weakened.
No new policy/composition barrel, proxy, state owner, public export, shutdown
policy or Parent/Child execution path was introduced.

Current Architecture describes broad composition and private policy grouping.
Other documents have source-target-only repairs. Research prose, existing edits
and untracked recommendation status were preserved; no files are staged.

This is direct review, not independent review. No UI or live Provider E2E
validation is claimed. The pre-existing Client chunk-size warning remains
outside scope. The owner accepted delivery/validation and authorized archive on
2026-11-11, explicitly without commit, push or merge.

## Authorization

Branch `refactor/runtime-composition-policy-layout` starts from aggregation
branch `refactor/runtime-boundaries` at `b589364`. The owner accepted this exact
Plan/Specification, authorized Delivery and narrow research source-link repairs
on 2026-11-11, and subsequently requested English translations of Chinese source
comments in scope. The owner subsequently accepted delivery/validation and
authorized archive on the same date, explicitly without commit, push or merge.

The owner subsequently authorized separate local commits for the layout Change
and follow-up Runtime comment translations, fast-forward integration into
`refactor/runtime-boundaries`, and an aggregate regression run on 2026-11-11.
Research documents remain excluded from both commits, preserving all worktree
edits and source-link repairs. No push or merge into `main` is authorized.

## Follow-up comment cleanup

After layout acceptance, the owner requested English translations of remaining
Chinese comments across Runtime source and tests, without changing code or test
names. The follow-up translates comments in `prompt-factory.ts` and
`summarize-assembled.ts`; the layout commit already translates the moved policy
comments. A scan of 62 Runtime TypeScript files and 99 parsed comment ranges
found no remaining Chinese comments. Three existing Chinese-containing test
names were intentionally retained. The message-summary executable-syntax
fingerprint is unchanged; 13 prompt/summary unit tests and whitespace checks
passed. This cleanup is committed separately from the directory migration.

Process authority: [Development Workflow](../../../governance/development-workflow.md).
