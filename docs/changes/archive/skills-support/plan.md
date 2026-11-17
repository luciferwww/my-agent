# Skills Support

> Status: Accepted
> Authority: Non-authoritative delivery record; may be cleaned up at any time.
> Date: 2026-11-13
> Owner: Project owner
> Classification: Architecture Slice
> Design: [Validated Specification](specification.md)
> Authorization: Owner accepted Plan/Spec and authorized implementation on 2026-11-13; subsequently authorized committing all changes and pushing the current branch. Owner accepted delivery and separately authorized archive on 2026-11-17. No additional commit/push or merge is authorized. No Spike is authorized.

## Outcome

Support user-authored and third-party Skills from one Agent Home library. Users
choose default and per-Agent Skill sets in Settings. Root and Child Agents use
the same discovery and loading mechanism, with automatic selection or explicit
instructions interpreted by the model. File changes and saved selections take
effect without restarting the Agent.

The owner reviewed the research baseline on 2026-11-13. Subsequent owner
clarifications include nested discovery with flat identity/listing and leaving
script environments to Skill instructions and existing tools. Neither research
approval alone authorized Delivery; explicit Plan/Spec acceptance is recorded below.

## Scope

- Discover nested `SKILL.md` packages only under `<agent home>\skills`.
- Flat unique names, descriptions and relative source paths; explicit diagnostics.
- Default selection with optional per-Agent complete replacement, including an
  explicit empty set.
- Settings selection and persistence through existing application boundaries.
- Automatic discovery of additions, edits and removals, including a root created
  after startup; update an open Settings view without requiring a new Turn.
- Per-Turn capture of effective selections for new Root and Child Turns.
- A model-visible Skills section owned by System Prompt Builder and one loading
  tool that validates the captured effective selection.
- Model-driven automatic and explicit use, including delegation instructions.
- Existing permissions, execution, failure and transcript handling.

## Non-goals

- Workspace support, per-Agent Homes, multiple discovery roots or source precedence.
- Host slash parsing, pre-expanded user prompts, Skill-specific message protocols
  or structured delegation parameters.
- Script environment management, dependency installers, per-Skill env/secret
  configuration, automatic shell execution or permission grants.
- Whole-package snapshots, resource version checks or a Skill-specific execution
  engine.
- Marketplace, remote sources, automatic updates, vector search or folder-level
  enablement.
- Selecting or shipping bundled Skills in this Change without a further explicit
  scope decision. Nested `builtin` is an ordinary folder, not a special source.
- Cleanup of unused prompt helpers, `_debug`, or relocation of the existing
  Subagent prompt renderer.
- Commit, merge, push or archive without separate authorization.

## Current evidence and intended boundaries

- [Configuration](../../../architecture/configuration.md) owns document loading
  and projections. Existing defaults and named entries provide selection context;
  no Skills fields exist merely because this Change proposes them.
- [Agent Management](../../../specifications/agent-management.md) defines named
  identities and shared/named policy application. Do not equate Agent identity
  with each temporary Child run.
- [Prompt Composition](../../../architecture/prompt.md) consumes Runtime-supplied
  inputs. Builder owns section rendering, not filesystem scans or watchers.
- [Tool Contract](../../../architecture/tools.md) owns validation, visibility,
  permissions and execution. Skill loading must use these boundaries.
- [AgentPolicyState](../../../../src/runtime/policy/agent-policy-state.ts) and
  [SettingsManager](../../../../src/runtime/settings/settings-manager.ts) are
  existing integration points to inspect for persist-before-publish selection
  updates, not a mandate to add a parallel manager.
- [SystemPromptBuilder](../../../../src/core/prompt/SystemPromptBuilder.ts) is
  the rendering integration point.
- [Exec input](../../../../src/builtins/tools/environment/process/exec-types.ts)
  already supports working-directory and environment arguments; no Skill-specific
  runtime setup is required.

The [concrete delivery proposals](specification.md#10-concrete-delivery-design-proposals)
resolve discovery ownership, polling, loading-tool registration, trusted Turn
binding and Settings contracts from source inspection. Owner accepted these
contracts and authorized Delivery on 2026-11-13.

## Plan and gates

| Item | Status | Exit criterion |
|---|---|---|
| SK-1: Resolve delivery design | Completed | Static review closed; simplified discovery/loading contracts confirmed |
| SK-2: Accept design | Completed | Owner accepted Plan/Spec and authorized implementation on 2026-11-13 |
| SK-3: Deliver discovery and loading | Completed | Implemented; discovery/loading, live updates, duplicate rejection and focused tests pass |
| SK-4: Deliver selection, prompt and Settings wiring | Completed | Implemented; selection persistence, independent Root/Child captures, prompt modes and Settings controls verified |
| SK-5: Validate and synchronize | Completed | Automated, native-browser and authorized real-model checks pass; Owner accepted delivery |
| SK-6: Accept delivery | Completed | Owner accepted delivery on 2026-11-17; subsequent publication/archive requires separate authorization |

SK-2 depends on SK-1. SK-3 and SK-4 depend on SK-2; shared contract prerequisites
between their implementation steps must be recorded before Delivery. SK-5 depends
on both SK-3 and SK-4. SK-6 depends on SK-5.

No Spike is authorized. If static inspection cannot resolve a concrete lifecycle,
model or external behavior question, propose a bounded experiment rather than
silently adding an alternative execution path.

## Validation strategy

- Unit: discovery/layout/diagnostics, selection semantics, prompt rendering and
  tool validation using controlled files and current repository test runners.
- Integration: add/edit/remove/root-creation updates, Settings persistence and
  publication, restart retention and Root/Child admission boundaries.
- Real model: automatic selection, explicit `/skill` instructions, delegated
  names/arguments, loading before use and honest unavailable-Skill feedback.
  Mocked tool calls alone do not prove model adherence. Record Provider/model
  and concrete outcomes; do not invoke paid services without authorization.
- UI: default inheritance, custom/empty sets, source paths, diagnostics and
  automatic updates on desktop/mobile, preserving dirty edits.
- Regression: targeted prompt, Tools, Settings, Agent and lifecycle checks; lint
  and build at the cross-boundary Gate. Use Fitness only for justified durable
  constraints, not new prose or incidental module layouts.
- Documentation: links, diagnostics and whitespace checks.

## Preparation record

- 2026-11-13: Created Proposed Plan and Draft Specification only. No Skills
  implementation, approved Spec, runtime verification or Delivery acceptance is
  claimed. Preserve unrelated worktree changes.
- 2026-11-13: Completed static integration tracing and proposed `skills` selection
  fields, one `skill` Tool, Core parsing/loading rules, Runtime-owned serialized
  two-second rescans, catalog-only Settings polling, active-Turn binding and
  `full`/`minimal` Skills sections. Existing `none` remains empty. No production
  code changes or runtime/model/UI checks; SK-1 is ready for review.
- Documentation validation: both Change documents passed local link/anchor,
  whitespace and final-newline checks (25 local references). Tracked-worktree
  `git diff --check` also passed; no production test or build was needed.
- 2026-11-13: Owner discussion supersedes the background rescan proposal:
  discovery runs on demand for new Turns and Settings catalog reads. Do not add
  a last-scan timestamp or short-lived cache before an actual performance need
  appears. Settings-only polling preserves automatic visible updates.
- 2026-11-13: Owner confirmed the final simplifications: remove Agent Context
  budget coupling, resolve names afresh when loading, and return complete
  `SKILL.md` content with frontmatter without host semantics for extra fields.
  Expanded recursive discovery acceptance cases in the Spec and research draft.
  These confirmations do not accept the whole Plan/Spec or authorize Delivery.
- 2026-11-13: Static review reported no remaining blockers. Owner explicitly
  selected "接受 Plan／Spec，并授权开始实现". SK-1/SK-2 are complete and Delivery
  begins with SK-3. SK-4 wiring depends on SK-3's discovery/loading contracts.
- 2026-11-13: Implemented Core Skills discovery/loading, module-owned selection
  validation/defaults, one Built-in `skill` Tool, trusted active-Turn checks,
  configuration persistence/publication, Root/Child prompt catalogs and Settings
  default/named editors with catalog-only polling. No background scan or cache.
- Validation: 553 focused Unit cases passed across 30 files, including Runtime
  Root/Child selection updates and current-content loading, Settings drafts,
  conflicts, parsing, configuration and existing behavior. Three acquisition/
  WebSocket integration cases passed, including live catalog reads and persisted
  default Skills. Mocked execution is not real-model adherence evidence.
- Validation: root/workspace/Vue lint/type-checks and production build passed;
  Host build audit passed (398 files at the first build), Relay tests passed
  (121 cases), and 62 client assets verified. Final client copy changes passed
  24 component cases, lint and client rebuild; the later type-only separation
  passed 31 focused cases and Host rebuild.
- Fitness: the first FT-01 run identified unclassified new Skills paths. Split
  pure contracts from filesystem implementation and classified them using
  existing Application/Infrastructure boundaries, without adding exceptions.
  FT-01/12/14 then passed all six checks.
- Browser: used a disposable Home and real WebSocket Channel without Providers.
  Verified default selection save, unavailable-name retention, automatic new
  discovery without auto-selection or draft loss, named explicit-empty save,
  and 1280px/390px layouts (no horizontal overflow at 390px). DOM interaction
  was used because pointer actions on the shared background tab timed out.
  Disk reads confirmed both persisted selections. Temporary helper and Home
  are removed after validation.
- Updated owning configuration guide, configuration/prompt/Builtin architecture
  and Agent management contract. Source comments encountered in edited files
  are English; three mixed-language test titles were translated as well.
- Remaining: separately authorized real-model automatic/explicit/delegated
  adherence checks and Owner delivery acceptance. No model request, commit,
  merge, push or archive was performed. Vite reports a nonfatal >500 kB chunk
  warning; no unrelated bundle refactoring is included.
- 2026-11-13: Owner authorized necessary model-call costs using the working local
  configuration. Executed real-model validation with Built-in Provider,
  `gpt-5.6-sol-fast`, in disposable Homes with synthetic Skills and only `skill`
  and `task` registered. Reused the connection in memory; no project source or
  existing conversation history was sent, and the original config remained
  byte-for-byte unchanged. No production code changes were needed.
- Real-model results: automatic task matching loaded the Skill and returned its
  private instruction marker; explicit `/skill` preserved source/count arguments;
  a second Turn in the same Session loaded again and used a changed marker rather
  than historical instructions; delegation preserved name/arguments in normal
  `task.prompt`, and reviewer independently loaded the current Skill in its Child
  Session. All expected output lines matched exactly.
- Real-model unavailable behavior: the natural request explained that the Skill
  was not enabled, without substituting or delegating. The first harness run
  incorrectly required a loader call even in that case; this extra assertion was
  rejected as stricter than the accepted contract, not treated as a product defect.
  One additional bounded request explicitly asking to attempt loading called it
  once, received an error result and explained the denial without retries.
  Previously passing cases were not rerun.
- All six real-model scenarios passed their applicable checks. Both Runtime
  shutdowns completed with zero failures/residuals; disposable Homes were removed.
  SK-5 is now In Review. Only Owner delivery acceptance remains; no commit,
  merge, push or archive is authorized.
- 2026-11-13: Owner requested code review before acceptance. Confirmed and accepted
  two P2 defects: an invalid Skills root blocked all Settings loading, and Child
  preparation scanned before checking loader visibility. Owner instructed work
  to continue. Added three failing server/Runtime/UI regression cases before
  fixing production code; no unrelated changes were included.
- Corrections: failed Settings discovery now produces explicit
  `skillCatalogError: {code, message}` without hiding other sections or erasing
  saved selections. The catalog-only action retains a failed result and reports
  the specific diagnostic. Client displays the error in the Skills area and clears
  it on recovery. Child preparation invokes a deferred Runtime catalog read only
  after confirming `skill` is visible; no cache or scanner service was introduced.
- Revalidation: 191 focused Unit cases passed across eight files, including
  positive/negative loader visibility, visible-loader read-failure propagation,
  actual Runtime delegation with a denied loader and invalid root, Settings saves
  during catalog failure, and UI recovery with selections preserved. Root,
  workspace and Vue type-checks passed; all six FT-01/12/14 checks passed.
- Revalidation: all three real WebSocket integration cases passed, including
  catalog failure, partial Settings load and subsequent recovery. The initial
  integration run failed Channel startup while shared Host/client build outputs
  were being rebuilt concurrently; the run after both builds completed passed.
  Host build/audit passed (400 files); client build and all 62 asset checks passed.
  The existing nonfatal Vite chunk-size warning remains. No further paid model
  calls were made; earlier real-model evidence is unchanged. SK-3/4/5 remain
  In Review pending Owner acceptance; no commit/merge/push/archive is authorized.

- 2026-11-13: Owner manual testing identified missing Built-in Skill presentation.
  Added `skill load` / `skill loads` group counts and `Load Skill <name>` card
  titles, retaining unknown-Tool fallback and existing group-count overflow rules.
  Verified live and historical rendering; 95 focused presentation/component tests,
  WebSocket/Vue type-checks, client build and 62 asset checks passed. Approval
  policy is unchanged.

- 2026-11-13: Owner explicitly requested committing all changes and pushing to
  remote. This authorizes source-control publication, not delivery acceptance,
  merge or archive. Preserve the ignored manual-test Home outside commits.

- 2026-11-17: Owner accepted delivery with "通过" after reviewing the Change
  progress. SK-3 through SK-6 are complete. Clarified in the guide, Agent
  management contract and this Change's Spec that Skills selection focuses the
  advertised catalog to reduce model confusion; it is not a security deny-list
  or a filesystem restriction. An explicitly requested file-based workflow
  remains subject to ordinary Tool permissions and does not change selection.
  No production behavior changed. No additional commit/push, merge or archive
  is authorized by this acceptance.

- 2026-11-17: Owner separately authorized archive and clarified that every
  document under `docs/changes/`, active or archived, is non-authoritative and
  may be cleaned up at any time. Durable contracts remain in stable
  Specifications, accepted ADRs and Current Architecture, independently of
  this record's retention. No additional commit/push or merge is authorized.

Follow [Development Workflow](../../../governance/development-workflow.md).
