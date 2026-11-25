# ADR-028: MXC-backed Native Exec

> Status: Accepted
> Decision date: 2026-11-24
> Owner: Project owner
> Supersedes: none
> Implementation: Implemented with recorded Windows/Linux automated and owner manual validation
> Linux amendment: Owner accepted recorded delivery and manual scope on 2026-11-24; additional platforms/policies remain outside validation
> Network amendment: Owner accepted three-state startup-only networking on 2026-11-24
> Filesystem amendment: Owner accepted design and confirmed Windows manual verification on 2026-11-25; recorded automated scope retained

## Context

Tool approval authorizes calls but does not confine their effects. Native
Windows execution needs an operating-system file/network boundary without
changing command language or introducing a virtual-machine dependency.

The owner accepts MXC's public Node SDK on Node 24 LTS and the bounded Windows
feasibility evidence. This adds an opt-in execution boundary to
[ADR-012](adr-012-agent-home-path-unification.md); Agent Home-relative paths,
original cwd and ordinary approval semantics remain unchanged.

## Decision

- Use `@microsoft/mxc-sdk/v1` with Windows BaseContainer, initially SDK 1.1.0.
  Node 24.21 or later in the Node 24 LTS line is required.
- The accepted Linux extension uses bubblewrap and the same public SDK/control
  ownership. Private HOME/cache is mounted narrowly and `/tmp` stays namespace-
  private. Operator-provisioned backend tools and unsupported policies fail closed.
- Configure global startup-only `agents.sandbox`, disabled by default. Enabled
  unsupported hosts/requests fail closed; no native CLI/.NET or host fallback.
- First scope is Exec and descendants, in the original directory with explicit
  content permissions and separate directory metadata access. No automatic
  copies, writeback or credential grants. Network defaults to denied.
- A single `agents.sandbox.network` enum selects `none`, `outbound`, or
  `outbound-and-loopback`; file grants and Tool approval do not change.
  Explicit host-loopback authorization produces a risk warning, not a policy
  refusal. Native capability requirements still fail closed. General ingress
  remains denied; host loopback is bidirectional. Linux supports outbound only
  with operator-provisioned private-network helpers and rejects host-loopback
  allow with SDK 1.1.0. No domain proxy or live network-policy update is added.
- Keep Core independent of MXC. Runtime awaits Builtins initialization before
  publication; a private execution control owns start, termination and release.
- A fixed trusted Node entry inside the sandbox prepares private TEMP and
  launches unchanged cmd argv. Bootstrap environment is Host-only; user
  environment is applied only to the actual command after preparation.
- On Linux the entry launches unchanged `/bin/sh -c` without Windows profile
  preparation. A startup frame confirms the namespace Shell, while management
  uses the SDK host-root ID, never the child namespace PID. Path/environment
  identity is case-sensitive; no broad host mount may shadow private `/tmp`.
- Preserve the existing ProcessRegistry as lifecycle owner, including private
  foreground sandbox resources and terminal cleanup failures. Do not discard
  unreleased controls or add a second registry.
- Output integrity/cleanup failures are failures, not successful degraded runs.
  No public Tool/Approval mode is added.

## Consequences

The runtime/native dependencies require migration and package validation.
Allowed writable project data can still be destroyed; metadata may be visible
outside the work directory. Host file tools and arbitrary Extensions are not
OS-confined by this boundary. The accepted filesystem amendment adds software
checks to seven host file/search tools while enabled, sharing explicit execution
dependency reads but not copying OS baselines or per-Exec temporary grants.
Same-path/child precedence remains, without extra trusted-write conflict refusal.
Home-external special approval is removed after wiring or in the same delivery.
Off-mode file access still uses host permissions; allowed external targets no
longer require additional Home-based approval. This is intentional broader
authorization, not OS protection. Recorded automated checks and owner-reported
Windows manual verification passed; native Linux MXC was not revalidated.

Shell/root completion removes remaining descendants; background servers must
keep their root alive. CPU, memory and disk quotas are not claimed. Native
diagnostic-data behavior must be disclosed without logging caller secrets.

## Contract and validation

[Sandbox Execution](../specifications/sandbox-execution.md) owns configuration,
startup, framing, deadlines, cleanup and failure semantics. Validate real Windows
enforcement and installed artifacts as well as focused adapter/registry tests.
Accepted design is not proof of completed implementation or other-platform
validation.

## Migration and rollback

Upgrade the declared runtime and restore compatible native dependencies; do not
reuse Node 22 ABI binaries on Node 24. Sandbox-off retains explicit host-direct
execution, not a failure fallback. No global Node/OS privilege change is required.
