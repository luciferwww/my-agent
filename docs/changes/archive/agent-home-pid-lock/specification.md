# Agent Home PID File Lock Specification

> Status: Validated and owner-accepted for the approved Windows scope; archived on 2026-11-18 with platform/install limitations retained
> Authority: Non-authoritative target design; not implemented behavior.
> Date: 2026-11-18
> Owner: Project owner
> Related Plan: [Agent Home PID File Lock](plan.md)

## Purpose and scope

One Agent Home admits at most one cooperating Runtime owner. Preserve an
operator-readable `.my-agent.pid`, but decide admission using a held OS lock
rather than file existence, PID reuse or lease expiration.

Use a native binding on local filesystems without a platform-name allowlist
or warning solely for an unvalidated platform. Actual native-backend support
decides availability; loading/operation failures stay explicit. Do not claim
cross-platform validation from a Windows-only
run. Network shares and hostile/manual deletion or replacement of a live
lock file are outside this contract.

## Boundaries and public contracts

Runtime Builder remains the lifecycle owner and acquires ownership before
Bootstrap opens Home resources. The existing lock helper encapsulates the
native operation. Core, Channels, Extensions and configuration gain no lock
dependencies, mode settings or process-control APIs.

Retain `acquireAgentHomeLock(agentHome)` and the returned asynchronous
`release()` contract. Keep `AgentHomeLockedError` for genuine contention and
an optional diagnostic PID; no unverified PID may decide ownership.

## Acquisition and metadata

1. Create the Home directory if needed. Open the stable PID pathname with
   create-if-absent/read-write semantics, never truncate before acquiring.
2. Try a nonblocking exclusive lock on the stable backing file. A missing,
   empty, stale or malformed record is not proof of contention.
3. If acquisition succeeds, replace the metadata with the existing bounded
   JSON record fields `pid`, `instanceId` and `startedAt`. Publish the lock
   handle only after the record is successfully written.
4. If acquisition conflicts, leave the file and its contents unchanged.
   Report a busy Home and owner metadata only when it can be read safely;
   unreadable/invalid owner information must be described as unavailable.
5. Hold the acquired descriptor/lock continuously through Runtime ownership.
   Another descriptor opened just to inspect metadata must neither release
   nor weaken the owner's lock.

The file must remain normally inspectable while ownership is held, including
on Windows. Windows uses the verified one-byte lock at offset 1 MiB, outside metadata
bounded to 4096 bytes; it does not extend the file. Other platforms use whole-file
locks. A lock preventing ordinary PID-record inspection is not sufficient.

## Release, failure and shutdown

Completed shutdown releases ownership exactly once by unlocking/closing the
owned descriptor. Keep the PID file at its stable pathname; neither normal
release nor the next startup unlinks or renames it. Retained contents describe
the last recorded owner, not proof of a currently running instance.

Process termination releases the operating-system lock. Startup can then
acquire immediately even if the old metadata is intact. Do not wait for a
staleness timeout or inspect whether the old PID happens to exist.

Partial initialization must close every locally opened descriptor and preserve
the primary acquisition/write failure. Report cleanup failure explicitly.
Only documented lock-conflict results become `AgentHomeLockedError`; permission,
unsupported operation, native-addon loading and I/O errors remain distinguishable.
No fallback to PID probing, marker deletion or a success-shaped unlocked mode.

Normal completed shutdown must permit another owner. A shutdown timeout must
not permit two surviving Home writers to overlap. If cleanup is failed or residual, conservatively retain ownership until process
exit, with explicit diagnostics/reporting. Do not add automatic late release,
retry, a new timeout or process termination. This may require an embedding Host
to exit before retrying the Home, even if a pending cleanup later settles.

Manual removal of a live lock file is unsupported even on systems that permit
it. Do not offer a force-delete/unlock command or terminate another process.

## Compatibility and migration

Stop all old-protocol instances before the first upgraded startup. Holding an
OS lock cannot protect against old binaries that ignore it. After that one-time
cutover, do not interpret a leftover record from an old instance as an active
lock. Existing metadata shape remains diagnostic only.

No automatic Home edits during preparation, no PID-liveness compatibility path,
no database lock, heartbeat timer, Settings surface or mixed-version guarantee.

## Acceptance and validation

- Two simultaneous processes targeting one fresh or residual-file Home yield
  exactly one owner; a contender cannot truncate or replace the owner's record.
- Different Homes admit independent owners. Same-process acquisitions still
  exclude one another under the chosen binding.
- Clean release and hard-kill release both allow the next acquisition without
  deleting files, elapsed-time inference or stale-process probing.
- Existing or malformed metadata, including a PID belonging to an unrelated
  live fixture process, does not prevent acquisition when no OS lock is held.
- Inspect the record from another handle/process while held, then verify a
  third acquisition remains excluded.
- Check initialization failures, repeated release, descriptor cleanup and
  distinct permission/native-operation failures.
- Verify startup cleanup and safe completed/residual shutdown with real
  Runtime/Host callers, not only mocked lock operations.
- Candidate validation uses the [bounded Spike](spike-specification.md).
  Delivery adds focused Unit/contract/integration tests and the Plan's owning
  documentation, lint/build and generated-Host checks.

## Accepted dependency and validation boundary

Owner approved pinned `fs-native-extensions` 1.5.3, the verified Windows
range/Unix whole-file policy, a narrow typed dependency boundary, and
conservative retained ownership on 2026-11-18. See
[ADR-026](../../../decisions/adr-026-held-agent-home-pid-file-lock.md).
Linux/macOS actual execution remains a pre-release gate; this Delivery can
validate Windows without describing other platforms as tested.

Follow [Development Workflow](../../../governance/development-workflow.md).
