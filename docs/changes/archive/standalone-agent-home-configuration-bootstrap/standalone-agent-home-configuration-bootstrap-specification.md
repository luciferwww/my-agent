# Standalone Agent Home Configuration Bootstrap Specification

> Status: Implemented and Validated
> Date: 2026-09-16
> Owner: Project owner
> Related Plan/Decision: [Standalone Agent Home Configuration Bootstrap Plan](plan.md) and [ADR-011](../../../decisions/adr-011-standalone-agent-home-configuration-bootstrap.md)
> Amends: [Configuration](../../../specifications/configuration.md) and [Standalone Service Host](../../../specifications/standalone-service-host.md)

## Purpose and observable outcome

On a standalone first start with no existing Agent Home, the application creates `<agentHome>/config.json` before Extension Acquisition and Runtime creation. The file is a visible, editable, valid empty Agent configuration document. Runtime may then initialize Agent Context and capability state through their existing owners.

The observable result is that a standalone-created Agent Home no longer contains Context or database state without the sole configuration document defined by ADR-010. The generated empty document preserves defaults but does not promise a usable default Model, Provider connection, Extension configuration, or credential.

## Scope

- standalone creation of a missing Agent Home directory for configuration bootstrap;
- exclusive creation of a missing `config.json` as `{}\n`;
- strict read and validation after bootstrap;
- existing-file preservation and repeated-start idempotency;
- creation/read failure classification and bounded diagnostics;
- startup ordering before Extension Acquisition and Runtime creation;
- bounded concurrent first-start semantics;
- preservation of Agent Context and other capability ownership;
- package and working-directory immutability evidence;
- stable/current authority transfer after validation.

## Non-goals

- an installer, interactive wizard, setup command, or configuration editor;
- selecting or validating a default Provider or Model;
- obtaining, storing, or validating credentials and secrets;
- generating an expanded snapshot of hardcoded defaults;
- moving Agent Context creation or loading out of Core Agent Context;
- eager creation of Memory, Session, Subagent, Logger, temporary, or recall paths;
- Extension installation, copying, update, marketplace, cache, or data APIs;
- Agent Home version markers, migrations, repair, reset, uninstall, or rollback transactions;
- cross-process Agent Home locking or multi-profile state partitioning;
- changing Agent Home, `workingDir`, or `installDir` selection;
- changing filesystem authorization, symlink policy, ACLs, umask, or file permission policy;
- changing Runtime Unit lifecycle, Host modes, Channel behavior, or shutdown policy.

## Boundaries and dependency direction

### Owners

- The standalone Host owns when configuration bootstrap occurs in process startup.
- Platform Configuration owns the bootstrap operation and the sole `config.json` read/validation path.
- The standalone path-context boundary continues to derive, validate, and canonicalize `agentHome`.
- Core Agent Context continues to own Context template publication into Agent Home.
- Runtime and capability modules continue to own their existing state paths and lifecycle.
- An installer or setup workflow may replace Host-triggered empty bootstrap only through a future accepted decision.

### Required direction

```text
standalone Host
    -> resolve AgentPathContext
    -> Platform Configuration bootstrap(agentHome)
    -> Platform Configuration load(agentHome/config.json) once
    -> Extension Acquisition(installDir/extensions, immutable Extension projection)
    -> RuntimeApp.create(agentHome, workingDir, immutable application projection)
         -> Core Agent Context ensure/load
         -> existing capability initialization

Platform Configuration -X-> Context templates or Runtime state
Core Agent Context -X-> config.json
Runtime -X-> config.json
workingDir -X-> configuration bootstrap
installDir -X-> mutable configuration
```

Creating the shared Agent Home container is a non-exclusive enabling filesystem operation. Platform Configuration may ensure it before creating `config.json`; Core Agent Context may continue to ensure it before creating its four files, particularly for embedded Runtime composition. It does not make either module the owner of sibling content. After delivery, Current Architecture must describe Core Agent Context as owning its Context files and ensuring their parent, not as the exclusive creator of the Agent Home container.

## Public and structural contracts

The implementation must expose one narrow Platform Configuration operation equivalent to:

```ts
function ensureAgentConfigDocument(options: {
  readonly agentHome: string;
}): Promise<void>;
```

The exact supporting type name may vary, but the semantic boundary is fixed:

- it accepts only an already resolved `agentHome`;
- it does not resolve process-global paths;
- it creates the parent directory and missing document only;
- it returns no configuration projection;
- it never modifies an existing path;
- it treats only an exclusive-create `EEXIST` result as an existing-document outcome;
- all other creation failures reject.

The bootstrap operation may perform directory creation and an exclusive create/write only. It does not open an existing document for reading, parse it, validate it, or produce projections.

`loadAgentConfig({ agentHome })` remains the sole projection loader. After direct cutover it is strict for every caller: a missing document at read time is a fatal `FILE_MISSING` error rather than an in-memory empty document. Standalone always bootstraps first. Any other caller of the physical loader must provision the document explicitly. No standalone-only permissive loader, alternate `loadOrDefault`, fallback, or dual path is retained.

`AgentConfigErrorCode` gains these stable bootstrap/read classifications:

- `AGENT_HOME_CREATE_FAILED`: parent directory creation failed;
- `FILE_CREATE_FAILED`: exclusive creation or initial write failed;
- `FILE_MISSING`: the document was absent when the strict loader performed its one document read.

Their messages are fixed, bounded, and contain no raw path, filesystem message, document content, or secret. Raw filesystem failures are wrapped inside Platform Configuration before reaching the Host entry diagnostic boundary.

The standalone Host dependency seam must allow injection of the bootstrap operation separately from `loadConfig`. Ordering tests observe `resolve paths -> bootstrap -> load -> acquisition -> Runtime` and prove bootstrap failure short-circuits all later calls.

`AgentConfigSnapshot` and its application, Extension, and Host projections remain unchanged.

## Behavior and invariants

### Missing Agent Home

Given a resolved path that does not exist:

1. create the directory recursively;
2. exclusively create `config.json` with exact UTF-8 content `{}\n`;
3. load the document once through the existing parser and validator;
4. continue startup with immutable projections.

No Context file, database, Session, Subagent, log, temporary file, Extension content, or working-directory content is created by the configuration bootstrap operation. “One document read” means one open/read of `config.json` content by the loader; path resolution, directory creation, and exclusive create attempts are not document reads, and bootstrap itself must not inspect document content.

### Existing Agent Home and document

- Existing Agent Home validation and canonicalization occur before bootstrap.
- An existing `config.json` is not opened for writing.
- Its byte content, timestamps attributable to writing, and symlink target are not changed by bootstrap.
- Valid content is loaded normally.
- Malformed, unreadable, non-object, unknown, or invalid content fails under the stable Configuration error contract.
- A directory or unsupported entry at the document path is a read/bootstrap failure and is never replaced.

### Generated document

`{}\n` intentionally contains no explicit defaults. The existing hardcoded-default merge produces the current default projections. The file does not imply operational readiness: a default Turn can still fail with no Model Reference or Provider connection.

### Repeated startup

Bootstrap is idempotent with respect to a completed document. Every later startup preserves the existing file and performs the same single authoritative read. User changes are never reconciled with a generated template.

### Owner preservation

After configuration succeeds, Runtime invokes the existing Core Agent Context initializer. It may create or supplement the four Context Markdown files under its current create-if-missing contract. This Specification neither moves nor duplicates that path.

Memory, Sessions, Subagents, Logger, and temporary paths retain current eager/lazy creation and degradation behavior. They are not evidence of configuration bootstrap completion.

## Lifecycle and resource ownership

1. Host path resolution validates `installDir`, `agentHome`, and `workingDir` without creating Runtime state.
2. Configuration bootstrap may create `agentHome` and `config.json`.
3. Configuration loading validates one physical document and returns immutable projections.
4. Extension Acquisition runs only after valid configuration.
5. Runtime creation and startup run only after valid configuration and acquisition.
6. Core Agent Context and each capability initialize their own content at existing lifecycle points.
7. Shutdown closes Runtime resources but does not remove generated configuration or other persisted state.

Configuration bootstrap has no long-lived resource after its filesystem operation settles.

## Failure, Abort, deadline, and concurrency semantics

- Parent-directory creation fails with `AGENT_HOME_CREATE_FAILED`; exclusive create/write fails with `FILE_CREATE_FAILED`.
- Missing at the strict document read fails with `FILE_MISSING`; unreadable, malformed, or invalid document loading retains its existing distinct classification.
- Failure occurs before acquisition and Runtime creation; no Runtime cleanup path is required.
- Platform Configuration wraps raw filesystem failures; Host diagnostics expose only fixed, bounded, secret-free `AgentConfigError` messages and never raw paths or platform messages.
- No alternate directory or in-memory fallback is attempted.
- The operation has no application Abort or deadline contract; it uses the existing bounded Host startup process boundary.
- Exclusive creation prevents overwrite between concurrent starters.
- `EEXIST` is accepted only as a signal to proceed to the authoritative read.
- No cross-process lock guarantees both concurrent first-start attempts succeed.
- A crash or filesystem failure that leaves an empty or partial document is not repaired automatically; later strict validation fails and preserves evidence. Tests model this deterministically through an injected exclusive-write dependency that creates controlled partial bytes and then rejects; no process-crash timing or platform permission behavior is required.
- Failures after a valid document is created do not roll back or delete it.

## Security and capabilities

- Generated content contains no secret or credential reference.
- Existing secret-safe configuration and Extension diagnostics remain unchanged.
- No `chmod`, ACL, ownership, umask, symlink-hardening, or trust-root policy is added.
- `agentHome` remains writable state; `installDir` remains immutable program publication.
- `workingDir` is not inspected or modified by bootstrap.
- Existing configuration symlink behavior is preserved rather than newly endorsed as a security boundary.

## Compatibility and migration

This is a direct behavior amendment:

- old: missing document produces in-memory defaults and no file;
- new: standalone creates a physical empty document, then loads it;
- unchanged: the resulting default projections are equivalent.

No alias, fallback document, merge source, Feature Flag, warning-only period, or automatic migration of existing content is introduced. Existing configuration remains authoritative and unchanged.

The generated `{}` remains valid if the executable is rolled back to the prior version. A future installer/setup decision must explicitly retire or replace automatic Host bootstrap; it must not silently create a second initialization path. Retirement requires removing the Host bootstrap call, amending stable Configuration and Standalone Host contracts, updating first-start package verification, and defining how an absent document is reported after installer provisioning becomes mandatory.

## Acceptance and validation

Delivery must cover:

1. exact `{}\n` creation in a previously absent Agent Home;
2. creation in an existing empty Agent Home;
3. exact preservation of valid existing configuration bytes;
4. preservation and fatal rejection of malformed existing configuration;
5. wrong-type entries and deterministic injected unreadable/create failures without depending on host ACL behavior;
6. current Agent Home symlink/junction behavior;
7. exclusive-create `EEXIST` race handling without overwrite;
8. injected parent/create/partial-write failures with exact stable codes and bounded diagnostics;
9. no Extension Acquisition or Runtime call after bootstrap/load failure;
10. no Context or Memory state before Runtime creation;
11. no rollback after later startup failure;
12. exactly one document-content read across the complete Host path and immutable projection reuse; bootstrap performs no document read;
13. unchanged Context create-if-missing tests and Runtime ownership;
14. unchanged embedded `RuntimeApp.create()` behavior;
15. unchanged `workingDir` and `installDir` trees;
16. a separate isolated built/package first-start scenario that begins without Agent Home, observes exact `{}\n`, and does not replace the existing fully configured WebSocket Turn scenario;
17. focused Configuration and Host Unit tests, affected Integration and Fitness suites, full regression, lint, clean build, package/Host checks, documentation diagnostics, links, `git diff --check`, and independent review.

## Open questions

None. The owner accepted this Specification before Delivery.

Follow [Development Workflow](../../../governance/development-workflow.md). Stable delivered amendments belong in Configuration and Standalone Service Host Specifications; this change-local Specification remains delivery provenance after closeout.
