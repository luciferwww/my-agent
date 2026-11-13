# Agent Management Specification

> Status: Accepted
> Contract status: Implemented, validated and owner-accepted on 2026-11-11
> Date: 2026-11-11
> Owner: Project owner
> Decision: [ADR-023](../decisions/adr-023-agent-definition-discovery-and-settings.md)
> Authority: Named Agent discovery, startup definitions and Settings Tool-policy updates
> Delivery status: Definition discovery, effective registry, dynamic Tool policy
> and the minimal Agents Settings editor are implemented and verified.

## Contract applicability

This specification owns the accepted changes to named Agent registration,
definition loading and Settings application. It supersedes the configuration-only
registration and per-task MD loading contracts in [Configuration](configuration.md)
and [Subagent](subagent.md). Those documents describe the delivered behavior.
Unchanged Model resolution,
Provider-generation capture and Child lifecycle contracts remain in force.

### Current delivery

Implemented and verified:

- Seed the packaged reviewer, explorer and researcher templates only when Home
  `agents` is absent, using temporary-directory publication.
- Discover and validate immediate Home definitions, parse metadata before
  truncation, and retain immutable bounded source/body snapshots, missing-file
  results and per-definition diagnostics.
- Bootstrap owns the snapshot. Child preparation consumes its stripped bodies
  without disk reads; Root Context reload does not refresh named definitions.
- Host and npm package audits require all twelve nested template files.
- Discover executable profiles from the startup definitions with sparse config
  overrides. Parent discovery and task lookup consume the same applied registry.
- Capture immutable Root/Child Tool policies from current shared defaults and
  the selected Agent's own override. Persist before publishing Settings changes;
  never adopt unrelated pending-restart configuration.
- Agents Settings edits only enablement and shared/named Tool allow/deny.
  Context tabs expose startup metadata separately from instruction bodies.
  Shared saves refresh read-only policy projections without discarding other
  dirty drafts or changing their section revisions.

Verification: 411 focused Context/Subagent/Runtime/configuration/Settings cases
and 12 asset-audit cases; Root, WebSocket backend and Vue client type-checks;
client build/asset verification and Host build/audit (376 files); actual npm
package audit and installation/startup smoke (459 files). Actual browser checks
confirmed fresh-Home discovery, read-only Context, named disablement, explicit
empty allow, shared deny refresh, persistence after reload and mobile layout
with a fixed footer. No live or paid Model invocation was needed.

After the owner accepted the refined Settings UX on 2026-11-11, 67 targeted
Settings parser, selector, editor and backend tests passed across five files.
Root and Vue client type-checks, the client build and all 62 client asset checks
also passed.
Browser checks at 1280x900 and 375x812 verified floating selectors, unchanged
content height when Tool popovers open, inset scrolling, checkbox-first labels,
restart wording and locked shared deny entries. The initial package/install
verification above predates these selector refinements and was not repeated for
this UX-only closeout.

## 1. Definition and initialization

Installed layout, under the existing Context templates:

```text
templates/
  IDENTITY.md
  SOUL.md
  AGENTS.md
  TOOLS.md
  agents/
    reviewer/
      IDENTITY.md
      SOUL.md
      AGENTS.md
      TOOLS.md
    explorer/
      ...
    researcher/
      ...
```

The corresponding Home location is `agents/<id>/`.

- If Home `agents` is absent, copy the complete template directory into a
  same-parent temporary directory, then publish it as `agents`.
- Copy failure must leave no partially initialized `agents`; report the error
  and clean only the temporary directory owned by this attempt.
- If `agents` already exists as a directory, do nothing, even when empty.
  Never refill deleted children or overwrite user files.
- A non-directory `agents` path is an explicit initialization error.
- Initialization runs under existing exclusive Home ownership. Do not add a
  second lock protocol or assume rename overwrites are safe on every platform.
- Installed templates are never scanned as a runtime fallback. Package/build
  validation must prove the nested templates are included.

## 2. Metadata and Context

Definition carrier: `IDENTITY.md` frontmatter.

```markdown
---
description: Reviews code changes for correctness and regressions.
model:
  providerId: example-provider
  modelId: example-model
---
# Reviewer

Review changes and report actionable findings with evidence.
```

`description` is required and nonblank. `model` is optional and uses the existing
native Model Reference. The example model is illustrative, not a default template
dependency; shipped templates should omit recommendations that require users to
configure a particular Provider.

The directory basename supplies the ID, using existing ID/reserved-name rules.
Do not duplicate ID, enabled state or approval Tool policy in frontmatter.
Reject malformed frontmatter, unknown metadata fields and invalid value shapes
with file/field diagnostics. Parse metadata before Context truncation.

Frontmatter is machine metadata, not child instructions. The child receives the
MD body through existing Context loading, budgets and same-name inheritance.
Other supported Context files retain their existing purpose. Do not change Root
Context interpretation merely because named Agent metadata is introduced.

Load named Agent metadata and supported MD bodies together at startup and retain
their bounded, immutable running representation, including missing-file and
invalid-definition results. Child preparation and read-only Settings Context
views use this same startup snapshot; neither rereads Agent MD on each task or
Settings load. Preserve Context budgets and same-name inheritance.

Manual edits, deletions or additions to these files take effect only after
restart. Settings displays the running snapshot with a restart-to-update note,
not a second disk version. This follows the startup-authoritative convention
for main Agent MD and manually edited configuration; do not introduce file
watching, disk-version comparison or external-edit recovery.

MD prose may guide behavior but cannot grant permissions or select the actual
model. First-party templates must not claim that a hardcoded Tool allow list is
the only available Tool set.

### 2.1 First-party template authoring

The shipped reviewer, explorer and researcher definitions are operational starting
points, not just role introductions. Keep the existing four-file structure:

| File | Responsibility |
|---|---|
| `IDENTITY.md` | Short parent-facing routing description in frontmatter; child-facing role, goal and default boundary in the body |
| `SOUL.md` | Evidence standards, judgment principles, restraint and treatment of uncertainty |
| `AGENTS.md` | Role-specific workflow, scope, stopping conditions and deliverable |
| `TOOLS.md` | Search/inspection/validation methods and side-effect precautions, without duplicating Tool APIs or permission configuration |

Same-name child files replace the corresponding parent Context files rather than
appending to them. Each definition must therefore supply the guidance it needs;
do not assume that the parent's workflow remains present. Keep the content
focused, within existing Context budgets, and avoid repeating entire global
instructions in every role.

Role-specific guidance:

- **Reviewer:** Establish the requested scope and intended behavior, inspect the
  relevant execution paths and validate concrete triggering conditions and impact.
  For change reviews, distinguish introduced defects from pre-existing issues and
  intentional behavior. Exclude unsupported speculation and unrelated style
  preferences. Return deduplicated, actionable findings in severity order with
  source locations and focused fix directions, or explicitly report no supported
  findings. State actual validation and its limits; do not claim unchecked code
  is proven correct.
- **Explorer:** Locate entry points, trace the relevant implementation and state
  changes, and identify reusable patterns when useful to the caller. Adapt depth
  to the question and stop once there is enough evidence. Return the answer,
  relevant flow and file/line/symbol references, separating confirmed behavior
  from unanswered questions. Do not turn a lookup into a repository-wide survey
  or unsolicited redesign.
- **Researcher:** Bound the question and decision criteria, prefer primary
  sources, verify important claims against the actual supporting material and
  compare alternatives against the caller's constraints. Distinguish examples,
  experimental features, shipped behavior and inference. Return a concise
  conclusion, relevant trade-offs, supporting sources and evidence limitations;
  protect private data in external queries.

All three roles default to investigation rather than file edits or implementation.
Report files require an explicit request. Guidance must respect caller-specified
scope, validation limits and output format. Stop on sufficient evidence or report
a blocker; do not require exhaustive searches, full test suites, numeric
self-confidence thresholds or rigid JSON output for every task. Runtime Tool
availability and approvals remain authoritative; prose is not a read-only
enforcement mechanism.

The authoring principles were informed by the following public references.
They are supporting examples, not runtime dependencies or imported contracts:

- [VS Code Copilot Explore source](https://github.com/microsoft/vscode-copilot-chat/blob/5863f5a7088958050792b5dccbe8b46c6e13eccc/src/extension/agents/vscode-node/exploreAgentProvider.ts):
  scoped search strategy, sufficient-evidence stopping and actionable source
  references.
- Anthropic's official feature-dev plugin
  [code explorer](https://github.com/anthropics/claude-plugins-official/blob/main/plugins/feature-dev/agents/code-explorer.md)
  and [code reviewer](https://github.com/anthropics/claude-plugins-official/blob/main/plugins/feature-dev/agents/code-reviewer.md):
  execution-path analysis and evidence-based finding selection. These are public
  plugin definitions, not claims about private built-in prompts.
- [Codex subagent documentation](https://developers.openai.com/codex/subagents/)
  and [public review rubric](https://github.com/openai/codex/blob/5228d94a27b7f84cae4854acbb5ea3b3e90dfeaf/codex-rs/prompts/templates/review/rubric.md):
  bounded role examples and concrete, actionable defect criteria.
- [OpenCode Explore source](https://github.com/anomalyco/opencode/blob/791a2c489efd88c566df710a7e074ba7327236af/packages/core/src/plugin/agent.ts):
  concise search-only responsibilities and explicit side-effect boundaries.

Template revisions affect future first-time Home seeding only. Existing Home
`agents` directories are never overwritten or refilled; users who want revised
instructions there must update their own files explicitly and restart to adopt
them. Do not add a migration or change startup snapshot semantics for prose
improvements.

## 3. Discovery and overrides

Scan only immediate Agent child directories under Home `agents`, in stable ID
order. Empty or invalid definitions are diagnosed and skipped independently;
one bad definition does not hide healthy neighbors. A failure to enumerate the
Home registry itself is reported explicitly, not treated as an empty registry.
Do not follow directory links outside Home or recursively discover nested Agents.

Configuration retains the existing array:

```json
{
  "agents": {
    "list": [
      {
        "id": "reviewer",
        "enabled": false
      },
      {
        "id": "researcher",
        "model": "inherit",
        "tools": {
          "allow": ["read_file", "web_fetch"]
        }
      }
    ]
  }
}
```

Supported override meanings:

| Field | Missing | Explicit value |
|---|---|---|
| `enabled` | Enabled | Boolean override |
| `description` | Use MD description | Nonblank parent-facing override |
| `model` | Use MD recommendation, otherwise inherit parent | `"inherit"` or native Model Reference |
| `tools.allow` | Use the latest applied shared allow | Replace shared approval-bypass list, including explicit `[]` |
| `tools.deny` | Use the latest applied shared deny | Append this Agent's deny entries to shared deny |

Keep existing supported per-Agent capability/default fields; do not extend their
Child semantics in this Change. Exclude new metadata fields from capability
merging. Consume only supported Agent configuration fields; unrecognized content
is ignored, not interpreted as a legacy form. Do not add legacy-field detection,
mapping or cleanup. Duplicate IDs and invalid values/shapes in supported fields
remain configuration errors.

An override cannot repair a missing/invalid base definition or create a
config-only Agent. Retain unmatched entries on disk and show a diagnostic; do not
silently delete them. Disabled Agents remain visible in Settings but are absent
from available-Agent prompts and executable named lookup.

`general-purpose` is the permanent built-in default Subagent type, also intended
as the future default Automation Agent type. Automation execution is not
implemented by this Change. It needs no dedicated definition directory or
template and is not registered by scanning MD.

It cannot be disabled through Agent enablement or overridden by an
`agents.list[]` entry. Its Tool policy uses the latest applied shared
`agents.defaults.tools`, not a separate `general-purpose` override or a captured
parent Tool policy. Keep the ID reserved.
Non-disableable type registration does not bypass the existing `task` Tool
policy or maximum Subagent depth.

## 4. Effective behavior

Model precedence:

1. Explicit configuration Model Reference.
2. Explicit configuration `"inherit"`: use the parent model, bypassing MD
   recommendation.
3. No config override: use the MD recommendation if present.
4. Otherwise inherit the parent model.

An unavailable explicit/recommended model is reported, not silently replaced.
Keep existing task-time model-resolution failure semantics; structural validity
does not promise Provider availability. Settings shows the saved reference and
availability diagnostic even when it is absent from the model selector catalog.

The parent receives ID and effective description from the same registry used by
`task`. It does not receive whole child MD files. Explicitly disabled IDs fail
admission, even if an earlier parent prompt listed them; they must not fall
through to `general-purpose`, including disabled entries without a valid
definition. Otherwise, when no executable named profile is found, preserve the
existing logged fallback to `general-purpose`. This includes unknown IDs and
missing/invalid specialist definitions: absence of specialist Context need not
prevent the task from running with inherited Context and general defaults.

Prioritize task continuity over requiring a specialist definition for execution.
Keep discovery diagnostics and log the requested ID and fallback reason; do not
claim the specialist was loaded when the general fallback is used. This does
not register config-only specialist definitions or introduce a separate
known-invalid execution state. Fallback is profile selection, not a blanket
retry for model-resolution or task-execution errors.

Tool enforcement continues to use the current application policy: deny takes
precedence; allow is approval bypass, not the available Tool set. Manual-mode
rules for execution and external Home paths remain unchanged.

For every new Child Turn, resolve Tool policy from one current applied-state
selection: latest shared Tool defaults plus the selected Agent's own override.
Missing allow uses shared allow; explicit allow replaces it. Shared deny and
the selected Agent's own deny are combined, with deny precedence unchanged.

Do not merge the parent Turn's previously captured Tool policy into this
selection, including during recursive delegation. A named parent's extra deny
entries do not automatically become the child's deny entries. Parent permission
to call `task` and the existing depth limit are still enforced. This Tool-policy
rule does not change model inheritance, approval mode, or Provider-generation
capture.

For example, if shared deny contains `write_file` when a parent starts, and
Settings then removes it, that parent retains its old policy. A child it starts
after publication uses the new shared deny plus the child's own deny. Clearing a
local deny still cannot remove an entry that remains in current shared deny.

## 5. Settings and immediate application

### Global execution policy

`agents.steeringEnabled`, `agents.maxLlmCallsPerTurn` and
`agents.maxSubagentDepth` publish dynamically after a confirmed Settings save.
Each new Root captures the current applied policy; each new Child captures the
latest global limits independently of its Parent's older parameters, before
asynchronous preparation. Existing Turn parameters remain unchanged.
Child depth admission and canSpawn use the same snapshot. A reduced global
depth limit can reject a new delegation from an already running Parent before
allocating Child resources; depth zero hides task from new Root Turns.
This does not add interactive Child steering or change Child message ingress.

Settings exposes these three fields through independent revisioned section
`agents:execution`. Its sparse `settings`, module-owned `defaults`,
and `resolvedSettings` distinguish explicit overrides and default behavior
without exposing the raw document.
Omitted `maxLlmCallsPerTurn` means no count limit, not zero. Resetting a field
removes its override; unchanged views do not materialize defaults. Execution
saves preserve other fields and prepare/persist/publish through the existing
AgentPolicyState. Failed persistence leaves applied policy unchanged.
Successful saves return current status with no restart requirement. Use ordinary
saved feedback, with no duplicate running-policy view or subsequent-Turn notice.

### Shared Tool defaults

`agents.defaults.tools.allow/deny` are not restart-required. A successful Settings
save updates the Runtime's applied shared Tool defaults for subsequent Turns,
including the built-in `general-purpose` type. Resolve inherited policies and
named-Agent overrides from the latest applied shared defaults, not from an old
parent Turn's policy, using the merge rules above.

Runtime captures the effective Tool policy when admitting a Root Turn or
selecting a Child Turn's profile. Pass that immutable policy to AgentRunner;
Agent execution does not read `config.json` or query changing shared defaults.
Already admitted Turns retain their selected policies.

Tool defaults and Skills selections under `agents.defaults` are dynamic. Other `agents.defaults`
fields retain startup-only application; this does not add memory, Context or
compaction editors or change their existing Child support.

### Per-Agent settings

The Agents group alongside LLM and Extensions contains Global settings and
Agent list. Global settings opens independent Execution policy, Default Tool
permissions and Default Skills editors. Execution policy has steering, non-negative delegation depth and
an optional positive Model-call limit and per-field reset. Each editor saves
independently, without restart.

Agent list contains the built-in general-purpose type, discovered definitions
and unmatched saved overrides, with compact rows showing ID, effective
description and enabled state. Selecting a named Agent opens:

- **Configuration:** enabled, approval allow/deny and inherited/custom Skills controls. Label allow
  as approval bypass, not exclusive Tool availability; explain deny precedence.
  Distinguish use-shared-default allow from an explicit empty allow list. Show
  current shared deny read-only alongside the editable local deny entries.
- **Context:** read-only tabs for the four supported MD files, with frontmatter
  visibly distinguished from body content and missing-file indication.
- Description and effective/recommended model may be shown as read-only
  information. Do not add description/model editing or MD save controls.

Show `general-purpose` as a fixed built-in entry, with no disable control or
dedicated MD tabs. Its read-only shared Tool summary links to Default Tool
permissions, the sole editor for `agents.defaults.tools`. There is no independent
`agent:general-purpose` override or second writable default editor. Shared saves
apply to subsequent Turns without restart and preserve other `defaults` fields.
Navigation between groups preserves unsaved drafts.

Tool allow/deny editors use checkbox multiselects rather than requiring users to
know Tool names. Settings load supplies a safe `toolCatalog` containing only name
and description from the current registry, before per-Agent policy filtering.
Denied Tools must remain visible so users can understand and edit policy.
The catalog is a selection aid, not a declaration that all Tools are executable.

An inheritance checkbox disables the named allow selector and displays current
shared allow read-only. Clearing inheritance exposes an explicit selection,
including an empty selection. Named views supply `sharedAllow`, `sharedDeny`
and `sharedDeniedTools`; the last is computed using the existing wildcard
matcher against registered names. Shared-denied Tools appear checked and locked
in the named deny selector; do not copy them into the local saved deny merely
because they are displayed. Successful shared saves refresh these read-only
projections without replacing another Agent's dirty draft or revision.

Existing wildcard rules and unavailable names are shown read-only and preserved
verbatim on save. Do not silently expand patterns into exact selections, trim
stored rules, or discard entries absent from the current catalog. Users can
change those entries manually in configuration; this is not a new text editor.

Tool lists float in the browser top layer rather than participating in content
layout or being clipped by the dialog's scrolling region/footer. Constrain them
to the viewport and choose above/below placement according to available space.
Keep the rounded frame non-scrolling, with an inset inner list scroller. Internal
list scrolling retains the popup; outer scrolling, resize, outside dismissal,
Escape and dialog closure dismiss it. Escape returns focus to the trigger.

Use the main client's themed custom selectors for single-choice fields too.
Keep actual enum value types and omission semantics. Across Settings, booleans
use a checkbox followed by its label on one row; wide controls retain labels
above. Extension enablement explicitly says saving requires a service restart;
Agent enablement retains subsequent-Turn application.

Use the existing fixed latest-operation feedback and Save placement.
Saving writes only that Agent's editable override fields, preserving its other
fields, other Agents, global Agent policy, LLM and Extensions. Removing an editable
override restores default/inheritance; opening Settings or leaving it unchanged
must not materialize defaults in config.

Default Skills use the independent revisioned section `agents:skills`; named
Skills share the existing `agent:<id>` revision with enabled and Tools. Omitted
named selection inherits defaults; explicit `[]` selects none. The catalog is a
flat name/description/relative-directory list. `load` includes `skillCatalog`;
on discovery failure it includes `skillCatalogError: {code, message}` instead,
without blocking other sections or erasing saved selections. The Skills area
shows the error until a subsequent successful catalog read clears it.
The read-only `skills_catalog` action scans on demand without replacing sections
or changing revisions. While Settings is open/connected, the client requests it
every two seconds after the preceding request settles, updating only catalog
state and preserving drafts. Stop polling on close/disconnect/disposal.

One Agent is one revisioned Settings section, ID `agent:<id>`. Reuse the
existing generic `settings.execute` load/update flow and serialized persistence;
shared Tool defaults have a separate revisioned section. Channel code must not
parse MD or own Agent policy.

For execution policy, enablement, shared Tool defaults and default/named Skills and Tool policy saves:

1. Validate and prepare the complete resulting effective profile state before
   writing. Use the currently applied shared Tool defaults and named overrides,
   changing only the fields admitted by this save. Keep all other defaults and
   global execution policy at their currently applied values; never adopt
   unrelated fields from the complete saved document. Reuse section persistence and its
   existing failure/rollback contract.
2. After confirmed persistence, publish the prepared state through one current
   policy-state reference containing global execution policy, shared Tool defaults and the registry.
   Success means both saved and applied; never report
   success while parent discovery and task lookup use different registries.
3. New task admissions select the current profile/policy. A disabled Agent is
   rejected even from a parent Turn that started before the save.
4. Each parent's available-Agent section is built from the current registry at
   its next prompt construction. An in-flight LLM request is not rewritten.
5. Root admission and Child profile selection each read the current policy state
   once. The reference switch is the live-update boundary: selection before it
   uses the previous state; selection after it uses the published state. Keep
   that selection through preparation and execution, even across asynchronous
   work. Do not mutate shared profile objects in place, cancel existing Turns or
   retroactively change their approval policy. Save failure does not publish.

This is immediate publication of small Agent data, not Provider reload.
Use a single current-state accessor/reference shared by prompt and task
consumers and Root Tool-policy assembly; do not add a general hot-reload
framework, retirement queues or per-tree resource generations. The existing
active-child lifecycle stays intact.
Reducing permissions does not revoke permissions of already running Turns;
stopping them remains the existing explicit Abort operation.

External MD edits are adopted on restart. The UI must not describe a disk edit
as already active. Live file watching, external-edit conflict resolution and
Context editing are not implied by read-only tabs. Model/description overrides
edited outside Settings likewise do not gain file watching in this Change.
Manual `config.json` edits are not a live-update interface; they take effect
after restart. Only supported Settings saves explicitly publish the dynamic
fields defined above. They do not rescan MD or adopt unrelated disk edits into
running state.

## 6. Ownership and failure boundaries

- Context initialization/loading owns template seeding and MD parsing/body
  separation. Existing Core-facing interfaces should remain filesystem-scoped;
  do not couple them to WebSocket or Vue.
- Configuration owns override validation and section persistence.
- Runtime composes discovered definitions with overrides, diagnostics and the
  single running registry; SettingsManager exposes saved/running views.
- Subagent execution retains Parent/Child lifecycle, depth, approval, cancellation
  and Context inheritance. This is not a new task execution framework.
- WebSocket transports generic Settings requests; the client edits drafts.

Reuse shutdown admission, revision checks and bounded request handling. Read-only
Context requests are restricted to known Agent IDs and supported filenames, never
client-supplied arbitrary paths. Path/size validation is required before serving
content. Metadata/Context failures include actionable paths without dumping full
configuration, credentials or MD contents into logs.

## 7. Direct cutover

The owner explicitly excluded compatibility and migration work. Follow the new
discovery and override rules directly. Old, unrecognized configuration content
does not participate in registration or execution and needs no special handling.

Do not add migration code, legacy detection, conversion, cleanup, automatic MD
rewrites, compatibility registries or migration-specific diagnostics/tests.
There is no migration-tool, upgrade-example or paired-file rollback requirement
and no separate migration gate before Delivery.

Existing Home `agents` directories are still never reseeded. Apply ordinary
discovery diagnostics and task fallback, not an upgrade-repair workflow. Do not
alter the owner's Home/config as a side effect of design or tests.

## 8. Acceptance and validation

1. Fresh Home with `{}` gets first-party definitions and exposes them before any
   Settings save. No preconfigured Provider recommendation is required.
2. Existing empty `agents` stays empty; deleted children do not reappear.
3. Copy failure cannot leave a partial published directory. Existing files are
   byte-preserved. Installed package contains and seeds nested templates.
4. Valid MD registers without a config entry; invalid neighbors are isolated and
   diagnosed. Invalid supported config values remain explicit errors;
   unrecognized historical content is ignored without a compatibility path.
   Missing/invalid specialist definitions and unknown IDs retain logged
   general-purpose fallback at task lookup, without hiding discovery diagnostics.
5. Enable/disable controls both prompt discovery and named task lookup.
   Explicit disablement rejects the requested ID rather than falling back,
   including when its definition is missing or invalid.
6. Parent prompt uses effective description; child prompt contains body content,
   not stale metadata model instructions.
   Editing, deleting or adding Agent MD after startup does not change new tasks
   or the read-only Settings snapshot. Task preparation and Settings load do not
   reread Agent MD. Restart adopts the changed definitions or diagnoses their
   invalidity; no disk-version comparison interface is required.
7. Test all four model-precedence cases and unavailable selections; no silent
   fallback. Existing parent generation capture remains valid.
8. Test missing versus empty allow, deny precedence and manual-mode protections.
   Shared Tool defaults saved through Settings apply to subsequent Root and
   Child Turns under the shared-default merge rules, without restart. Already
   admitted Turns retain their Tool policy. An explicit named allow overrides
   shared allow, and shared deny is not removed by clearing local deny.
   A pre-save parent keeps its old policy, but children started after the save
   use the latest shared allow/deny plus their own overrides. Cover both adding
   and removing shared rules. In recursive delegation, a named parent's extra
   deny is not implicitly merged into a different child's Tool policy.
9. Save/remove editable overrides without modifying other Agent fields or
   sections; stale revisions fail explicitly. A no-op UI round trip does not
   populate config defaults.
10. After a successful save, new tasks use the new enablement/Tool policy without
    restart, including tasks requested by a pre-save parent Turn. The next
    parent prompt lists the current enabled Agents. Already prepared/running
    children retain their selected profile/policy. Save failure leaves the
    previous effective state and reports the persistence/application outcome.
    The three global execution-policy fields publish for new Root/Child Turns
    without restart; existing captured limits/steering remain unchanged.
    Save a pending-restart non-Tool default, then alternate shared Tool-default
    and named-Agent saves: none may apply the pending field early. Use a paused
    persistence operation to verify old/new policy selection across publication
    and that save failure leaves the applied state unchanged.
11. Context tabs cannot access arbitrary paths; missing files and diagnostics are
    visible. Desktop/mobile layout and feedback use actual browser validation.
12. Existing anonymous fallback, Root capability resolution, Child execution,
    Context merge, Settings transport and package immutability tests still pass.
    The built-in `general-purpose` entry remains present without its own
    directory, cannot be disabled and cannot acquire a named override. Its
    Tool editor preserves other defaults, identifies the shared scope and
    applies Tool-default changes to subsequent Turns without restart.

Run focused tests and type-checks before integration/browser/package validation.
Record evidence only after execution; acceptance of this contract does not claim
that its implementation tests have run or passed.

## 9. Acceptance and implementation status

The owner accepted the reviewed design and authorized proceeding on 2026-11-11.
Implementation and delivery validation are complete. After accepting the refined
Settings UX and the final independent review, the owner confirmed delivery and
authorized archive/commit on 2026-11-11. The delivered scope covers
enablement/Tool-policy controls, read-only MD, subsequent-Turn shared/named Tool
policy application, current shared defaults rather than captured parent Tool
policy, and direct cutover without compatibility or migration work.
