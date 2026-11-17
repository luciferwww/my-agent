# Agent Global Settings Specification

> Status: Implemented and Validated
> Authority: Non-authoritative delivery record; may be cleaned up at any time.
> Date: 2026-11-11
> Owner: Project owner
> Related Plan: [Agent Global Settings](plan.md)
> Authorization: Owner's conditional Delivery authorization activated after independent design review passed on 2026-11-11
> Delivery acceptance: Owner accepted delivery and validation on 2026-11-12 and separately authorized archive on 2026-11-17; no additional commit, push or merge is authorized.

## Purpose and observable outcome

Expose existing global execution policy through Settings and distinguish it
from shared Tool defaults and individual Agent overrides. Users can inspect
defaults, reset overrides, save global execution policy without a restart and edit Tool
defaults without mistaking them for an independent general-purpose policy.

## Scope and non-goals

Include only `agents.steeringEnabled`, `agents.maxSubagentDepth`,
`agents.maxLlmCallsPerTurn`, the existing default Tool editor, and navigation to
existing Agent views.

Do not move configuration fields, introduce per-Agent execution limits, change
Runner/Subagent/approval behavior beyond the owner-approved steering default
and subsequent-Turn global policy updates,
add Memory settings, or broaden Agent Context
and model editing. No automatic service restart is added.

## Boundaries and dependency direction

- Runner owns its configuration, defaults and validators. Subagent owns its
  depth default and validator.
- Platform Configuration composes these contracts and owns sparse file editing.
  Share its pure global-policy resolution with Settings where needed rather
  than copying default literals or reloading the application to render a view.
- SettingsManager owns section revisions, safe views, update serialization and
  persistence orchestration. It does not become an execution-policy owner.
- AgentPolicyState owns one applied snapshot containing global execution policy
  and shared/named Tool policy. Reuse its prepare/persist/publish flow.
- Channel transports Settings requests/results. The client owns presentation
  and drafts, not configuration parsing, default literals or enforcement.
- No generic settings registry, permission manager or second mutable policy
  store is introduced.

## Sections and safe projections

Add section `agents:execution` for exactly the three global execution fields.
Keep `agents:defaults` for shared Tool configuration and `agent:<id>` for
existing named-Agent edits. Use existing Settings load/update requests.

The execution section provides:

- `settings`: sparse explicitly saved execution fields only.
- `defaults`: module-composed defaults; omitted `maxLlmCallsPerTurn` means no
  count limit, not a fabricated numeric value.
- `resolvedSettings`: saved execution settings resolved with those defaults.
- Existing revision, `restartRequired` and `applicationStatus` metadata.

The client treats an omitted call-count limit in these projections as no limit;
no `Infinity`, zero sentinel or stringified number is sent over the wire.
Never expose the full document, environment or unresolved credentials.
These are additive Settings view fields, not new configuration-file fields.

Execution settings never require restart. A successful save means the candidate
was both persisted and published; report `applicationStatus: current` and
`restartRequired: false`. Compare resolved saved values to the applied snapshot
for consistency; a mismatch is `not_applied`, not a restart requirement.

## Defaults and validation

| Field | Default behavior | Accepted explicit value |
|---|---|---|
| `steeringEnabled` | true, from Runner | Boolean |
| `maxSubagentDepth` | 1, from Subagent | Non-negative safe integer; 0 disables delegation |
| `maxLlmCallsPerTurn` | No count limit when omitted | Positive safe integer |

Use owner validators and exact Settings field attribution. Reject unknown
execution-section keys, invalid types, null, fractions, non-finite numbers,
out-of-range integers, and invalid zero/negative values. A zero depth is valid.
Reject credentials for this section.

On 2026-11-11 the owner explicitly requested steering enabled by default.
Omitted configuration now resolves to true; explicit false remains an opt-out.
Do not rewrite existing Home configuration. The owner subsequently authorized
all three fields to publish dynamically for new Root and Child Turns alike.

The runtime limit remains per Root/Child Turn independently; this editor does
not add Parent remaining-budget inheritance or remove supported internal
per-Turn overrides.

## Editing, reset and persistence

Execution updates replace only this section's three editable fields in the
latest document. Omitted fields remove their explicit override; unrelated
`agents` fields, other defaults, entries, unknown preserved content, LLM,
Extensions and credentials remain untouched.

Opening Settings, switching pages, or leaving a field untouched must not
materialize defaults. Preserve explicit saved values until changed or reset.
A per-field reset removes only that field from the draft. Saving an unchanged
sparse draft must not expand it into resolved values.

Use the existing serialized update path, expected-revision conflict rejection,
validation-before-write and atomic section persistence. Prepare the safe
resolved result before persistence, and report success only after confirmed
save and publication through AgentPolicyState. Prepare from the currently
applied state, changing only this section's admitted fields. Persistence failure
leaves the prior confirmed section state
intact and returns the repository-standard explicit failure.

Tool-default saves retain prepare, persist, then publish semantics. They must
not adopt unrelated file edits to execution policy. Execution saves likewise
do not reset Tool overrides or adopt file edits to other Agent capabilities. Independent
section revisions and drafts must survive edits to the other section.

## Client hierarchy and interaction

Under Agents, show Global settings and Agent list as distinct navigation groups.
Global settings exposes Execution policy and Default Tool permissions.
Each editor saves its own section; navigation does not implicitly save,
discard dirty drafts or combine separate section saves.

Execution controls:

- A checkbox for steering, with an explicit label and default/reset indication.
- A non-negative integer depth input explaining that 0 disables delegation.
- A "Limit Model calls per Turn" checkbox and positive integer input. Unchecked
  means omission. Enabling requires a valid user-entered limit, not an arbitrary
  default constant.
- Per-field reset and ordinary saved feedback. Do not display restart guidance,
  a Current running policy duplicate, or a redundant subsequent-Turn notice.

Keep the current themed selectors, checkbox/label layout, operation feedback
and section Save behavior. Validate numeric input without silently coercing
blank or invalid text to zero.

Agent list contains the built-in general-purpose entry and the existing named
Agent entries. general-purpose remains non-disableable, with no independent
Tool override or dedicated MD editor. Show a read-only shared-permission summary
and navigation to Default Tool permissions. This is a presentation view over
shared defaults, not a new `agent:general-purpose` configuration entry or
second editable copy of `agents:defaults`.

Named Agents retain current enablement, read-only Context and Tool controls.
Missing allow inherits shared allow; explicit allow, including an empty array,
replaces it. Local deny appends to locked shared deny. Shared saves refresh
inheritance summaries without overwriting dirty named drafts or their revisions.

Preserve catalog visibility, wildcard/unavailable-name retention and dropdown
behavior. Explain that allow is approval bypass rather than Tool availability,
deny wins, and manual-mode exec/external-path approval exceptions remain.

## Lifecycle, failure and concurrency

Use existing Settings admission, queue and shutdown budgets; do not introduce a
worker, watcher, new Runtime generation or restart facility.
Each new Root captures one applied global/Tool snapshot. Each new Child captures
the latest execution limits at delegation admission, independently of its
Parent's older parameters. Capture before asynchronous Child setup; use that
same depth limit for admission and Child canSpawn. Existing Turn parameters,
call-count limits and selected Tool policies do not change mid-execution.
After a limit reduction an existing Parent may still expose task, but a new
Child exceeding the latest global depth limit is rejected before lifecycle
allocation. Depth zero also hides task from new Root Turns.
Steering continues to use the existing Root message-ingress path; do not add
interactive Child steering or message ingress as part of this Change.

Preserve explicit revision conflicts, write errors and closing failures.
Existing timeout/disconnect feedback must state that save outcome is uncertain
and require reloading before retrying; do not report an unconfirmed save as
applied. Failed saves preserve the editable client draft.

## Compatibility and migration

Existing configuration files load unchanged, including sparse empty documents.
Keep existing Tool/named section identifiers and semantics. Add the execution
section and safe view parsing together; reject malformed new views explicitly.
Do not infer section identity from display text or pretend the new global
section is an Extension.

Remove the superseded general-purpose Tool editing surface in the same
delivery. Do not leave a second writable default editor, migrate Agent Home
files, or introduce old/new config aliases. No transport action or public
permission-mode change is required.

## Acceptance and validation

- Configuration/section tests: owner defaults and validation; sparse reset;
  unchanged round trips; explicit false and depth zero; invalid call limits;
  unrelated-field preservation; no default literals duplicated in the client.
- Projection tests: empty config; all explicit values; no-limit omission;
  saved/applied consistency; no restart or running-value duplicate; safe output
  without raw document/credential leakage.
- Settings transaction tests: revision conflicts, independent sections, write
  failure, serialization and shutdown. Failed saves do not publish; shared
  Tool saves do not adopt unrelated on-disk execution edits.
- Runtime tests: already captured Root/Child parameters remain unchanged;
  later Root, Child and recursive delegations use latest published limits;
  depth admission, task visibility and canSpawn agree. Verify snapshots survive
  asynchronous setup and reset removes the explicit call-count limit.
- Client tests: section parsing; nested navigation/back behavior; built-in
  read-only summary and jump; sparse/dirty drafts; resets; numeric and checkbox
  handling; separate Save targets; named inheritance and locked shared deny.
- Relevant existing Settings/WebSocket integration checks: load, independent
  saves, reconnect/reload and persisted startup resolution.
- Browser verification on desktop/mobile: hierarchy, plain saved feedback,
  no restart/running-policy noise, no duplicate editor, overflow/dropdowns and usable Save controls.
  Use a disposable fixture, never a user's active Agent Home.
- Run the smallest relevant existing test selectors first, then affected
  contract/integration/Fitness checks, lint and build. Use established Node.js
  and workspace tooling; add no dependencies or timeout/retry workarounds.
- Check documentation links/whitespace and directly review changes against
  these invariants. Record actual results and uncovered limits in the Plan;
  prior Change results do not validate this delivery.

## Open questions and authorization

No unresolved product behavior is proposed beyond the confirmed direction.
Exact visual spacing and helper names remain implementation details.
Independent design review passed without required corrections on 2026-11-11,
activating the owner's authorization to continue. Update owning stable
specifications only with delivered facts; acceptance of this design does not
claim implementation or validation.
