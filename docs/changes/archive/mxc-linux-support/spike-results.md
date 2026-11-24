# WSL2 Linux MXC Feasibility Results

> Status: Completed
> Executed: 2026-11-24
> Environment: Ubuntu 22.04, WSL2 x64, kernel 6.18.58.1-microsoft-standard-WSL2, non-root user
> Owner: Project owner
> Authority: Spike evidence only; production scope and validation belong to the Plan

The owner accepted these bounded Results and the Linux design on 2026-11-24.
Implementation authorization is recorded separately in the Plan; production
validation remains required.

## Question and method

The owner requested the bounded Linux experiment defined by
[the Spike Spec](spike-specification.md). The question is whether the public
Node SDK can provide Linux Exec containment with existing ownership semantics,
without the Windows TEMP/cmd bootstrap.

The WSL distribution had neither a native Linux Node runtime nor bubblewrap.
An npm path found initially was a Windows-mounted executable and was not used.
Unprivileged user-namespace creation succeeded as UID 1000.

Prepared a standalone project on the Linux filesystem using:

| Artifact | Exact version and provenance |
|---|---|
| Node | Official portable Linux x64 v24.22.3; archive SHA-256 `4f2b175a6d53a5c617a80dba2676238a0688cef28c6da4eba35c7d844e66fcfb` |
| Bubblewrap | Ubuntu `0.6.1-1ubuntu0.3`; package SHA-256 `706763714e5d19fc7ab2572a6418506e3a4a5d5960e99309707b58117e6b40cb`; unpacked privately, not system-installed |
| MXC Node SDK | `1.1.0`; lock integrity `sha512-tSOPZ14ddCiXHc4hVNQp5Yi22HSQEfXh58Z4O/tLzERi+23rfRmMrJoxVK5jZYhlll68u4eF/UlQSaXWyUMj4w==` |
| libc | glibc 2.35 |

Downloaded/verified official artifacts, disabled dependency install scripts, and
used independent npm user/global configuration paths. No Windows dependencies,
credentials or Agent Home were copied. Only synthetic harness files crossed the
Windows/WSL mount boundary.

An initial `/tmp` preparation directory disappeared between WSL calls. The cause
was not established; preparation was moved to an explicitly owned Linux user-cache
directory. This is a test-artifact persistence issue, not evidence about the
sandbox's private `/tmp`.

## Effective experiment policy

Explicitly selected `bubblewrap`. The controller supplied a minimal Linux PATH,
private-namespace TMPDIR and a synthetic HOME value, with host-environment
inheritance disabled. Runtime/fixture and readonly data paths were readable;
only the owned work directory was writable. A nested private directory was denied.

All external/host-loopback networking was denied. This ruleless offline profile
uses a private network namespace and did not require network-enabled helpers.
The SDK reported proxy enforcement unsupported because `slirp4netns` was absent;
no proxy or network enablement was attempted.

The host controller independently checked readonly/denied marker preservation,
local listener control reception, temporary-path absence after completion and
descendant heartbeat cessation.

## Evidence

All 18 bounded checks passed:

| ID | Observation | Result |
|---|---|---|
| L0 | Public SDK reported bubblewrap available with the actual Linux binaries | Pass |
| L1 | Native POSIX command preserved separate stdout/stderr and exit code 7 | Pass |
| L2 | Allowed read/write and readonly read succeeded; readonly write failed `EROFS` | Pass |
| L2 | Nested denied read failed `ENOENT`, write failed `EROFS`; marker unchanged | Pass |
| L2 | Synthetic data outside the grants was not visible (`ENOENT`) | Pass |
| L3 | An owned symlink to the denied directory did not expose its marker | Pass |
| L4 | Four outside-sandbox IPv4/IPv6 TCP/UDP listeners received their controls but no sandbox payload | Pass |
| L5 | Ordinary Node created data under the private `/tmp`; host canary was not inherited, and no corresponding host temp path remained | Pass |
| L6 | Natural completion, typed timeout and repeated explicit kill stopped the known descendant heartbeat | Pass |

UDP send callbacks succeeded inside the isolated namespace, but that did not mean
data reached the host listener. The pass is based on receiver observations after
successful outside-sandbox controls, not on the send callback's return value.

The Linux workload PID lives in a private PID namespace. The harness never treated
the workload's self-reported PID as a host PID or signaled unrelated processes.
SDK handles controlled termination; heartbeat files supplied independent evidence
of the known descendant stopping.

## Findings and decision impact

### Launch and HOME follow-up

Three additional synthetic probes clarified the Linux adapter contract:

- A valid SDK spawn reported a host PID whose process name was `bwrap`.
- For a missing cwd, SDK spawn still returned that handle; native execution later
  failed with exit code 1, and the requested marker was not emitted. Therefore
  SDK handle availability cannot alone certify actual command startup.
- A precreated, narrowly mounted owned HOME accepted a file write, and ordinary
  Node created temporary data in the private namespace without Windows profile
  preparation.

These probes used the retained temporary Linux SDK and removed their fixtures
after wait/disposal. They do not change the initial 18-check count.
The [Linux Draft](specification.md) uses this evidence to keep a small trusted
readiness entry without Windows LOCALAPPDATA/TEMP rewriting. No production
adapter or Linux PID mapping was implemented.

1. **WSL2 is a usable Linux development/test environment for this backend.**
   No sudo, system bubblewrap installation, Docker daemon or permission/sysctl
   changes were needed for the selected profile.
2. **The Windows bootstrap is not the default Linux execution route.**
   Native Linux commands and ordinary Node temporary-file creation worked through
   the SDK directly. This does not establish that the synthetic HOME was created
   or that all tool caches are ready; a Linux production environment contract is
   still needed.
3. **Shared configuration/ownership can be retained, not platform mechanics.**
   A later Linux adapter should reuse path policy and process control concepts,
   but select POSIX command semantics and Linux mount/environment handling.
   Do not reuse Windows ComSpec, profile rewriting or `enumeratePaths`.
4. **Linux error shapes and visibility differ.**
   A hidden/denied read may produce `ENOENT` and readonly writes `EROFS`, rather
   than Windows `EPERM`. Tools must surface real failures without fabricating
   empty-success results or assuming identical backend visibility.
5. **Keep the first Linux profile offline.**
   Network-enabled/proxy modes need extra tools and separate capability
   validation; they are not implied by the successful offline test.

This is a Provisional Pass for the recorded environment and fixtures. It unlocks
a Linux design proposal, not an automatic change to the currently Windows-only
[Sandbox Execution contract](../../../specifications/sandbox-execution.md).

## Limitations

- One Ubuntu WSL2 build, not all native Linux distributions/architectures.
- No production Runtime/Tool/ProcessRegistry Linux integration, installed my-agent
  package, real project build/test task or owner Agent manual validation.
- No public internet endpoint, alternate network protocols, host-to-sandbox
  service access or proxy validation. Four local receiver-controlled cases only.
- Existing denied paths only. Missing deny targets under readonly mounts may
  require bubblewrap 0.11+ and unprivileged OverlayFS; local 0.6.1 does not certify
  that capability.
- No complete hard-link/TOCTOU/WSL interop assessment, quotas or new security
  guarantee beyond the tested file/network/process effects.
- SDK `run`/`spawn`, timeout and retained-handle kill were exercised; production
  pending-start Abort/handoff/shutdown/drain races remain integration requirements.

## Cleanup and follow-up

Per-run fixture directories and local listeners were removed/closed. No experiment
processes remained in the owned Linux preparation root. Download archives and
package caches were removed; portable tools, prepared SDK/harness and evidence
remain in the owned user-cache directory for follow-up, not system PATH.
Synthetic results/lock provenance were copied to the Copilot session files.

No production code/configuration/runtime requirement was changed, and no
commit/push was performed.

The owner accepted these bounded Results, then authorized the Linux design and
implementation separately. See [the Plan](plan.md) for production validation and
remaining manual/platform gates; this initial Spike does not substitute for them.
