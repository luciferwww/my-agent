# Runtime Source Layout Convergence

> Status: Accepted
> Date: 2026-11-11
> Owner: Project owner
> Classification: Architecture Slice
> Design: [Specification](specification.md)

## Outcome

Improve navigation in `src/runtime/` by grouping already-established
responsibilities. At the accepted base, the top level contained 47 files:
26 production files and 21 colocated tests. The delivery moves 20 existing files
into three responsibility groups, leaving 27 top-level files: 15 production
files and 12 tests.

This is physical source organization, not another responsibility extraction.
The previously accepted Settings and scheduler owners remain unchanged.

## Exact move scope

Keep all basenames; move each listed test with its implementation.

| Destination under Runtime | Production basenames | Existing test files |
|---|---|---|
| `composition/` | `composition-coordinator.ts`, `registry-builder.ts`, `reload-coordinator.ts`, `runtime-composition-manager.ts`, `runtime-composition.ts`, `runtime-lifecycle.ts`, `runtime-unit.ts` | The six matching `.test.ts` files; `runtime-composition.ts` has none |
| Existing `settings/` | `settings-manager.ts` | `settings-manager.test.ts` |
| `scheduling/` | `session-message-scheduler.ts`, `queue-types.ts`, `request-completion-gate.ts` | Scheduler and completion-gate `.test.ts` files |

Retain RuntimeApp, Builder/bootstrap, shared deadlines/errors/types, Agent policy,
Subagent orchestration, prompt helpers, Channel lifecycle, and Agent Home lock
at their current paths. Keep existing Session and interaction directories.
Do not force all remaining files into groups.

## Constraints and artifact rationale

- No behavior, state/resource ownership, configuration, dependency, public
  contract, export-name, or filename change.
- No extra Manager, interface, package, compatibility shim, or generic framework.
- New directories are organization groups, not new APIs. Do not introduce
  composition/scheduling barrels merely for symmetry.
- The existing private Settings entry exposes SettingsManager to its real
  external callers; internal Settings files use direct internal imports to
  avoid a new barrel cycle.
- Preserve each moved file's existing logical Fitness classification. In
  particular, moving queue types and request gates must not silently convert
  their current Mixed inventory entries into new exemptions or reclassify them.
- Preserve current public Runtime and Extension facade exports.

Use a Plan/Specification to bound this cross-cutting path migration. No new ADR
is proposed because ownership, dependency direction, and public boundaries do
not change. No Spike is justified for deterministic import/path updates.
If a move requires such a change, pause and reduce/revisit scope.

## Work items

| Item | Status | Exit criterion |
|---|---|---|
| RSL-1: Accept layout design | Completed | Owner accepted exact move list, migration constraints, and Delivery on 2026-11-11 |
| RSL-2: Move and update callers | Completed | All 20 moves and caller updates implemented; first 82 composition tests passed; old paths absent; owner accepted delivery |
| RSL-3: Verify and review | Completed | Counts, semantic comparison, unit/integration/Fitness, lint/build, emitted exports, links and direct review passed; owner accepted validation |
| RSL-4: Accept and close | Completed | Owner accepted delivery/validation and authorized archive on 2026-11-11, explicitly without commit, push or merge |

RSL-2 depends on RSL-1; RSL-3 depends on RSL-2; RSL-4 depends on RSL-3.

## Validation and documentation

The [Specification](specification.md#acceptance-and-validation) defines the
checks. Verify the actual 47-to-27 top-level reduction, not only passing imports.
Update Runtime architecture and mechanically repair links to moved source
files in affected existing documentation; retain historical prose and claims.
The owner's pre-existing research changes remain excluded from automatic edits
except narrowly authorized repairs to source links invalidated by these moves.

Proposal preparation runs document link/whitespace checks only. Earlier test
results are not proof that relocated imports or packaged output resolve.

## Delivery evidence

Validation ran on Node.js 22.22.2 after the moves:

| Check | Result |
|---|---|
| First coherent move group | 82 composition tests passed before continuing the migration |
| Runtime, Runner and WebSocket unit selection | 535 tests in 30 files passed; all moved Runtime tests discovered |
| Acquisition-to-Runtime integration | 3 tests passed |
| FT-01/03/12/13 | 8 checks in 4 files passed |
| Root/workspace lint | Passed |
| Full build | TypeScript and Client build passed; 62 Client assets verified, Host audit passed with 390 files, 121 Relay tests passed |
| Measured layout | Exactly 20 old paths absent and 20 destinations present; Runtime root has 27 files, 15 production plus 12 tests |
| Non-import semantic comparison | All 42 changed/relocated language files outside the three reviewed exceptions preserve normalized non-import AST against `01aa33f`; line endings normalized for comparison only |
| Emitted artifacts and facades | Both normal and Host output trees contain relocated production JS/declarations and no old artifacts; public Runtime/Extension declaration surfaces match the accepted base after module-target normalization, and emitted facade targets resolve |
| Source/script references | No old Runtime-root paths found in production/test/script/config references |
| Documentation | 31 source-link targets repaired in 9 documents; 300 local targets across 12 affected documents verified, including historical source-line suffixes |
| Whitespace | `git diff --check` passed |

The TypeScript language-service rename did not settle and was stopped before
writing files. A temporary TypeScript AST/module-resolution migration tool then
updated only resolved module targets and performed the exact moves; preliminary
unresolved-asset checks aborted before writes. No dependency or repository
tooling was added.

Direct review covered the intentional exceptions to the AST comparison:
Fitness classification selectors and the two existing Mixed entries were
relocated without reclassification or extra inventory entries; FT-13 permits
the exact private Settings entry to export its manager while continuing to
reject helper-to-manager dependencies; the existing private Settings entry
adds only the concrete manager export. Settings internals use sibling imports
and external callers use the private entry. No composition/scheduling barrel,
old-path proxy, duplicate owner, public export-name change, or executable
behavior change was introduced.

Current Runtime architecture now describes the verified grouping. Archive and
research repairs change live source-link targets only, preserving historical
prose and line suffixes. The owner's pre-existing research README modification
and untracked recommendation document remain user-owned and unstaged.

This was direct review, not independent review. No live Provider E2E or UI
validation is claimed. The existing Client chunk-size warning remains outside
scope. The owner accepted delivery/validation and authorized archive on
2026-11-11. Commit, push and merge remain separate, unauthorized decisions.

## Authorization

The owner agreed to a bounded Runtime directory-convergence Change. This branch,
`refactor/runtime-source-layout`, starts from integrated
`refactor/runtime-boundaries` at `01aa33f`. The owner explicitly accepted the Plan/Specification and authorized Delivery
and narrow repair of research source links on 2026-11-11. The owner subsequently
accepted delivery/validation and authorized archive on the same date, explicitly
without commit, push or merge.

The owner subsequently authorized a local commit of this Change and fast-forward
integration into `refactor/runtime-boundaries` on 2026-11-11. Research documents
are excluded from this commit; their current edits and source-link repairs stay
in the worktree. No push or merge into `main` is authorized.

Process authority: [Development Workflow](../../../governance/development-workflow.md).
