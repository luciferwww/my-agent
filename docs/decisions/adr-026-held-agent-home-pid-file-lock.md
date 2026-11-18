# ADR-026: Held Agent Home PID File Lock

> Status: Accepted
> Decision date: 2026-11-18
> Owner: Project owner
> Related Specification: [Runtime Composition](../specifications/runtime-composition.md)
> Supersedes: no prior ADR

## Context and decision drivers

An exclusive-create PID marker with a process-liveness probe can mistake a
reused PID for an owner. Closing the marker's descriptor after writing does
not maintain an operating-system lock. Operators still need an ordinary,
inspectable PID file and one cooperating Runtime per local Agent Home.

## Options considered

1. Keep PID-liveness admission: no native dependency, but identity ambiguity
   and stale-marker recovery races remain.
2. Directory/heartbeat locks: established portable libraries exist, but
   depend on expiration rather than immediate process-death release.
3. Dedicated SQLite lock: kernel-backed, but adds a database solely for
   ownership rather than the owner's requested observable PID-file mechanism.
4. Held OS file lock: native dependency and platform semantics require testing,
   but the kernel owns exclusion and releases ownership on process death.

## Decision

Choose a continuously held OS lock on the stable `.my-agent.pid` file.
Runtime Builder remains the lifecycle owner. PID, instance ID and start time
are diagnostic metadata only; neither their contents nor process-liveness
probes decide admission. Do not delete, rename or replace the live lock file.

Use the pinned `fs-native-extensions` 1.5.3 native binding with a narrow typed
boundary. On Windows, lock one byte beyond the bounded metadata region to
preserve ordinary PID-file inspection; elsewhere, use whole-file locks.
Do not reject operating systems by name or warn solely because a platform is
unvalidated. Actual native-backend loading/lock support decides availability;
unsupported operations fail explicitly without a PID-only fallback.
No database, heartbeat, PID-only fallback, force-unlock or new configuration.
Only documented contention is an occupied Home; other failures remain explicit.

Release after confirmed cleanup. If shutdown or failed-startup cleanup cannot
confirm resource closure, retain ownership conservatively until process exit.
Do not extend shutdown deadlines or kill an embedding process. A failed
cleanup is conservatively unconfirmed; automatic late-release/retry is not
introduced. Retained ownership must be attributable in diagnostics/reports.

The owner explicitly approved the native dependency, Windows-first implementation
and fail-closed incomplete cleanup on 2026-11-18. Linux/macOS execution remains
an explicit pre-release validation gate, not inferred from Windows success.

## Consequences

- Process death releases ownership even if the diagnostic file remains.
- Inspecting the file must not release another descriptor's lock.
- A retained file may name the last owner; existence is not an occupancy test.
- Native prebuild availability becomes a packaging concern.
- Local cooperating processes are covered; network shares and manual removal
  of a live lock file are not supported.
- An embedding process with unconfirmed cleanup must exit before retrying
  the same Home; retaining a descriptor does not keep Node's event loop alive.

## Validation and migration

Validate actual process races, clean/forced exit, metadata inspection, unrelated
live PIDs, malformed records, cleanup failures, and completed/incomplete Runtime
shutdown. Add production regression tests and generated Host/native-load checks.

Stop all old-protocol instances once before upgrading. Old binaries ignore the
new OS lock; mixed-version exclusion is not promised. Rollback likewise requires
stopping owners first. Do not automatically delete files or terminate processes.

Process authority: [Development Workflow](../governance/development-workflow.md).
