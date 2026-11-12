# Agent Global Settings

> Status: Accepted
> Date: 2026-11-11
> Owner: Project owner
> Classification: Architecture Slice
> Design: [Accepted Specification](specification.md)
> Authorization: Owner authorized Delivery conditional on independent review passing; independent read-only design review passed on 2026-11-11
> Delivery acceptance: Owner accepted delivery and authorized a feature-only commit on 2026-11-12; no merge, push or archive authorized

## Outcome

The initial design and delivery below retain their historical restart-only
contract. The owner-approved dynamic execution-policy amendment later in this
Plan supersedes that contract; its implementation and validation were accepted
on 2026-11-12.

Make global Agent controls discoverable without confusing shared defaults with
an individual Agent. Add Settings editing for the three existing global execution
fields, reuse module-owned defaults, and preserve their restart-only behavior.
Keep shared Tool defaults dynamic for subsequent Turns.

The owner agreed to this navigation:

```text
Agents
  Global settings
    Execution policy
    Default Tool permissions
  Agent list
    general-purpose (built-in)
    Named Agents
```

The Agent list is a presentation group, not a delegation depth or new registry.
No configuration namespace or field moves.

## Current evidence

- [Configuration](../../../specifications/configuration.md) separates global
  execution policy from Agent capability defaults. Runner owns
  `steeringEnabled` (default true after the owner-approved amendment below) and optional `maxLlmCallsPerTurn`
  (omission means no count limit); Subagent owns `maxSubagentDepth` (default 1).
- [Agent Management](../../../specifications/agent-management.md) already requires
  restart-only global execution policy and subsequent-Turn shared Tool updates.
  Its current presentation uses general-purpose as the shared-default editor.
  This Change proposes replacing that presentation, not its policy semantics.
- [SettingsManager](../../../../src/runtime/settings/settings-manager.ts) owns
  revisions and serialized persistence. Agent updates prepare effective state,
  persist, and then publish through
  [AgentPolicyState](../../../../src/runtime/policy/agent-policy-state.ts).
- [Configuration loading](../../../../src/platform/config/agent-config-loader.ts)
  already resolves global defaults. The
  [section editor](../../../../src/platform/config/agent-config-editor.ts)
  currently edits shared Tools and named Agent overrides, not global execution
  fields.
- The [client Settings parser](../../../../extensions/websocket-channel/client/src/client/settings.ts)
  and [Settings panel](../../../../extensions/websocket-channel/client/src/components/SettingsPanel.vue)
  need explicit support for global execution views and the revised grouping.

## Scope and non-goals

In scope:

- One revisioned execution-policy section alongside existing `agents:defaults`.
- Safe sparse saved values, module defaults, resolved saved values, running
  values, and restart-state projection for the three execution fields.
- Independent section saves and per-field reset-to-default.
- The agreed grouping, a read-only general-purpose inheritance summary, and a
  link to shared Tool defaults instead of a duplicate editor.
- Focused backend/client tests and directly owning documentation updates.

Out of scope:

- Memory, Context, Compaction, model or MD editing; automatic memory capture.
- Hot-reloading execution policy, revoking already admitted Turn permissions,
  changing approval modes, or changing allow/deny or inheritance semantics.
- New permission/configuration managers, generic section-provider frameworks,
  dependencies, schema migrations, or compatibility aliases.
- Modifying test Agent Homes, unrelated process-test changes, or owner research.
- Committing, merging, pushing, or archiving without separate authorization.

## Artifact rationale and gates

Use a Plan and change-local Specification because this adds a Settings section
contract, persistence behavior and client presentation across existing owners.
No new ADR is proposed: the design preserves module-owned defaults, Runtime-owned
Settings, execution-policy startup capture and Tool-policy publication. Reassess
if implementation requires changing those ownership or dependency decisions.
No external SDK or new resource-lifecycle unknown currently justifies a Spike.

| Item | Status | Exit criterion |
|---|---|---|
| AGS-1: Accept design | Completed | Independent design review passed without required corrections; owner's conditional Delivery authorization activated |
| AGS-2: Implement execution settings | Completed | Shared resolution, sparse edits, startup-aware views, Runtime wiring and backend tests passed |
| AGS-3: Update client navigation and editors | Completed | Nested groups, execution controls, sparse reset and read-only built-in summary delivered and tested |
| AGS-4: Validate and synchronize authority | Completed | Full Unit, relevant real WebSocket integration, Fitness, browser checks, lint/build and owning docs passed |
| AGS-5: Accept delivery | Completed | Owner accepted delivery/validation on 2026-11-12 and authorized only the feature commit; no merge, push or archive authorized |

AGS-2 depends on AGS-1. AGS-3 depends on AGS-2. AGS-4 depends on AGS-2 and
AGS-3. AGS-5 depends on AGS-4.

Follow [Development Workflow](../../../governance/development-workflow.md).
Preparation does not establish implementation or behavioral validation.
Keep pre-existing dirty changes separate; establish an isolated implementation
branch/worktree before Delivery without committing or reverting those changes.

## Validation and closeout

The [Specification](specification.md#acceptance-and-validation) defines the
behavior matrix. Proposal preparation checks local links and whitespace only.
Do not run a live Home, download models, or start a Provider for this Change.

At Delivery, update the existing Agent Management contract for the new hierarchy,
global section, default projections and replacement of the general-purpose
editor. Update Configuration/Channel/Runtime prose only where its owned facts
actually change. Do not rewrite archived deliveries or research.

## Review and authorization

On 2026-11-11 the owner requested independent review and continuation if it passed.
A separate read-only reviewer returned PASS, with no blockers or required
corrections, against the owning contracts and actual implementation. Delivery is
therefore authorized. This is design review, not implementation validation.
Implementation uses branch `feat/agent-global-settings`; existing unrelated
dirty changes are preserved and excluded from this Change.

## Delivery results

The implementation reuses Platform's pure execution-policy resolver at startup
and in Settings. It composes existing Runner/Subagent defaults, not client
literals. Runtime Builder provides actual startup policy; the new
`agents:execution` view exposes only the three fields with sparse saved,
default-resolved and running projections.

Execution section persistence uses existing validation, serialization and atomic
publication without hot-applying policy. Shared Tool updates still prepare and
publish AgentPolicyState independently. Tests cover both save directions,
pending-restart isolation, explicit false/depth zero, omitted call limits,
revision conflicts, write failure, restart reversal and fresh startup resolution.

The client now groups Global settings and Agent list under Agents, offers
independent execution/default-Tool editors, and keeps general-purpose read-only
with a link to the sole shared-default editor. Drafts survive navigation and
other section saves. Uncertain saves and malformed confirmations retain the
execution draft and require reload. No dependency, configuration shape,
permission semantics, execution default or production module file was added.

All commands used process-local Node.js 22.22.2 through
`fnm exec --using=22.22.2 --`; no shared environment changed.

| Check | Result |
|---|---|
| Initial existing backend checks | 137 tests passed across 4 files |
| Combined affected configuration/Settings/policy/composition/client checks | 293 tests passed across 14 files before the final 3 uncertain-save cases |
| Final execution-panel regression | 22 tests passed, including the 3 additional uncertain-save cases |
| Final default full Unit suite | 1986 tests passed across 133 files; no worker, retry or timeout overrides |
| Real acquisition/Runtime/WebSocket integration | 3 tests passed; the fresh-Home case now also checks execution save, Tool save, reload, restart resolution and reset |
| Full existing Fitness suite | 16 checks passed across 10 files, including FT-01/12/13/14; no exceptions added |
| Final root/workspace lint | Passed, including Vue type-checking |
| Production build | Passed; 62 Client assets and 390 Host files verified; 121 Relay tests passed |
| Documentation | 7 documents and 180 local links/anchors passed, with whitespace checks |
| Desktop browser | 1280x900: hierarchy, execution save/reset, running-policy/restart feedback, read-only built-in view and no horizontal overflow passed |
| Mobile browser | 390x844: hierarchy, visible Save footer, no horizontal overflow, viewport-contained Tool popup and Escape focus restoration passed |

The first new backend matrix expected an unknown field to be attributed to that
field; the existing editor reports unknown keys at `/settings`, so the test was
corrected without changing that contract. Three old client navigation tests
needed the new Agent-list navigation step. Final checks passed after those
fixture updates. The first mobile popup automation attempt raced viewport/scroll
settlement; settling those events before opening verified existing popup behavior
without changing production dropdown code.

Browser validation used a temporary synthetic Settings fixture, not a live
Provider or user Home. Its local Vite service was stopped, its listener was
confirmed gone, and the fixture file was deleted. Integration used a disposable
Home; no test-workspace configuration or Memory data was edited. This is not a
live-model or owner manual acceptance claim.

The existing Client chunk-size warning above 500 kB remains outside scope.
Current authority was synchronized in Agent Management, Configuration, Channel
and Runtime; archived deliveries and owner research were not rewritten.
Delivery and validation await owner acceptance. Nothing was staged or committed.

## Owner-approved steering default amendment

On 2026-11-11 the owner requested `steeringEnabled` default to true. Change the
Runner-owned default only, retain explicit false, and leave existing Agent Homes
untouched. Settings default/reset/startup projections reuse the owner default;
restart semantics do not change. The validation above records the initial
delivery before this amendment; amendment checks are recorded separately.

Amendment validation: 193 focused Unit cases across 6 files and 3 real
acquisition/Runtime/WebSocket integration cases passed. Tests verify default-on,
explicit false opt-out, Settings reset/restart reversal and isolation from
dynamic Tool publication. Root/workspace lint, whitespace and stale-default
documentation checks passed. No full-suite or production-build rerun is claimed
for this one-default amendment; the initial delivery results remain above.

## Owner-approved dynamic execution-policy amendment

On 2026-11-11 the owner authorized removing restart requirements for all three
execution fields and treating new Root and Child Turns alike: capture the latest
published global policy, without changing already captured Turn parameters.
An existing Parent's later Child uses the latest policy, not inherited Parent
limits. Reuse AgentPolicyState's prepare/persist/publish flow; add no Manager,
watcher or configuration framework. Depth admission and Child canSpawn must use
the same captured limit. Preserve existing Child message-ingress boundaries;
this amendment does not add interactive Child steering.

Remove the execution editor's restart guidance, running-policy duplicate and
extra subsequent-Turn success notice. Extension and MD restart semantics remain
unchanged. This amendment supersedes the restart-only design in the initial
delivery above.

Implementation is complete. AgentPolicyState publishes execution updates only
after confirmed persistence; failures retain the previous reference. Root
parameters use the same captured state as Root Tool policy. Delegation captures
global limits before its first asynchronous operation, checks current depth
before allocating lifecycle resources, and uses that snapshot for Child
canSpawn and Model-call limits. A depth-zero save also updates future Root task
visibility. No extra Manager, watcher or configuration namespace was added.

| Amendment check | Result |
|---|---|
| Focused Runtime, policy, Settings and Vue/client checks | 199 cases passed across 7 files |
| Final default full Unit suite | 1988 tests passed across 133 files; no retry/timeout/worker overrides |
| Actual acquisition/Runtime/WebSocket integration | 3 cases passed, including save, independent Tool save, reload, persisted startup resolution and reset |
| Full Fitness suite | 16 checks passed across 10 files |
| Root/workspace lint | Passed, including Vue type-checking |
| Production build | Passed; 62 Client assets and 390 Host files verified; 121 Relay tests passed |
| Documentation | 8 documents and 194 local links/anchors passed |
| Desktop/mobile browser fixture | 1280x900 save and 390x844 reset passed; ordinary saved confirmation, no restart/running-policy/subsequent-Turn notice, no horizontal overflow and mobile Save within viewport |

The recursive-delegation unit fixture now explicitly permits depth two; the new
admission guard correctly rejected its old depth-one fixture. New regression
coverage verifies stable Root parameters across a save, new and recursive Child
limits from an existing Parent, next-Root steering/call limits/task visibility,
Child snapshot isolation across asynchronous setup, and rejection before Child
lifecycle registration. UI assertions require ordinary saved confirmation with
no execution restart notice, subsequent-Turn notice or Current running policy.

Browser checks used a temporary in-memory fixture, with no live Provider or
user Home. The reused browser tab stalled Playwright's native click-stability
wait; DOM-dispatched control/input events verified rendered values and feedback,
and viewport geometry verified layout. These are not a fresh native-pointer
interaction or owner manual acceptance claim. The temporary server was stopped
and its fixture removed. The initial browser evidence above remains the
validation for unchanged Tool dropdown and navigation interactions.

The existing Client chunk-size warning remains outside scope. Owner delivery
acceptance remains pending; no commit, push, merge or archive was performed.

## Independent implementation review and native interaction follow-up

On 2026-11-12 an independent read-only implementation review returned PASS:
no high-confidence correctness bugs, regressions or blockers. Its only material
validation gap was native-pointer verification of the amended UI. The owner
authorized closing that gap without committing.

A fresh browser page using a temporary in-memory fixture passed native
interaction checks, without DOM-dispatched clicks or input events:

- Desktop 1280x900: click through Agents / Global settings / Execution policy;
  toggle steering off, enter depth zero and enable a three-call limit using
  native clicks and keyboard input. Save emitted exactly the three explicit
  values and confirmed `Execution policy: saved.`
- Mobile 390x844: click each per-field reset and Save. The update contained
  sparse empty settings `{}`, restored steering true and depth one, and removed
  the call-count limit.
- All 12 observed click events had `isTrusted: true`. Neither viewport showed
  execution restart guidance, a running-policy duplicate or a subsequent-Turn
  notice. Neither had horizontal overflow; mobile Save remained inside the
  viewport.

This closes the earlier native-pointer validation gap, not owner manual
acceptance or live-Provider validation. No production code was changed. The
temporary fixture was removed and its Vite service stopped after verification.
Owner delivery acceptance remains pending. No commit, push, merge or archive
was performed.

## Owner delivery acceptance and commit authorization

On 2026-11-12, after independent implementation review and native interaction
validation passed, the owner confirmed: "验收通过，仅提交本次修改".
Delivery and its validation are accepted. Commit only this Change's production
code, tests and directly related documentation on `feat/agent-global-settings`.
Exclude existing process-test changes, Built-in Tool documentation and owner
research changes. Merge, push and archive remain unauthorized; retain the
accepted Change in the active directory.
