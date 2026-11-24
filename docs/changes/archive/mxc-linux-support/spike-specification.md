# WSL2 Linux MXC Feasibility Spike

> Status: Completed
> Date: 2026-11-24
> Owner: Project owner
> Decision unlocked: Whether the current Exec ownership contract can support a Linux MXC adapter
> Authority: Non-authoritative experiment specification; no Linux production authorization

The bounded run passed 18 checks on the recorded Ubuntu WSL2 environment.
See [Results](spike-results.md) for exact evidence, capability limits and cleanup.
Owner Results acceptance and Linux production design remain separate gates.

The owner accepted the bounded Results and Linux design on 2026-11-24; the
separate accepted Plan now authorizes implementation, not this experiment itself.

## Decision question

Can the public MXC Node SDK provide constrained Linux command execution in the
installed Ubuntu WSL2 distribution while preserving file/network denial, output,
and process ownership without the Windows TEMP/cmd bootstrap?

The owner requested starting the bounded Linux Spike. This permits synthetic
probes and independent temporary runtime/dependency preparation, not production
integration, system permission changes, sudo installation or Windows dependency
reuse.

## Falsifiable hypothesis

The installed WSL2 kernel supports unprivileged user namespaces and a sufficiently
new bubblewrap. With Linux Node 24 and the public SDK, a minimal deny-network
profile permits required work/runtime access, rejects forbidden content access,
and cleans up owned descendants on completion, timeout and termination.

## Scope and non-goals

Use Ubuntu WSL2, public SDK 1.1.0, Linux Node 24 LTS and bubblewrap. First policy
is completely offline; no proxy or outbound-network enablement. Do not port the
Windows-only runner, change its configuration contract, migrate host file tools,
or promise all Linux distributions are supported.

## Method

- Inspect distribution, kernel, architecture, Linux tools and namespace support.
- Create an independent owned directory on the Linux filesystem. Do not reuse
  Windows `node_modules`, Agent Home, real credentials or project scripts.
- Prefer existing compatible tools. If missing, download an official portable
  Node distribution and verify its official SHA-256. Obtain a version-pinned
  bubblewrap package via Ubuntu package metadata, verify SHA-256 and unpack
  locally with `dpkg-deb`; do not install system-wide or alter file capabilities.
- Prepare a private SDK package with install scripts disabled. Do not copy npm
  credentials/configuration from the Windows host.
- Create synthetic writable, readonly and denied files plus safe script/process
  fixtures. Observe outcomes from the controller, not only workload assertions.
- Use local receiver-observed network controls with inert markers; no production
  service, public payload or model invocation is needed.
- Bound output, time and process lifetime; record exact tool versions and SDK
  operation outcomes.

## Required evidence

| ID | Scenario | Required observation |
|---|---|---|
| L0 | Runtime/backend support | Actual Linux binaries, exact versions and SDK support; missing tools fail explicitly |
| L1 | Native shell and output | POSIX command cwd, stdout/stderr and exit code preserved |
| L2 | File boundary | Allowed reads/writes succeed; readonly writes and denied reads/writes fail; markers unchanged |
| L3 | Alias boundary | Owned symlink cannot expose denied contents; record metadata visibility instead of assuming Windows equivalence |
| L4 | Network denial | Outside-sandbox local control is reachable; sandbox cannot deliver TCP/UDP payload; report untested families/protocols |
| L5 | Private temporary data | Workload gets usable contained temporary data without Windows profile preparation |
| L6 | Lifecycle | Normal completion, timeout and explicit kill remove owned descendants; retained handle supports eventual completion |

## Success, failure, and stop conditions

Provisional Pass requires measured mandatory scenarios and explicit limitations.
Unsupported packaging/kernel/tool prerequisites are environment blockers, not
proof that MXC is unusable everywhere. A failed denial or surviving required
descendant fails the candidate; never widen access to hide failure.

Stop on unexpected access, external payloads, system-wide modifications or loss
of ownership. Do not silently fall back to host execution or mark skipped
scenarios passed.

## Constraints and safety

The environment can be shared. No sudo, global runtime installation, firewall/
sysctl change, real user file reading or account secrets. Do not execute unknown
repository scripts. Do not grant mounted Windows drives or WSL interop sockets
implicitly; record actual backend support and effective policy.

Clean only named owned fixtures after terminating their users. Retain a small
reproducible harness/evidence record when useful; remove download caches and
large temporary artifacts. Do not delete broad roots or kill processes by name.

## Deliverables

Produce a Spike Results record with measured observations, cleanup status,
limitations and a Linux-adapter recommendation. Results inform a later owner-
accepted design; they do not change
[Sandbox Execution](../../../specifications/sandbox-execution.md) or authorize
Linux production delivery.

Source: [MXC v1.1.0 Bubblewrap guide](https://github.com/microsoft/mxc/blob/v1.1.0/docs/backends/bwrap/bubblewrap-backend.md).
Follow [Development Workflow](../../../governance/development-workflow.md).
