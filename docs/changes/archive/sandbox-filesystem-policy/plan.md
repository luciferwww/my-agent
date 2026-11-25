# Sandbox Filesystem Policy and Approval Plan

> - **Status:** Accepted
> - **Date:** 2026-11-25
> - **Authorization:** Owner approved design and Windows manual results, then authorized archive and scoped commit on 2026-11-25; no push
> - **Archived:** 2026-11-25
> - **Scope:** System access baseline, trusted execution resources, seven host file/search tools and approval simplification; no automatic commit, push or archive
> - **Process authority:** [Development Workflow](../../../governance/development-workflow.md)

## 1. Objective and design basis

This Change covers three related parts of the filesystem design:

1. Classify existing Windows/Linux system access without adding broad grants.
2. Describe and reuse explicit read grants for the actual trusted execution
   dependencies, not every task runtime or the whole application installation.
3. Apply the explicit read baseline and user read/write/deny to seven host
   file/search tools in software, then remove Home-external special approval
   after wiring or in the same delivery.

Sharing the explicit read baseline with host file tools is implemented and
validated within the recorded scope. It does not copy OS ACLs,
Linux baseline mounts or per-Exec temporary grants into host access.

The [design draft](../../../research/sandbox-filesystem-baseline-design-draft.md)
records discussion and independent-review corrections, not implementation
authority. The [Specification](specification.md) defines this approved slice.
Scoped contract amendments were accepted with the Plan; the owner reported
successful Windows manual verification on 2026-11-25.

## 2. Plan items and gates

| ID | Item | Status | Prerequisite / exit |
| --- | --- | --- | --- |
| SFP-0 | Obtain revised design and contract-amendment approval | Completed | Revised scope independently reviewed; owner approved 2026-11-25 |
| SFP-1 | Consolidate the explicit dependency read baseline | Completed | Shared selection implemented; System32/Node/Bootstrap/manifest/Linux npm reads retained |
| SFP-2 | Implement and wire host file/search checks | Completed | Seven tools wired; automated checks and owner-reported Windows manual verification passed |
| SFP-3 | Remove Home-external special approval | Completed | Same delivery; ordinary Tool/Exec approval preserved; Windows manual verification passed |
| SFP-4 | Validate, review and synchronize contracts | Completed | Recorded checks and Windows manual verification passed; limitations retained below |

The owner confirmed successful Windows manual verification, then separately
authorized archive and scoped commit. Push remains unauthorized.
The earlier unapproved prototype was abandoned and
the user completed its undo; its failed tests/build are not delivery evidence.
No prototype code is to be restored merely because these documents now exist.

## 3. Behavior and migration

- Enabled: the seven tools use the shared explicit dependency read baseline
  plus configured path lists in software, independently of Tool approval.
  No implicit Home/cwd, copied OS baseline or per-Exec temporary grants.
- Disabled/omitted: no software path restriction; ordinary host permissions apply.
- In both modes, allowed non-Exec tools no longer prompt solely because a target
  is outside Home. This widens allowed host file access when Sandbox is off and
  must be explicit in migration notes. Ordinary approval and final Tool deny remain.
- Keep the current network modes, System32 explicit read, private TEMP ownership,
  relative-path anchors, Settings startup-only semantics and absence of bypass.

## 4. Ownership and validation

Builtin Environment owns dependency-read selection, the software helper and its
seven call sites. Reuse the existing path-selection logic locally; do not build
a backend registry or discover all installed language runtimes. Runtime
passes the resolved startup configuration through existing Builtin assembly and
owns Tool approval simplification. Core gains no filesystem/SDK dependency.
Do not introduce a second configuration source or generic authorization framework.

Use existing test files where practical, with a small helper test file only if
needed. Cover directory inheritance and most-specific rules, outside/default
denial, enabled/off behavior, aliases and missing targets, filtered search,
link mutation and multi-file permission preflight. Remove obsolete tests of
Home-external special approval rather than retaining contradictory behavior.
Check actual tool outputs and unchanged files after rejected operations.
Verify explicit baseline resources are readable but not writable under equal
or broader user write rules; more-specific user write exceptions remain legal.
Check Exec and file tools use the same explicit read selection, while per-Exec
temporary roots and backend/OS-only access do not become host-tool grants.
Verify the current packaged Node/Bootstrap entry still starts with unchanged
effective reads; test a hypothetical exe layout only when packaging actually changes.

Run targeted tool/policy/Runtime tests first, then existing lint/build and
relevant Fitness checks. Verify real temporary filesystem cases on Windows and
Linux; unavailable environments remain an explicit unverified gate, not a pass.
Do not rerun unrelated native networking suites merely for this filesystem slice.
Document limits and obtain owner validation acceptance before closing the Change.

## 5. Contract amendments and non-goals

The proposed changes belong in [Sandbox Execution](../../../specifications/sandbox-execution.md),
[Tool Contract and Policy](../../../architecture/tools.md),
[Builtin Tools](../../../architecture/builtin-tools.md), and the directly
affected [Configuration](../../../specifications/configuration.md) and
[Tools and Hooks](../../../specifications/tools-and-hooks.md) clauses.
Reconcile the existing [ADR-028](../../../decisions/adr-028-mxc-windows-exec.md)
baseline/resource and host-file-tool scope through an owner-approved amendment before Delivery;
do not silently change authoritative documents while implementing.

No PATH discovery, default workspace/session-files directory, Smart Approval,
network changes, OS-isolation claim for host tools, new denial blacklist,
trusted-resource write-conflict rejection, patch transaction/rollback or
Sandbox escape policy. Approval of this Plan does not claim validation or
authorize automatic commit, push or archive.

## 6. Delivery evidence

Checks on 2026-11-25, using Node 24.22.3:

- Windows: final 99 focused Environment/policy/Settings UI Unit cases passed
  (three Linux-only cases skipped); eight selected Runtime cases and 16 Fitness
  cases passed. Existing file/search tests remain, obsolete external-approval
  behavior tests were replaced rather than retained.
- Native Windows: five relevant MXC Exec cases passed, covering allowed/denied
  content, cwd/TEMP, caller hooks, background ownership, timeout and yield cleanup.
  This slice did not repeat unrelated native network scenarios.
- Full lint (Host, workspaces and Vue) and full build passed; Host asset audit
  412 files and client verification 62 assets.
- Linux: the old delivery copy and Node were absent. A private checksum-verified
  portable Node was prepared without sudo/system installation. A compiled-tool
  smoke on WSL passed real file reads/writes, baseline protection, no inferred
  `/etc` grant, case sensitivity, inherited creation, filtering/direct child,
  patch preflight, link deletion/replacement, missing parents and off-mode policy.
  All fixtures were synthetic and cleaned. Native Linux MXC was not revalidated;
  no Linux package/full Unit or universal race-free claim follows from this smoke.

Independent implementation review raised a P2 about a dangling child link failing
the complete directory listing. This is retained as the approved explicit
path-resolution failure behavior, not changed to silent filtering: the spec
requires check/parse errors to propagate, separately from policy-denied entries.
A focused real-junction test confirms failure and recovery after link removal.
The review did not repeat tests or native checks.

A focused follow-up also found and fixed permission preflight for a patch that
deletes an allowed link then adds a regular file at the same name. Preflight now
recognizes the earlier removal; actual operations still recheck permissions.
Windows and Linux checks confirm the denied link target remains unchanged.

### Owner-reported Windows manual verification

On 2026-11-25, the owner reported successful manual verification and explicitly
clarified that it was on Windows, following the four-case checklist:

- Allowed `read_file` calls in read/write directories outside Agent Home without
  additional approval.
- File creation in the write directory after ordinary write-tool approval,
  followed by an allowed read.
- A write attempt in the read-only directory remained rejected after ordinary
  approval.
- Directory/search output filtered denied data and direct denied-file reading
  failed without an extra approval prompt.

This is owner-reported acceptance evidence, not an independently repeated test
or a supplied raw trace. It is not Linux manual verification. The Linux evidence
remains the compiled software-tool smoke above, not native MXC revalidation.

No user configuration was modified by the assistant and no test service was
started. The owner subsequently authorized archive and scoped commit; no push.
