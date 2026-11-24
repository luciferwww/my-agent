# Linux MXC Exec Integration

> Status: Implemented and Validated; owner accepted the recorded Linux scope on 2026-11-24
> Archived: 2026-11-24
> Date: 2026-11-24
> Owner: Project owner
> Related Plan: [Linux integration proposal](plan.md)
> Readiness: Owner accepted Linux design/results and authorized implementation on 2026-11-24
> Authority: Change-local design, not a stable contract amendment

The accepted Linux amendments to
[Sandbox Execution](../../../specifications/sandbox-execution.md) and
[ADR-028](../../../decisions/adr-028-mxc-windows-exec.md) own the durable contract.
This Change tracks authorized implementation and validation, not another authority.

## Purpose and scope

Extend the existing opt-in MXC Exec boundary to Linux without weakening the
Windows implementation or adding a second registry/backend framework.

Use public Node SDK 1.1.0, supported Linux Node 24 LTS and bubblewrap.
Retain original cwd, independent Tool approval, explicit content permissions,
external-network denial and existing foreground/background/yield ownership.

First validated environment is Ubuntu 22.04 under WSL2. No macOS support,
container automation, proxy/network enablement, resource quotas, real credential
forwarding, host file-tool policy migration or automatic project copy is included.

The [Spike Results](spike-results.md) establish bounded feasibility, not a claim
that every Linux distribution or policy works.

## Evidence-backed differences

- Linux has mount/PID/network namespaces, not Windows BaseContainer.
- The SDK's host process ID was observed as a `bwrap` process. Child PIDs printed
  inside the namespace are not host PID identities.
- SDK spawn returned a handle even when a subsequent cwd setup failed before
  executing the requested command. Native handle publication alone is not user-
  command readiness.
- Private `/tmp` worked without Windows profile/TEMP preparation. A precreated,
  narrowly mounted owned HOME also worked.
- Denied reads can return `ENOENT`, and readonly writes `EROFS`. Preserve these
  real failures rather than requiring Windows-specific errors.
- Existing denied targets work with tested bubblewrap 0.6.1; missing targets
  under readonly mounts can require newer bubblewrap/OverlayFS support.

## Owners and dependency direction

Keep the existing Builtins Environment factory, public config facade, Runtime
startup await barrier and ProcessRegistry. Core remains independent of MXC.

Use a small OS selection inside `createMxcCommandRunner`: Windows keeps its
current BaseContainer preparation; Linux selects bubblewrap. Unsupported OSes
still fail explicitly. Do not create a provider registry, user-selected backend,
.NET/native helper or Linux-only process registry.

Reuse execution control, output capture, deadline/cancellation, retained cleanup
and the initial-frame protocol. Keep platform-specific request/environment/path
preparation explicit; extract only shared lifecycle code required by both callers.

### Reviewed reuse boundary

The current bootstrap requires ComSpec, Windows TEMP/profile variables and
case-insensitive root/environment comparison. Reusing that implementation
unchanged is not permitted. Keep request validation, first-frame parsing,
supervision/drain and control ownership common, but choose the Shell,
environment preparation and path identity rules by the actual execution OS.
Do not accept an Agent-supplied platform value in the private request.

Update containment checks to use the execution OS's path separator and root
identity. The current runner's `..\\` check and lowercasing are Windows-specific;
Linux outside-root checks and distinct-case roots need explicit regressions.

## Configuration and support

Keep the same global startup-only `agents.sandbox` shape and disabled default.
No schema-version or separate Linux namespace is needed.

Paths are absolute in the execution OS. In WSL these are Linux paths, not Windows
drive spellings; do not automatically convert or grant `/mnt/c`. Matching and
environment names are case-sensitive on Linux. `cwd` remains execution context,
not an automatic permission grant.

When enabled, Runtime must await SDK/backend discovery and reject an unavailable
bubblewrap or unsupported host capability before publishing usable Tools. Linux
does not call the Windows-only `probe()` operation. Advisory availability does
not guarantee a particular mount request can run; actual launch/setup failure
still fails the call without host-direct fallback.

Do not install bubblewrap or change sysctl/AppArmor/firewall settings at Agent
startup. Report the dependency/version cause; the operator provisions the host.
Basic offline profiles require bubblewrap 0.5+ according to the pinned backend.
The native backend must reject policy features it cannot enforce, including
missing denied targets needing newer OverlayFS support, rather than skip them.

## Effective file and network policy

Configured readonly/readwrite/denied paths remain distinct from the backend's
baseline OS mounts. Verify real nested deny, overlap and symlink behavior on
Linux instead of assuming Windows path precedence and enumeration semantics.

Grant the trusted installed bootstrap and required Node runtime files read-only.
Include only necessary package metadata and explicitly required tooling paths,
not the entire user's HOME or a Windows-mounted development drive. Node binary
access alone does not prove npm/tool-library paths are readable; test the actual
toolchain instead of granting broad parent directories speculatively.

Grant the per-execution owned HOME/cache root narrowly. Do not mount the host's
whole `/tmp` over bubblewrap's private tmpfs. Temporary path aliases/conflicts
must fail or remain explicitly constrained, not fall back to shared temp.

For this first profile, reject configured readonly/readwrite mounts that replace
the namespace's `/tmp` itself or a parent such as `/`. A narrow descendant mount
for the Host-created private root is allowed. Reject a denial that would make
the required private temporary area inaccessible. Do not silently omit a supplied
grant/deny or accept a broad host-temp bind and still claim private namespace
TEMP. A later broader-mount profile needs a separate accepted contract.

Use deny-default egress/ingress with host loopback denied. Ruleless denial uses
private network namespaces; no slirp4netns, proxy, host DNS/socket forwarding or
network-enabled helper path is added. Do not expose WSL interop sockets implicitly.
The Linux baseline/resolver handling is SDK-owned and must be reported honestly.

## Environment, temporary data and user commands

Host creates one private root outside Agent Home, with ready HOME and npm-cache
subdirectories, before launch. These are narrowly mounted writable paths and
retain the existing command-control cleanup owner.

SDK/bootstrap environment uses an explicit Linux PATH with no empty/current-
directory entries and a fixed `/bin/sh` selection. Do not inherit host/caller
`NODE_OPTIONS`, `NODE_PATH`, `LD_PRELOAD`, `LD_LIBRARY_PATH`, `BASH_ENV`, `ENV` or
arbitrary ambient values into the trusted entry. Exact allowlisting is reused,
not a blacklist of only credential-looking names.

Caller environment travels separately in the existing bounded stdin request and
applies only when starting the user Shell. Reject reserved HOME/TEMP/TMPDIR/PATH/
bootstrap/offline-cache conflicts explicitly; preserve case-sensitive names,
where `Foo` and `FOO` are different valid names. Caller runtime/preload settings
are user-command behavior, never pre-entry bootstrap configuration.

The shared environment validator must select case sensitivity by the execution
OS: exact Linux reserved names are rejected, but an unrelated lowercase `home`
is not automatically the same variable as `HOME`. The current Windows validator
lowercases every key, so it must not be reused unchanged. Root binding is also
case-sensitive on Linux, including paths with distinct-case directory names.

Use private namespace `/tmp` as TMPDIR and a precreated owned HOME/cache.
The trusted Node entry is needed for command readiness/environment separation,
not for Windows LOCALAPPDATA rewriting. No synthetic Windows variables,
`enumeratePaths`, drive-root enumeration or ComSpec are sent on Linux.

Launch `/bin/sh -c` with the original command as one argv element. Use POSIX
quoting only to locate the fixed Node/entry in the SDK's launch string; do not
concatenate setup commands into user code or change `/bin/sh` to Bash silently.
User command stdin stays closed as in the current Exec contract.

## Readiness and PID presentation

The trusted contained entry prepares its environment and reports exactly one
initial frame after the actual child Shell spawn. Setup/entry/spawn failure before
that point rejects `started`, publishes no successful runId and triggers owned
cleanup. User stdout after the first frame is never interpreted as control.

Linux managed `pid` presentation uses the positive meaningful host ID from the
SDK's native sandbox root (`bwrap` in the experiment), not the child's private-
namespace PID. Describe it as the managed host root rather than the interpreter
PID. Keep namespace PID data private; do not make it a Tool termination input or
invent host IDs by arithmetic/mapping.

Keep the existing first-frame shape for compatibility. A Linux frame's positive
`pid` certifies child Shell startup inside the namespace; it is not the value
passed to `options.onSpawn()` or used to resolve `RunningCommand.started`.
After accepting that frame, validate the positive SDK host-root ID and use that
host ID for both callbacks/presentation. If no meaningful host ID is available,
fail explicitly instead of substituting the namespace PID.

The retained SDK handle is the authority for kill/release on both platforms.
A namespace readiness frame is not a reason to run host `kill` on its numeric PID.
Windows Shell PID presentation and command behavior remain unchanged.

## Lifecycle, output and cleanup

Use the existing single adapter deadline, started/completion Promises and
termination control. Cancel before/during launch, and terminate any late native
handle before forgetting its owner; never publish successful handoff after Abort.

Keep private foreground ownership and managed quota/history semantics unchanged.
Parent Abort is detached only after successful background/yield handoff. Session
cleanup and Host shutdown visit terminal controls with unconfirmed release.

Reuse the accepted bootstrap output-drain contract: EOF preserves exit code,
incomplete output fails visibly with partial bytes, and the command timeout is
not extended. Native wait, output/handle release and owned HOME/cache deletion
must converge before removing the control. Failure retains an attributable owner.

Natural completion, timeout and kill stop descendants; no descendant persistence
outside its retained root is promised. Private tmpfs disappears with the namespace,
and host-created HOME/cache is explicitly deleted only after native release.

## Migration and validation

Amend [Sandbox Execution](../../../specifications/sandbox-execution.md) and
[ADR-028](../../../decisions/adr-028-mxc-windows-exec.md) only after owner acceptance.
Keep the public SDK/runtime dependency versions already validated; do not upgrade
them merely to add a platform.

Focused cases cover OS selection, Linux config paths/case-sensitive env, no
Windows fields/bootstrap preparation, actual Shell readiness versus failed cwd,
namespace versus host IDs, inherited-hook separation, original shell output,
startup Abort, foreground quotas, managed handoff and cleanup failures.

Specific review regressions must include:

- A valid namespace startup frame with a different SDK host PID resolves the
  recorded host ID, never the namespace value; missing readiness/failed cwd
  cannot produce a successful background handoff.
- Linux reserved/environment and root comparisons retain case sensitivity;
  Windows duplicate-case/reparse/bootstrap tests remain unchanged.
- Broad mounts that would shadow private `/tmp` are rejected rather than
  weakening the policy, while a narrow owned HOME/cache descendant is usable.
- No Linux request/start entry reads Windows ComSpec/profile values or uses
  Windows-only request probing/enumeration.

Real WSL tests must run Linux Node/dependencies in an independent Linux working
tree, not reuse Windows `node_modules`. Cover actual Runtime/Exec integration,
readonly/nested-denied/symlink access, private HOME/temp/cache, network controls,
normal offline tasks and Node/tool runtime paths. Run focused Windows regressions
and applicable lint/build/package checks; do not broaden production validation
claims from this WSL experiment.

## Delivery follow-up

The owner accepted the bounded Results and reviewed Linux contract. Implementation
uses the existing config/control/Registry and shared contained entry, with explicit
Linux Shell/env/PID policy and no system installation.

Automated WSL validation covers configuration/controls, real Exec lifecycle,
readonly/nested/symlink content policy, offline npm and host-root identity.
A fresh installed tarball also completed a true Runtime Turn through a local
synthetic Provider, one manual approval and the actual Framework/Exec boundary.
This is not real-upstream model certification or owner manual Agent acceptance.

The complete Linux package verification and Windows regression also passed.
Independent review found no significant issue; exact counts, the directly
coupled POSIX CLI entry fix and remaining limits are recorded in the Plan.
The owner also accepted recorded real-Agent manual permissions/TEMP, background,
yield and post-foreground cleanup results, with manual networking excluded.
Archive, scoped commit and stopping the independent test service were authorized;
Home/credentials were preserved and push was not authorized.
Additional distributions, policies/proxies and resource quotas are not implied.
