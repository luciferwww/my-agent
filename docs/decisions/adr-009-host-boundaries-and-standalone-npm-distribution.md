# ADR-009: Environment Host Boundaries and Standalone npm Distribution

> Status: Accepted
> Decision date: 2026-09-16
> Owner: Project owner
> Related Plan/Specification: [Standalone Host Source Layout and npm Distribution](../changes/archive/standalone-host-source-layout-and-npm-distribution/plan.md) and [Standalone Host Layout and npm Distribution Specification](../changes/archive/standalone-host-source-layout-and-npm-distribution/standalone-host-layout-and-npm-distribution-specification.md)
> Supersedes: None; refines the source/build ownership recorded by the [Standalone Service Host Specification](../specifications/standalone-service-host.md)

## Context

The canonical standalone Host is implemented and behaviorally validated, but its production entry, process lifecycle wrapper, startup acquisition support, and tests remain under `scripts/`. That location was inherited from retired prototype/test entry points and no longer represents actual ownership: the Host is a supported product executable and long-lived composition boundary.

The process-neutral Runtime is intentionally embeddable. A future VS Code Extension is foreseeable and should become a sibling environment Host that creates Runtime directly, not a client that spawns or wraps the standalone executable. This makes the distinction between executable bootstrap, standalone composition, and shared Runtime durable rather than cosmetic.

The standalone application also needs a concrete distribution path. It currently runs on Node 22 and uses ordinary JavaScript plus npm-managed native dependencies including `better-sqlite3` and `sharp`. No current requirement needs platform-native executable selection, a bundled Node runtime, or a root launcher.

A durable decision is required because the correction changes canonical production source ownership, executable structure, emitted package path, dependency direction, and distribution authority.

## Decision drivers

- Place supported production Host code under a clear production source boundary.
- Preserve one process-neutral Runtime composition and Unit lifecycle path.
- Allow standalone and future VS Code Hosts to be siblings rather than wrappers around one another.
- Separate executable side effects from testable standalone composition.
- Keep `scripts/` limited to repository operations.
- Provide one installable Node 22 npm command without inventing a platform bootstrap requirement.
- Preserve all current standalone behavior and command semantics.
- Avoid package/monorepo splitting before packaging or release constraints require it.
- Keep native dependencies under npm's supported installation model.

## Options considered

1. **Direct executable Host module:** move the current module into a production Host directory while retaining executable bootstrap, argument parsing, composition, and top-level error handling in one file. This is the smallest correction and is appropriate while only one environment Host is expected, but it keeps reusable composition coupled to executable side effects.
2. **Compiled thin entry plus environment-specific Host implementation:** create a small TypeScript executable bootstrap and keep standalone composition/process modules under a dedicated Host package directory. The npm `bin` points directly to the compiled entry. This adds one deliberate boundary and supports a future sibling VS Code Host without another release launcher.
3. **Root/package JavaScript wrapper plus compiled entry and Host implementation:** expose a stable root launcher that checks the environment or selects an artifact before loading the compiled application. This is appropriate for platform-native binaries, bundled runtimes, or pre-load compatibility logic, but none is currently required.

A separate package/monorepo split was considered premature. No current release cadence, dependency-isolation, VS Code packaging, or native ABI evidence requires independently versioned Host packages.

## Decision

Choose option 2.

### Source ownership

Environment adapters are owned under the plural Host root:

```text
src/hosts/<environment>/
```

The initial environment is `standalone`. Its package owns:

- the thin executable entry;
- standalone argument and configuration adaptation;
- standalone Runtime composition invocation;
- process signal, deadline, liveness, diagnostic, and exit policy;
- Host-specific tests.

Runtime remains owned by `src/runtime/` and does not depend on an environment Host. Core and External Extensions also do not depend on environment Hosts.

A future VS Code Host may be added as a sibling only through a separately accepted design. It must embed Runtime directly and must not import or spawn the standalone executable merely to reuse Runtime.

### Executable and distribution

The npm `bin` points directly to the compiled standalone TypeScript entry. The entry owns only executable bootstrap mechanics and fatal startup handling, then delegates to the standalone Host composition function.

No root JavaScript wrapper is introduced. A wrapper becomes eligible only when accepted requirements need behavior before loading the compiled entry, such as platform/architecture artifact selection, bundled-runtime selection, or a compatibility check that `package.json.engines` cannot represent.

The canonical initial distribution is a Node 22 npm package whose manifest `files` allowlist contains only the audited `dist/host` closure. The accepted tarball root is `package.json`, `README.md`, and `dist/host/**`; license/publication metadata is deferred to the external release decision. npm owns command shims and installation of declared JavaScript/native dependencies. The package does not bundle or rewrite `better-sqlite3`, `sharp`, or Node itself.

This decision authorizes package construction and isolated installation verification on the current OS/CPU with Node 22 and npm. It does not claim a cross-platform release matrix or guaranteed native prebuild availability, authorize registry publication, choose a final public package identity, or define release credentials, legal metadata, signing, provenance, or cadence.

### Build authority

The root TypeScript configuration excludes the standalone `entry.ts` while continuing to type-check and emit non-entry Host implementation modules and tests. The Host-specific build independently type-checks and emits the one supported executable entry from the thin bootstrap and its static dependency closure. The aggregate build runs both compilers and must not create a second executable bootstrap.

Repository scripts continue to own build, artifact audit, package verification, and smoke operations. They do not own production Host behavior.

### Compatibility

The source and emitted path migration is direct. No forwarding modules, duplicate `bin`, path aliases, or second composition root are retained. The user-visible `my-agent` command and all standalone behavior remain unchanged.

## Consequences

### Positive

- Production Host ownership becomes explicit and no longer resembles an ad hoc script.
- Standalone composition can be imported and tested without executable startup side effects.
- A future VS Code Host has a clear sibling boundary around the shared Runtime.
- The npm command remains a short direct launch chain.
- Native dependency installation remains with npm rather than a custom executable packager.
- The repository avoids a wrapper, package split, and platform release matrix without current evidence.

### Negative

- The source move affects imports, tests, TypeScript roots, emitted paths, package metadata, audits, Fitness rules, smoke verification, and documentation evidence.
- The thin entry is an additional module that requires an explicit responsibility boundary.
- A future native executable or bundled runtime may require adding a wrapper or separate distribution package through another decision.
- Actual public npm publication still requires package identity, license/legal metadata, platform support, and release-policy decisions.

## Validation

The related Specification and Plan must establish:

1. one thin executable entry invokes one standalone composition root;
2. Runtime/Core/External Extensions do not depend on environment Hosts;
3. existing standalone inputs, modes, liveness, diagnostics, shutdown, and exit behavior remain unchanged;
4. old scripts-based source and emitted entries are absent without forwarding paths;
5. the Host-specific build emits one audited executable closure and required Workspace assets;
6. the npm tarball uses an explicit allowlist, contains the `bin` target, and excludes source tests, repository scripts, local state, and concrete External Extension source;
7. an isolated tarball installation exposes and starts the `my-agent` command;
8. focused Host tests, affected Integration/Fitness tests, full regression, lint, clean build, artifact audits, smoke verification, links, and diff checks pass;
9. stable and Current Architecture authority transfers only after implementation is validated.

## Migration and rollback

Move the complete standalone Host package and tests atomically, then update build/package/audit consumers in bounded Plan items. Delete old source and emitted paths in the same Change. Rollback uses the Git checkpoint for the complete source/build layout; no runtime dual path is retained.

If implementation evidence requires a wrapper, bundled runtime, native dependency rewrite, separate Host package, behavior change, or registry commitment, Delivery stops for a new owner decision.

## Follow-up

- Accept the related Plan and Specification before Delivery.
- After validated implementation, update the stable standalone Host Specification and Current Architecture evidence, then archive the Change.
- Design any VS Code Host, native executable, portable runtime bundle, or public registry release separately.

Process authority: [Development Workflow](../governance/development-workflow.md).
