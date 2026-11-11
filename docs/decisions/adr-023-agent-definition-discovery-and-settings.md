# ADR-023: Agent Definition Discovery and Settings

> Status: Accepted
> Decision date: 2026-11-11
> Owner: Project owner
> Specification: [Agent Management](../specifications/agent-management.md)
> Partially supersedes: [ADR-021](adr-021-shared-configured-agent-registry.md), configuration-only registration and definition-loading behavior
> Implementation status: Implemented, validated and owner-accepted on 2026-11-11. Current delivery and verification are recorded in the Specification.

## Context

At decision time, named Agents require a complete `agents.list[]` entry. Their Context
already lives under Home `agents/<id>`. A new Home therefore cannot discover a
named Agent from its files alone. Keeping description/model policy independently
in both MD prose and configuration would also create conflicting instructions.

## Options

1. Keep configuration as registration authority. Simple, but fails the requested
   fresh-Home discovery and makes Settings a prerequisite.
2. Overlay installed templates, Home files and configuration as independent
   registration sources. Deleted Agents can reappear and precedence multiplies.
3. Seed Home once, discover only Home definitions, then apply sparse configuration
   overrides. One definition source and one effective registry.

## Decision

Choose option 3.

- Installed templates are initialization material only. Home files become the
  sole runtime definition source.
- A directory's `IDENTITY.md` frontmatter supplies description and optional model
  recommendation. Its body remains child Context.
- Load metadata and supported Context bodies once at startup. Execution and
  read-only Settings use the same running snapshot. Manual file edits require
  restart; do not add per-task disk reads, file watching, disk-version comparison
  or external-edit recovery. Supported Settings saves remain the explicit
  dynamic-update path and do not adopt unrelated disk edits.
- `agents.list[]` remains the configuration override surface, not a registration
  list. Missing entries mean default enabled with MD metadata.
- Build one effective registry for parent introduction and execution lookup.
- If no executable specialist profile exists, retain logged `general-purpose`
  fallback for task continuity, even for missing/invalid definitions. Keep
  discovery diagnostics; do not add a known-invalid execution state requiring
  failure. Explicitly disabled IDs are rejected even without a valid definition.
- Strip structured frontmatter from child prompt content. Do not inject a stale
  recommended model or approval policy as if it were the active policy.
- Publish enablement and shared/named approval-policy changes for subsequent
  Turns without restart. Runtime captures policies at Root admission and Child
  profile selection and passes them to AgentRunner, which does not read config.
  Each new child selects latest applied shared Tool defaults plus its own Agent
  override, not the parent's captured Tool policy. This also applies recursively:
  named-parent-specific denies are not implicitly added to another child's
  policy. Parent `task` permission and depth checks remain enforced.
  Refresh parent discovery on its next Turn. Retain the policy selected for an
  already admitted Turn; do not introduce Provider generations,
  resource retirement or cancellation merely to change a profile.
- Settings edits only enablement and Tool allow/deny. MD is read-only;
  description and model remain definition/configuration data, not UI editors.
- `general-purpose` is a fixed, non-disableable built-in entry, not an MD
  definition. Its Tool controls edit shared `agents.defaults.tools`, applied to
  subsequent Turns without restart. Do not create a dedicated template directory
  or named config override for it.
- Only Tool defaults become dynamic. Other defaults and the three global
  execution-policy fields retain startup behavior. Dynamic saves use the
  currently applied Tool defaults/overrides and must not apply unrelated saved
  fields that are waiting for restart.

## Consequences

Positive:

- Fresh Home works without Settings edits.
- Empty directories and user deletions remain intentional.
- Parent descriptions and child instructions retain distinct purposes.
- Approval policy remains enforced by code, not by MD wording.

Costs:

- Metadata parsing, package template inclusion and discovery diagnostics become
  required behavior.
- Existing MD without required metadata does not register a specialist; ordinary
  diagnostics and general-task fallback apply, without migration handling.
- Existing parent prompts can mention an Agent disabled after that Turn started.
  Task admission must explicitly reject that disabled ID rather than falling back.
- Editing Context through Settings would add file-write semantics and is excluded
  by the owner's read-only requirement.
- ADR-021's configuration-only registration rule is superseded by this decision;
  its shared Agent identity and unchanged Child lifecycle remain valid.

## Direct cutover

The owner excluded compatibility and migration. Consume supported fields under
the new contract and ignore unrecognized historical content. Do not add even a
legacy-detection branch, conversion, cleanup, repair workflow or fallback
registration source to support an old format.

No automatic MD rewrites, migration tools/examples, upgrade-specific tests or
paired-file rollback requirements. Ordinary discovery diagnostics and task
fallback remain; they are not a migration mechanism.

## Validation and delivery

Validate seed-once templates, startup definition snapshots, prompt/task registry
consistency, general fallback versus explicit disablement, latest shared Tool
defaults plus local overrides, and per-Turn policy capture. Verify preservation
of pending-restart fields and existing model, approval and lifecycle behavior.

The owner accepted this decision and authorized proceeding on 2026-11-11.
Implementation and validation are complete; current verification is recorded in
the [Specification](../specifications/agent-management.md). The owner confirmed
delivery and authorized archive/commit on 2026-11-11. Migration is not a
prerequisite.
The owner accepted the refined Settings UX on 2026-11-11 and authorized its
related test/documentation closeout. This does not change policy publication or
startup snapshots.
No Spike is required solely for file discovery; resolve concrete packaging or
publication uncertainties with bounded tests, without a new reload framework.

Process authority: [Development Workflow](../governance/development-workflow.md).
