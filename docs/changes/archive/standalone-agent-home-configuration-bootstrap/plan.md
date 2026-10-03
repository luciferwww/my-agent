# Standalone Agent Home Configuration Bootstrap Plan

> Status: Archived and Validated
> Date: 2026-09-16
> Accepted: 2026-09-16
> Validated: 2026-09-16
> Archived: 2026-09-16
> Owner: Project owner
> Type: Architecture Slice
> Decision: [ADR-011](../../../decisions/adr-011-standalone-agent-home-configuration-bootstrap.md)
> Contract: [Standalone Agent Home Configuration Bootstrap Specification](standalone-agent-home-configuration-bootstrap-specification.md)
> Validation record: [Validation](validation.md)
> Refines: configuration initialization under [ADR-010](../../../decisions/adr-010-install-and-agent-home-ownership.md)

## 1. Goal

Ensure standalone startup materializes the sole Agent Home configuration document before any Extension or Runtime initialization. A missing `<agentHome>/config.json` becomes an exclusively created `{}\n` document and is then loaded through the one strict configuration path.

The Change keeps Core Agent Context as the sole owner of Context Markdown initialization and keeps every other capability's state lifecycle unchanged. It does not attempt to make an empty configuration operationally complete; a future installer or setup workflow will own deliberate Provider, Model, Extension, and credential-reference choices.

## 2. Proposed direction

1. Add one narrow Platform Configuration bootstrap operation that receives an already resolved `agentHome`.
2. Let that operation create a missing Agent Home container and exclusively create a missing `config.json` as `{}\n`.
3. Never open an existing configuration path for writing and never overwrite, merge, format, migrate, or repair it.
4. Invoke bootstrap from the standalone Host after path resolution and before the one configuration read, Extension Acquisition, and Runtime creation.
5. Remove `loadAgentConfig()`'s missing-file in-memory fallback for every caller; missing at read time becomes fatal after bootstrap, with no permissive standalone or programmatic variant.
6. Preserve one physical read and one immutable application/Extension/Host snapshot.
7. Preserve current Agent Home directory validation and symlink/junction canonicalization.
8. Preserve Core Agent Context initialization in Runtime bootstrap without a second Context path or owner.
9. Preserve Memory, Session, Subagent, Logger, temporary, Extension, Runtime, Channel, and shutdown behavior.
10. Treat `EEXIST` as an exclusive-create race and proceed to strict read, without adding cross-process locking or guaranteeing both concurrent first starts succeed.
11. Keep a successfully generated document after later startup failure; add no filesystem rollback.
12. Update stable Configuration and Standalone Service Host contracts, Current Architecture—including Agent Context's non-exclusive parent-directory wording—README, package verification, and authority indexes only after implementation evidence passes.

## 3. Delivery sequence

| Item | State | Scope | Exit condition |
|---|---|---|---|
| ACB-0 | Completed | Review and accept ADR-011, this Plan, and the change-local Specification | Owner accepted ownership, ordering, exact bytes, strict missing-file cutover, concurrency limits, failure persistence, non-goals, and validation obligations on 2026-09-16 |
| ACB-1 | Completed | Add the Platform Configuration bootstrap primitive, stable bootstrap errors, and globally strict physical loading semantics | Focused tests prove missing-parent creation, exact bytes, no overwrite, malformed preservation, exact error classification, no bootstrap read, and bounded injected race/partial-write behavior |
| ACB-2 | Completed | Add an injected Host bootstrap seam before config loading/acquisition/Runtime and preserve all other owners | Host tests prove `paths -> bootstrap -> one document read -> acquisition -> Runtime`, failure short-circuit, no Context/Memory creation before Runtime, and unchanged existing-config behavior |
| ACB-3 | Completed | Add a separate isolated package first-start scenario and transfer stable/current/README authority | Missing-home package startup creates exact config bytes, the configured WebSocket Turn smoke remains distinct, installation/working trees remain unchanged, and authority agrees |
| ACB-4 | Completed | Run final Gate, independent review, owner closeout, and archive | Automated Gate, independent review, authority transfer, project-owner closeout, and archive passed on 2026-09-16 |

## 4. Acceptance criteria

- Standalone configuration bootstrap runs after `AgentPathContext` resolution and before configuration loading, Extension Acquisition, or Runtime creation.
- A missing resolved Agent Home is created recursively.
- A missing `config.json` is created once with exact UTF-8 bytes `{}\n`.
- Exclusive creation is used; existing paths are never overwritten or truncated.
- Existing valid configuration bytes remain unchanged and produce the same projections.
- Existing malformed, unreadable, wrong-type, or invalid configuration is preserved and fails fatally.
- Missing configuration at strict read time no longer produces an in-memory empty document for any `loadAgentConfig()` caller.
- Exactly one document-content read across the complete Host path produces immutable application, Extension, and Host projections; bootstrap does not read content.
- `EEXIST` proceeds to strict read; no cross-process lock or universal concurrent-success promise is introduced.
- A partial file left by a process/filesystem failure is preserved and rejected rather than automatically repaired.
- Parent creation, document creation, and strict missing-read failures have distinct stable, bounded, secret-free error codes/messages; configuration bootstrap failure prevents Extension Acquisition and Runtime creation.
- A valid generated document remains after any later startup failure.
- Core Agent Context retains its Runtime-owned create-if-missing behavior and template source.
- No eager initialization is added for Memory, Sessions, Subagents, logs, temp, recall, or Extensions.
- Embedded Runtime composition remains free of physical configuration reads/writes.
- No file under `workingDir` or `installDir` is created or changed by bootstrap.
- Generated `{}` is documented as a physical default document, not a readiness or successful-Turn guarantee.

## 5. Non-goals

- installer, setup command, interactive wizard, or configuration editor;
- default Provider/Model inference or connectivity preflight;
- credential collection, secret storage, or secret-file permissions;
- expanded default configuration generation;
- Context ownership or template changes;
- Agent Home transaction, rollback, repair, reset, version marker, or migration framework;
- cross-process locking or multi-profile support;
- Extension provisioning or package management;
- filesystem authorization, ACL, umask, or symlink security redesign;
- Runtime lifecycle, Host mode, Channel, or shutdown changes.

## 6. Validation strategy

Use impact-driven checks during Delivery and broad validation only at ACB-4.

- ACB-1: focused Platform Configuration tests for exact creation, globally strict loading, fixed error codes/messages, preservation, zero bootstrap reads, and deterministic injected race/partial-write failures. Use injected errors and wrong-type paths rather than platform ACL assumptions.
- ACB-2: focused standalone composition tests using an injected bootstrap dependency for complete ordering, one document-content read, failure short-circuit, existing documents, and Runtime boundary preservation; retain Agent Context tests unchanged.
- ACB-3: clean Host build, Host asset audit, npm package audit, a separate missing-home installed-command first-start check, the retained configured WebSocket Turn smoke, separate Agent Home/working directory/install tree snapshots, documentation diagnostics, and authority links.
- ACB-4: affected Integration and Fitness suites, `npm run test:all`, `npm run lint`, clean `npm run build`, `npm run verify:package`, applicable WebSocket Host verification, residual scans, links, `git diff --check`, and independent review.

No broad suite is repeated after documentation-only edits unless Fitness or package authority changes require it.

## 7. Stop conditions

Stop for owner review if evidence requires:

- moving Context creation into Host or Platform Configuration;
- making Runtime read or create `config.json`;
- writing an expanded, Provider-specific, Model-specific, Extension-specific, or secret-bearing default;
- retaining the missing-file in-memory fallback as a second production path;
- adding cross-process locks, setup state markers, repair, migration, rollback, or a second initialization entry;
- changing Agent Home selection or standalone path precedence;
- changing Extension acquisition, Runtime Unit lifecycle, Host mode, Channel behavior, or shutdown policy;
- writing into `workingDir` or `installDir`;
- undocumented platform-specific atomicity or filesystem assumptions.

## 8. Completion and authority transfer

The Change remains active until implementation and validation complete. After ACB-4:

1. ADR-011 records the durable bootstrap decision and ADR-010 remains accepted ownership authority;
2. stable Configuration and Standalone Service Host Specifications carry delivered behavior;
3. Current Architecture records only verified implementation facts;
4. README describes generated `{}` and the continued need to configure a Provider/Model/credentials;
5. this Change records commands/results and moves to `docs/changes/archive/` after owner closeout;
6. a future installer/setup workflow requires a separate accepted decision and must explicitly replace automatic empty bootstrap.

Replacement includes deleting the Host bootstrap call, amending stable Configuration and Standalone Host contracts, updating package first-start verification, and defining the mandatory-provisioning missing-document diagnostic. A second installer-plus-Host creation path is not allowed.

Follow [Development Workflow](../../../governance/development-workflow.md).
