# Settings Section View Extraction

> Status: Accepted
> Date: 2026-11-11
> Owner: Project owner
> Classification: Architecture Slice
> Design: [Draft Specification](specification.md)
> Existing decision: [ADR-024](../../../decisions/adr-024-settings-contract-and-model-test-ownership.md)

## Outcome and evidence

Evaluate and, only after design acceptance, extract the existing LLM/Extension
safe view construction into stateless functions in the private Runtime Settings
module. The measurable benefit must be direct, file-free testing of credential
redaction and Extension restart comparison, not merely a smaller manager file.

Current evidence:

- [`SettingsManager.section()`](../../../../src/runtime/settings/settings-manager.ts)
  contains Agent decoration followed by LLM and Extension projections.
  `credentialMetadata`, `comparisonEntry`, and `isScalar` are used for these
  projections; none owns asynchronous work or resources.
- [`settings-manager.test.ts`](../../../../src/runtime/settings/settings-manager.test.ts)
  already tests safe views, stable revisions, Extension enablement defaults,
  restart reversal, and transaction/application behavior, but its shared
  fixture creates a temporary Home and writes a config file even for view tests.
- AgentPolicyState already owns Agent section content. SettingsManager owns
  current document, baseline, revisions, descriptors, and application status.
  These ownership facts must not move or be copied into a new stateful owner.

No behavior defect is asserted. Keeping the current code is acceptable if the
extraction requires broad dependencies or fails to create independent test value.

## Scope and non-goals

In scope:

- One private `src/runtime/settings/section-views.ts`, with direct colocated tests.
- Stateless LLM and Extension projection functions and their credential/restart
  helpers, consuming explicit facts supplied by SettingsManager.
- Thin delegation from the existing non-Agent branches of `section()`, private
  module entry exports, and directly affected documentation.
- Reuse Platform Configuration validation and Extension schema-field helpers.

Out of scope:

- Agent projection, policy publication, Model Catalog construction/linking,
  capability contracts, public exports, wire shapes, or client changes.
- Save/apply/rollback, serialization, revision allocation, load timing,
  Model Tests, Shutdown, credential materialization, and filesystem changes.
- A new view owner/cache, section registry/provider framework, configuration,
  dependency, directory reorganization, or further Memory/Runtime extraction.
- Editing the owner's pre-existing research changes.

## Design and artifact rationale

This is a private module-boundary change, so use a Plan and accepted change-local
Specification before Delivery. No new ADR is proposed: the functions do not
become an authoritative source of configuration or policy, alter dependency
direction, change public boundaries, or supersede ADR-024. Runtime SettingsManager
still owns safe views and the underlying facts; these are implementation helpers.
If implementation disproves that boundary, pause and revisit artifact/approval
requirements rather than silently extending this Change.

No Spike is currently justified: no SDK, concurrency, or resource-lifecycle
behavior changes, and pure projection behavior can be verified directly.

## Work items and gates

| Item | Status | Exit criterion |
|---|---|---|
| SSV-1: Accept bounded design | Completed | Owner accepted Plan/Specification and authorized Delivery on 2026-11-11 |
| SSV-2: Extract and test projections | Completed | Stateless functions connected; 29 direct tests pass without files or Runtime |
| SSV-3: Verify integration and review | Completed | 68 scoped unit tests, 3 integration cases, 6 Fitness checks, lint/build passed; direct review found no blocker; owner accepted validation |
| SSV-4: Accept and close | Completed | Owner accepted delivery/validation and authorized archive on 2026-11-11, explicitly without commit, push or merge |

SSV-2 depends on SSV-1; SSV-3 depends on SSV-2; SSV-4 depends on SSV-3.

## Validation and cancellation gate

The [Specification](specification.md#acceptance-and-validation) defines the direct
test matrix and regression scope. Proposal preparation ran no behavioral tests;
prior Settings/Scheduler checks were not used as extraction evidence. Actual
delivery results are recorded below.
Preparation required local-link and whitespace checks only.

Cancel or reduce the extraction if independent tests require a manager, file
fixture, Runtime snapshot lifecycle, or generic context/callback facade; if the
manager must duplicate view state; or if the result is only forwarding code
without directly testable credential/restart rules.

## Delivery results

The implementation adds two stateless projection functions and their direct
tests, exported only through the existing private Settings entry. The manager
delegates its LLM/Extension branches and no longer defines the credential,
scalar-filtering, or restart-comparison helpers. All original transaction,
Agent-decoration and Model Catalog branches remain in place.

All commands below used process-local Node.js 22.22.2 through
`fnm exec --using=22.22.2 --`; no shared environment or dependencies changed.

| Check | Result |
|---|---|
| Immediate section-view tests | Initial run: 28 passed, 1 fixture expectation failed; corrected fixture, then 29 passed |
| Final section views, SettingsManager, ModelTestRunner and AgentPolicyState | 4 files, 68 tests passed |
| Acquisition-to-Runtime integration | 3 passed, including real local WebSocket Settings load/save |
| FT-01/12/13 | 3 files, 6 checks passed without new exceptions or rules |
| Root/workspace lint | Passed |
| Production build | Passed; 62 Client assets and 390 Host files verified; 121 Relay tests passed |
| Final documentation | 4 documents and 155 local links/anchors plus whitespace passed; FT-12 passed again |

The initial test constructed a custom-prototype config object but expected its
own scalars to pass the existing plain-object guard. The test was corrected to
exercise ordinary scalar filtering and non-plain rejection separately; production
guard behavior was not changed. The invalid LLM credential test also checks the
exact `llm.builtin.apiKey` error attribution, rather than passing on an unrelated
validation failure.

Direct tests establish independent value: they exercise unset/blank/literal/
environment/invalid credential metadata, complete-output redaction sentinels,
omission/status rules, editable/read-only/nested/nonfinite filtering, descriptor/
diagnostic projection, default-normalized and invalid restart comparisons,
credential changes, reversal, and nonmutation without a temporary Home,
SettingsManager, Provider, or Runtime lifecycle.

The existing Client chunk-size warning remains and is outside this Change.
Validation uses controlled Providers/fixtures, not live-model E2E or manual
browser acceptance. No UI or external Settings contract changed.

## Direct review

Direct review of the manager diff and projection call sites found no blocker:

- Raw document, baseline, descriptors, revision generation, and application
  status remain solely in SettingsManager. The new functions retain no state.
- The new logic preserves the prior projection expressions, schema/credential
  helpers, error propagation, diagnostic order, response shapes and omissions.
- AgentPolicyState, Model Catalog, save/apply/rollback, serialization, shutdown,
  and Model Test resource ownership are unchanged.
- Real callers delegate through the private module entry; superseded helper
  definitions are removed, with no public export or compatibility path.
- No new dependency, Fitness exception, registry, Provider abstraction, or
  unrelated production edit was introduced.

This is direct review, not independent-agent review.

## Authorization

The owner initially authorized proposal preparation only, then explicitly
accepted the Plan/Specification and authorized implementation and validation
on 2026-11-11. The branch `refactor/settings-section-views` starts at `6715938`
on the integrated `refactor/runtime-boundaries` base. That approval did not
authorize commit, push, or merge.

The owner subsequently accepted delivery and validation results and authorized
archive on 2026-11-11, explicitly without commit, push or merge. All work items
are Completed; the Specification is Validated. This archive preserves delivery
provenance, not current authority. The Runtime architecture topic records the
verified implementation; ADR-024 and stable behavioral contracts remain
unchanged.

The owner subsequently authorized one local commit of this accepted Change
and a fast-forward merge into `refactor/runtime-boundaries` on 2026-11-11.
The commit excludes the pre-existing research document changes. Push,
integration into `main`, and another refactor remain outside this authorization.

Process authority: [Development Workflow](../../../governance/development-workflow.md).
