# Windows MXC Execution Feasibility Spike

> Status: Completed
> Date: 2026-11-23
> Owner: Project owner
> Decision unlocked: Binding and supported boundary for the [Draft Specification](specification.md)
> Execution authorization: Owner accepted the bounded native-executor experiment on 2026-11-23
> Readiness: Owner accepted the bounded Windows results and design on 2026-11-24; production validation remains required

The owner-approved native round and metadata/portable-Node-SDK follow-up have
stopped with no active probes or workload processes. See
[Results](spike-results.md) for the bounded pass, broader metadata visibility and
remaining product-validation limits. This evidence does not authorize Delivery,
production runtime/dependency changes or broader file-content grants.

The owner approved downloading the official v1.1.0 binary bundle (approximately
509 MiB), verifying its published SHA-256, and executing synthetic probes in an
independent temporary directory. Required Windows diagnostic collection was
disclosed before approval. No Node upgrade, production dependency installation,
real project/credential access, or system permission change is authorized.

After strict-UI startup failed, the owner approved staged UI compatibility
experiments: first allow UI initialization with container-level UI isolation;
if needed, test the Desktop isolation used by Codex. Clipboard, input injection,
desktop/system controls, file and network restrictions remain configured.
This does not authorize adding Codex's `registryRead` capability or adopting its
broader Desktop policy in production. No real desktop/clipboard interactions are
part of the probes.

On 2026-11-23 the owner approved follow-up investigation of minimum directory
metadata permissions, followed by a portable Node 24.21+ and official Node SDK
experiment in an independent temporary project. This permits temporary runtime/
SDK downloads, not a project/global Node upgrade or production dependency change.
Keep file-content read/write grants unchanged and record the actual metadata
visibility of any enumeration grant rather than assuming it is non-recursive.
Dependency preparation starts with lifecycle scripts disabled.

## Decision question

Can a published MXC binding provide native Windows execution with the proposed
file/network boundary and existing Exec/Process lifecycle, without an unapproved
runtime migration or silent weakening of constraints?

## Falsifiable hypothesis

On an approved compatible Windows host, an explicitly selected MXC
ProcessContainer/BaseContainer workload can enforce the fixture policy, expose
correct readiness/output/exit information, and retain a terminable workload-tree
handle across foreground and managed execution.

The hypothesis fails for a candidate route if required access is possible,
confinement failure still starts the target, or lifecycle behavior cannot be
preserved within the existing ownership boundary. Unsupported hosts establish
an environment blocker, not proof that the technology is universally unusable.

## Scope and non-goals

Compare a published Node SDK route and, if runtime constraints require it, a
published native executor route. Static artifact/API inspection comes first;
execute only the smallest approved candidate needed to resolve the decision.

Use known fixture programs for command and directory-listing/file-reading
probes. No production code, installed application migration, file-service
framework, Smart Approval, all-platform testing, custom fallback backend,
network proxy or credentials.

Node upgrade and executor distribution are possible decision outcomes, not
preapproved changes. Do not install into the repository to make the Spike run.

## Method

### Preflight

1. Obtain owner acceptance of this Spec and approval of the environment,
   artifacts and fixture/network scope before execution.
2. Record Windows edition/build/architecture, exact SDK or executor version,
   provenance/license, actual Node version and required runtime minima.
3. Inspect distribution and telemetry/diagnostic behavior before importing or
   launching native code. Use only synthetic request data.
4. Prefer an already available compatible runtime. If missing, record the blocker
   and seek scoped provisioning approval; do not alter PATH, engines, Windows
   configuration or machine-wide installations.
5. Record platform discovery and request-specific probing. Then verify launch;
   neither OS version nor discovery alone is sufficient.

### Fixtures and instrumentation

Create a unique owned fixture directory outside the real project and Agent Home:

- `source`: synthetic original files; record hashes for write-protection checks.
- `work`: disposable copy, with a small known script and marker files.
- `readonly`: readable but non-writable synthetic data.
- `blocked`: synthetic secret marker that must not appear in output.
- `temp`: independent scratch/home data for the workload.

Record configured policy and actual backend/tier, output, target/helper PID
meaning, exit/timeout/Abort results, timestamps, child liveness and handle/temp
cleanup. Read or hash fixtures independently from the trusted test controller;
do not rely on the workload's self-report as proof.

Use bounded output and short fixture deadlines. For network probes, use only
approved test listeners/destinations with inert markers and bounded attempts.
Record address family, protocol, destination and observer evidence. No public
service or real account is required. Missing non-loopback evidence must be
reported as an outbound-network coverage gap, not a full deny-all pass.

## Required evidence

| ID | Scenario | Required observation |
|---|---|---|
| M0 | Artifact/runtime/host support | Exact versions, runtime minima, probe and launch evidence, diagnostic-data review; unsupported requests fail explicitly |
| M1 | Native command readiness and output | Target marker appears only after containment; preserve stdout/stderr, non-zero exit and `cmd.exe` argument behavior, including paths with spaces |
| M2 | Read/list access | Allowed file/listing succeeds; blocked file reads fail with no marker disclosure; missing allowed files report real errors, not empty-success results |
| M3 | Writable boundary and aliases | Work/temp writes succeed; source/readonly/blocked writes fail; source hashes remain unchanged; owned reparse-point and applicable local-path aliases do not expose blocked targets |
| M4 | Network denial | Deny-default outbound and host-loopback policy is active; approved IPv4/IPv6 TCP/UDP probes show blocked access with controller observations; report unavailable coverage explicitly |
| M5 | Foreground lifecycle | Natural completion, timeout and Abort terminate owned descendants and release resources; pre-aborted/startup-Abort cases do not publish a running workload |
| M6 | Yield/background ownership | Hold the workload handle through handoff; Parent call completion/Abort does not prematurely stop it; explicit kill, Session-style cleanup and controller shutdown remove the tree |
| M7 | Failure and terminal races | Probe/launch errors do not start a host-direct target; exit-versus-kill settles once; abnormal executor/controller exit does not leave fixture children running |
| M8 | File-service feasibility | A minimal contained process handles repeated bounded directory-list/read requests; blocked reads remain denied; record transport/lifetime requirements without migrating production tools |
| M9 | Representative local tooling | Installed node/git/npm run known offline fixture tasks with expected results; include python only when available; no package downloads or unknown repository scripts |

Any intended production guarantee not established by these rows remains open.
Record actual resource-control capabilities and basic startup/output overhead;
do not invent performance thresholds or treat measurements as resource limits.

## Success, failure, and stop conditions

- **Provisional Pass:** mandatory scenarios for the proposed route have measured
  evidence, and the Results describe a bounded binding and preserved lifecycle.
  Owner review is still required to complete the Spike.
- **Failed candidate:** required denial is bypassed, target readiness is falsely
  reported, descendants survive required cleanup, or a required semantic cannot
  be preserved. Stop that route and document the evidence.
- **Blocked:** approved artifacts/runtime, native host capabilities or safe probe
  coverage are missing. Do not hide a blocker by skipping cases and claiming Pass.
- A narrowed supported scope requires owner review; it is not permission to
  remove a required constraint or introduce a weaker fallback.
- Stop immediately on unexpected access to real data, machine-wide permission
  modification, unexplained external traffic, or processes outside the fixture
  ownership boundary. Preserve safe diagnostics and clean only owned resources.

## Constraints and safety

- The machine may be shared. No changes to real project files, Agent Home,
  account permissions, filesystem ACLs outside fixtures, firewall rules,
  Windows capabilities, globally installed tools or another user's resources.
- No real secrets, provider calls, billing, untrusted scripts or package
  lifecycle hooks. Review any unavoidable diagnostic transmission before launch.
- Do not use audit modes that disable enforcement to claim a sandbox pass.
- External listeners, runtimes or dependency provisioning require separate
  scoped approval. Do not download/install dependencies merely because this
  Draft exists.
- Track workload and fixture process identities; terminate only explicitly owned
  processes/handles. Do not kill by executable name.
- Cleanup only named owned files/subdirectories after stopping their users.
  Never recursively delete the workspace, home, or session root.
- Retain useful failures and report cleanup failures; do not record secrets or
  imply that model predictions establish OS enforcement.

## Deliverables

After approved execution, produce a Spike Results document using
[Spike Results Template](../../../templates/spike-results-template.md), with
scenario observations, exact versions, untested guarantees, cleanup status,
and a recommendation for the binding/contract decisions in
[the Plan](plan.md).

Keep disposable harness code outside production source and remove unneeded
fixture artifacts. Do not create a success Results record before execution.
Passing evidence permits design refinement, not implementation.

## Sources and evidence limits

- [MXC repository](https://github.com/microsoft/mxc) and
  [Node SDK documentation](https://github.com/microsoft/mxc/blob/main/sdk/node/README.md)
- [Windows version support](https://github.com/microsoft/mxc/blob/main/docs/backends/process-container/os-version-support.md),
  [filesystem baseline](https://github.com/microsoft/mxc/blob/main/docs/backends/process-container/filesystem.md),
  [network enforcement](https://github.com/microsoft/mxc/blob/main/docs/backends/process-container/networking.md),
  and [telemetry](https://github.com/microsoft/mxc/blob/main/docs/telemetry.md)
- [Project runtime requirement](../../../../package.json) and
  [current Exec/Process contracts](../../../architecture/builtin-tools.md)

These were documentation/source inputs reviewed on 2026-11-23, not successful
local executions. Live `main` documents are not evidence that a published
artifact contains the same capabilities; record the tested artifact's own
requirements and behavior.
