# PID File Native Lock Spike Results

> Status: Provisional Pass on Windows; cross-platform conclusion blocked
> Executed: 2026-11-18
> Environment: Windows x64, Node v22.22.2, fs-native-extensions 1.5.3
> Owner: Project owner
> Authority: Evidence only; not production acceptance
> Experiment: [Spike Specification](spike-specification.md)

## Question and method actually executed

Can the [target design](specification.md) retain an inspectable PID file with
held OS-lock exclusion and automatic release on process death?

After owner authorization with "继续", installed the pinned candidate only
in a private session fixture with its own dependency manifest and lockfile.
Used `npm install --ignore-scripts --no-audit --no-fund`: six packages installed,
and the packaged native addon loaded without a build or install script.
Production manifests and lock implementation were not edited.

The fixture used Node's built-in test runner, actual child processes and IPC
readiness/acquisition/release acknowledgements. Ran
`node --test --test-timeout=90000 lock.test.mjs`: **11 tests passed**, no failures,
cancellations or skipped tests; runner duration was approximately 7.8 seconds.
Ten-second response deadlines detected hangs; no lease, staleness sleep or PID
liveness probe decided success.

Tested the default whole-file lock first, then a supported byte-range lock for
Windows: one byte at offset 1 MiB, outside a fixture-enforced 4096-byte metadata
bound. The offset is not written, does not extend the file, and is not another
authority file. This is a tested candidate policy, not an accepted production
implementation detail. Non-Windows fixture code used whole-file locks, but
was not executed here.

## Evidence

| ID | Observation | Result |
|---|---|---|
| PFS-1 | Six fresh-file and six retained-file simultaneous two-process races each admitted exactly one owner; a subsequent contender stayed excluded and owner metadata remained unchanged | Pass on Windows, 12 races |
| PFS-2 | Independent handles in one process excluded one another; clean unlock and descriptor close without explicit unlock both permitted acquisition; different files admitted independent owners | Pass on Windows |
| PFS-3 | Six owner processes were forcibly terminated using their own spawned child handles/PIDs; after observed termination the next owner acquired while the old PID record remained | Pass on Windows, six cycles, no deletion/lease wait |
| PFS-4 | Empty and malformed metadata and a record naming the still-live fixture parent did not prevent acquisition; fresh-file cases also passed | Pass on Windows |
| PFS-5 | Default whole-file locking made ordinary `readFile` fail with `EBUSY`; the out-of-record range permitted Node and PowerShell `Get-Content` inspection, kept the file at metadata length, and still excluded another owner after inspection | Whole-file approach fails readability; range candidate passes on Windows |
| PFS-6 | Invalid open target and invalid native descriptor produced errors rather than contention; an injected post-acquisition `EBADF` write failure closed the descriptor and permitted another owner | Partial: tested error paths pass; real ACL denial and absent native binary not exercised |
| PFS-7 | Windows x64 prebuilt addon loaded under Node 22; tarball contains Windows x64/arm64, Linux x64/arm64 and macOS x64/arm64 prebuild directories | Windows runtime pass; Linux/macOS runtime untested |

Closing a metadata-inspection handle did not release another handle's ownership.
No file was truncated before acquiring its lock. Every successful fixture
acquisition wrote the existing `pid`, `instanceId`, `startedAt` JSON shape.

## Upstream facts and limitations

Inspected tagged source, rather than assuming all platforms implement `flock`:

- [Windows implementation](https://github.com/holepunchto/fs-native-extensions/blob/v1.5.3/src/win32.c)
  uses nonblocking `LockFileEx` and `UnlockFileEx`. This explains why locking
  the metadata bytes prevents ordinary Windows reads.
- [Linux implementation](https://github.com/holepunchto/fs-native-extensions/blob/v1.5.3/src/linux.c)
  uses `fcntl` open-file-description locks (`F_OFD_SETLK`), including range
  support. Kernel/filesystem support still requires runtime evidence.
- [macOS implementation](https://github.com/holepunchto/fs-native-extensions/blob/v1.5.3/src/apple.c)
  uses `flock`, and rejects nonzero offset or length. A single unconditional
  byte-range call is therefore not a cross-platform solution.
- The [upstream integration matrix](https://github.com/holepunchto/fs-native-extensions/blob/main/.github/workflows/integrate.yml)
  names Windows x64, Linux x64 and macOS arm64. Matrix declarations and bundled
  prebuild directory names do not prove this project's scenarios pass there.
- Published package license identifies Apache-2.0. No bundled TypeScript
  declaration appears in the inspected manifest; any production use needs a
  narrow typed boundary and package/native-loading validation.

Also inspected the owner-supplied
[node-pid implementation](https://github.com/MathieuTurcotte/node-pid/blob/master/lib/pid.js).
It creates a marker using `wx`, writes the PID, closes the descriptor immediately
and optionally removes the file at normal process exit. Its `force` mode
overwrites the marker. It does not hold a native lock or probe PID liveness,
so it cannot substitute for the agreed held-lock contract.

The fixture did not test user ACL changes, network filesystems, application
Runtime integration, native-addon absence on another architecture, Windows
arm64, Linux or macOS execution. A passing fixture is not production validation.
Manual unlink/rename/replacement of a live lock file remains unsupported.

## Runtime lifecycle finding

Static inspection found a separate implementation gate:
[Runtime Builder](../../../../src/runtime/composition/runtime-builder.ts) releases
the current PID marker even when shutdown reports residual resources; its
`finally` also releases if the main close path throws. Startup failure cleanup
uses bounded waits, then releases ownership.
[Bootstrap](../../../../src/runtime/composition/bootstrap.ts) can likewise time
out Memory/Logger cleanup before its caller releases the lock.

Merely replacing marker creation with native locking preserves these handoff
risks. A timed-out Session, managed process, Memory or Logger owner may still
access Home after a new Runtime acquires it.

The design must explicitly distinguish completed closure with recorded errors
from unconfirmed convergence: historical log loss alone does not mean an active
writer remains. Recommend retaining ownership while Home-writer convergence
is uncertain, until confirmed settlement or process exit, without broadening
shutdown budgets or automatically terminating an embedding Host. The exact
release/reporting rule requires acceptance before production changes.

## Hypothesis assessment and decision impact

The whole-file variant is not suitable for an inspectable PID on Windows.
The supported out-of-record byte-range variant satisfies the measured Windows
conditions without a second file or heartbeat. This is a **conditional Windows
pass**, not cross-platform acceptance or authorization to add a production
native dependency.

At observation time, [Plan item PFL-3](plan.md#items-and-gates) required:

1. Accept or reject the native dependency and the Windows range/Unix whole-file
   policy; do not describe it as a purely JavaScript PID-file utility.
2. Obtain actual Linux/macOS evidence for the same scenarios, or explicitly
   narrow the validated scope and record the unsupported conclusion.
3. Accept safe residual-writer and failed-startup ownership semantics, including
   required reporting, before editing Runtime release sites.
4. Decide/record any required ADR, then authorize Delivery separately.

The owner subsequently approved the native dependency, Windows-first Delivery
with Linux/macOS pre-release validation, and conservative retention on incomplete
cleanup. [ADR-026](../../../decisions/adr-026-held-agent-home-pid-file-lock.md)
records that accepted decision. This later approval does not expand the
platform observations made by this Spike.

## Cleanup

The runner reaped fixture children before removing its owned temporary PID
files and directories. No user process, selected Home or production PID file
was opened or killed. The isolated dependency installation and disposable
fixture sources are removed after recording these observations. No commit,
push, branch switch, model call, model download or production edit occurred.

Process authority: [Development Workflow](../../../governance/development-workflow.md).
