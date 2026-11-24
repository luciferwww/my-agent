# MXC-backed Tool Execution

> Status: Draft
> Date: 2026-11-23
> Revised: 2026-11-24
> Owner: Project owner
> Related Plan: [MXC Sandbox Adoption](plan.md)
> Readiness: Bounded [MXC Spike](spike-specification.md) provisionally passed; owner design/migration acceptance required

The [Results](spike-results.md) now include Node 24 SDK, ordinary offline npm-task
and metadata-boundary validation, plus a contained private-TEMP bootstrap.
The default design candidate is the public in-process Node SDK V1 on Node 24
LTS with explicit enumeration-only metadata access and a small trusted Node
bootstrap. These are evidence-backed proposals, not production acceptance.

## Purpose and observable outcome

Introduce optional native Windows sandboxed `exec` execution with an explicit,
verified file/network boundary. Commands still use the normal Tool approval and
Process lifecycle. When requested isolation cannot be established, report a
failure rather than executing on the host.

MXC is the selected technology direction, not an already validated integration.
This Draft neither adds a permission mode nor promises that arbitrary commands,
toolchains, or Windows builds are supported.

## Scope

- First production candidate: sandbox `exec` and descendants, including foreground,
  yield, and background modes.
- Owner-selected working-directory model: operate in the original `cwd`, with
  file-content writes limited to trusted configured paths and owned temporary
  data. No automatic project copy, path remapping or writeback.
- First policy candidate: expose necessary readable tool/runtime paths and
  configured data paths; do not grant Agent data or credentials automatically;
  deny external network including host loopback. Directory metadata visibility
  remains separate from file-content permissions.
- Measure directory listing and file reading inside the sandbox as a future
  file-tool feasibility probe, not as a production file-service design.

## Non-goals

No Smart Approval, local classifier, automatic authorization, public file-broker
protocol, Extension migration, three-platform rollout, network proxy, credential
forwarding, or new sandbox backend selection framework. No automatic working
copy, Git worktree, patch application, backup or rollback service.

Allowed writable project files can still be overwritten or deleted. A user may
prepare a disposable copy and select it as `cwd`, but the sandbox does not create
or synchronize that copy. Do not describe access confinement as recovery.

The Agent host remains outside the sandbox. Its direct filesystem and network
operations are not OS-confined by sandboxing `exec`.

## Boundaries and dependency direction

- **Core Tools/Framework:** retain portable Tool, validation, execution and closure
  contracts; do not depend on MXC or platform-specific SDK types.
- **Runtime policy and interactions:** retain approval decisions, effective
  Hook-transformed input, Session/Turn/call correlation and first-settlement-wins.
  Sandbox success must not bypass approval or represent a user decision.
- **Builtins execution:** translate trusted execution constraints to the chosen
  MXC binding and own workload output/readiness/termination integration.
- **Existing ProcessRegistry:** retain managed-process ownership, visibility,
  Session scoping, capacity, handoff and shutdown behavior. Do not introduce a
  second registry.
- **Builtins Environment:** own the sandbox leaf contract/defaults/validation,
  policy compilation, SDK binding and private per-execution temporary resources.
- **Platform Configuration:** compose that leaf into global `agents.sandbox`;
  keep the existing namespace and immutable projection mechanism.
- **Runtime composition:** pass the startup-resolved sandbox configuration to the
  Environment contribution. No new configuration-file reader or per-Agent override.

Current boundaries are documented in
[Tool Contract and Policy](../../../architecture/tools.md) and
[Builtin Tools](../../../architecture/builtin-tools.md). The concrete baseline
is [run-command.ts](../../../../src/builtins/tools/environment/process/run-command.ts),
[exec-types.ts](../../../../src/builtins/tools/environment/process/exec-types.ts),
and [exec-tool.ts](../../../../src/builtins/tools/environment/process/exec-tool.ts).

## Public and structural contracts

### Startup configuration proposal

Add global, file-configured `agents.sandbox`, not a Tool argument or Session
permission mode. The initial resolved shape is:

```typescript
interface SandboxConfig {
  readonly enabled: boolean;
  readonly readonlyPaths: readonly string[];
  readonly readwritePaths: readonly string[];
  readonly deniedPaths: readonly string[];
}
```

Defaults are `enabled: false` and empty configured path lists. Enabling selects
MXC on Windows; the first profile always denies external networking and does
not expose a network toggle, alternate backend or unsandboxed retry.

All paths are concrete absolute local paths, not shell strings or globs. Invalid
recognized fields fail configuration validation through the existing Platform
path-reporting mechanism. The first slice does not accept UNC/device policy roots,
per-Agent sandbox overrides or environment-variable configuration overrides.

Configuration is startup-only. File changes require restart; existing Settings
section edits must preserve it without presenting a live toggle or marking a
saved value as already enforced. A browser sandbox editor and live reconfiguration
are excluded from this first slice.

When off, retain current host-direct behavior and avoid loading/probing native
MXC. When on, import/probe at Environment startup, fail startup if the required
Windows backend is unavailable, and check each actual request before launch.
Do not silently disable the flag, omit Exec, or switch backends.

An illustrative configuration is:

```json
{
  "agents": {
    "sandbox": {
      "enabled": true,
      "readonlyPaths": ["C:\\tools\\shared-runtime"],
      "readwritePaths": ["C:\\work\\project"],
      "deniedPaths": ["C:\\work\\project\\private-data"]
    }
  }
}
```

Compile configured paths together with the explicitly required runtime/OS
read paths, execution-volume metadata grants, and per-command owned temp paths.
Do not use a broad developer-profile helper that automatically grants HOME,
credential files or writable shared caches. Adding `cwd` or changing `env.PATH`
does not automatically grant more file-content access.

The native policy must represent configured restrictions under documented MXC
path/alias precedence; reject unsupported/conflicting requests rather than
silently dropping denies. Verify the example's nested denied data under the
writable project in integration tests. Report implicit OS baseline access rather
than claiming the explicit path lists are the entire reachable filesystem.

### Selected binding candidate

Use `@microsoft/mxc-sdk/v1`, initially the tested SDK `1.1.0`, on a supported
Node 24 LTS runtime. SDK documentation requires at least Node 24.21.0 for Windows
native stdio; the Spike used 24.22.3. Do not add a .NET helper or a native CLI
production fallback by default.

Translate the private executor contract through SDK `spawn`, standard streams,
`wait`, `kill` and `dispose`. SDK spawn establishes the sandbox root, not the
final user-command readiness. The direct-command Spike verified a real OS PID;
with the contained bootstrap, that ID belongs to the trusted Node root.
Retain it for SDK ownership, and report the actual Shell PID only after the
trusted bootstrap's startup frame. Typed startup rejection and bootstrap failure
must not publish a successful background call.

The SDK does not take the repository's execution AbortSignal in its spawn
options. The minimal adapter must preserve pre-launch checks, cancellation
during async launch, and the existing ownership transfer using explicit handle
termination. Do not introduce a competing registry or deadline owner.

### Metadata and content access

The tested Windows candidate adds `enumeratePaths` for the execution volume
while keeping file-content grants unchanged. This enables normal Node/npm
metadata traversal without whole-drive file reads, but descendant directory
metadata also becomes queryable. Policy/configuration and UX must distinguish
this from workspace-only visibility. On 2026-11-24 the owner clarified that
outside-workspace enumeration and reading explicitly permitted external files
are expected sandbox behavior, not an adoption blocker. The target is access
control, not making every path outside the work directory invisible.

Retain the tested metadata-only candidate; this clarification adds no file-content
grant. External tool/runtime files may be readable under the effective policy,
while unauthorized content reads/writes and explicit denied paths must remain
constrained. Report implicit OS access honestly rather than promising that all
external files are unreadable. Directory-name visibility remains a documented
capability boundary, not an unresolved compatibility defect.

The initial candidate preserves existing Tool inputs and results. Trusted host
configuration, not model-supplied command arguments or explanations, determines
isolation constraints.

An execution binding must provide semantically:

- readiness only after confinement is established and the target starts;
- stdout/stderr, exit status and explicit execution failures;
- idempotent workload-tree termination and eventual resource release;
- a handle whose ownership survives yield/background handoff;
- actual backend/capability information sufficient to detect unmet constraints.

### Private command-control proposal

Keep `runCommand` as the Builtins entry to foreground and managed execution.
Its result retains a started Promise and a single completion Promise, but replace
the cross-caller `ChildProcess` dependency with a private termination control.
Both host-direct and MXC routes expose the same semantic `terminate(reason)`
operation; only the host-direct implementation calls the existing process-tree
kill helper. The MXC implementation terminates through the live SDK handle,
not through PID-based host signaling.

Create the control before asynchronous launch, so a `starting` managed record
already owns pending-start cancellation. Resolve started only after SDK spawn
and the bootstrap's Shell-start confirmation plus final cancellation checks;
attach streams before wait. Store this control
in the existing ProcessRegistry, replacing its `child`-based cleanup paths and
the Process Tool's direct kill call. No public Tool schema, new registry or Core
SDK dependency is needed.

Keep real OS PID presentation where available, but do not make that PID the
authority to release the SDK's policy/native resources. Do not cast an SDK handle
to `ChildProcess`, invent a PID, or infer target readiness from helper output.

## Behavior and invariants

1. Preserve Hook transformation, schema validation, policy, approval and Framework
   ordering. Bind approval and execution to the same effective call.
2. `manual` retains per-call Exec Approval. `allow_all` continues to authorize
   non-denied calls; authorization does not disable an explicitly selected
   sandbox. Tool-name deny stays final.
3. All three Exec modes use the same enforced policy. Failure cannot trigger a
   hidden host-direct retry or weaker sandbox tier.
4. Preserve Windows `cmd.exe /d /s /c` semantics. Do not substitute Linux execution
   or rewrite shell strings to redirect arbitrary absolute paths.
5. Preserve the existing Agent Home-relative `cwd` resolution. The resolved
   directory is the actual execution directory, not a permission grant or an
   automatic copy destination. Existing file tools and Exec see the same project.
   Commands outside the permitted view fail without implicit extra access.
6. Writable paths come from trusted configuration, not Agent explanations,
   command approval or `cwd`. Agent Home is not automatically writable merely
   because it is the default relative-path anchor.
7. Report real output/activity only. Isolation failure is an execution failure,
   not fabricated user rejection or policy-model output.

## Lifecycle and resource ownership

Launch and policy validation must finish before reporting a running workload or
publishing a background `runId`. Probe success is advisory; launch can still fail.
Partial startup failures must terminate any owned workload and release handles.

Foreground execution retains call Abort ownership. A successful yield/background
handoff transfers the live workload handle to the existing Process owner; finishing
the Tool call must not dispose the handed-off sandbox.

Terminal settlement remains single-winner. Timeout, Abort, manual kill, Session
deletion and Host shutdown must terminate the actual workload and descendants,
drain or explicitly bound output, and release native handles and owned temporary
resources. A helper PID alone is not a sufficient termination contract.

An immediate-background call retains its startup Abort ownership until successful
handoff; a yield call retains it until promotion. This deliberately closes the
current background startup gap: the existing immediate-background path does not
pass Parent Abort to launch. A canceled pending launch must not later publish
a successful `runId`.

Keep managed records internal during startup and expose them only after successful
handoff. Check completion versus yield/Abort before promotion. SDK termination
also removes remaining descendants when the root command exits; detached servers
must keep their root command alive, not expect children to outlive a completed
root. Document this intentional sandbox-only lifecycle difference.

For normal termination, call SDK kill and observe wait/stream settlement before
release and temporary cleanup. Dispose terminal handles idempotently; active
disposal is not a substitute for proof of cleanup. A failed cleanup retains its
owner and reports failure instead of marking the record cleaned or deleting it.

## Failure, Abort, deadline, and concurrency semantics

- Unsupported host, request, artifact or binding: explicit failure before target
  execution, with a useful reason and no success-shaped fallback.
- Abort before/during launch: no surviving workload and no background publication.
- Timeout/kill versus natural exit: preserve existing terminal precedence and
  avoid duplicate completion or cleanup.
- After handoff, Parent Abort must not incorrectly take ownership back.
- Resource or cleanup failure must remain visible through the repository's
  established failure/diagnostic path; do not silently forget live resources.

Use one adapter-owned command deadline, retaining existing foreground defaults
and explicit/no-timeout rules for background and yield. Track a stop request
before, during and after SDK spawn; a late successful spawn after cancellation
must be terminated and settled before releasing ownership, never published.
Do not have both the SDK scheduler and adapter timer independently settle the
Tool result. Framework deadlines remain the outer existing execution boundary.

Cancellation during native launch may not stop the launch itself immediately
because SDK spawn takes no AbortSignal. Retain pending ownership until the
native call rejects or returns a handle that can be killed. Test this state
explicitly; a rejected started Promise alone is not proof that no workload exists.

### Temporary environment proposal

Use a uniquely created per-execution temp root outside Agent Home, plus a minimal
Windows/Node environment. Reserve SystemRoot, ComSpec, HOME/USERPROFILE,
LOCALAPPDATA, TEMP/TMP and trusted PATH preparation from call-level override;
reject conflicting supplied entries explicitly in sandbox mode. Preserve ordinary
call-level environment additions that do not change the reserved bootstrap.

Configure offline npm/cache/update-notifier values for the initial no-network
profile. Never merge the whole host environment or log its values. Keep temporary
directories until the workload tree and native resource release settle; Session
cleanup and Host shutdown own any handed-off command's final cleanup.

### Contained TEMP bootstrap

The public SDK request alone cannot guarantee a ready private Windows TEMP.
The tested host rewrites TEMP, TMP and LOCALAPPDATA to random per-sandbox paths
without creating them; precreating `Packages` did not fix it. TMPDIR alone
does not redirect Windows Node `os.tmpdir()`.

Select one small trusted Node bootstrap inside the MXC boundary, using the same
Node runtime as the Host. This is an application-owned JavaScript entry, not a
new native executable, sidecar service, backend or SDK fork. Do not reuse the
disposable Spike script as production code without implementing and validating
the accepted contract.

1. Host creates a unique empty root and passes the fixed bootstrap's absolute
   path to SDK spawn. Grant that entry read-only access, not writable access to
   the installed application. Preserve original `cwd` as the bootstrap's cwd.
2. Attach SDK streams before wait. Pass one bounded private JSON envelope on
   stdin with the unchanged command and trusted owned root; do not put the
   envelope in executable argv or an Agent-supplied environment variable.
   Check Abort before sending it. SDK startup alone never resolves `started`.
3. Bind the root to a reserved Host-generated bootstrap environment value; reject
   an envelope naming another directory even when that directory is writable.
   Call-level environment cannot override this value, and it is removed before
   the user Shell starts. Bootstrap validates the envelope and root, then prepares Windows-rewritten
   data paths and stable home/appdata/tmp/cache directories within that root.
   Reject outside-root, malformed and reparse escapes before launching user code.
   Cleanup later targets the original owned root only.
4. Set the child TEMP/TMP and LOCALAPPDATA to the now-existing owned directories,
   with explicit offline npm/cache settings. Do not alter host environment,
   machine permissions or the configured project/content grants.
5. Launch the original command via the existing `cmd.exe /d /s /c` argv
   convention and `windowsVerbatimArguments: true`. Do not concatenate setup
   commands, rewrite paths or reinterpret the user command.
6. Buffer child stdout/stderr until the bootstrap emits exactly one bounded
   startup frame after the actual Shell spawn. A failed preparation/spawn emits
   failure, not readiness. Host consumes this private first frame, validates it
   and then treats every following byte as ordinary command output; user output
   resembling a frame must not trigger a new handshake.
7. Shell exit propagates its code, drains output, and closes the bootstrap root
   so native job cleanup removes remaining descendants. Do not wait indefinitely
   for descendant-held pipes: any output-drain cutoff must be bounded, explicit
   and separately tested, never silently drop data. SDK termination remains the
   operation for Abort/timeout/manual kill and whole-tree release.

The prototype verified unchanged cmd commands, ordinary file-backed Node temp
creation, offline npm, failure before command start, exact 512 KiB stdout /
64 KiB stderr relay, normal descendant cleanup and explicit SDK Abort.
The prototype's drain-cutoff branch was not exercised; its numeric timeout is
not an accepted production default. Final adapter/protocol, reparse protection,
output draining and installed-entry tests remain delivery requirements.

## Security and capabilities

Validate actual read/write/denied access against owned fixtures, including
reparse points and implicit OS grants. Neither a readable-path list nor
`realpath` alone proves the intended boundary. Read-only access can still expose
secrets; minimal visibility is distinct from protection against writes.

Construct a minimal environment without merging the host's entire `process.env`.
Use independent temporary data and inspect inherited handles/startup inputs.
Specify and verify network denial; do not treat cooperative proxy variables or
network throttling as deny-all enforcement.

Record supported resource controls rather than claiming CPU, memory, process or
disk limits without backend evidence. Required limits must be settled before
design acceptance; absence of a required limit blocks the corresponding mode.

The first profile claims file-content access restrictions, metadata policy,
external-network denial and process lifecycle only. Existing timeout/managed
capacity/output bounds are not per-sandbox CPU, memory, PID or disk quotas.
Do not add a resource-limit framework or market those unimplemented guarantees.

For the first no-network tooling profile, explicitly select owned tool caches
and suppress tool update checks where supported rather than inheriting host
settings. The Spike's npm task passed two fresh-home trials with offline mode,
an owned cache and update notification disabled; the unconfigured task had
unexplained cold-environment timeouts. Do not mask those failures with extended
deadlines or claim all package-manager commands work.

Review diagnostics and telemetry for the pinned distribution. Fixture-only
experiments do not authorize transmitting project data or credentials.

## Compatibility and migration

The repository currently requires Node `22.x`. The default candidate moves to
the supported Node 24 LTS SDK route; this Draft does not authorize the upgrade.
Node 24 native-addon installation must be validated rather than reusing Node 22
binaries. The Spike verified a fresh SQLite 12.8.0 Node 24 prebuild; installed
Sharp/filesystem-native smoke checks also passed, not a complete app regression.

Preserving host-direct behavior when sandboxing is explicitly off is a candidate
opt-in policy, not an automatic failure fallback. Existing approval contracts
remain unchanged. Do not introduce temporary dual implementations or dependency
exceptions without an owner-approved migration/removal gate.

Windows validation does not establish macOS/Linux support. Selecting sandboxing
on an unsupported execution host must not silently use host-direct execution.

## Acceptance and validation

1. Complete and review the Spike matrix with exact artifacts and environment.
   Missing mandatory isolation/lifecycle observations block adoption.
2. Accept binding, ownership, configuration and capability decisions,
   with applicable durable ADR/Spec contracts before Delivery.
3. Delivery checks cover newly introduced adapter behavior and existing Exec,
   Process and approval regressions; real Windows tests verify containment and
   lifecycle, including failed startup and descendant cleanup.
4. Run applicable integration, lint/build and installed-artifact checks. Add
   Fitness checks only for a new durable dependency invariant, not document text.
5. Perform focused independent review of boundary and lifecycle changes, and
   owner acceptance; synchronize only directly affected authority/guidance.

## Open questions

- Will the owner accept the validated SDK/Node 24 route and its runtime migration?
- Will the owner accept the startup-only configuration/private-control proposals
  and intentional background-startup/descendant-lifetime differences?
- Will the owner accept the measured contained Node bootstrap and its private
  startup/output protocol, rather than treating SDK-root spawn as Shell readiness?
- Will the owner accept the first profile's explicit resource/UI/path limitations,
  with focused enforcement, reparse and output-drain checks during Delivery?
- What installation and diagnostic-data requirements are acceptable?

These questions block acceptance when they affect architectural conclusions.
They are not permission to add speculative runtime paths.
