# ADR-008: Workspace Root Configuration and State Authority

> Status: Superseded
> Decision status: Superseded by [ADR-010](adr-010-install-and-agent-home-ownership.md)
> Decision date: 2026-09-15
> Superseded: 2026-09-16
> Owner: Project owner
> Authority: Durable decision
> Related Plan: [Unified Workspace Configuration and Standalone Service Host](../changes/archive/unified-workspace-configuration-and-standalone-service-host/plan.md)
> Amended: 2026-09-15 — Workspace state also moves to root paths; `.agent` is retired
> Amended: 2026-09-15 — accepted SSH-0 adds the bounded `host` namespace and Host projection
> Accepted amendment: [Workspace Configuration and State Layout Specification](../changes/archive/unified-workspace-configuration-and-standalone-service-host/workspace-configuration-specification.md)
> Supersedes: the configuration-location portions of the current Configuration and Extension Acquisition contracts; authority transfers during the related Change

## Context

The repository currently reads application configuration from `<workspace>/.agent/config.json` and Extension enablement/configuration from `<agent-home>/config.json`. A supported standalone Host must choose a Workspace, acquire Extension artifacts, select optional Channels, configure logging, and create one Runtime without assembling contradictory configuration snapshots.

Keeping two configuration documents creates separate ownership, parsing, failure, and deployment surfaces. Moving all configuration under Agent Home would make Agent, Logger, and Extension policy global across unrelated Workspaces sharing the same installed Extension artifacts. Reading one physical file independently in Host and Runtime could also produce different startup snapshots.

Workspace-local configuration and Agent Home artifact discovery are separate concerns. The project owner also requires Workspace state to be directly rooted under `workspaceDir`, without a hidden `.agent` container. A durable authority decision is required because the target changes configuration and state locations, startup ownership, Runtime input, Extension Acquisition input, malformed-file behavior, and Compatibility policy.

## Decision drivers

- Give one Workspace one explicit, discoverable configuration authority.
- Preserve independent policy for Workspaces sharing installed Extensions.
- Read and parse configuration once per startup attempt.
- Keep embedded Runtime behavior independent of process-global path resolution.
- Keep Agent Home focused on Extension installation and discovery.
- Preserve the one Runtime Unit lifecycle and Registry-publication path.
- Remove duplicate paths rather than create permanent precedence or Compatibility rules.
- Keep runtime state separate from human-authored root configuration.
- Remove the hidden `.agent` indirection while keeping internal state distinct from user-authored Memory inputs.

## Options considered

1. **Workspace-root authority:** use `<workspace>/config.json`, keep Agent Home as the Extension artifact root, and project one immutable startup snapshot to Runtime and Extension Acquisition.
2. **Agent Home authority:** use `<agent-home>/config.json` for all settings. This centralizes installation configuration but couples unrelated Workspaces to one Agent/Logger/Extension policy.
3. **Layered Workspace and Agent Home files:** retain both documents with merge precedence. This preserves flexibility but creates two authorities, migration rules, and conflict semantics.
4. **One Workspace file read independently by Host and Runtime:** unify only the path. This is mechanically smaller but can observe two document versions and duplicates parsing/failure behavior.

## Decision

Choose option 1: Workspace-root authority with one immutable startup snapshot.

### Configuration and state locations

`<workspace>/config.json` is the sole configuration document. It contains the accepted `agents`, `logger`, `extensions`, and `host` namespaces. Unknown top-level namespaces are rejected so misspellings cannot silently disable policy. Any later namespace requires an accepted contract that explicitly amends the reader and stable authority.

The Workspace has no `.agent` directory. State owners use these direct paths:

```text
<workspace>/IDENTITY.md
<workspace>/SOUL.md
<workspace>/AGENTS.md
<workspace>/TOOLS.md
<workspace>/sessions/
<workspace>/memory.sqlite
<workspace>/memory-recalls/
<workspace>/subagents/
<workspace>/logs/
```

Existing user Memory inputs remain `<workspace>/MEMORY.md` and `<workspace>/memory/`. Internal recall state uses `memory-recalls/` so it cannot be mistaken for or indexed as user-authored Memory. Existing storage formats are unchanged; only ownership paths move. Workspace bootstrap preserves the existing ability to create a missing Workspace before initializing root Context files; other state directories retain their capability-owned eager or lazy creation behavior.

Agent Home remains independently selected and contains installed Extension artifacts under `<agent-home>/extensions/`. It does not own Workspace configuration.

### Snapshot and dependency direction

The outer composition boundary reads the Workspace document once and creates deeply immutable application, Extension, and Host projections from that parsed document version. Cross-projection object identity is not required. Runtime consumes the application projection, Extension Acquisition consumes the Extension projection, and the standalone process Host consumes the Host projection. No consumer rereads the document, and Extension Acquisition does not read Agent Home configuration.

Runtime continues to own Unit creation, staging, validation, publication, retirement, stop, and immutable generations. Acquisition continues to return uncreated `LoadedRuntimeUnit[]`. This decision changes configuration input, not Unit lifecycle ownership.

Embedded callers explicitly select `workspaceDir` and provide the application projection and acquired Units. Generic Runtime does not infer Workspace or Agent Home from `process.cwd()` or process-global environment.

### Failure policy

A missing Workspace document is a valid default state. An existing unreadable, malformed, or non-object document is a fatal startup configuration error. Known namespace structural errors are attributed and fatal. Secret values and unbounded document content are excluded from diagnostics.

This strict existing-file policy replaces the permissive malformed application-file fallback because one malformed document can also contain Extension enablement and scoped secrets.

### Migration and Compatibility

The migration directly replaces both `<workspace>/.agent/config.json` and `<agent-home>/config.json` and every production `.agent` state path. Neither configuration path remains a fallback or merge input. No production component reads, creates, migrates, or deletes a pre-existing `.agent` directory after cutover. Retained state requires an operator-controlled, offline move with backup and explicit conflict resolution; there is no automatic merge. No forwarding API, automatic migration, dual-read period, or Feature Flag is introduced.

The related Plan moves maintained fixtures/examples and synchronizes stable Specifications and Current Architecture during delivery. Historical archives remain unchanged unless they are an active index or would otherwise direct current usage.

## Consequences

### Positive

- Every Workspace has one visible configuration authority.
- Context and runtime-state ownership is directly visible at the Workspace root.
- Workspaces can share installed Extension artifacts without sharing policy or secrets.
- Runtime and Extension Acquisition observe the same startup document version.
- Embedded composition stays explicit and process-neutral.
- Agent Home has one narrower purpose: Extension installation and discovery.
- No permanent file-precedence or Compatibility system is required.

### Negative

- Existing deployments must move both old files into one Workspace-root document.
- Existing deployments must separately move any retained Context, Session, Memory, recall, or Subagent data; the application does not migrate `.agent` automatically.
- Malformed application configuration becomes fatal instead of silently using defaults.
- Runtime bootstrap and Extension Acquisition signatures must accept injected projections.
- The supported Host must resolve Workspace before Extension acquisition.
- Root-level configuration, Context files, `sessions/`, `subagents/`, `memory.sqlite`, and `memory-recalls/` reserve visible Workspace names that embedding projects must accept or deliberately isolate through their selected `workspaceDir`.

## Compliance

The related Change must add focused tests for single-read projection, strict failure behavior, multi-Workspace Extension configuration, immutable snapshots, root Context initialization, Session/Memory/recall/Subagent paths, `.agent` residual removal, direct cutover, and unchanged Runtime Unit lifecycle. Current Architecture and stable Specifications become implementation authority only after delivery validation.