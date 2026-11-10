# Runtime Composition Specification

> Status: Stable Authority
> Contract status: Implemented and Validated
> Verified: 2026-11-10
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

`RuntimeApp.create()` requires `agentHome` as its sole architecture path input. Agent Home owns Root Agent Context, configured-Agent Context under `agents/<agentId>/`, Sessions, Memory and recall state, logs, and temporary Runtime state. It is also the relative-path anchor for Environment filesystem Tools, the default Search root, the default Exec `cwd`, prompt path rendering, and project-oriented Subagent execution.

Runtime does not infer this path from process globals and never reads configuration files. A supported or embedding Host injects one immutable Application projection. Embedding construction may omit that projection to use hardcoded defaults, but may not omit or alias Agent Home. Root user messages still enter through a registered Channel; `RuntimeApplication` exposes no direct Turn execution method.

Agent Home anchoring is not confinement. Tool-name deny is always final. In the default `manual` Session mode, structured Tool targets outside Agent Home and every Exec call require current-call Approval even when the Tool name is statically allowed; missing Approval capability fails closed. Internal allowed targets bypass Approval. A live Session may be elevated to process-local `allow_all`, which automatically authorizes every non-denied Tool without claiming that its concrete input was reviewed. Runtime does not parse command text or `cwd` as a confinement mechanism. Canonical/symlink-aware authorization, persistent grants, command patterns, executable integrity verification, and sandboxing are excluded.

## Composition invariants

- There is one authoritative composition path.
- Builtin and External Units share create, staging, start, publication, retirement, and stop.
- A candidate publishes atomically; pre-publication failure leaves current unchanged.
- Post-publication retirement failure never rolls back the new generation.
- Positive process-local generation IDs identify immutable cross-kind Provider/Tool/Hook/Channel projections and the captured default-model reference.
- Root Turns capture at start; queued work does not pin early; Children inherit Parent generation.
- Unchanged instances are reused; each instance has one lifecycle owner.
- Start follows dependency order; stop follows reverse dependency order and successful stop is not repeated.
- At most one active candidate and one pending-latest request exist. Latest-wins applies before publication, not across published generations.
- Multiple previous generations may retire independently; old pins and retirement failures do not occupy update admission.
- Candidate cleanup nonconvergence still blocks unsafe later reload. Retirement failures remain attributable and logged without rolling back publication.
- Request completion sealing cannot release a generation pin before actual worker convergence.
- Runtime library never calls `process.exit()`.

## Reload and retirement

Preflight validates Unit identity/dependencies and no-op state. Candidate creation and staging are isolated from current publication. Publication linearizes capture and reload. Generic Unit toggles retain bounded drain/Abort retirement; internal LLM configuration updates wait for old-tree pins without timeout-aborting them during ordinary operation. Shutdown retains its shared bounded convergence policy. Protected/nonconverged generations remain attributable in residual reports.

Same-identity active enable is no-op. Runtime composition has a narrow internal
`applyLlmConfiguration` entry for materialized Built-in/default changes: it can
add, replace or remove the Built-in Provider, reuses unchanged Units and updates
the default with the same publication. Default-only changes do not recreate an
unchanged Built-in instance. Failed candidates do not replace the current applied
input, and reload results contain change metadata rather than credentials.

This is not a public Extension hot-load/code-replacement API or arbitrary file
reload. SettingsManager owns Settings `load`/`update` and delegates persistence to
Platform Configuration. It serializes every acknowledged save through the
application result and required rollback; it does not rely on the generic
latest-wins reducer to queue saves.

Channels and embedding use the same `settings.execute({ requestId, action, input })`
capability through Channel capabilities and `RuntimeApplication.settings`.
Absent persisted startup editing input returns `settings_unavailable` rather
than reading or synthesizing a file. Safe load waits for current updates, retains
opaque per-section revisions, and exposes no raw credentials.

Known pre-publication LLM failure triggers target-only raw restoration with a new
revision. Published outcomes and uncertain thrown publication errors do not
authorize rollback. Rollback failure returns/logs both failures and unknown file
state without permanently rejecting later updates. Extension saves do not invoke
Runtime application; their restart flag reflects the current saved difference
from startup, including retained raw credential references.

`test_llm_model` resolves either an unpublished temporary Built-in Unit from a
candidate or a Provider in a pinned current Snapshot. The temporary Unit uses the
same Built-in factory and registration staging without publication. Loaded Tests
retain their pin across later saves/publications. Tests invoke the existing model
port with a fixed small prompt and no Session/Turn, using a fixed 30,000 ms total
preparation/invocation/cleanup deadline.

Timeout and shutdown abort the Test signal and return explicit failure. Pending
creation, invocation or cleanup keeps its temporary instance/generation protection
until actual settlement. Shutdown shares the existing remaining budget and reports
these residuals; failed temporary cleanup is a resource failure, not success.
No Extension recreation, automatic retry or generic testing framework is added.

Generation records retain lightweight state/instance IDs, not complete historical
Snapshots. Current composition and live pins own required Snapshot references.
Successful normal or late stop clears the lifecycle owner's strong reference;
protected, pending and failed owners remain available for cleanup. Completed
retirement task tracking and shutdown wait listeners are removed.

## Shutdown

Shutdown closes future admission and capture/reload, cancels queued requests with terminal request events, attempts graceful active-work drain, performs Abort convergence, seals nonconverged outcomes once, and cleans resources within one deadline budget. Late worker completion may update diagnostics but cannot rewrite sealed request outcomes.

Cleanup preserves ownership and reverse order across Units, Channels, Memory, and Logger. Failures and residual resources are reported rather than hidden or forcibly double-closed.

Settings admission closes alongside composition admission. Queued and preparing
updates cannot commit afterward; already-admitted file commits settle truthfully.
No new Runtime application starts after closing. A committed, unpublished LLM
update attempts restoration within the shared remaining budget. Settings converges
before Unit stop, or reports pending file work without assuming cancellation.
Settled file/application inconsistencies are resource failures; no permanent
SettingsManager fault gate is introduced.

## Acceptance scenarios

Cover dependency order, required/optional failure, atomic cross-kind conflict, immutable projections, unchanged-instance reuse, generation capture and Child inheritance, no-op, latest-wins, candidate rollback, publication, concurrent retirement, blocked reload after candidate-cleanup nonconvergence, queued cancellation, completion sealing, bounded Shutdown, reverse stop, and residual reports.

Dynamic LLM regressions cover successive publication while old trees remain
pinned, generation-bound default changes, default-only instance reuse, retries
after preparation failure, Built-in removal, multiple protected retirements at
shutdown, and bounded retained owners/tasks/listeners after repeated updates.

## Related authority

[Runtime](../architecture/runtime.md) owns current implementation facts, [ADR-014](../decisions/adr-014-extension-packages-and-runtime-composition.md) owns Unit composition, and [ADR-012](../decisions/adr-012-agent-home-path-unification.md) owns the shared Agent Home path context.
