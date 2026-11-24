# MXC Sandbox Adoption

> Status: Accepted
> Date: 2026-11-23
> Owner: Project owner
> Scope: Approved Windows Exec delivery and Node 24 project migration; no global runtime change or automatic commit/push

The owner accepted the design and bounded Spike results and authorized
implementation on 2026-11-24. Earlier approval limits below describe prior
phases. Durable authority is [ADR-028](../../../decisions/adr-028-mxc-windows-exec.md)
and [Sandbox Execution](../../../specifications/sandbox-execution.md).

## Requirement and approval boundary

The owner selected Microsoft eXecution Container (MXC) as the preferred sandbox
technology and authorized creating a Draft Change. On 2026-11-23 the owner also
accepted the bounded Spike: download the official v1.1.0 native executor bundle,
verify its SHA-256, and run synthetic file/network/process probes in an independent
temporary directory, with the release's Required diagnostics disclosed.
The owner subsequently approved metadata and portable Node SDK experiments and
autonomous conservative decisions during research.
This does not authorize production dependency installation, runtime upgrades,
system permission changes, or changes to current Tool permissions and execution.

The intended outcome is optional, explicitly constrained native Windows command
execution. Sandbox enforcement remains separate from Tool approval. MXC must
demonstrably enforce the requested boundary before production adoption.

On 2026-11-24 the owner clarified that external directory enumeration and
policy-permitted external file reads are expected behavior, not a problem to
eliminate. The metadata-only candidate is therefore a documented capability
boundary, not an adoption blocker. This adds no runtime access or file-content
grant and does not accept the entire design or production migration.

The owner selected original-directory execution with constrained access on
2026-11-24. First delivery no longer includes an automatic working copy or
writeback system. Writable authorized project data can be modified/deleted;
users may supply a copy themselves when they want recovery isolation.

This is an Architecture Slice with a prerequisite Architecture Spike under
[Development Workflow](../../../governance/development-workflow.md). This Change
is non-authoritative; its existence and document states do not override current
contracts.

## Documents

- [Draft Specification](specification.md)
- [Decision Draft](decision.md)
- [Spike Specification](spike-specification.md)
- [Spike Results](spike-results.md)
- [Research input](../../../research/smart-approval-and-cross-platform-sandbox-research-2026-11-23.md)

## Scope and non-goals

- First delivery candidate: `exec` and its child processes on supported Windows,
  preserving native `cmd.exe` behavior and existing Process ownership.
- First policy candidate: original `cwd`, configured file-content access,
  independent temporary data, no automatic host credential grants, and no
  external network. Directory metadata visibility is a separate known boundary.
- A small directory-listing/file-reading probe tests whether the same boundary
  could support future file tools; it does not authorize their migration.
- Excluded: Smart Approval, model inference, all-Tool or Extension isolation,
  three-platform delivery, domain proxies, credential forwarding, automatic
  dependency downloads, and changes to existing approval modes.
- Do not build a multi-backend framework, custom AppContainer fallback,
  automatic project copy, Git worktree or writeback service.

The owner requested considering shared Sandbox path checks for host file tools
as a useful later evaluation. Keep this outside MXC-3; compare consistent software
checks and their limitations without equating them with OS isolation or committing
to a file broker. The Draft Specification records the candidate, not an approved
delivery item.

## Plan items and dependencies

| ID | Item | State | Prerequisites and exit |
|---|---|---|---|
| MXC-0 | Draft the bounded design and Spike | Completed | Owner accepted design scope |
| MXC-1 | Run the Windows MXC Spike | Completed | Owner accepted bounded Windows results |
| MXC-2 | Accept the adoption design | Completed | ADR-028/contract published; Node 24 project migration accepted |
| MXC-3 | Implement the accepted slice | In Review | Code, automated Windows checks and owner-reported Agent manual tests passed; formal closeout remains |

Items are not execution authorization. MXC-0 does not authorize MXC-1, and an
experiment passing does not authorize MXC-3.

## Known gates

1. **Runtime binding:** [package.json](../../../../package.json) requires Node
   `22.x`. Current MXC Node SDK documentation requires Node 24+ and a later
   minimum for Windows native stdio. The current terminal reported Node
   `20.16.0`, so it is not a supported project or SDK validation environment.
   The follow-up validated the public in-process SDK on portable Node 24.22.3
   and selects it as the default proposal. Do not relax engines or silently
   upgrade the project; owner acceptance and native-addon migration gates remain.
2. **Host and request support:** Windows build information alone is insufficient.
   Record MXC capability discovery, request-specific probing, and launch results.
3. **Effective isolation:** Verify actual file and network access, including
   implicit Windows ACL access. A configured path list is not proof of confinement.
4. **Lifecycle:** The existing executor exposes a Node `ChildProcess`; the SDK
   exposes its own process handle. Confirm readiness, termination, output drain,
   yield/background handoff, and descendant cleanup before designing an adapter.
5. **Distribution and diagnostics:** Pin the artifact actually tested; review
   native packaging, license, and diagnostic/telemetry behavior before execution.
6. **User-facing contract:** Accept configuration scope, opt-in behavior,
   supported resource limits, original-directory permissions and explicit unsupported
   errors before implementation.

The refined Draft proposes global startup-only `agents.sandbox`, file-only
configuration with explicit read/write/denied paths, and a private command
termination control shared by the existing host-direct/MXC execution paths.
This keeps native handles out of Core and routes managed cleanup through the
existing registry. TEMP feasibility is now measured through a small trusted Node
entry inside MXC; the public SDK request alone left rewritten TEMP directories
missing. Accepting that entry's startup/output protocol, proposed startup Abort/
descendant-lifetime semantics, Node migration and configuration remains required;
the design is not yet authorized for Delivery.

The [Decision Draft](decision.md) summarizes the runtime/binding and ownership
choices for owner review. On acceptance, publish durable rationale/contracts
to their owning ADR and stable Specifications before Delivery; this Change
remains non-authoritative.

The review-only refinement on 2026-11-24 specifies a Builder startup await barrier,
separate Host/bootstrap and user-command environments, private foreground and
terminal cleanup ownership in the existing registry, and failed outcomes for
incomplete output draining. These are proposed contracts, not newly executed
Spike scenarios or production changes. The Chinese draft is synchronized.

The follow-up provisionally passed bounded Node SDK/Node 24 execution, normal
offline npm tasks and metadata-vs-content checks. Volume enumeration enables
startup but broadens descendant metadata visibility. The default candidate is
the public in-process Node SDK, not a .NET helper or CLI fallback. See
[Results](spike-results.md). Metadata visibility is no longer a compatibility
blocker; acceptance of Node 24/native-addon migration remains required. Project engines/dependencies
have not changed. The bounded toolchain result covers explicitly configured
offline caches/update settings; unconfigured npm had unexplained fresh-profile
timeouts that remain recorded compatibility limitations.

## Validation and closeout

### Owner manual validation, 2026-11-24

The owner reported that all discussed manual tests passed during actual Agent
use. This confirms the tested Windows workflow in addition to automated evidence.
The report is user-supplied; no per-call transcript or additional platform
evidence was collected in this step.

Keep the existing documented limitations, including the default-port package
smoke follow-up. Manual validation does not authorize archive, commit or push
and does not extend the first slice to host file tools or other platforms.

The owner subsequently authorized a scoped commit of this implementation and
its documentation on 2026-11-24. Archive and push remain unauthorized.

### Automated delivery evidence, 2026-11-24

- Final full Unit run in an isolated Node 24.22.3 dependency tree: 144 files,
  2,102 passed and one platform-related skipped test. A subsequent localized
  synchronous-admission rollback passed all 23 Exec/Registry cases and type-check.
- Real Windows integration: six MXC cases plus three existing managed-process
  cases passed. Coverage includes original cwd, nested/junction denied contents,
  private TEMP, caller Node hooks, background/yield handoff, timeout, Session
  cleanup and direct Node loopback denial with a reachable external control.
- Root/workspace lint passed; full isolated build and final Host audit passed
  with 408 Host files. Existing client audit verified 62 generated assets.
- All 16 Fitness checks passed using one worker with unchanged timeouts. Earlier
  parallel I/O/compiler runs timed out. Public Config facade imports were fixed;
  the existing process-exit gate now narrowly includes the accepted contained
  bootstrap entry, not arbitrary Tool libraries.
- Independent review found a full-managed-quota foreground admission defect.
  Incoming foreground admission and abort-on-registration-failure were fixed;
  the reviewer confirmed the blocker resolved and targeted regressions passed.
- Fresh installed tarball MXC smoke passed: bootstrap present, Runtime ready,
  original-cwd writes, denied contents, private TEMP deletion and converged
  shutdown. Native DLLs stayed loaded until verifier exit; fixture deletion was
  performed afterward by its parent, not mistaken for a per-command cleanup leak.

The unchanged full `verify:package` script could not finish its empty-Home default
WebSocket check because an existing service owns `127.0.0.1:8787`. That service
was not stopped or reconfigured. Packing, installation and initial API checks ran,
and a separate installed-MXC smoke avoided the port. Retest the full default-port
check in an environment with 8787 available; do not describe this limitation as a
passed default-Host scenario.

Project manifests/lockfile now require Node 24 LTS and SDK 1.1.0. Restoration used
install scripts disabled in the live worktree; ABI-specific SQLite validation
used verified Node 24 assets only in the isolated copy/fresh install. Existing
services/global Node were not restarted or changed. Activate supported Node 24
and restore native dependencies before manually running the development checkout.
The npm lock refresh also normalized duplicate esbuild/peer metadata without
upgrading unrelated package versions.

Owner manual acceptance, default-port smoke follow-up and any future non-Windows
backend release remain separate. No commit or push is authorized automatically.

Draft-only work requires local-link and whitespace checks; it does not require
production builds or installing MXC. Spike validation follows its scenario
matrix, not the production test count.

Delivery must preserve the focused Tool/Process and approval regressions, add
only tests for introduced isolation and lifecycle behavior, and pass applicable
integration, lint, build, and packaging gates. Actual isolation requires OS
tests, not mocked capability responses alone.

At closeout, route accepted durable decisions and contracts to their owning ADR
and stable Specifications, and verified behavior to Current Architecture and
user guidance. This disposable Change must not become their authority.
