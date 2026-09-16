# Runtime Composition Specification

> Status: Stable Authority
> Contract status: Implemented and Validated
> Verified: 2026-09-16
> Authority: Stable Unit, generation, reload, retirement, and Shutdown contract

## Scope

Own loaded Unit catalog, dependency ordering, Unit creation/staging/start, candidate validation, immutable Registry publication, process-local generations, capture/inheritance, reload coordination, retirement, lifecycle ownership, completion sealing, bounded Shutdown, and routing of explicit Agent Home to Runtime resources.

## Public control

```ts
interface RuntimeHandle {
  readonly application: RuntimeApplication;
  readonly composition: RuntimeCompositionControl;
  close(reason?: string): Promise<RuntimeShutdownReport>;
}
interface RuntimeCompositionControl {
  enableUnit(unitId: string): Promise<RuntimeReloadResult>;
  disableUnit(unitId: string): Promise<RuntimeReloadResult>;
}
```

Reload results distinguish publication, no-op, rejection, supersession, blocking, and shutdown cancellation.

## Runtime path ownership

`RuntimeApp.create()` requires `agentHome` as its sole architecture path input. Agent Home owns Agent Context, Sessions, Memory and recall state, Subagent profiles, logs, and temporary Runtime state. It is also the relative-path anchor for Environment filesystem Tools, the default Search root, the default Exec `cwd`, prompt path rendering, and project-oriented Subagent execution.

Runtime does not infer this path from process globals and never reads configuration files. A supported Host injects one immutable Application projection. Direct library callers may omit that projection to use hardcoded defaults, but may not omit or alias Agent Home.

Agent Home anchoring is not confinement. Structured Tool targets outside Agent Home require current-call Approval and fail closed when Approval capability is absent; Tool-name deny remains final, while internal allowed targets bypass Approval. Exec is arbitrary Shell authority: deny blocks it, allow permits it without Approval, and otherwise it requires current-call Approval. Runtime does not parse command text or `cwd` as a confinement mechanism. Canonical/symlink-aware authorization, persistent grants, command patterns, and sandboxing are excluded.

## Composition invariants

- There is one authoritative composition path.
- Builtin and External Units share create, staging, start, publication, retirement, and stop.
- A candidate publishes atomically; pre-publication failure leaves current unchanged.
- Post-publication retirement failure never rolls back the new generation.
- Positive process-local generation IDs identify immutable cross-kind Provider/Tool/Hook/Channel projections.
- Root Turns capture at start; queued work does not pin early; Children inherit Parent generation.
- Unchanged instances are reused; each instance has one lifecycle owner.
- Start follows dependency order; stop follows reverse dependency order and successful stop is not repeated.
- At most one active candidate, one retiring generation, and one pending-latest request exist. Latest-wins applies before publication.
- Candidate cleanup or retirement nonconvergence blocks unsafe later reload.
- Request completion sealing cannot release a generation pin before actual worker convergence.
- Runtime library never calls `process.exit()`.

## Reload and retirement

Preflight validates Unit identity/dependencies and no-op state. Candidate creation and staging are isolated from current publication. Publication linearizes capture and reload. The prior generation retires only after leases drain or bounded Abort convergence completes. Protected/nonconverged generations remain attributable in residual reports.

Same-identity active enable is no-op; this contract does not support live code replacement, arbitrary file reload, multi-instance identity, or multiple simultaneous retiring generations.

## Shutdown

Shutdown closes future admission and capture/reload, cancels queued requests with terminal request events, attempts graceful active-work drain, performs Abort convergence, seals nonconverged outcomes once, and cleans resources within one deadline budget. Late worker completion may update diagnostics but cannot rewrite sealed request outcomes.

Cleanup preserves ownership and reverse order across Units, Channels, Memory, and Logger. Failures and residual resources are reported rather than hidden or forcibly double-closed.

## Acceptance scenarios and evidence

Cover dependency order, required/optional failure, atomic cross-kind conflict, immutable projections, unchanged-instance reuse, generation capture and Child inheritance, no-op, latest-wins, candidate rollback, publication, retirement, blocked reload after nonconvergence, queued cancellation, completion sealing, bounded Shutdown, reverse stop, and residual reports.

Evidence: [Runtime contracts](../../src/runtime/types.ts), [bootstrap](../../src/runtime/bootstrap.ts), [Tool Approval policy](../../src/runtime/tool-approval-policy.ts), [composition source](../../src/runtime/runtime-composition.ts), [manager](../../src/runtime/runtime-composition-manager.ts), [reload coordinator](../../src/runtime/reload-coordinator.ts), [lifecycle](../../src/runtime/runtime-lifecycle.ts), [manager tests](../../src/runtime/runtime-composition-manager.test.ts), and [Runtime tests](../../src/runtime/RuntimeApp.test.ts). Decisions: [ADR-005](../decisions/adr-005-extension-registry-runtime-composition.md), [ADR-010](../decisions/adr-010-install-and-agent-home-ownership.md), and [ADR-012](../decisions/adr-012-agent-home-path-unification.md).
