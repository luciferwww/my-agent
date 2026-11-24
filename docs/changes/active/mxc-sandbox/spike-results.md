# Windows MXC Spike: Execution Results

> Status: Completed
> Executed: 2026-11-23 through 2026-11-24
> Environment: Windows 11 26H2 x64, build 26300.9911; MXC v1.1.0 native executor and Node SDK; Node 20.16.0 / portable Node 24.22.3
> Owner: Project owner
> Authority: Evidence only
> Overall assessment: Owner accepted bounded feasibility on 2026-11-24; production delivery is not yet validated

## Latest follow-up: metadata and SDK binding

The owner approved continuing the metadata investigation and a portable Node 24
SDK experiment, then authorized conservative default decisions during research.
The following supersedes the first round's unresolved compatibility/binding
findings; it does not authorize changing production dependencies or runtime.

| Question | Measured result |
|---|---|
| Ordinary script-loader compatibility | Without enumeration, both tested Node 20 and Node 24 file entry failed on `lstat 'C:\\'`. `processContainer.filesystem.enumeratePaths: ["C:\\"]` enabled normal file entry |
| Metadata scope | A previously ungranted synthetic descendant directory became listable. This is broader recursive metadata visibility, not a non-recursive ancestor-only grant |
| File-content boundary | The ungranted synthetic file remained unreadable/unwritable with the enumeration grant; its marker stayed unchanged. The Node SDK independently returned explicit `EPERM` |
| Normal tooling | Node 20/npm version checks and Node 24/npm 11.19.1 succeeded with enumeration. A known offline npm task ran ordinary file-backed Node code; two fresh-home trials passed with explicit offline/cache/update-notifier settings, without extending the 7-second deadline |
| Published Node SDK | Restored `@microsoft/mxc-sdk@1.1.0` through the configured registry with install scripts disabled; loaded and executed it on official portable Node 24.22.3 |
| Native process identity/readiness | SDK `spawn` supplied an OS PID verified as the actual `cmd` process, not the CLI helper. Invalid environment caused typed `MxcError(policy_validation)` before a process handle was returned |
| Output and ownership | Captured and live stdout/stderr, exit code 7, retained-handle Abort, typed timeout, repeated kill/disposal and workload-tree cleanup passed; no native-cleanup warning was observed |
| SDK file-service input | SDK stdin/streams carried three requests through one contained service: listing, allowed read, explicit denied read |
| Public egress | A payload-free outside-sandbox TCP connection to `example.com:443` succeeded; the SDK workload's direct IPv4 TCP connection was denied. This is one public endpoint/protocol, not universal egress coverage |
| Node upgrade impact | Installed Sharp and filesystem-native smoke checks passed on Node 24. The existing SQLite binary is Node ABI 127 and cannot be reused by ABI 137; the official fresh Node 24 prebuild for SQLite 12.8.0 passed an in-memory query in the temporary project |

All TypeScript SDK probes passed strict type checking. No Node VM was used as a
security boundary, TLS validation was not disabled, no real repository script or
credential was used, and project `engines.node` remains `22.x`.

### Clean-environment reliability finding

After deleting/recreating the fixtures, the original npm task timed out twice
with no stdout/stderr and `timedOut: true`; plain `npm --version` still worked.
Deny-and-record and verbose diagnostic runs completed. The verbose run showed
npm attempting a registry update check despite the task needing no dependencies.
These successes do not explain away the recorded failures or prove their cause.

The selected no-network test profile now sets an owned fresh HOME/LOCALAPPDATA
and cache, `npm_config_offline=true`, and `npm_config_update_notifier=false`.
Two independent clean profiles then completed the known task within the original
deadline. This avoids unnecessary update traffic without granting network
access. It is measured support for this explicit offline profile, not a claim
that unconfigured npm or all cold toolchains are reliable. The original timeout
remains an explicit limitation, not a retried success or a production fallback.

### Follow-up artifact identity

- Portable Node: official `node-v24.22.3-win-x64.zip`, 37,762,649 bytes,
  SHA-256 `e612af99f626ab415ea225af6bce5c971feb448cb5cae250bb1c3fa50c5f7d9f`;
  executable Authenticode signature verified.
- Node SDK: version `1.1.0`, lockfile integrity
  `sha512-tSOPZ14ddCiXHc4hVNQp5Yi22HSQEfXh58Z4O/tLzERi+23rfRmMrJoxVK5jZYhlll68u4eF/UlQSaXWyUMj4w==`.
- SQLite Node 24 prebuild: official
  `better-sqlite3-v12.8.0-node-v137-win32-x64.tar.gz`, SHA-256
  `cf91c2200c721b717a0562ecb399f60575566c5507e72426c96fb85ad2dd3d57`.
  It was installed only into the temporary package without executing install hooks.

### Default design recommendation, not production acceptance

Use the public in-process Node SDK V1 binding with a supported Node 24 LTS
runtime, rather than designing a .NET helper or treating native CLI spawn as
target readiness. The SDK declares Node 24+ with Windows stdio requiring
24.21.0 or later in that release line; this experiment tested 24.22.3.

Separate directory metadata visibility from file-content read/write grants.
The tested volume-root enumeration is a viable candidate but exposes descendant
names/attributes; do not describe it as workspace-only visibility or silently
substitute a whole-drive read grant.

On 2026-11-24 the owner clarified that external directory enumeration and
policy-permitted external file reads are expected sandbox behavior. Classify
metadata visibility as a known capability boundary, not a compatibility fault
or remaining adoption blocker. This does not add file-content permissions,
erase the measured scope, or imply that every external file is unreadable.
The Node runtime migration and remaining design contracts still need acceptance.

## Private TEMP follow-up

A clean SDK experiment observed that Windows replaced supplied TEMP, TMP and
LOCALAPPDATA with a random per-sandbox package path, but none of those directories
existed. Precreating the owned `Packages` parent did not change this. TMPDIR
remained supplied, but Windows Node `os.tmpdir()` still selected the missing
rewritten TMP/TEMP. No real user directory was supplied as HOME/LOCALAPPDATA;
the probe's temporary writes stayed inside the owned fixture.

A small trusted Node entry was then launched directly through the public SDK,
inside the same file/network/UI policy. It read a bounded private stdin request,
validated the owned root, created the rewritten and stable private directories,
and spawned the unchanged user command through the existing cmd argv convention.
It emitted a startup frame before relaying command bytes.

| Scenario | Measured outcome |
|---|---|
| Plain cmd temp usage | A command containing no setup code wrote `%TEMP%` data successfully; stdout/stderr and exit code 7 were preserved |
| Ordinary Node script | `fs.mkdtempSync(path.join(os.tmpdir(), ...))` succeeded in the owned temp root; an explicitly denied marker read remained `EPERM` |
| Offline npm | The normal file-backed test task used a ready private TEMP without changing the user command |
| Invalid root | Denied and other permitted writable roots could not replace the Host-bound temporary root; failure preceded user-command start and no success frame was produced |
| Output fidelity | Exact 524,288-byte stdout and 65,536-byte stderr were relayed after consuming the startup frame |
| Normal descendant cleanup | Shell/root completion removed the known stdout-inheriting descendant |
| Abort | SDK kill removed the bootstrap, Shell and known descendant |

The native API-only goal was disproved on this host; the contained entry is the
smallest measured preparation route, not an extra native helper or host-direct
fallback. SDK `id` now identifies the trusted Node root. Actual Shell readiness
and PID come from the entry's private first frame, not from arbitrary user output.

Initial fully quoted fixture commands did not match the existing cmd verbatim
convention; valid unchanged command strings passed without modifying execution
semantics. An initial test also wrongly required an output-cutoff warning even
though the descendant case completed normally. The corrected check verified
termination rather than requiring a diagnostic branch. The 250 ms prototype
drain-cutoff branch remains untested and is not a production contract.

This resolves TEMP preparation feasibility. It does not accept the production
protocol or prove all reparse/output/launch races; those are explicit adapter
delivery tests. All fixture roots were removed after terminal cleanup.

## First-round evidence and findings

The sections below retain the initial native-executor-only observations for
provenance. Their original failures are superseded only where the follow-up
table above records a measured solution.

## Question and hypothesis

The owner accepted the bounded native-executor experiment in
[the Spike Spec](spike-specification.md), then approved staged UI compatibility
tests. The question remains whether a published MXC binding can preserve the
proposed file/network boundary and existing Exec/Process lifecycle without
unapproved runtime migration or silent constraint weakening.

This round validates containment primitives and identifies compatibility gates.
It does not accept [the adoption design](specification.md) or authorize Delivery.

## Method actually executed

- Queried Windows PSEC support without creating a security environment:
  version 1.1 available, support flags `0xF`. The native executor's request probe
  selected `base-container` and reported deny-path, enumeration and UI controls.
- Downloaded the official GitHub v1.1.0 binary release, checked its published
  SHA-256, and verified the executor's Authenticode signature.
- Used stable request schema `1.0.0`, explicitly selected `processcontainer`,
  supplied a minimal environment with `inheritDefaultEnv: false`, and configured
  writable synthetic work/temp roots, readable runtime/fixture paths, denied
  synthetic source/secret roots, and deny-default external/host-loopback networking.
- Initially tested complete UI disablement. After owner approval, allowed UI
  initialization with `processContainer.ui.isolation: "container"` and retained
  clipboard, injection, desktop/system-control and IME restrictions. Desktop
  isolation and `registryRead` were not needed or added.
- Ordinary Node file startup failed on ancestor metadata access. Kept the file
  policy unchanged and used self-contained `node -e` fixtures to measure file,
  network and process behavior independently. This is a probe invocation choice,
  not a proposed production loader or proof that ordinary toolchains work.
- Used receiver-observed controls for six local TCP/UDP destinations: IPv4/IPv6
  loopback and this host's non-loopback IPv4 address. No public destination,
  Provider, real repository script, package download or credential was used.
- Tested bounded process trees, stdout/stderr, non-zero exit, natural completion,
  descendant-held output, timeout, helper termination, startup abort and a
  Node-controller hard exit. Terminated only tracked owned PIDs.
- Reused one contained process for three file-service requests: directory list,
  allowed read and denied read. No production Tool was migrated.

### Artifact identity

| Item | Identity |
|---|---|
| Official release | [microsoft/mxc v1.1.0](https://github.com/microsoft/mxc/releases/tag/v1.1.0) |
| Download size | 533,829,612 bytes |
| Release ZIP SHA-256 | `31a44963e288e3af23bc2e7e350608ed28f7c76b922ee7a7f1758a486dda37b3` |
| Executor SHA-256 | `cb8f9253a2288bbb5e980d63216068ea3b640ebaf845ba3fccc0d3fe822f7a0d` |
| Native DLL SHA-256 | `e7ba97ff834bd7a3921a0d0292735cb807a5967013141da540c596bbe59f5bf2` |
| Request contract | `1.0.0`, explicit ProcessContainer; no weaker fallback |

The Node SDK was not installed/imported. Its v1.1.0 documentation requires Node
24+, with Windows native-stdio minima of 24.21.0 or 26.8.0. This repository requires
Node `22.x`; only Node 20 was found on PATH and in the inspected tools directory.
This round cannot certify either the supported project runtime or the Node SDK.

## Evidence

| ID | Observation | Result |
|---|---|---|
| M0 | Native support/request probes passed; supplied host-environment canary did not reach the workload. Actual launch additionally required `LOCALAPPDATA`. Native TEMP was rewritten beneath the owned root and required directory preparation | Partial: environment contract needs explicit design |
| M1 | Native `cmd.exe` plus inline Node preserved stdout, stderr and exit code 7. Ordinary Node file entry failed; fixture output is not a general target-readiness protocol | Partial |
| M2 | Allowed reads/listing succeeded; blocked read/list failed without marker disclosure; a missing allowed file returned a real error | Pass within fixtures |
| M3 | Work writes succeeded; source/readonly writes failed; source hash stayed unchanged. Reads through an owned junction and extended local path to the blocked marker were denied | Pass within tested paths |
| M4 | All six local endpoints had successful outside-sandbox controls and no sandbox payload delivery; IPv4/IPv6 TCP and UDP loopback were covered | Partial: no public-internet test |
| M5 | Natural completion, descendant-held output and timeout removed the known workload tree. Helper abort at 0/50 ms produced no fixture-ready output or remaining owned direct descendants | Pass within the tested lifecycle cases; no production adapter |
| M6 | Retained workload/child were alive before explicit termination and gone after it | Partial: actual ProcessRegistry/Parent-ownership integration remains untested |
| M7 | Missing environment and unsupported LPAC requests failed explicitly. Helper/controller hard exits left no tracked workload survivors. Full concurrent exit/kill settlement was not independently stressed | Partial |
| M8 | One contained service returned three bounded per-request results, including an explicit denied read | Pass as a feasibility probe only |
| M9 | `node --version` and `git --version` succeeded. Ordinary Node 20 script startup and `npm --version` failed with `EPERM`, `lstat 'C:\\'` | Not passed; no Node 22/24, Python or real build/test validation |

File observations comprise 13 read/write/list/path checks. The final remaining
matrix recorded 21 passing checks and an explicit untested public-egress row.
These counts include startup/control checks; they are not an overall safety score.
Mixed short-fixture execution samples ranged from 262 to 583 ms. This is not a
benchmark, latency commitment, or resource-limit result.

## Findings

### 1. Full UI disablement is not a usable default for the tested commands

Both `cmd.exe` and direct Node returned `STATUS_DLL_INIT_FAILED` under
`ui.disable: true`. Block-mode diagnostics included a `ConvertToGui` denial.
Allowing initialization with container UI isolation advanced execution past
that failure; the broader Desktop mode was unnecessary for these fixtures.

[Codex's pinned policy mapping](https://github.com/openai/codex/blob/a1604a8c0554c09c1be45e5a121bb1889b4d9a50/codex-rs/mxc-sandbox/src/policy.rs#L324)
allows UI initialization and uses Desktop isolation for startup compatibility,
while retaining other UI restrictions; it also requests `registryRead`.
We did not copy those extra allowances. Desktop mode is broader handle access,
not creation of a private desktop.

[OpenClaw's referenced plugin](https://github.com/openclaw/openclaw/blob/08eaf404075b67d29ae13f1019db14cd88072a60/extensions/mxc/README.md)
uses an earlier MXC 0.8.0 integration and is described as prerelease. Its UI and
retired-policy examples are not a valid v1.1.0 compatibility baseline.

No real desktop or clipboard operations were attempted. Requested UI controls
and capability reports are not independent proof of every UI restriction.

### 2. Tool/runtime metadata access is a separate permission decision

Node 20's ordinary script loader and npm attempted to stat an ancestor volume
root outside the grants. Inline probes avoided that loader path, so their success
cannot certify normal scripts, package managers or the supported Node versions.

MXC documents [enumeration-only permissions](https://github.com/microsoft/mxc/blob/v1.1.0/docs/schema.md)
for query/list access without file-content reads. A follow-up may evaluate the
minimum required ancestor metadata grants, but exposing directory metadata is
still a policy change requiring owner acceptance. Do not solve this by silently
granting read access to the entire drive or HOME.

### 3. Environment and temporary-directory readiness cannot be inferred

Request probing passed before launch rejected a missing `LOCALAPPDATA`.
Adding an owned synthetic value satisfied the launch requirement without
inheriting the host environment. Windows rewrote TEMP to a package-specific path
beneath that value, but the directory did not exist.

The fixture verified that path was inside its owned root, created it, and then
wrote a marker successfully. Production must define preparation/cleanup; this
does not show that an arbitrary synthetic HOME is a complete Windows profile.

### 4. A native CLI process is not automatically the final execution contract

Observed process-tree cleanup and streaming are encouraging, including the
tested non-detached Node-controller hard exit. They do not establish a
production-ready adapter or generalize to all launch/stdio modes.

The existing executor exposes `ChildProcess` and `started: Promise<number>`.
The MXC binding must supply trustworthy confinement/start readiness, termination
and completion semantics without treating helper spawn/output as arbitrary
target readiness or inventing a target PID.

## Hypothesis assessment

**Provisional Pass for the measured Windows Node SDK route and its selected
metadata policy.** The initial fixed profile failed ordinary tooling, but the
follow-up enabled normal Node/npm tasks while preserving the tested file-content
boundary and verified the public SDK's readiness/streams/termination contract.

This unlocks design acceptance discussions, not Delivery. Production integration,
runtime migration, selected security guarantees and owner Results confirmation
remain separate gates.

## Limitations

- One Windows build; native executor and Node SDK v1.1.0 tested. No Node 22,
  other OS or installed-agent integration validation.
- Local endpoints and one public IPv4 TCP endpoint only; no universal public
  egress, public IPv6/UDP or domain-proxy proof.
- Owned existing junction/extended-path cases only; no complete UNC/device-path,
  hard-link, alias or TOCTOU assessment.
- No independently tested CPU/memory/PID/disk limits or real UI access attempts.
- Unconfigured npm tasks showed clean-environment timeouts whose exact cause is
  not established. The bounded pass covers the explicit offline/cache profile,
  not unrestricted toolchain compatibility.
- No production ProcessRegistry, Approval, Hook or Framework migration; the
  pre-aborted call and full settlement/concurrency contract remain delivery gates.
- Direct public npm metadata lookup failed with TLS handshake errors. Temporary
  SDK restoration succeeded through the existing configured registry with strict
  TLS validation; no TLS bypass or project/global runtime upgrade occurred.

## Decision impact and follow-up

Retain MXC and use the validated Node SDK/Node 24 route as the default design
candidate, but do not enter Delivery.
[The Plan](plan.md) and [Draft Specification](specification.md) must obtain:

1. Owner acceptance of Node 24 migration, with directly dependent native-addon
   installation validation. External metadata visibility is an expected boundary,
   not an outstanding defect; preserve separate file-content constraints.
2. An accepted minimal adapter and contained TEMP-bootstrap design preserving
   approval, Framework and ProcessRegistry ownership; no SDK-handle casts,
   helper-PID substitution or interpreting user output as startup frames.
3. Original-directory access contracts, plus validation for the actual
   chosen network/resource/UI guarantees and production integration.

On 2026-11-24 the owner selected original-directory execution with configured
permissions, not automatic work-copy creation. Synthetic copies in this report
are experiment safety fixtures, not a required production storage design.
Allowed writes still permit project data loss; access confinement is not rollback.

Owner review of these Results and acceptance of any follow-up experiment are
still required. Results do not authorize production work or become authority.

## Cleanup

All tracked workload/controller processes and local test listeners were stopped.
Verified release/runtime/prebuild archives, unused backend/symbol assets, package
download caches, owned fixtures/requests and raw identity-bearing denial reports
were removed. Pinned native tools, the portable Node runtime, prepared temporary
SDK dependencies, reproducible harnesses and synthetic execution evidence remain
in the current session's files directory, outside production source. Remove them
at Spike closeout when no longer needed; none changes the project/global runtime
or installed project dependencies.
