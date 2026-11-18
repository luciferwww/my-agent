# PID File Native Lock Spike

> Status: Provisional Pass on Windows; cross-platform conclusion blocked
> Authority: Non-authoritative experiment record; owner authorized isolated execution with "继续" on 2026-11-18.
> Date: 2026-11-18
> Owner: Project owner
> Decision unlocked: [Dependency and validation boundary](specification.md#accepted-dependency-and-validation-boundary)
> Results: [Executed observations and remaining gates](spike-results.md)

## Decision question and hypothesis

Can one maintained native Node binding implement a nonblocking, inspectable
PID-file lock on local Windows, Linux and macOS, without heartbeat recovery
or PID-liveness admission? Candidate: `fs-native-extensions`; do not commit to
it before evidence.

The hypothesis fails if acquisition does not exclude contenders, process death
does not release ownership, inspection releases ownership, supported binaries
cannot load, or a normally held lock prevents reading the PID record.

## Scope and method

After owner acceptance, use a small isolated fixture outside production and
the owner's Homes. Declare any candidate dependency in that fixture's manifest
before installation; do not change production dependency manifests merely to
run the experiment. Report the exact package/runtime/OS/architecture used.

Use real Node child processes with explicit ready/acquired/busy IPC messages.
Observe acquisition before killing only the fixture owner PID. Use bounded
deadlines for hangs, not sleeps or stale-age assertions as the correctness
oracle. Ensure all children are reaped before removing only fixture-owned
temporary directories.

| ID | Scenario | Required observation |
|---|---|---|
| PFS-1 | Two processes contend on a fresh and a retained file | Exactly one owner; loser preserves metadata |
| PFS-2 | Repeated acquire/release and same-process independent handles | Exclusion while held; immediate reacquisition after release |
| PFS-3 | Force-kill fixture owner | Next process acquires without deletion or lease wait |
| PFS-4 | Old/malformed record and unrelated live PID | No false busy result without a held OS lock |
| PFS-5 | Read metadata through a second process/handle | PID remains readable and another contender remains excluded |
| PFS-6 | Open/write/native-load failure | Explicit differentiated failure; no descriptor/child leaks or unlocked success |
| PFS-7 | Windows, Linux, macOS packaging | Declared binary actually loads on tested target; untested targets explicitly blocked |

Review upstream APIs and native implementation for release semantics, lock
range/whole-file differences and file-descriptor interactions. Never modify
third-party installed source to make the experiment pass. Inspect existing
Runtime release paths for residual-writer handoff; report rather than silently
change production shutdown.

## Stop conditions and deliverables

Stop and revisit the design if preserving readable PID metadata requires a
second authority file, unsupported native calls, a heartbeat protocol or a
materially larger dependency surface. Do not silently change the accepted
approach or claim Windows success establishes Linux/macOS success.

Produce bounded Results with platform evidence and failures, a candidate
accept/reject recommendation, exact remaining blockers and any required ADR
decision. No model calls, downloads of models, credentials, production Homes,
termination of user processes, production edits, commits or publication.
Dependency installation alone may access the package registry after approval.

Follow [Development Workflow](../../../governance/development-workflow.md).
