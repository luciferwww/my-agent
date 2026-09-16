# ADR-011: Standalone Agent Home Configuration Bootstrap

> Status: Accepted
> Decision date: 2026-09-16
> Owner: Project owner
> Related Plan/Specification: [Standalone Agent Home Configuration Bootstrap](../changes/archive/standalone-agent-home-configuration-bootstrap/plan.md) and [Standalone Agent Home Configuration Bootstrap Specification](../changes/archive/standalone-agent-home-configuration-bootstrap/standalone-agent-home-configuration-bootstrap-specification.md)
> Supersedes: none
> Refines: [ADR-010](adr-010-install-and-agent-home-ownership.md) configuration initialization; its ownership decision remains accepted
> Refined by: [ADR-012](adr-012-agent-home-path-unification.md), which allows standalone selection of Agent Home while preserving this document's bootstrap behavior for the selected path

## Context

ADR-010 establishes `<agentHome>/config.json` as the sole standalone configuration document and keeps Agent Context, Memory, Sessions, logs, and other mutable state under the same Agent Home. The current standalone Host reads configuration before Runtime creation, but a missing file is represented only as an in-memory empty document. Runtime bootstrap later creates Agent Context Markdown files and may initialize Memory state. A fresh Agent Home can therefore contain Context and database files without a physical configuration document.

An eventual installer or startup setup workflow should create a deliberately configured Agent Home, including Provider, Model, Extension, Host, and credential-reference choices. That product surface is not yet designed. The current application nevertheless needs one visible configuration document and one deterministic first-start behavior without guessing deployment choices or changing the existing owners of Context and capability state.

A durable decision is required because adding file creation changes configuration loading side effects, missing-file semantics, startup ordering, failure behavior, concurrency behavior, and the boundary between the standalone Host, Platform Configuration, and Runtime.

## Decision drivers

- Materialize the configuration authority that ADR-010 already assigns to Agent Home.
- Avoid an Agent Home that contains Runtime-created state but no configuration document.
- Preserve Platform Configuration as the owner of `config.json` and Core Agent Context as the owner of Context Markdown files.
- Keep one configuration read and one immutable startup snapshot.
- Never overwrite or infer user deployment policy.
- Preserve explicit Runtime composition for embedded callers.
- Keep the change replaceable by a future installer or setup workflow.
- Avoid introducing migration, repair, secret storage, locking, or a general Agent Home transaction.

## Options considered

1. **Keep an in-memory missing-file default.** This preserves current mechanics but allows a partially materialized Agent Home with no visible configuration authority.
2. **Have standalone bootstrap create an empty configuration document before strict loading.** This makes the existing authority visible without selecting a Provider, Model, Extension, Host customization, or credential source.
3. **Move configuration creation into Core Agent Context.** This reuses template mechanics but mixes configuration and Context ownership and makes Runtime responsible for Host configuration.
4. **Generate an expanded or runnable configuration.** This would freeze current defaults or guess deployment-specific Provider, Model, Extension, and secret-reference choices.
5. **Implement an installer or interactive setup workflow now.** This is the desired long-term product direction but requires separate UX, input, validation, secret, cancellation, and repair decisions.

## Decision

Choose option 2 as a bounded bootstrap behavior until a separately accepted installation workflow replaces it.

### Ownership and orchestration

The standalone Host triggers configuration bootstrap after resolving and validating `AgentPathContext` and before Extension Acquisition or Runtime creation. Platform Configuration owns creation and loading of `config.json`.

Core Agent Context continues to own creation and loading of `IDENTITY.md`, `SOUL.md`, `AGENTS.md`, and `TOOLS.md`. Its Runtime bootstrap call, template source, create-if-missing behavior, and partial-file repair semantics do not move into the Host or Platform Configuration.

Agent Home directory creation is a shared enabling operation rather than exclusive ownership of the container. Platform Configuration may ensure the container exists before creating its file; Core Agent Context may continue to ensure the same container exists before creating its four files, including for embedded Runtime callers. Neither operation owns the other module's content. Current Architecture must record this narrower meaning after implementation.

`RuntimeApp.create()` does not create or read `config.json`. Embedded callers continue to provide an already validated application projection and acquired Units.

### Missing Agent Home and configuration

For standalone startup:

1. create the resolved `agentHome` directory recursively when it is absent;
2. create `<agentHome>/config.json` as the exact UTF-8 bytes `{}\n` when the file is absent;
3. use exclusive creation so an existing path is never overwritten or truncated;
4. read and validate the resulting document through the one authoritative configuration-loading path;
5. use the resulting immutable application, Extension, and Host projections for the remainder of startup.

Creating the Agent Home container does not transfer ownership of Context, Memory, Session, Subagent, Logger, temporary, or other capability content to Platform Configuration. Existing Agent Home path validation and canonicalization remain Host-owned.

A missing document is no longer silently interpreted as an in-memory empty document by `loadAgentConfig()`. Strict missing-file behavior applies to every caller of that loader; there is no standalone-only permissive variant. Standalone invokes bootstrap first, while any future non-standalone caller of the physical loader must explicitly ensure or provision the document. Missing-after-bootstrap, unreadable, malformed, non-object, unknown-namespace, and invalid-field conditions are fatal configuration errors.

### Existing files and repeated startup

An existing `config.json` is never rewritten, formatted, merged, migrated, or repaired. Existing bytes are read once and validated under the stable Configuration contract. Repeated startup preserves user edits and produces the same projections as the existing document.

The generated `{}` deliberately preserves current default projections. It does not assert that the Agent is ready to complete a Turn. In particular, it selects no default Model, contains no credential, enables no specific External Extension entry, and makes no Provider connectivity guarantee.

### Failure and concurrency

Configuration-directory or file-creation failure is fatal before Extension Acquisition and Runtime creation. Platform Configuration catches raw filesystem errors at the bootstrap operation and exposes only stable `AgentConfigError` values with constant, bounded, secret-free messages. `AGENT_HOME_CREATE_FAILED` identifies parent creation failure, `FILE_CREATE_FAILED` identifies exclusive document creation failure, and `FILE_MISSING` identifies absence at strict read time. Existing read and validation codes remain unchanged. The standalone entry reports only the bounded wrapped message; raw filesystem messages, paths, and contents do not cross that boundary. There is no fallback location.

Exclusive creation prevents two starters from overwriting each other. This decision adds no cross-process lock or first-start transaction. A concurrent process may observe a competing creation and then follow the normal read/validation path; no guarantee is made that both concurrent first-start attempts succeed. If a process or filesystem fails after creating but before completing the short document write, the resulting invalid file is preserved and later startup fails rather than overwriting it. Operator repair remains explicit.

Once a valid empty document has been created, later Extension, Runtime, Memory, Channel, or Host failure does not delete it. No filesystem rollback is introduced.

### Preserved capability initialization

This decision does not eagerly create or move ownership of:

- Agent Context files;
- Memory databases, recall state, indexes, or embedding caches;
- Session directories or transcripts;
- Subagent directories or profiles;
- logs or temporary directories;
- Extension installation or data.

Each existing owner retains its current eager or lazy lifecycle.

## Consequences

### Positive

- A standalone-created Agent Home has a visible sole configuration document before Runtime state is initialized.
- Configuration and Context retain separate owners and lifecycle semantics.
- Existing files and deployment choices are never overwritten or inferred.
- The generated document naturally follows future hardcoded defaults rather than freezing an expanded snapshot.
- A future installer can replace the Host-triggered empty bootstrap without changing Runtime composition.

### Negative

- Creating `{}` does not make an unconfigured Agent capable of completing a default Turn.
- Platform Configuration now has a bounded filesystem-creation responsibility.
- A failed startup can leave a valid empty configuration document.
- Concurrent first startup is fail-safe against overwrite but not coordinated for universal success.
- A later installation workflow must explicitly supersede or remove automatic empty-document creation.

## Validation

Delivery must prove:

1. a missing standalone Agent Home produces only the parent directory and `config.json` before Runtime creation;
2. the initial file is exactly `{}\n` and passes the existing validator;
3. existing configuration bytes are never changed;
4. malformed or unreadable existing configuration remains unchanged and fails fatally;
5. an existing non-directory Agent Home remains rejected by path validation;
6. existing Agent Home symlink/junction canonicalization is preserved;
7. exclusive-create races never overwrite an existing document and have bounded outcomes;
8. bootstrap failure does not invoke Extension Acquisition or Runtime and creates no Context or Memory state;
9. Runtime failure after successful config creation does not roll back the document;
10. standalone still reads one configuration document once and reuses immutable projections;
11. Core Agent Context ownership and tests remain unchanged;
12. embedded Runtime behavior remains unchanged;
13. `workingDir` and `installDir` remain unmodified by configuration bootstrap;
14. focused Unit/Host/package checks, affected Integration/Fitness tests, full regression, lint, clean build, documentation links, diff checks, and independent review pass.

## Migration and rollback

No existing document is migrated. Existing deployments observe no content change. A previously absent document becomes `{}` on the next standalone startup.

Rollback restores the prior executable. The generated `{}` is a valid document under both old and new loading behavior and need not be removed. Production code contains no rollback branch or dual configuration path.

## Follow-up

Design an installer or startup setup workflow separately. It must decide Provider/Model selection, Extension provisioning, credential references, cancellation, resumability, repair, and replacement of automatic empty-document bootstrap before implementation.

Process authority: [Development Workflow](../governance/development-workflow.md).
