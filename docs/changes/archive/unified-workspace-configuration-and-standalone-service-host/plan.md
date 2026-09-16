# Unified Workspace Layout and Standalone Service Host Plan

> Status: Archived and Validated
> Date: 2026-09-15
> Accepted: 2026-09-15
> Validated: 2026-09-16
> Archived: 2026-09-16
> Owner: Project owner
> Type: Architecture Slice
> Decision: [ADR-008](../../../decisions/adr-008-workspace-configuration-authority.md)
> Accepted layout amendment: [Workspace Configuration and State Layout Specification](workspace-configuration-specification.md)
> Accepted Host specification: [Standalone Service Host Specification](standalone-service-host-specification.md)

## 1. Goal

Establish a root-level Workspace layout with no `.agent` directory, then add one canonical standalone service Host on top of the existing Runtime composition path.

The completed change must preserve these boundaries:

- `workspaceDir` directly contains configuration, Context, Session, Memory, Subagent, and Tool filesystem scope;
- Agent Home identifies installed Extension artifacts and remains independent from Workspace selection;
- a composition-level loader reads the Workspace document once and produces one immutable snapshot;
- Runtime and Extension Acquisition consume typed projections from that snapshot and do not reread the file;
- Builtin and External Units continue through the one authoritative Runtime lifecycle;
- CLI remains an optional Channel rather than the default Host architecture;
- Runtime library code never owns process exit or signal policy.

## 2. Approved direction

1. The sole configuration path is `<workspace>/config.json`.
2. The document contains the accepted `agents`, `logger`, `extensions`, and `host` namespaces.
3. The Workspace has no `.agent` directory. Configuration, Context files, Session storage, Memory state, recall state, and Subagent profiles use the accepted root-level paths in the layout amendment.
4. `<workspace>/.agent/config.json` and `<agent-home>/config.json` are retired by direct cutover; no fallback, merge, compatibility facade, or dual-read period is introduced.
5. No production path reads, creates, migrates, or deletes `<workspace>/.agent/` after cutover. A pre-existing directory is unmanaged obsolete data.
6. `<agent-home>/extensions/` remains the Extension installation and discovery root.
7. A missing Workspace config uses defaults. An existing unreadable, malformed, or non-object config is fatal.
8. Existing application precedence after file loading remains unchanged: file defaults, matching Agent entry, environment overrides, then caller/CLI overrides.
9. Logger behavior and adapters are reused; this change does not redesign logging.
10. Standalone execution is service-first. CLI is explicit and optional, and a CLI/Console Logger output conflict must be rejected rather than silently rewriting configuration.

## 3. Delivery sequence

| Item | State | Scope | Exit condition |
|---|---|---|---|
| UWC-0 | Completed | Accept ADR-008, this Plan, and the Workspace configuration/state-layout amendment | Durable configuration, state paths, ownership, migration, and failure policy are explicit |
| UWC-1 | Completed | Add `loadWorkspaceConfig({ workspaceDir })` and the accepted immutable projection/error contracts | One read produces application and Extension projections; focused parser tests pass |
| UWC-2 | Completed | Inject `ApplicationConfigProjection` into Runtime and `ResolvedHostExtensionsConfig` into acquisition | Neither consumer reads `config.json`; existing Runtime/Unit ownership remains unchanged |
| UWC-3 | Completed | Move Workspace initialization/loading, packaged Context templates, Session, Memory, recall, Subagent, and maintained caller/test path owners to the accepted Workspace-root layout | No production owner reads or creates `.agent`; focused state-owner tests pass |
| UWC-4 | Completed | Atomically move fixtures and supported Host setup, delete Workspace/Agent Home config readers and old path assumptions, and transfer authority | No production or active-authority reference treats `.agent` or Agent Home config as current; stable Specifications and Current Architecture agree with code |
| UWC-5 | Completed | Run the Workspace-layout phase validation and owner review | Focused, Integration, Fitness, lint/build, residual, and review evidence accepts the direct cutover |
| SSH-0 | Completed | Specify standalone Host inputs, Channel selection, service liveness, failure, shutdown, output compatibility, and executable scope | Owner accepts the complete observable Host contract before Host implementation |
| SSH-1 | Completed | Add the canonical service composition root using the unified snapshot and common Runtime path | Supported service starts from an explicit Workspace and Agent Home without a second Runtime path |
| SSH-2 | Completed | Add development/build entry points and focused Host artifact verification | Supported source and emitted entry points are documented and audited |
| SSH-3 | Completed | Final regression, authority transfer, independent review, and owner closeout | Applicable Unit/Integration/Fitness/full/lint/build Gates pass and the Change is ready to archive with its delivery commit |

UWC-1 through UWC-5 form the first delivery phase. UWC-4 is one code/document authority cutover; it must not leave Current Architecture or stable Specifications describing a removed production path. SSH-0 is a mandatory design Gate: Workspace-layout migration does not implicitly authorize unresolved multi-Channel liveness, package publication, or installable-binary contracts.

## 4. Acceptance criteria

### Unified Workspace configuration

- A Workspace document containing `agents`, `logger`, `extensions`, and `host` is parsed once.
- Missing optional namespaces preserve their existing defaults.
- Application and Extension consumers receive the same immutable document snapshot.
- Existing Agent selection, merge, environment override, caller override, Logger, Tool, and Subagent behavior remains unchanged unless this Plan explicitly states otherwise.
- Multiple Workspaces may share one Agent Home while retaining independent Extension enablement and scoped Extension configuration.
- Existing `<workspace>/.agent/config.json` and `<agent-home>/config.json` inputs have no runtime effect after cutover.
- Context files live directly at `<workspace>/IDENTITY.md`, `SOUL.md`, `AGENTS.md`, and `TOOLS.md`.
- Session storage lives at `<workspace>/sessions/`.
- the Memory database lives at `<workspace>/memory.sqlite`; SQLite-owned sidecars may use the same root prefix.
- internal recall state lives at `<workspace>/memory-recalls/` and is not placed in the user-authored `<workspace>/memory/` input directory.
- Subagent profiles and Context live at `<workspace>/subagents/<id>/`.
- no production code creates, reads, migrates, or deletes `<workspace>/.agent/`.
- a missing `workspaceDir` is created before root Context initialization; the prior valid behavior for a new Workspace is preserved.
- a pre-existing `.agent` directory is ignored and remains byte-for-byte unmanaged by the application.

### Standalone service Host

- The default standalone architecture is a service Host, not a direct `AgentRunner` or CLI composition.
- The Host loads the unified Workspace snapshot before Extension acquisition and Runtime creation.
- Channel Units remain optional and use the existing Runtime Unit lifecycle.
- CLI enablement is explicit; Console Logger plus CLI terminal output is rejected before Runtime startup unless a later accepted specification defines a single coordinated renderer.
- Process signals, exit policy, and forced-shutdown deadlines remain Host-owned.
- Embedded callers retain a process-neutral Runtime path and can supply the same typed configuration projection without relying on `process.cwd()` or process-global Agent Home resolution.

Before SSH-1 becomes Ready, SSH-0 must define and testably classify:

- Workspace argument/environment/default precedence and path validation;
- Agent Home input precedence and its relationship to Workspace selection;
- the bounded built-in Channel selection shape and whether combinations are legal;
- normal Channel completion, individual Channel failure, all-Channel completion, and zero-builtin-Channel service liveness;
- the exact Console Logger conflict predicate and pre-Runtime failure result;
- signal, shutdown-deadline, exit-code, and startup-diagnostic behavior;
- development source entry, emitted Host entry, and whether an installable `bin` is in scope.

## 5. Non-goals

- placing Workspace configuration under Agent Home;
- merging configuration from multiple files;
- automatic migration or deprecation fallback for either retired path;
- deleting or rewriting a pre-existing obsolete `<workspace>/.agent/` directory;
- changing Session, Memory, recall-log, or Subagent data formats beyond their paths;
- Logger adapter redesign or a terminal UI/log renderer;
- dynamic configuration reload;
- direct `AgentRunner` construction as a standalone application;
- a second Runtime composition or Unit lifecycle path;
- package publication, global installation, or a multi-command CLI unless separately accepted at SSH-0;
- changing Provider protocol, Model Catalog, Tool policy, Session format, Memory format, or Extension descriptor contracts.

## 6. Validation strategy

Delivery uses focused, impact-driven checks during each item and final Gates only at phase completion.

- UWC focused tests: document parsing/failure behavior, defaults and precedence, immutable projections, Extension enablement/configuration, Runtime bootstrap injection, new-Workspace creation, packaged Context text, direct-directory Context assumptions, and each root-level state-path owner.
- UWC integration: one Workspace document drives Extension acquisition and Runtime startup while Context, Session, Memory, recall, and Subagent state use the approved root layout and Agent Home supplies artifacts only.
- SSH focused tests: Host arguments/config projection, Channel selection, CLI/Console conflict, service completion/failure, and signal-driven shutdown.
- Fitness/residual checks: one config path; no production, maintained template, test-fixture, or active-authority `.agent` assumption; no retired readers; no second Runtime path; and valid authority links.
- Final Gates: relevant Integration and Fitness suites, `npm run test:all`, `npm run lint`, clean build, Host/Relay artifact audits, link validation, and `git diff --check`.

## 7. Stop conditions

Delivery stops for owner review if evidence requires any of the following:

- retaining or merging either old configuration path;
- retaining any production read/create dependency on `<workspace>/.agent/`;
- placing internal recall state inside the user-authored and indexed `<workspace>/memory/` directory;
- moving Extension discovery or lifecycle ownership into Runtime;
- adding implicit process-environment resolution to embedded Runtime behavior;
- introducing more than one configuration snapshot for a startup;
- changing stable Logger semantics rather than validating Host composition;
- supporting simultaneous Channels in a way that requires new liveness, failure, or output arbitration policy before SSH-0 acceptance;
- introducing package publication or compatibility commitments not listed in this Plan.

## 8. Completion

The Change is complete only after both phases are delivered, Current Architecture and stable Specifications own the resulting behavior, retired paths have no active references, independent review has no unresolved Critical/High finding, and the project owner accepts closeout.