# Settings Boundary Extraction Plan

> Status: Accepted
> Date: 2026-11-11
> Owner: Project owner
> Classification: Architecture Slice
> Authorization: Owner accepted the Plan, ADR and Specification and authorized bounded implementation on 2026-11-11; scoped commit subsequently authorized, excluding pre-existing research edits
> Delivery status: Completed, validated and owner-accepted on 2026-11-11; archive and subsequent scoped commit authorized
> Specification: [Settings Boundary Extraction Specification](specification.md)
> Decision: [ADR-024](../../../decisions/adr-024-settings-contract-and-model-test-ownership.md)

## 1. Outcome

Make model Test execution independently testable and give the transport-neutral
Settings capability its own contract boundary. Preserve existing Settings behavior,
public Extension exports and Runtime lifecycle guarantees.

This proposal is not an authorization to implement the research recommendations
as a package. Its only production objectives are the two extractions below.

## 2. Scope

- Extract model Test execution, active Test tracking and temporary resource cleanup
  from SettingsManager into a Runtime-owned module.
- Move SettingsCapability, SettingsActionRequest and SettingsActionResult to one
  Settings contract module; migrate actual consumers and retain the public
  `my-agent/extension-api` names and entry point.
- Update directly affected tests, dependency classifications, public-entry checks
  and owning Current Architecture documentation when implementation is delivered.

## 3. Non-goals

No Session scheduler, Memory/Session/Media restructuring, Runtime-wide directory
migration, Model Catalog contract migration, Settings UI change, wire protocol
change, new configuration, dependency or package. LLM/Extension view extraction
is deferred rather than an optional implementation task.

Do not redesign AgentPolicyState, update transactions, rollback, Provider
publication, credentials or deadline policy. Do not introduce a generic section
provider, testing framework, service locator or parallel production path.

Existing FT-01 classification failures and research-document status corrections
are separate work, not bundled cleanup or authorized prerequisites.

## 4. Delivery plan

| Item | Status | Work | Exit condition |
|---|---|---|---|
| SBE-0 Design | Completed | Review this Plan, ADR and Specification | Owner accepted all three and authorized bounded Delivery on 2026-11-11 |
| SBE-1 Model Test | Completed | Extract the Test lifecycle and wire SettingsManager to it | Independent Test-module and Settings integration checks pass; owner accepted delivery on 2026-11-11 |
| SBE-2 Contracts | Completed | Establish one Settings contract owner and migrate consumers | Consumers migrated and public Extension exports type-check/build; owner accepted delivery on 2026-11-11 |
| SBE-3 Validation and documentation | Completed | Run affected checks and synchronize owning documentation | Scoped behavior, integration, lint/build and FT-01/12/13 pass after the separately authorized classification correction; owner accepted validation and authorized archive on 2026-11-11 |

SBE-1 and SBE-2 each require SBE-0 acceptance; neither extraction requires the
other. Validate the first substantive change before extending its scope.

Existing accepted contracts remain the behavior authority. ADR-024 covers
the Settings contract ownership and dependency-direction change. The Specification defines the structural
boundaries within those constraints. No generic Settings abstraction is required.

## 5. Validation and baseline

Use the Specification's acceptance matrix and existing tooling. Do not invoke
live or paid Providers for this structural refactor.

Pre-change observations from 2026-11-11, not evidence that this proposal is delivered:

- The selected SettingsManager, AgentPolicyState, RuntimeApp intake and RuntimeApp
  unit files passed: 130 tests.
- FT-13 public-entry checks passed.
- FT-01 failed because `src/core/agent-context/agent-definitions.ts` and
  `src/runtime/agent-policy-state.ts` are unclassified. The assertion stopped there;
  this does not establish that later assertions pass.

Rerun applicable checks against the implementation state. Do not broaden an
allowlist, misclassify files or claim a passing architecture Gate to hide this
baseline. If it blocks a required Gate, record the blocker and obtain a separately
confirmed correction scope.

## 6. Completion

Record actual commands, results and remaining risks here during Delivery.
Update Current Architecture only after boundaries are implemented and verified;
amend stable Specifications only where their authoritative contracts actually
change. Seek owner delivery acceptance before archive. No commit is authorized
by preparation of this proposal.

## 7. Design review (2026-11-11)

Direct source and contract review identified and addressed two proposal gaps:

- The type-ownership migration meets the workflow's ADR criteria. Added one
  bounded Proposed ADR rather than leaving this as an implementation-time decision.
- Shared Settings error helpers and combined shutdown convergence need explicit
  boundaries. The Specification now prevents Test-to-manager dependencies,
  duplicated sanitization and sequential shutdown waits.

The caller audit found Settings imports in Runtime Builder, Runtime composition,
SettingsManager, the Extension facade and related tests. WebSocket callers consume
the public facade or the composed capability and must keep doing so. No public
import migration or wire change is needed.

This was a direct design review, not independent review. The owner subsequently
accepted the Plan, ADR and Specification and authorized bounded Delivery on
2026-11-11. Delivery acceptance remains pending.

## 8. Delivery evidence (2026-11-11)

Implemented ModelTestRunner with one active-Test/resource owner and shared private
validation/error helpers. SettingsManager retains update transactions and starts
Test/update shutdown convergence against the same budget. Lifecycle-only tests
moved to the independent module; manager tests retain dispatch, persistence,
publication and shutdown integration, including simultaneous update/Test residuals.

The three Settings contracts now have one definition in Core Settings. Runtime,
Channel and Extension facade consumers migrated; public Extension exports and
WebSocket envelopes are unchanged. FT-13 now protects the new public module entries,
forbids Settings contracts depending on Channel/Runtime implementation, and forbids
the Test implementation depending back on SettingsManager.

| Command/check | Result |
|---|---|
| Initial post-extraction SettingsManager unit file | 23 passed before lifecycle test migration |
| Model Test, SettingsManager and AgentPolicyState unit files | 39 passed after lifecycle test migration |
| Those three files plus RuntimeApp and Runtime Builder | 128 passed |
| WebSocketChannel unit file, `-t "Settings protocol"` | 4 passed; 69 unrelated tests skipped by selector |
| Acquisition-to-Runtime integration file | 3 passed |
| `npm run lint` | Passed root, Relay, WebSocket backend and Vue client type-checks |
| `npm run build` | Passed; 62 Client assets verified, Host audit 386 files, 121 Relay tests passed |
| FT-12 and FT-13 | Passed under Node.js 22.22.2; the first Node.js 20 concurrent FT-13 run exceeded the existing 5-second timeout under Runtime test load, then passed in isolation; no timeout or retry policy was changed |
| FT-01, before separate correction | Failed on the same two pre-existing unclassified files listed in the baseline; subsequently resolved under the separate authorization below |

Initial validation used the environment's default Node.js 20.16.0; its Vite
minimum-version warning prompted a supported-runtime check. An already-installed
Node.js 22.22.2 was found through fnm. The 128 selected unit tests, 4 wire cases,
3 integration cases, lint, build and the three selected Fitness files were rerun
with `fnm exec --using=22.22.2 -- npm.cmd ...`, without changing the shared default
runtime or installing anything. All passed except the same pre-existing FT-01
classification assertion. The supported-runtime build verified 62 Client assets,
386 Host files and 121 Relay tests; only the existing large-chunk warning remains.

Current Architecture has been synchronized for the verified structural changes.
Existing behavioral Specifications remain unchanged. Final documentation checks
passed for 8 documents and 216 local links/anchors, plus whitespace checks for
the 6 new source files and `git diff --check`.

At this stage FT-01 remained open; the separately authorized correction below
subsequently cleared that Gate. No owner delivery acceptance, archive, commit,
full Unit suite, live Provider call or manual browser acceptance is claimed.

## 9. Separately authorized FT-01 correction (2026-11-11)

After implementation, the owner explicitly authorized correcting only the two
pre-existing unclassified files, checking their dependencies and adding relevant
validation. This is a separate bounded Fitness defect correction, not an expansion
of the Settings extraction's production scope.

- Classify `src/core/agent-context/agent-definitions.ts` as Infrastructure: it
  performs filesystem discovery/reads and YAML parsing to produce startup snapshots.
- Classify `src/runtime/agent-policy-state.ts` as Composition: it assembles applied
  profiles and policies from Platform configuration and Core contracts.
- Add a regression that rejects Application imports of these concrete
  Infrastructure/Composition files. Neither file is classified as Mixed.
- Change no business logic, dependency direction, Mixed inventory or violation
  allowlist. No new ADR, compatibility path or production abstraction is needed.

Validation used the existing Node.js 22.22.2 through process-scoped fnm execution:

- Immediate focused FT-01 run: 3 passed, including the new regression and the
  previously failing complete production classification/dependency assertion.
- Combined FT-01, FT-12 and FT-13: 6 passed.
- `npm run lint`: passed root and workspace type-checks.

Production source is unchanged since the recorded successful build and behavior/
integration checks; this test-rule correction does not require another Host or
Client build. The FT-01 blocker is cleared. Delivery is ready for owner review,
not automatically accepted or authorized for commit/archive.

## 10. Delivery review (2026-11-11)

Direct review covered Test ownership and cancellation/cleanup, Settings update
serialization and rollback, real caller wiring, public type exports, dependency
classifications and scope. No blocking issue was identified. ModelTestRunner owns
the only active-Test collection and temporary resources; SettingsManager retains
the only update transaction and revision state. No scheduler, view extraction,
Memory refactor, generic framework or new exemption was introduced.

The review relied on the recorded checks against the unchanged production source;
it did not rerun unrelated suites or make further production changes. This is a
direct review, not independent review or owner delivery acceptance. Commit and
archive still require explicit owner authorization.

## 11. Owner closeout (2026-11-11)

The owner accepted the completed delivery and validation record and authorized
archiving this Change, explicitly without a git commit. The Plan and Specification
are archived together; the Changes index points to their archived locations.

ADR-024 owns the durable boundary decision. Current Runtime/Channel architecture
and the module map record the implemented structure; existing stable Specifications
retain their unchanged behavioral authority. This archived Change preserves bounded
design, validation and acceptance history and does not create another authority.

This closeout did not itself authorize a next research recommendation, additional
refactor, commit or release. A subsequent owner instruction authorized committing
only the accepted delivery, excluding the pre-existing research-document changes;
no next refactor or release was authorized.
