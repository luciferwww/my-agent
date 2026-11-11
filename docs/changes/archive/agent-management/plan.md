# Agent Management Plan

> Status: Accepted
> Date: 2026-11-10
> Owner: Project owner
> Classification: Architecture Slice
> Specification: [Agent Management Specification](../../../specifications/agent-management.md)
> Decision: [ADR-023](../../../decisions/adr-023-agent-definition-discovery-and-settings.md)
> Authorization: Owner authorized preparing this design after Dynamic Settings
> commit `9747128`, then limited editable UI to enablement and Tool allow/deny,
> with read-only MD and a preference for immediate application.
> Delivery authorization: After independent re-review found no blockers, the
> owner directed proceeding on 2026-11-11. Definition foundations are delivered
> and verified, together with effective registration, policy publication and
> Settings. Subsequent UX refinements and final validation are recorded below.
> Delivery closeout: Owner accepted complete delivery and authorized archive/commit
> on 2026-11-11 after the refined Settings UX, validation and final independent
> review. This Change is completed and archived.

## Outcome

A fresh Agent Home exposes useful named Agents without first opening Settings.
Agent definitions live under Home `agents`; configuration contains optional user
overrides. Settings explains the saved and running values without presenting
approval bypass as an exclusive Tool list.

## Confirmed direction

- Installed templates are under the existing Context template directory's
  `agents` child, not a separate template system.
- Copy that directory only when Home `agents` does not exist. An existing empty
  directory means initialized; deleted Agents must not reappear.
- Scan Home definitions to register Agents; configuration entries are not required.
- Valid discovered Agents default enabled; explicit `enabled: false` disables.
- Description introduces the Agent to the parent; Context bodies instruct the
  child. Both are necessary and have different audiences.
- Configuration can override the model and approval policy. MD model metadata
  is a recommendation, not an instruction to ignore the effective model.
- Parent discovery and `task` lookup use the same effective registry.
- Owner resolved the independent review's Tool-inheritance ambiguity on
  2026-11-11: each new Child Turn selects latest applied shared Tool defaults
  plus that Agent's own override. Do not mix in the parent Turn's captured Tool
  policy or freeze all Agent profiles for an execution tree. Already admitted
  Turns retain their selected policies; model inheritance is unchanged.
- Preserve task continuity: missing/invalid specialist definitions or unknown
  IDs use the existing logged `general-purpose` fallback. Specialized Context
  may be lost, but its absence alone must not block a general task. Explicitly
  disabled IDs are rejected, never bypassed through fallback. Keep discovery
  diagnostics without a separate known-invalid execution state.
- Named Agent MD metadata and bodies are loaded together at startup. Execution
  and read-only Settings share that snapshot, not per-task disk reads. Manual
  file changes take effect after restart, consistent with the startup-authoritative
  convention for main Agent MD and configuration. No file watching, disk-version
  comparison or external-edit recovery is required.
- `general-purpose` is a permanent built-in default type, not a scanned
  definition. It has no dedicated template directory and cannot be disabled.
  Its shared Tool defaults are edited through `agents.defaults.tools` with
  the same subsequent-Turn application as named-Agent Tool overrides; no
  restart is required for either. Other `defaults` fields remain startup-only.
  Future Automation may use the same default type; Automation implementation
  remains excluded.

## First delivery

The [accepted Specification](../../../specifications/agent-management.md) defines:

1. Use frontmatter in each Agent's `IDENTITY.md` for required `description` and
   optional recommended `model`. Directory name is the ID.
2. Keep `agents.list[]` as sparse overrides rather than adding a second
   configuration namespace. Description becomes optional there; existing
   capability fields keep their supported semantics.
3. Add Agents to Settings with only enablement and approval allow/deny editors.
   Description and model are not editable UI controls. MD content is read-only.
4. Apply saved enablement and Tool policy to new task admissions immediately.
   Include shared `agents.defaults.tools` in dynamic publication, with Root
   Turns also capturing their effective policy at admission. AgentRunner only
   receives Turn parameters; it does not read configuration. Build updates from
   currently applied Tool defaults/overrides, never pending-restart fields in
   the complete saved document.
   New children use current shared Tool defaults plus their own overrides,
   even when their parent started before the save. Recursive delegation does
   not implicitly inherit a named parent's additional Tool denies.
   Refresh the parent's available-Agent section on its next Turn. Already
   prepared/running children retain their policies. No Provider-style resource
   lifecycle or multi-file Context save transaction is needed.
   The owner separately confirmed that global `steeringEnabled`,
   `maxLlmCallsPerTurn` and `maxSubagentDepth` remain restart-required for this
   delivery; do not include dynamic execution-policy updates.
5. Cut over directly without compatibility or migration work. Ignore
   unrecognized historical content under the new contract; add no legacy
   detection, conversion or repair code. Configuration-only entries do not
   remain a second registration source.

Item 3 reflects the owner's scope refinement. Item 4 defines the observable
boundary of the requested immediate behavior. Item 5 records the owner's explicit
decision not to support compatibility or migration; it is not an open gate.

## Non-goals

No Automation implementation, Agent installation marketplace, directory rename/
delete UI, arbitrary file manager, MD writes, description/model UI editors,
new Tool execution sandbox, Provider-style registry generation/retirement,
live MD watching, or expansion of Child capability inheritance.
No compatibility layer, migration tool, legacy-field handling or migration
delivery gate.
The anonymous `general-purpose` fallback keeps its existing behavior.

## Delivery checkpoints

| Item | Status | Work | Exit condition |
|---|---|---|---|
| AM-0 Design | Completed | Independent re-review found no blockers; owner authorized proceeding; accepted contracts moved to authority documents | Met on 2026-11-11; delivery validation remains separate |
| AM-1 Definitions | Completed | Template seeding, metadata parsing, immutable startup snapshots and shared Child/Settings consumption | Fresh Home discovery and existing/empty preservation verified |
| AM-2 Effective registry | Completed | Shared/default overrides, current parent/task registry, Root/Child policy capture and atomic publication | New Turns use current policies without changing admitted Turns or applying pending-restart fields |
| AM-3 Settings | Completed | Minimal controls, shared defaults, read-only Context and current policy projections | Browser saves confirm persistence; policy admission tests confirm live application |
| AM-4 Validation and closeout | Completed | Focused tests, types, builds, package install/startup, browser checks, final independent review and authority synchronization completed | Owner confirmed delivery and authorized archive/commit on 2026-11-11 |

AM-1 depends on AM-0; AM-2 depends on AM-1; AM-3 depends on AM-2; AM-4 validates
their combined delivery. Do not mark checks passed before execution.

### Definition foundation verification

- 207 focused Context, Subagent and Runtime tests passed, including copy failure
  cleanup, invalid-neighbor isolation, YAML validation, snapshot immutability,
  missing-file capture, link rejection and real delegated prompts retaining
  startup bodies after disk edits.
- 12 Host/npm asset-audit tests passed.
- Root TypeScript checking, Host compilation and Host audit passed.
- Actual npm package dry-run audit passed with all twelve named-Agent templates.

### Combined delivery verification

- 411 focused tests passed across 24 files, covering configuration, Context,
  Subagent/task, Runtime policy capture and Settings parser/editor behavior.
- The new backend view assertion initially compared against a revision predating
  a successful no-op target save. Corrected the assertion to capture the revision
  immediately before the shared save; unrelated section revisions stay unchanged.
- Root, WebSocket backend and Vue client type-checks passed.
- Client build and all 62 assets verified; Host build/audit passed (376 files).
  Vite reports its existing non-fatal large-chunk warning.
- Actual npm audit and installed-package smoke passed (459 files), including
  fresh/explicit Home startup, acquisition, Settings and installation immutability.
- Actual browser verified seeded reviewer discovery, read-only metadata/body
  Context, persisted disablement and explicit empty allow, shared deny refresh,
  and reload. At 390x844 the dialog has no horizontal overflow and footer remains
  visible. No paid/live Model invocation.
- Authority documents record current implementation without links to Change
  drafts. No commit or push requested or performed.

### Refined Settings UX closeout

- On 2026-11-11 the owner accepted the current Settings UX and authorized related
  tests and documentation. Overall feature closeout/archive/commit is separate.
- Tool allow/deny now uses catalog-backed checkbox multiselects, with inherited
  allow display, locked shared deny matches and verbatim preservation of
  wildcard/unavailable-name rules. All Settings single-choice fields use themed
  custom menus. Booleans consistently use checkbox-first labels, and Extension
  enablement explains the service restart requirement.
- 67 focused tests passed across five files: Settings parsing, selector behavior
  and positioning, editor round trips, shared-policy projections and safe Tool
  catalog publication. The DOM simulator lacks native popovers and inherited
  fieldset `:disabled` matching; those specific platform behaviors are modeled
  in tests rather than presented as real-browser evidence.
- Final Root and Vue client type-checks passed. The client build and verification
  of all 62 client assets passed with the existing non-fatal Vite chunk-size
  warning. The generated JS/CSS hashes match the browser-verified build.
- Actual browser checks at 1280x900 and 375x812 verified no horizontal overflow,
  themed single-choice menus, top-layer Tool popup hit testing and viewport
  bounds, unchanged content height/scroll position on opening, 5px inner-scroller
  insets, last-Tool selection, shared-deny locking, Escape focus restoration,
  outer-scroll dismissal, inline checkbox layout and the revised restart label.
  The updated reviewer definition was visible in read-only startup Context.
- Used an isolated temporary Home and no model calls. Stopped the preview and
  removed its Home afterward. The initial package/install verification above
  predates these selector refinements; it was not rerun for this closeout.
- The three first-party Agent templates now contain scoped workflows, evidence
  standards, stopping conditions and deliverables. Their authoring contract and
  public-source rationale are recorded in the Specification; the existing
  shipped-definition loading test passed.

## Starting evidence and affected owners (before implementation)

- [Context initialization](../../../../src/core/agent-context/init.ts) seeds four
  Root files without overwriting existing files.
- [Configured profile loading](../../../../src/core/subagent/config-loader.ts)
  currently makes `agents.list[]` the only named registration source.
- [Parent prompt projection](../../../../src/core/subagent/available-subagents.ts)
  exposes only ID and description.
- [Child preparation](../../../../src/core/subagent/SubagentExecutor.ts) merges
  same-name Context files; that merge behavior is not being redesigned.
- [Tool policy resolution](../../../../src/core/subagent/profile-tools.ts)
  replaces inherited allow only when explicitly supplied and appends child deny.
- [SettingsManager](../../../../src/runtime/settings/settings-manager.ts) already owns
  revisioned saves and restart-based Extension settings.
- [Task lookup](../../../../src/builtins/tools/task/task-tool.ts) currently reads a
  shared profile map and falls back for unknown names.
  [Child preparation](../../../../src/runtime/runtime-builder.ts) derives a Tool
  policy from the selected profile. Updating only parent prompt text would leave
  these execution surfaces unchanged.
- The owner's [configuration](../../../../test-workspace/config.json) has
  reviewer/explorer/researcher descriptions and approval allow overrides. This
  Change must not silently discard them or rewrite this file during design.

## Validation plan

Target initialization, metadata parsing, discovery, configuration validation,
registry/prompt/task consistency, model selection, approval inheritance and
Settings persistence tests first. Then run one real fresh-Home integration and
installed-package smoke, type-checks, and actual Settings browser checks.
Do not invoke paid models just to validate registration.

The accepted target contract now lives in
[Agent Management](../../../specifications/agent-management.md) and
[ADR-023](../../../decisions/adr-023-agent-definition-discovery-and-settings.md).
Update Current Architecture and affected Configuration/Subagent/Channel
implemented contracts with verified delivery, not ahead of implementation.
Authority documents must not link back to this Change or review history.

## Review and acceptance record

- Initial independent review identified a Tool-policy source ambiguity.
- Owner selected latest applied shared Tool defaults plus the selected Agent's
  own override, including recursive delegation, on 2026-11-11. No parent-policy
  merge or whole-tree profile snapshot.
- Independent re-review found no blockers and verified consistency across
  the design documents. Owner then directed proceeding.
- Decision and contract are accepted; AM-1 through AM-3 and technical delivery
  validation were complete before the final UX and owner delivery closeout.
- Owner accepted the refined Settings UX and authorized its test/documentation
  closeout on 2026-11-11.
- Final independent read-only review on 2026-11-11 covered the complete tracked
  and untracked Agent Management implementation, Settings selectors, templates,
  packaging checks, tests and authority documents. No significant issues were
  found. The reviewer did not rerun tests/builds/browser checks; it excluded the
  unrelated research index and code-structure recommendations.
- After final review, the owner confirmed complete delivery and authorized
  archive/commit on 2026-11-11, excluding unrelated research changes. AM-4 is
  complete. The archive retains validation limits; no merge or push was authorized.

Process authority: [Development Workflow](../../../governance/development-workflow.md).
