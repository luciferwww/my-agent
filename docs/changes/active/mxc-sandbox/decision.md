# Decision Draft: MXC-backed Windows Exec

> Status: Proposed
> Decision date: 2026-11-24
> Owner: Project owner
> Related Plan/Specification: [Plan](plan.md), [Draft Specification](specification.md)
> Supersedes: none
> Authority: Change-local decision proposal; not an accepted durable ADR

## Context

Current Exec approval does not confine file/network effects. The bounded
[Spike Results](spike-results.md) validate a public MXC Node SDK route on Windows
with ordinary offline tooling, constrained content access and process cleanup.
The owner selected original-directory execution and clarified that external
metadata visibility is expected, not a defect.

The remaining adoption decision crosses a dependency/runtime boundary:
the application currently requires Node 22, while the SDK's Windows stdio
requires Node 24.21+ in the Node 24 line. Windows also rewrites TEMP paths without
creating them, requiring a measured contained preparation entry for general
commands.

## Decision drivers

- Reuse a public supported isolation SDK rather than build Win32 enforcement.
- Preserve native Windows command semantics and original project paths.
- Keep approval independent from confinement and fail without hidden fallback.
- Preserve Framework/Process ownership through startup, handoff and cleanup.
- Avoid a new native helper, backend framework, work-copy or writeback system.

## Options considered

1. **Node SDK on Node 24 LTS:** measured process handles, typed errors, streams
   and lifecycle; requires explicit runtime/native-addon migration.
2. **Native CLI on Node 22:** useful Spike route, but helper spawn is not target
   readiness and a production adapter would need its own startup protocol.
3. **.NET SDK helper on Node 22:** public typed alternative, but adds a language,
   runtime packaging and IPC maintenance path not needed by measured evidence.
4. **Automatic working copy:** protects original data from command writes but
   adds tool-view consistency/copy/writeback scope; excluded by owner selection.

## Proposed decision

Use the public `@microsoft/mxc-sdk/v1` binding on supported Node 24 LTS, with
an initially Windows-only opt-in profile. Configuration is a Builtins-owned
leaf composed under global startup-only `agents.sandbox`.

Execute in original `cwd`, with configured content grants, explicit metadata
permissions and external networking denied. Do not automatically grant write
access to `cwd` or Agent Home. Allowed project data can still be destroyed;
this is confinement, not recovery.

Use a small fixed Node bootstrap within MXC to prepare owned temporary data and
then spawn the unchanged cmd invocation. The private first frame represents
actual Shell startup; all later output is user-command data. Keep the native SDK
root handle as the cleanup authority. No Core contract imports MXC types.

Replace the existing private ChildProcess-based cross-caller cleanup dependency
with a termination control, retaining the existing ProcessRegistry rather than
adding a registry. Complete canceled pending launch cleanup before forgetting it.

## Consequences

### Positive

- Windows-native tools operate on the same files as existing file tools.
- Isolation, readiness and cleanup have explicit owners without new OS code.
- Scoped content restrictions can coexist with broader metadata visibility.

### Negative

- Node/runtime/native-addon migration and native asset distribution are required.
- A contained bootstrap introduces a small private startup/output protocol.
- Commands in permitted writable roots can damage data; not all Agent tools are
  sandboxed, and CPU/memory/disk quotas are not part of the first profile.
- Shell-root completion removes descendants; detached servers must retain a
  managed root. Bootstrap/output draining requires focused integration validation.

## Validation

Use the recorded SDK/TEMP evidence, then validate the accepted private protocol,
pending-start Abort, handoff, Session/shutdown cleanup, reparse/denied content,
output fidelity and installed native assets in the implementation.

Owner acceptance must name the Node migration, bootstrap, file-only configuration
and first-profile limits. Publish accepted durable rationale/contracts to their
owning ADR/Specifications before Delivery; this Change-local draft is not authority.

## Migration and rollback

No production files, runtime or dependencies change under this proposal.
After acceptance, upgrade the declared runtime with fresh compatible native
dependencies and focused app/package validation. Sandbox-off remains the explicit
host-direct mode, never a launch-failure fallback. Do not add a Node 22 native
helper compatibility path.

## Follow-up

Accept or revise the decision and module contract before implementation.
Follow [Development Workflow](../../../governance/development-workflow.md).
