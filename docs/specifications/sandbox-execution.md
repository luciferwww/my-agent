# Sandbox Execution

> Status: Stable Authority
> Contract status: Implemented and Validated for the recorded Windows/Linux scope
> Accepted: 2026-11-24
> Linux amendment: Automated WSL/package and recorded Agent manual results accepted by owner on 2026-11-24
> Network amendment: Three startup-only network modes accepted by owner on 2026-11-24; Linux host loopback remains unsupported
> Authority: Opt-in Builtin Exec containment and private lifecycle contract

## Scope and configuration

`agents.sandbox` is global, file-backed and startup-only. Builtins Environment
owns the leaf validator/defaults; Platform composes it; Runtime passes immutable
startup facts and awaits preparation before publishing Tools.

```typescript
interface SandboxConfig {
  readonly enabled: boolean;
  readonly network: 'none' | 'outbound' | 'outbound-and-loopback';
  readonly read: readonly string[];
  readonly write: readonly string[];
  readonly deny: readonly string[];
}
```

Omission resolves to disabled and empty configured lists. Concrete absolute local
paths are supported, not globs, UNC/device policy roots or per-Agent overrides.
Invalid recognized fields fail with configuration field paths.

Path access keys are `read` (read-only), `write` (read/write, not write-only),
and `deny` (denied content access under native precedence). These are my-agent
configuration and Settings names. The adapter maps them to MXC SDK
`readonlyPaths`, `readwritePaths`, and `deniedPaths`, respectively.
The old my-agent configuration keys are rejected, not aliases; existing Agent
Home documents must rename them without changing their path values.

Runtime Settings exposes the independent `agents:sandbox` section with enabled,
network and all three path lists. It includes resolved saved values, immutable
startup `appliedSettings`, Host platform, revision and restart/application status.
Its editor lives under Agents global settings, not per-Agent configuration.
The existing section save pipeline validates through the Builtins-owned leaf and
changes only `agents.sandbox`, preserving unrelated current file data. Credentials
are not accepted. Save does not load/probe MXC, install helpers, run commands,
reload Runtime units or modify admitted/running policies. Native support is still
checked during startup/launch. Differences from the actual resolved startup
snapshot require restart; saving equivalent startup values clears the marker.

Enabled means Windows MXC BaseContainer, initially public Node SDK 1.1.0 on Node
24.21+ within Node 24 LTS. Off means unchanged host-direct execution without SDK
load/probe. Unavailable or unmet enabled policies fail; no backend, permission or
host-direct fallback. The accepted Linux extension selects bubblewrap through the
same SDK and requires operator-provisioned tools; macOS remains unsupported.
Linux paths and environment keys are case-sensitive. Reject configured mounts,
including resolved aliases, that replace/expose the host `/tmp` or its parent,
and denies that block required private temp.

The execution directory is the ordinary resolved `cwd`, not a grant. Explicit
read/write/denied paths, necessary runtime/OS reads, owned private temporary data
and execution-volume metadata form the effective request. Follow native
path/alias precedence; report baseline OS access rather than claiming configured
lists are the entire filesystem. Do not implicitly write-enable Agent Home/cwd.

`network` defaults to `none`. With Sandbox enabled:

| Mode | External egress | Host loopback |
| --- | --- | --- |
| `none` | Denied | Denied |
| `outbound` | Allowed | Denied |
| `outbound-and-loopback` | Allowed | Allowed on supported Windows hosts |

The adapter emits directional MXC egress and host-loopback settings while keeping
general ingress denied. Sandbox-internal loopback is not host access. Selecting
host loopback is explicit authorization; startup warns that commands and their
dependencies can reach local services which may trust localhost. Risk alone does
not block the choice. The native host-loopback permission is bidirectional, not
an outbound-only exception. Unsupported host/request capabilities fail without
host-direct or wider-network fallback.

Linux `outbound` requires MXC's private-namespace network helpers (slirp4netns,
iproute2, util-linux, iptables/ip6tables and restore binaries), required kernel
support and `/dev/net/tun`. Availability is checked at startup and revalidated
by MXC at launch; no automatic installation or host-network namespace sharing.
SDK 1.1.0 bubblewrap cannot honor host-loopback allow, so the third mode fails
startup on Linux. Outbound is not a uniform public-internet-only guarantee:
Linux can reach private-network destinations; Windows with general ingress
denied does not grant the privateNetworkClientServer capability. No domain
allowlist or proxy is introduced.

Edits require a Host restart. Running commands retain their original policy;
Settings section saves preserve the value without applying it live. Sandbox-off
still means host-direct execution, regardless of the saved network mode.
Approval remains separate: `manual` still requires Exec approval, `allow_all`
does not remove confinement, and Tool-name deny stays final.

## Ownership and startup

Core has no SDK dependency. Runtime's Builtin factory may return an array or
Promise; Builder awaits it in its existing startup cleanup boundary before
publication. Tool registration stays synchronous.

A private control exists before asynchronous native launch. SDK spawn establishes
the sandbox root; the actual Shell-start confirmation establishes command
readiness. A canceled pending spawn is retained until rejection or termination
of its late returned handle. Do not publish a successful background ID after Abort.

The existing ProcessRegistry owns managed controls and private foreground-sandbox
controls. Foreground entries are invisible and do not count against managed
capacity/history. Terminal status alone does not release control ownership.
Pending managed cleanup keeps its resource reservation and cannot be evicted.
Session and Host cleanup visit unreleased controls even after terminal settlement.
Failure remains visible and prevents claiming cleanup/lock release succeeded.

On Linux SDK root spawn can precede mount/cwd setup failure. Confirm the trusted
initial Shell-start frame before command publication. The frame's PID is private
namespace data; the managed host PID is the SDK's positive root ID. Termination
uses the retained SDK handle and never signals a namespace PID on the host.

Pure host-direct foreground behavior and normal Tool/Process presentation remain
unchanged. Immediate-background startup now retains Parent Abort until handoff;
yield retains it until promotion. Parent Abort cannot terminate a handed-off
process. Root completion removes descendants; no detached descendant lifetime
outside its managed root is promised.

## Trusted bootstrap and environment

The fixed Node bootstrap runs inside MXC, not as a native helper/service. Host
creates one unique temp root outside Agent Home and grants the installed bootstrap
and its necessary package manifest read-only access. The bootstrap receives only Host-selected environment values,
not ambient or caller Node startup hooks.

One private stdin JSON envelope contains unchanged command, owned root and
validated caller environment. Limit the UTF-8 envelope to 64 KiB and the initial
stdout control frame to 4 KiB. Oversize/invalid inputs fail explicitly.

Bind the root to a reserved Host-generated environment value; reject another root
even when writable. Verify existing-parent and final realpaths before using
directories; do not present lexical checks as a complete TOCTOU solution. Prepare
Windows-rewritten directories and stable private home/appdata/tmp/cache within
the owned root before user code. Set child TEMP/TMP/LOCALAPPDATA accordingly.

Reserved path/bootstrap/offline/cache names cannot be overridden by caller env;
Windows matching is case-insensitive and duplicate case variants fail. Permitted
caller values, including intentional Node options, apply only to the user Shell.
Enforce offline npm for `none`; enabled network modes set the trusted npm offline
value to `false`. npm configuration names are reserved case-insensitively on
both platforms. Keep a private cache and disabled update notification. Never merge
or log the entire Host environment or caller values.

Launch original `cmd.exe /d /s /c` args with verbatim Windows arguments, without
concatenating setup commands or rewriting original paths/command text.
The private stdin envelope is not interactive command input; the user Shell has
stdin closed. Interactive-input support is not part of the Exec contract.

The Linux entry uses `/bin/sh -c`, prepares mounted owned HOME/cache and uses the
namespace's private `/tmp`, without ComSpec/LOCALAPPDATA or Windows directory
rewriting. Root matching is case-sensitive. Bootstrap environment remains Host-
only; caller Node/preload variables apply only after preparation to the actual
Shell. Do not mount host HOME/Windows drives implicitly or auto-install tools.

## Output and terminal semantics

Buffer child output until one startup frame reports actual Shell spawn. Host
validates and consumes that first frame only; later bytes are ordinary output,
including text resembling control messages. Native/entry failure before
readiness is not a successful start.

Normal EOF preserves Shell code and forwarded bytes. The internal post-exit
drain deadline is 1,000 ms, not a configurable command timeout. At cutoff or
read/forwarding failure, exit nonzero and emit an explicit incomplete-output
diagnostic including original Shell code. The adapter returns existing failed
outcome with available partial output, never success plus a warning. This differs
from the existing managed-output history truncation marker.

Use a single adapter command deadline with existing foreground default and
explicit/no-timeout managed rules; do not let SDK and adapter independently
settle results. Deadline/Abort/manual kill use the retained SDK control; native
wait, stream closure and owned TEMP cleanup precede confirmed release. The
Framework keeps its existing outer deadlines and terminal precedence.

Cleanup failure retains its owner and diagnostic. Retry only supported control
operations through existing bounded lifecycle hooks, not indefinite background
retries or invented recovery of a failed native handle.

## Limits and validation

No automatic project copy/rollback, resource-quota framework, Smart Approval,
MCP/Extension isolation or host file-tool migration. Writable data can be
destroyed. Metadata visibility, tool compatibility and implicit OS access must
be described honestly. Shared software path checks for host file tools are a
separate future decision, not equivalent OS enforcement.

Required focused checks cover configuration/preservation, SDK startup failure
without publication, caller-hook separation, startup frames, precise drain
threshold/failure, original output/cwd, pending-start Abort, handoff, terminal and
foreground retained cleanup, Session/shutdown and installed bootstrap/native
assets. Real Windows tests verify allowed/denied content, metadata, aliases,
network denial, private TEMP and process-tree termination.

Network-mode checks cover native policy mapping, reserved npm environment
variants, configuration projection/preservation and unavailable capabilities.
Windows native checks verified public HTTPS, `npm config get offline` returning
`false`, preserved denied-file access, host-loopback denial in `none`/`outbound`,
and successful host-loopback access in the third mode. The public HTTPS case is
opt-in with `MY_AGENT_TEST_MXC_NETWORK=1`; ordinary runs do not require internet.
WSL checks verified default isolation and startup rejection for missing outbound
helpers and unsupported host-loopback allow. Live Linux outbound networking is
not claimed by those checks.

Native ABI migration, lint/build/package and existing approval/Exec regressions
must pass. No other-platform or absolute escape-proof guarantee follows from
Windows fixture results. Diagnostics disclose SDK behavior without storing secrets.

## Related decisions and contracts

[ADR-028](../decisions/adr-028-mxc-windows-exec.md),
[Tools and Hooks](tools-and-hooks.md), [Approval Lifecycle](approval-lifecycle.md)
and [Configuration](configuration.md) retain their separate authorities.
