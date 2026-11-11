# Dynamic Settings Plan

> Status: Accepted
> Date: 2026-11-10
> Owner: Project owner
> Classification: Architecture Slice (configuration management, Channel actions and Runtime lifecycle)
> Authorization: Owner accepted the design, confirmed DS-0 completion, and authorized proceeding with implementation on 2026-11-10
> Closeout: Owner reported the first-round manual test passed, authorized baseline documentation/regressions, then directed completion and commit before Agent-management work on 2026-11-10.
> Specification: [Dynamic Settings Specification](specification.md)
> Discussion source: [Dynamic Settings design draft](../../../research/dynamic-settings-design-draft.md)

## 1. Outcome

Provide Settings while the local personal Agent service is running. Keep Agent
Home `config.json` as the only persistent configuration source. Built-in Provider
and default-model updates apply to new execution trees without interrupting old
ones; Extension parameters and enablement apply after manual restart.

One Change owns the Settings experience and its necessary Runtime support.
Do not split the lifecycle prerequisite into an unrelated feature or build a
general hot-reload framework.

## 2. Confirmed scope

- Runtime-owned SettingsManager exposes one generic Settings action capability.
  Channel owns transport, request correlation and input bounds, not domain parsing.
- Full load returns safe editable views, Schema, per-section revisions, current
  model directory and restart-required state. It does not test connections.
- LLM section saves Built-in connection, complete model list and default model.
  Each Extension independently saves its own parameters and enablement.
- Extension restart requirements reflect saved differences from startup configuration;
  saving back the original values clears that Extension's requirement.
- Model rows provide Test and Set default. Built-in tests can use draft settings;
  Extension tests use already-loaded instances. Test never saves configuration.
- Successful save returns confirmed safe values, revision and application status;
  normal save does not trigger full load.
- If an LLM file write succeeds but Runtime application fails before publication,
  restore only the pre-write target section before the next update. Return/log
  rollback failure explicitly without permanently blocking later updates.
- Remove the legacy global `extensions.enabled` switch and related logic.
  Preserve explicit per-Extension enablement, import-free discovery and diagnostics.
- Reuse existing Registry builder, generation pins and lifecycle ownership.
  Continuous dynamic updates must not wait for old execution trees to finish.
- Fix retired snapshot, stopped-instance owner and completed retirement-task
  strong-reference retention during implementation.
- Return request errors when possible; otherwise record them through existing
  logging without sensitive configuration or success-shaped fallbacks.

## 3. Non-goals

No automatic restart, post-publication configuration rollback, backup/history system,
external-file-change protection/recovery, generic patch/merge framework,
CompositeRegistrySnapshot type, Extension installation UI, temporary Extension
instances for testing, arbitrary Extension hot replacement, or user/role system.

Dynamic `maxSubagentDepth`, `steeringEnabled` and `maxLlmCallsPerTurn` are future
requirements, not first-version forms. Their execution-tree capture direction
must not be contradicted by this implementation.

## 4. Delivery plan

Keep delivery in three practical steps: configuration editing/capability,
Runtime application, and client wiring/validation. The rows below are checkpoints
inside those steps, not separate frameworks, Changes or new services.

| Item | Status | Work | Exit condition |
|---|---|---|---|
| DS-0 Design and readiness | Completed | Owner accepted Plan/Spec and confirmed readiness completion on 2026-11-10; focused baseline evidence and decisions recorded below | Met for readiness; production Delivery still requires separate authorization |
| DS-1 Runtime support | Completed | Targeted Built-in replacement, captured defaults, continuous publication and reference release implemented and validated | Old trees retain their version; later updates publish; shared instances remain live; shutdown reports protected resources |
| DS-2 Configuration and capability | Completed | Persistence, startup metadata, global-switch removal and SettingsManager load/update/model Test implemented and validated | Section saves/rollback preserve unrelated data and credentials; truthful results; bounded Tests protect resources through cleanup |
| DS-3 Channel and client | Completed | Generic Settings transport/editor and owner-tuned feedback/model interactions implemented; first-round manual testing passed | Bundled client use cases validated; transport-neutral capability remains reusable |
| DS-4 Validation and authority synchronization | Completed | Combined regression, integration, Fitness, browser and package evidence recorded; authority and user guidance synchronized | Owner directed closeout/commit before phase-two Agent management |

Dependencies: DS-1 and DS-2 follow DS-0; DS-3 needs their interfaces and behavior;
DS-4 validates their combined delivery. Do not run broad suites merely to increase
test counts, and do not mark an item completed without owner acceptance.

## 5. Readiness decisions

Owner design acceptance on 2026-11-10 covers the action shapes/section IDs,
credential intents and root-sensitive-field support boundary, explicit rejection
of the legacy global switch with manual per-entry guidance, and the
[Settings shutdown lifecycle](specification.md#32-settings-requests-during-shutdown).
Owner separately confirmed DS-0 completion on 2026-11-10 after reviewing the
readiness findings below, then authorized proceeding with implementation.

Owner refinement on 2026-11-10 adds bounded pre-publication file rollback and
explicit client/log errors when rollback fails; no permanent fault gate or
general recovery framework. Validate sequential updates and shutdown against this
refinement as part of the existing readiness work.

Readiness findings recorded on 2026-11-10:

1. The [minimum Runtime wiring](specification.md#41-minimum-runtime-wiring)
   and [section-write interface](specification.md#31-configuration-layer-save-interface)
   fit existing owners. Baseline tests confirm generation capture, candidate cleanup,
   instance protection and deadline mechanisms. Current single-retirement gating,
   same-ID reuse and retained references are known implementation changes, not
   capabilities these tests claim to establish.
2. Owner's later 2026-11-10 amendment supersedes the initial missing-document
   restriction: ordinary startup exclusively creates missing configuration as `{}`,
   then loads strictly. No-Provider startup is valid. Installed Extensions default
   enabled even without entries, so a healthy Channel can expose Settings.
3. Owner selected a fixed 30,000 ms model Test deadline on 2026-11-10. It starts at
   admitted preparation/resolution, is not user-configurable, and aborts upstream
   work without retry; shutdown can cancel earlier. Actual cleanup still follows
   resource protection and the shared shutdown budget.
4. Amend [ADR-014](../../../decisions/adr-014-extension-packages-and-runtime-composition.md)
   for global-switch removal and the owner-confirmed default-load rule.
   ADR-016's optional Built-in remains unchanged. The later startup amendment
   removes the terminal wizard, its obsolete decision/design documents and its
   exclusive dependencies.
   Continuous retirement changes stable Runtime contracts during Delivery, but
   preserve ADR-014's immutable publication and lifecycle ownership decisions.

### Focused baseline evidence

On 2026-11-10, the existing unit runner under cached Node 22 completed **8 files /
212 tests, all passed**, selecting only:

| Test files | Existing evidence |
|---|---|
| [Composition coordinator](../../../../src/runtime/composition/composition-coordinator.test.ts), [composition manager](../../../../src/runtime/composition/runtime-composition-manager.test.ts), [reload coordinator](../../../../src/runtime/composition/reload-coordinator.test.ts) | Capture/publication ordering, unchanged-instance reuse, candidate failure cleanup and shutdown admission; also confirms the current single-retirement behavior that Delivery must change |
| [Lifecycle ledger](../../../../src/runtime/composition/runtime-lifecycle.test.ts), [deadline budget](../../../../src/runtime/runtime-deadline.test.ts) | Shared-generation protection, stop outcomes and bounded shutdown waiting |
| [Runtime Builder](../../../../src/runtime/composition/runtime-builder.test.ts), [configuration loader](../../../../src/platform/config/agent-config-loader.test.ts) | Empty Provider startup, required-candidate cleanup, missing-document rejection and single raw-document read |
| [Protocol clients](../../../../src/builtins/providers/builtin/protocol-clients.test.ts) | Mocked invocation, signal/error behavior and no need for a live paid model call |

Static inspection also confirmed the configuration writer's same-directory
temporary-file/replace mechanism and the invocation port's AbortSignal. No separate
Spike is currently required to choose another architecture; known code changes and
their acceptance tests are bounded by this Specification. If implementation evidence
disproves those assumptions, pause the affected work rather than adding a second path.

These are foundation checks, not Settings delivery acceptance. SettingsManager,
rollback, concurrent load, the 30-second Test deadline, continuous retirement and
reference-release acceptance scenarios still require new implementation tests.
No production code was changed during DS-0. Owner confirmed DS-0 completion on
2026-11-10 after these findings; subsequent implementation authorization and
DS-1 evidence are recorded below.

### DS-1 implementation evidence (2026-11-10)

- Added the internal materialized LLM application seam, initial Built-in addition,
  same-ID replacement/removal and default-only instance reuse. Published Snapshot
  defaults are used by Root resolution and the model catalog; Child inheritance
  remains unchanged.
- Removed single-retirement publication admission. Published generations retire
  independently; retirement failure logs/retains residuals instead of blocking
  later publication. Candidate cleanup blockers remain intact.
- Settings retirement does not force-abort old trees. Shutdown includes outstanding
  retirement tasks and protects still-pinned instances under its existing budget.
- Removed unused historical Snapshot retention; successful/late-success stop drops
  owner references; completed retirement tracking and shutdown listeners are released.
- Validation: **12 files / 223 tests passed** with the existing unit runner under
  Node 22; **TypeScript `--noEmit` passed**. Scope: composition/reload, lifecycle,
  registry, Unit catalog/Built-in Unit, deadline, Runtime Builder, RuntimeApp intake/
  orchestration and Child orchestration.
- New regressions directly exercise two later publications while an old tree is
  pinned, old/new Root default resolution, no ordinary Settings retirement timeout,
  default-only reuse, retry after preparation failure, Built-in removal, multiple
  protected retirements at shutdown, 25 settled LLM updates and 50 owner/generation
  cycles with internal retention checks rather than GC thresholds.

DS-1 is In Review, not owner-completed. SettingsManager, file write/rollback,
Settings capability, model Test, Extension settings/discovery changes and UI are
not implemented by DS-1; their acceptance scenarios remain outstanding.

DS-2 configuration foundation evidence:

- Startup retains a frozen, server-only raw editing document alongside the existing
  consumer projections. Raw credentials must not cross Channel boundaries.
- Platform section editing reads the current file, preserves unrelated sections,
  keeps raw credential references, and returns the committed document and target
  preimage without a post-write reread. LLM restoration preserves original absence
  and reads the current file to retain unrelated changes.
- Retained model IDs preserve omitted limits/reasoning; removed model rows stay
  removed. Extension edits reject read-only/unsupported fields while preserving
  their existing values, and validate even disabled entries.
- Save-time validation checks reference syntax without environment resolution;
  literal credentials still satisfy declared constraints. Existing startup
  materialization and strict Schema behavior remain unchanged.
- Section writes use the Platform-owned exclusive temporary-file and rename
  primitive extracted from the former initializer. Publication failures clean
  temporary files and surface cleanup failures explicitly. The later owner
  amendment removes the initializer but preserves this shared primitive.
- Validation: **6 files / 159 unit tests passed**, **2 files / 3 boundary Fitness
  tests passed**, **TypeScript `--noEmit` and whitespace checks passed**.

These primitives alone were not an end-to-end Settings delivery. The subsequent
SettingsManager increment below adds Runtime coordination and load/update capability.
Model Test and client wiring were still pending at that foundation checkpoint;
subsequent server implementation evidence is recorded below.

DS-2 Extension metadata and enablement cutover evidence:

- Acquisition returns its original frozen discovery result alongside uncreated
  Units and diagnostics. Runtime Bootstrap retains discovery and diagnostics as
  separate startup metadata, without a second Unit list or scan/import path.
- Discovery retains import-free Descriptor/Schema metadata. Duplicate diagnostics
  remain intact. The later owner amendment supersedes unconfigured-entry
  nonexecution: absent entries default enabled, while explicit false skips import.
- Removed global `extensions.enabled` from raw/projection types, acquisition and
  Initialize/Edit behavior. Load, section save and direct acquisition reject the
  legacy field with per-entry/removal guidance. No automatic migration or silent
  global-false-to-enabled transition is performed.
- Initializer tests cover selected-entry enablement, discarding changes without
  enabling the original entry, and rejecting legacy configuration without prompts
  or file changes. Runtime tests verify startup metadata identity/retention and a
  single acquisition call.
- Validation: **7 files / 282 focused unit tests passed** (including a rerun of the
  corrected Host one-read fixture), **1 file / 2 integration tests passed**,
  **2 files / 3 boundary Fitness tests passed**, and **TypeScript `--noEmit` and
  whitespace checks passed**. No live paid Model invocation was performed.

DS-2 SettingsManager and server capability evidence:

- Runtime owns one SettingsManager and supplies the same frozen Settings capability
  to Channels and embedding. Startup without a raw editing document remains valid
  and returns explicit unavailable results; it does not implicitly read a file.
- Safe load exposes sections, current model Catalog and combined startup
  diagnostics, including failures without editable Descriptors. Credential values
  and unsupported/read-only values are not exposed; fields explicitly identify
  supported forms. Section revisions are opaque and stable until commit/restore.
- Updates serialize revision checking, file preparation, commit, Runtime
  application and bounded rollback. Loads wait through application and restoration,
  rather than exposing intermediate candidates. A pre-commit callback checks
  closing and default-model facts without introducing Extension dependency locks.
- Known pre-publication LLM failures restore the request's raw target preimage and
  produce a fresh revision. Published outcomes and uncertain thrown publication
  errors never authorize rollback. Rollback failure reports/logs both failures and
  unknown file state without permanently blocking subsequent updates.
- Extension saves retain raw secrets and remain restart-only. A→B→A clears only
  the affected Extension's flag against its startup baseline.
- Shutdown closes admission synchronously, cancels queued/preparing work and
  converges admitted commits within the shared budget before Unit stop. It does
  not start Runtime application after closing or claim uncancelled I/O stopped.
  Settled configuration divergence is a resource failure, not a deadline residual.
- **12 new cases**: 11 SettingsManager cases and one real Runtime-composition case.
  Coverage includes load during paused application/rollback, later updates after
  failed rollback, restart reversal, shared capability identity and shutdown.
  No live Model request was made.
- Focused verification across this increment: **55 unit cases passed** (including
  the 12 new cases and 24 existing Schema/metadata cases), **3 boundary Fitness
  tests passed**, and root plus WebSocket backend TypeScript checks passed.

DS-2 model Test evidence:

- `test_llm_model` remains an action on the existing Settings capability. No
  separate interface, generic section-testing framework or directory refactor.
- Built-in candidates reuse the in-memory section editor, credential intents,
  captured startup environment, Built-in Unit factory and registration staging.
  Keeping a saved credential checks the LLM revision. Replacement/clear do not
  reuse it. Test does not save, change revisions or publish a Registry generation.
- Loaded model Tests use the current Snapshot, not saved Extension parameters.
  A generation pin remains held through actual invocation completion, including
  later publication and noncooperative calls after timeout.
- A fixed **30,000 ms total deadline** starts before preparation. Deterministic
  tests assert pending state at **29,999 ms**, timeout/abort at **30,000 ms**,
  preparation consuming that same deadline, no invocation after cancellation,
  and temporary resource retention until actual cleanup.
- Shutdown aborts Tests immediately, closes admission and waits within the shared
  budget. Cooperative calls release pins before convergence; noncooperative work
  reports a residual without releasing protection. Temporary cleanup failure is
  explicit to the caller/logs and shutdown, without blocking later updates.
- Invocation reuses the model port without Runner, Session or Transcript.
  Results omit credentials, environment-reference names, model response bodies
  and raw upstream errors. The existing real Runtime-composition test now also
  verifies Test wiring through a fake protocol client without file/catalog changes.
- **9 new cases**, plus extension of that existing Runtime case.
  **39 focused unit cases passed**, **3 boundary Fitness tests passed**, and root
  plus WebSocket backend TypeScript checks passed. No live paid Model invocation.

DS-3 WebSocket and client evidence:

- The existing acknowledged socket forwards generic `settings_action` requests
  and unicasts `settings_action_result`. It keeps domain input unknown and applies
  existing frame bounds, with safe correlated unavailable/unexpected errors.
  No new Agent event, file access or SettingsManager import in production Channel.
- Navigation opens a two-pane native dialog with LLM/Extensions categories on the
  left and list/detail views on the right; narrow screens use a top selector.
  Independent LLM/Extension drafts survive section switching, with unsaved,
  restart-required and unconfirmed markers and a section-local save bar.
  Supported scalar fields, read-only/unsupported metadata and explicit credential
  intents are wired. Submitted credentials clear only in the submitted section;
  other drafts remain intact. Closing/disconnecting clears replacement buffers.
- Built-in model add/edit/delete, protocol/endpoint and advanced limits/reasoning
  editing are available. Model/default actions keep selection local until LLM
  save. Loaded Extension models use current instances; Test explains source,
  possible billing and the fixed total deadline.
- Save/rollback results replace only the confirmed target and revision, without
  an automatic full load. Failed rollback retains an explicitly unconfirmed
  draft/latest token for a later explicit update. Saved-but-unconfirmed Runtime
  application remains visible. Restart flags use confirmed sections and survive
  editor closure; reverting one does not erase another.
- The client correlates action and ID, bounds missing-response waiting at 60 s,
  clears pending requests on disconnect and never replays saves. Reconnected,
  unconfirmed editors require explicit reload. This is not server cancellation
  or a change to the model Test deadline.
- **7 new unit cases** cover transport, client correlation/model round-trip and
  a real socket → SettingsManager → file save/rollback/Test path using a fake
  model port. UI journeys against local fake data additionally verified section
  isolation, exact environment intent, restart reversal, local default selection,
  draft/loaded Test source, restored values/fresh revision without full reload,
  disconnect/no-replay recovery, Escape handling and Provider-free first setup.
- Browser validation used fake results, not live model connectivity. No paid
  model invocation, production Agent Home or directory refactor.
- Final focused verification passed **19 unit cases**: 11 Settings/catalog/client
  cases (including the **7 new cases**) and 8 existing client composition/history
  regressions. Root TypeScript, WebSocket backend TypeScript and Vue client
  type-checks passed. A missing `previousGeneration` in the new fake publication
  result was corrected before the final checks.
- All **3 boundary/layout Fitness checks** passed. The initial concurrent run
  hit the runner's 5 s timeout; the rerun used a 15 s runner allowance without
  changing assertions or production deadlines.
- The actual workspace client production build passed, with a nonblocking
  greater-than-500 kB chunk warning; all **62 built assets** passed verification.
  The local browser preview was stopped after validation.
- The section-navigation refinement passed Vue type-check, workspace build and
  asset verification. Browser checks against fake results verified single-section
  rendering, draft/credential isolation across navigation and saves, close-time
  credential clearing, restart reversal and a 390 px mobile layout without
  horizontal overflow. Disconnected saves remain disabled. No new unit cases or
  live model calls were added for this layout-only refinement.
- The grouped-navigation refinement adds Provider configuration-section links to
  Settings responses only, using the current composition's actual registrations.
  Shared Model Catalog and save contracts remain unchanged. LLM lists Providers;
  Every Provider opens details under LLM, with a separate link from Extension
  Provider details to the owning Extension's shared configuration draft.
  Extensions lists discovered entries, including disabled ones, and its details
  contain configuration only, not loaded models.
  Model actions use compact aligned rows, and buttons/navigation reuse main-client
  styles. Credential fields retain the fixed-mask/password-eye interaction;
  no saved secret values are returned.
- This refinement added **2 unit cases** (Settings ownership projection and client
  link parsing), and extended existing composition/Runtime cases. **58 focused
  unit cases** and **3 boundary/layout Fitness checks** passed, along with root,
  backend and Vue types, the workspace client build and all 62 assets. The build
  retains its nonblocking greater-than-500 kB chunk warning.
- Local browser checks with fake results verified the two-category navigation,
  distinct Provider/Extension IDs, multiple Providers sharing one Extension draft,
  independent credentials and saves, draft/loaded Tests, local default selection,
  rollback/fresh-revision retry without reload, independent restart reversal,
  explicit reconnect reload, Escape and 390 px layout. Botanical and Classic
  themes use the shared controls; compact model rows keep actions aligned.
  These checks do not establish live model connectivity.
- Owner clarified the Provider-detail boundary: list actions are Details;
  Provider model lists/Test/default actions remain under LLM, while Configure
  Extension alone crosses to the Extension form. The correction passed the
  **5 existing client unit cases**, Vue type-check, workspace build and all
  62 asset checks, without new unit cases or backend changes. Browser checks
  verified no model controls in Extension forms, LLM selection in Provider details,
  separate ownership navigation, shared drafts, unmapped Provider viewing/Test,
  default save, Built-in draft retention, mobile navigation/no overflow and an
  explicit message when a reloaded catalog no longer contains the open Provider.

Owner-authorized empty-Home and wizard-retirement increment (2026-11-10):

- Missing configuration now invokes Platform's exclusive `{}\n` bootstrap before
  strict loading. Existing malformed files remain fatal and existing bytes are
  preserved. Core still owns Root Context initialization.
- Removed `--initialize`, all Standalone wizard code/tests and the wizard-only
  `@clack/prompts` dependency with its unused transitive dependencies.
- Every discovered Extension defaults enabled, even without an entry; Schema
  defaults apply. Explicit disablement still prevents import. Candidate-local and
  optional Runtime failures remain diagnosed and isolated. Settings enabled state
  and restart comparison share the same default.
- Added regression coverage for existing/absent empty Homes, unconfigured
  acquisition, equivalent explicit/default Extension settings and restart reversal,
  plus a real Standalone/Runtime/WebSocket first-Settings-save integration case
  alongside a failed neighbor. Existing acquisition expectations were updated;
  obsolete wizard-only cases were removed.
- Focused validation totals (not newly added case counts): **301 unit cases**
  across 9 startup/configuration/Runtime files and the existing 5 package-helper
  cases; **3 integration cases**; **3 boundary/layout Fitness checks**.
  Root and Host TypeScript checks and whitespace checks passed.
- Full installed-tarball verification passed for **443 package files**, including
  default/explicit fresh Homes, automatic official Extension acquisition,
  WebSocket Settings load, client serving, strict legacy-namespace rejection, and
  unchanged installation/startup-CWD trees. The first-save integration verifies
  persisted configuration and the live Built-in catalog without model invocation.
  Prepack production build and audits passed; bounded helpers were cleaned up.
  No paid Model call, production Agent Home change, commit or push.
- Current configuration/Host/acquisition documentation is synchronized.
  ADR-014 records the default-load rule. The obsolete wizard decision, archived
  Plan/Specification and their index links are removed at the owner's request.
  Normal missing-only configuration bootstrap and default Context file preparation
  remain in place; neither is part of the removed wizard.

First-round UI baseline and regression closeout (2026-11-10):

- Owner reported no issues in the first round of manual testing, then explicitly
  authorized synchronizing documentation and adding regressions against the
  tuned UI. This is not combined/final Change acceptance.
- Current baseline: no Built-in configure checkbox; compact inline model editors;
  draft Default badges for all Providers; right-aligned model actions; one
  latest-operation footer aligned with content, with Save on the right and
  theme-aware success/error/pending colors.
- Added **10 component regression cases** in
  [SettingsPanel.test.ts](../../../../extensions/websocket-channel/client/src/components/SettingsPanel.test.ts).
  They mount the actual Vue component and exercise absence/first configuration,
  retaining URL/credential when deleting models, collapsed drafts/advanced fields,
  new-model editing, cross-Provider default selection, local validation, load/save/
  Test failure-retry-success, newer disconnect feedback and footer DOM ownership.
- Vitest uses the existing Vue plugin explicitly at the root and a test-only
  `happy-dom` environment for this component file. Other suites retain their Node
  environment; neither addition is a production runtime dependency.
- **110 focused unit cases passed across 4 files**, including the **10 new cases**,
  existing client helpers, WebSocket transport and Runtime SettingsManager.
  Root, WebSocket backend and Vue client/test type-checks passed. Production client
  build and all **62 asset checks** passed, retaining the known nonblocking chunk
  warning. No paid Model call or production Agent Home modification.
- During UI tuning, actual browser checks established desktop/390 px feedback
  alignment, right-aligned Save/actions, semantic colors, compact rows, visible
  feedback after scrolling and long-message containment. DOM regressions do not
  replace these geometry checks or establish live model connectivity.
- User guide and active Specification now describe the tuned behavior and its
  acceptance scenarios. Final combined validation/owner completion remains pending.

Final closeout (2026-11-10):

- Owner directed completion and commit of this Change before starting Agent
  management. This supersedes earlier pending-completion statements in the
  chronological delivery evidence above.
- Combined selected regression passed **50 files / 897 cases** covering Runtime,
  configuration, acquisition, standalone Host, CLI and bundled WebSocket/client.
  These are total cases run, not newly added cases.
- Dedicated acquisition-to-Runtime integration passed **3 cases**, including
  fresh Home, isolated bad neighbor, live WebSocket Settings and first model save.
  The selected boundary/layout Fitness checks passed **3 cases**.
- Final root and WebSocket backend/client type-checks passed. Installed-package
  verification passed with **443 packaged files**, covering empty Home startup,
  automatic Extension acquisition, live WebSocket Settings, client serving,
  legacy Host rejection and the installed command. Initial reruns encountered
  an occupied default port; verification passed after the owner stopped the
  existing service. Package-verifier helper tests passed **5 cases**.
- Prior component/browser/build evidence above remains applicable; no live paid
  inference is implied. Separate Session deletion consistency changes are
  intentionally excluded from this Change's commit.
- Agent discovery/templates/MD metadata and Settings Agent management remain
  phase-two design work, with no production implementation in this Change.

DS-0 through DS-4 are complete and this Change is archived.
Extension dynamic loading/reconfiguration and automatic recovery remain excluded.

The [development workflow](../../../governance/development-workflow.md) controls
readiness. Keep architectural amendments within the assessment above. Run a bounded
lifecycle Spike only for critical unknowns not resolved by static analysis or focused tests.
Design acceptance does not supersede current production authority before delivery
and its directly affected authority synchronization.

## 6. Validation and completion

Use the [Specification acceptance scenarios](specification.md#7-acceptance-scenarios)
as the behavioral oracle, not HTML presence or passed-test counts alone.
Preserve unrelated worktree changes. No live paid model invocation is performed
without authorization; mock invocation tests do not establish live connectivity.

Record implementation evidence when work runs, not in advance. Owner design
acceptance, delivery authorization and final delivery acceptance remain separate.
