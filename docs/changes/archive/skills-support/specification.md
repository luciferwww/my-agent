# Skills Support Specification

> Status: Validated
> Authority: Non-authoritative delivery record; may be cleaned up at any time.
> Date: 2026-11-13
> Owner: Project owner
> Related Plan: [Skills Support](plan.md)
> Acceptance: Owner accepted this Spec and the Plan and authorized implementation
> on 2026-11-13 following static review.
> Implementation: Discovery, loading, selection, prompt and Settings are wired.
> Automated/native-browser and real-model evidence are recorded
> in the [Plan](plan.md#preparation-record), including authorized real-model
> adherence checks; Owner accepted delivery on 2026-11-17.

## 1. Purpose and scope

Provide one discoverable Skill library and user-editable effective selections
for Root and Child Agents. Load instructions on demand through normal Tools;
automatic and explicit selection differ only in who chooses the Skill.

Scope and non-goals are owned by the [Plan](plan.md).

## 2. Library and identity

- The only discovery root is `<agent home>\skills`.
- Discover `SKILL.md` through nested classification directories. Once found,
  treat its directory as one Skill and stop discovering below that boundary.
- Use standard Skill name/description metadata and Markdown instructions.
  Validation and traversal rules are proposed in section 10.
- Present a flat catalog with unique names. Preserve each relative source
  directory as display information, not a namespace or selection key.
- Duplicate names produce explicit diagnostics, never scan-order overrides.
  Exclude every entry sharing a conflicting name; valid nonconflicting siblings
  remain available.
- Classification folders, including `builtin`, carry no special precedence,
  permission or enablement. No folder-level selection or inheritance.
- Newly discovered Skills are candidates, not automatically selected.

## 3. Selection and application

| State | Effective selection |
|---|---|
| No per-Agent override | Default selection |
| Explicit per-Agent selection | Complete replacement of defaults |
| Explicit empty per-Agent selection | No Skills |

Store the default list at `agents.defaults.skills` and optional complete
replacements at `agents.list[].skills`, each a list of Skill names. Omitted
defaults resolve to `[]`. Omitted named values inherit; an explicit `[]` does
not. Reject invalid names, non-arrays, non-string entries and duplicate names.
Use existing Agent identity resolution; do not create a new Skill-specific
Agent registry.

Root uses the existing resolved Agent capabilities, including startup-selected
Agent and supported caller overrides. Child uses the actual selected executable
profile ID, not its Parent's named selection or an unknown requested type that
has already fallen back to general-purpose. General-purpose uses defaults.
Keep existing configuration precedence; no new environment-variable syntax or
per-call Skill selector is introduced.

Syntactically valid saved names may refer to currently missing or invalid
packages. Preserve them and show their unavailable state, including on save;
filesystem changes must not invalidate an otherwise valid configuration document.

Settings must distinguish inheritance from explicit empty selection and persist
before publishing new effective state. Failed persistence leaves applied
selections unchanged. Preserve unrelated configuration and existing section-save
concurrency guarantees.

Each new Root or Child Turn captures current selection policy independently.
An existing Parent does not force its older selection onto a newly admitted
Child. Already captured selections do not switch during a Turn.

Removing a name from defaults does not remove it from explicit type overrides.
This design has no separate global deny layer.

## 4. Discovery and lifecycle

- Automatically observe additions, edits and removals, including creation of the
  initially missing discovery root, without Agent restart or manual refresh.
- Update open Settings even when no Turn is started.
- Discovery changes do not silently rewrite saved selections. Show references
  to missing or invalid Skills as such.
- Use current content when loading. A captured selection is not a frozen copy
  of the Skill package or a guarantee that a listed file still exists.
- Host file caching and update detection are implementation details; no separate
  version protocol or whole-package snapshot is required.
- Discovery runs on demand through the Runtime-owned integration described in
  section 10; no background scanner or generic service framework.

## 5. Prompt and loading Tool

Runtime supplies effective catalog summaries to System Prompt Builder. Builder
owns text rendering, not file reads, caches or subscriptions.

The Skills section lists available names and descriptions, not full bodies or
all resource files. It instructs the model to load current instructions before
use; historical text does not replace obtaining current instructions.

When the loading Tool is not visible, do not advertise callable Skills. Tool
denial, approval and execution failure follow existing default behavior; no new
Skill-specific permission or Settings diagnostic system is introduced.

The Tool accepts a Skill name, checks the trusted current Turn identity and
captured effective selection, and returns current instructions plus the resource
base directory. It must not accept a caller-supplied identity as authority or
provide an arbitrary-path loading bypass.

Proposed public tool: `skill`, with a closed object schema containing one required
string `name`. Success is ordinary Tool-result text containing the name, absolute
resource base directory and complete `SKILL.md` content, including frontmatter.
It does not enumerate
or preload resource contents. Failures use existing failed Tool output, logging
and canonical Tool-result mapping, not a new message/event type.

The section appears in both `full` and `minimal` modes when the Tool is visible
and valid selected entries exist. `none` still produces an empty system prompt;
it does not disable the Tool or change selection validation. Explicit use in
`none` mode is model-driven and has no advertised catalog or adherence guarantee.

Loading failure uses normal explicit Tool errors. Missing, invalid, conflicting
or unselected Skills must not produce empty success-shaped instructions.

## 6. Automatic and explicit use

- Automatic: the model matches the task against the catalog and calls the loader.
- Explicit: a request such as `/skill code-review check these changes` remains
  ordinary user text. The model recognizes the requested name and task, then
  calls the same loader.
- Subagent: the parent preserves the user's Skill requirement in the delegated
  task. The Child loads it under its own effective selection.
- No host slash parser, pre-expanded user prompt, special message type,
  Skill attachment protocol or new structured delegation argument.
- Loading results use existing Tool-result persistence and Provider conversion.
- If an explicit requirement cannot be satisfied, explain why. Do not enable
  automatically, silently perform an ordinary substitute task or repeatedly
  delegate the same unavailable request.

Model-driven adherence is not deterministic host enforcement. Validate actual
selection/loading/delegation behavior rather than claiming guarantees from
prompt text alone.

## 7. Scripts, resources and permissions

Skill instructions define interpreter, dependency, environment and invocation
requirements. The Agent uses existing tools to prepare and execute them.

No Skill-specific environment detection, virtual-environment manager, dependency
installer or env/secret settings are introduced. Loading itself executes no
scripts, installs nothing and grants no Tool permissions.

Resource base paths identify files; they do not grant access or implicitly change
the execution working directory. Resources are live files accessed through
existing tools, with their normal permissions and failure behavior. No same-version
guarantee spans instructions and resources.

Disabled selections apply to future Turns, not erasure of historical bodies,
revocation of unrelated Tool permissions or forced cancellation of current work.

Selection focuses the advertised catalog to reduce model confusion and selection
ambiguity; it is not a security deny-list. Unselected Skill files remain
accessible through ordinary Tools when permitted. An explicitly requested
file-based workflow is separate from named Skill loading: it does not enable
the Skill or bypass Tool permissions. Do not silently substitute that workflow
when a required Skill cannot be loaded.

## 8. Settings and compatibility

Use ordinary flat lists showing name, description and relative source directory.
Provide default selection and per-Agent inherited/custom selection, including
empty. Observe catalog updates without discarding unsaved edits.

No existing config migration or compatibility alias is assumed. The eventual
contract must explicitly define omitted fields for existing Homes; adding files
alone never enables them. Shipping template Skills and their update policy are
not authorized by this specification.

Do not change existing Agent registration, prompt mode, Tool authorization or
Session transcript contracts incidentally. Resolve necessary amendments before
acceptance, then synchronize only directly owning authority during Delivery.

## 9. Acceptance

The [Plan validation strategy](plan.md#validation-strategy) applies. Verify:

1. Nested discovery and flat identities:
   - Multi-level classification directories do not change Skill names.
   - A discovered `SKILL.md` stops discovery below its directory, even when
     invalid; nested examples are not independently discovered.
   - Same-name Skills across classifications are all excluded with explicit
     conflicts; loading never picks one arbitrarily, and healthy siblings remain
     available.
2. Defaults, replacement and empty sets across Root/Child and configuration reload.
3. Persist-before-publish behavior and failure/conflict rollback.
4. Automatic file/root changes and Settings updates without Turn activity.
5. New-Turn selections, stable admitted selections and loading current contents;
   a duplicate introduced after Turn preparation causes loading to fail explicitly.
6. Prompt summaries without bodies and visibility tied to the loading Tool.
   Child preparation must not scan Skills when its loading Tool is not visible;
   a broken library must not block such an ordinary delegated task.
7. Actual model-driven automatic/explicit/delegated loading with task arguments.
8. Explicit unavailable/invalid/read failures and existing Tool-policy outcomes;
   complete loaded content preserves optional and unknown frontmatter fields
   without granting host execution semantics.
9. Ordinary live-resource/script execution, with no automatic privilege or env setup.
10. Existing message persistence, Settings drafts and application shutdown remain
    correct; focused regressions, relevant integration, lint/build and UI checks pass.
    A catalog read failure must leave other Settings sections loadable/editable,
    retain saved selections and show an explicit catalog error rather than empty
    success-shaped catalog data.

## 10. Concrete delivery design proposals

These accepted choices are implemented; validation scope is recorded in the Plan.

### 10.1 Discovery rules and limits

- Require closed YAML frontmatter containing `name` and `description`, followed
  by a nonblank Markdown body. Use the existing `yaml` dependency with duplicate
  keys and aliases rejected, following the Agent-definition parsing pattern.
- Name: 1–64 lowercase ASCII letters, digits and hyphens; no leading/trailing
  hyphen or consecutive hyphens. It must equal the immediate containing directory
  name, not the classification path. Description: nonblank, at most 1024
  characters; normalize line breaks for the model-visible summary.
- Parse and validate `name` and `description` for discovery. Accept other fields,
  including `compatibility`, `license`, `metadata` and unknown extensions, without
  adding host execution semantics or rejecting them merely for being unknown.
  Return the complete source on loading, preserving their author-provided content
  for the model; do not implement per-field forwarding or vendor-specific behavior.
- Traverse ordinary directories only, stopping below each discovered `SKILL.md`.
  Do not add a separate classification-depth limit or hidden-directory exclusion;
  folder naming does not determine discovery eligibility.
- Accept only a regular `SKILL.md`; do not follow linked roots, linked directories
  or linked instruction files. Check current containment/type again when loading.
  These checks restrict discovery/loading, not arbitrary execution via other tools.
- Sort entries by name and diagnostics by relative source path for deterministic
  presentation. An invalid/read-failed branch does not discard healthy siblings;
  exclude duplicates on all conflicting paths.
- A missing root is an empty library, not an error. An unreadable or non-directory
  root is an explicit catalog failure; do not silently advertise stale entries.
- Do not couple Skill discovery/loading or catalog rendering to Agent Context
  `maxFileChars` / `maxTotalChars`, or add a separate Skill budget configuration.
  Existing Runner model-context handling remains unchanged.

### 10.2 Ownership and update mechanism

- A small Core Skills module owns package parsing, discovery/loading rules,
  summary/diagnostic contracts, selection validation and defaults. It does not
  import Platform Configuration, Runtime, Channel or UI.
- Runtime composition supplies the Home-bound discovery/loading operations.
  Scan on demand when preparing a new Root/Child catalog or handling a Settings
  catalog read. Each request receives its complete scan result and diagnostics.
  Do not add a background scan loop, filesystem watcher, last-scan timestamp or
  short-lived catalog cache without evidence of excessive scanning.
- Report scan failures explicitly; a subsequent request may recover without
  restart. No independently published catalog state or revision is required.
- After checking the captured selection, the loader scans by the requested name
  at invocation and requires a unique valid match, rather than reusing a path
  from Turn preparation. Missing or conflicting matches fail explicitly.
  Validate the current package and return its complete instruction file; do not
  serve historical content or introduce a loaded-Skill cache. Scanning and reading
  are not an atomic filesystem snapshot; concurrent edits/removals may fail
  normally, without locks or version protocols.
- Discovery/loading follows the requesting Turn or Settings operation's existing
  lifecycle and shutdown handling; no separate scanner lifecycle is introduced.
- System Prompt Builder consumes summaries only. File discovery is not performed
  inside Builder, Settings, each individual Agent or a new watcher per Session.

### 10.3 Trusted Turn binding and contribution

- Extend Runtime's existing active-Turn record with the captured Skill selection.
  Root capture occurs alongside its applied Agent state. Child capture occurs
  alongside current execution policy before asynchronous preparation.
- Supply a deferred catalog read to Child preparation. After resolving its
  visible Tools, read summaries only if `skill` is visible; its existing minimal
  prompt path receives the new section. A Child does not inherit the Parent's
  selected names through the active-record spread.
- Add one Built-in `skill` Tool contribution during Runtime assembly, using the
  existing contribution pattern. Its dependency resolves the active record from
  trusted `ToolExecutionContext.sessionId` and `turnId`, checks the bound Turn
  authority and captured names, then invokes library loading.
- Reuse the active map's existing `finally` cleanup for Root/Child. No new public
  Agent ID field on every Tool context, mutable global current-Agent variable,
  per-Skill Tool registrations or Runner message changes are needed.
- Extend applied capability construction in AgentPolicyState so selection
  updates and profiles are prepared before persistence and published together.
  Do not activate pending unrelated file changes.

### 10.4 Settings contract and presentation

- Add a default section `agents:skills` (`kind: agent-skills`) with editable
  `settings.skills`; omission resets to the empty module default. It appears
  under Agents → Global settings alongside, not inside, Default Tool permissions.
- Extend each existing `agent:<id>` section with optional `settings.skills`.
  The existing named section revision covers enabled, Tools and Skills together;
  submitting it must retain untouched fields. Omission means inheritance and
  `[]` means custom empty. Do not reinterpret `agents:defaults`, currently the
  shared Tool section, as a second editor for default Skills.
- Extend normal Settings `load` with `skillCatalog`, containing flat entries
  `{name, description, relativeDirectory}` and diagnostics.
  If discovery fails, return `skillCatalogError: {code, message}` instead, keeping
  other sections available. The read-only action still returns a failed result
  with the specific safe diagnostic. Show the catalog error in the Skills area;
  a successful subsequent read clears it without replacing drafts.
  Preserve configured missing names as unavailable choices in selection controls.
- Add read-only Settings action `skills_catalog`, input `{}`, returning that
  catalog only, without configuration sections or mutating section revisions.
  It scans the library on demand; it does not install, execute or enable packages.
- While Settings is open and connected, request this action initially and every
  two seconds after the preceding request settles. Stop on close/disconnect or
  component disposal. Update only catalog state, never replace draft selections,
  credentials, other settings or save revisions. Handle read failures visibly;
  no broad full-Settings reload or new WebSocket push protocol.
- Under normal test conditions, an open Settings list updates within one client
  polling interval plus scan/transport time. Verify polling with controlled
  clocks and a bounded real-filesystem convergence check.

## 11. Source fit and review gate

Static inspection confirmed the following integration points:

| Existing surface | Design implication |
|---|---|
| [Configuration merge](../../../../src/platform/config/loader.ts) | Arrays replace; omission preserves inherited values; project Skills through existing capability resolution |
| [Leaf/default composition](../../../../src/platform/config/default-composition.ts) | Add module-owned empty Skills default, not a new top-level namespace |
| [Config section editor](../../../../src/platform/config/agent-config-editor.ts) | Add dedicated default-Skills edit; extend named edits without discarding Tools or enabled state |
| [AgentPolicyState](../../../../src/runtime/policy/agent-policy-state.ts) | Existing prepare → persist → publish seam; its current build must be extended rather than assuming it already copies new defaults |
| [SettingsManager](../../../../src/runtime/settings/settings-manager.ts) | Generic action transport supports a narrow catalog read; existing update queue/revisions remain authoritative |
| [SubagentExecutor](../../../../src/core/subagent/SubagentExecutor.ts) | Child uses `minimal`; summaries must be passed explicitly |
| [Delegation orchestration](../../../../src/runtime/subagent-orchestration.ts) | Current-policy capture and active child registration provide trusted binding points |
| [Runtime assembly](../../../../src/runtime/composition/runtime-builder.ts) | Existing Built-in contribution and startup/shutdown cleanup owners |
| [SettingsPanel](../../../../extensions/websocket-channel/client/src/components/SettingsPanel.vue) | Existing `load()` replaces drafts, so catalog polling must not call it |

No new dependency, host slash parser, generic watcher system or new Runner
execution path is proposed. This follows existing layering; no separate ADR is
currently proposed. Reassess if review reveals a durable ownership change.

Owner accepted the design and authorized Delivery on 2026-11-13 after static
review closed without remaining blockers. Focused Unit, WebSocket integration,
type/build, boundary and native-browser checks passed as recorded in the Plan.
Authorized real-model checks with `gpt-5.6-sol-fast` also passed automatic,
explicit, same-Session current-content, delegated and unavailable-Skill scenarios.
These are observed outcomes, not deterministic model guarantees. Owner delivery
acceptance remains pending.

Follow [Development Workflow](../../../governance/development-workflow.md).
