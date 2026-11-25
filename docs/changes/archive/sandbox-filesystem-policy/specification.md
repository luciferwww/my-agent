# Sandbox Filesystem Policy and Approval Specification

> - **Status:** Validated for recorded automated checks and owner-reported Windows manual verification
> - **Date:** 2026-11-25
> - **Authorization:** Owner approved design and Windows manual results, then authorized archive and scoped commit on 2026-11-25; no push
> - **Archived:** 2026-11-25
> - **Authority:** Non-authoritative archived Change record; durable contracts remain in stable Specifications and accepted ADRs
> - **Plan:** [Accepted Plan](plan.md)

## 1. Scope and activation

Cover system baseline classification, explicit application execution reads,
host file-tool checks and approval simplification as one filesystem slice.
Reuse the resolved startup `agents.sandbox` configuration for seven Builtin
host tools: `list_dir`, `read_file`, `file_search`, `grep_search`, `write_file`,
`edit_file` and `apply_patch`.

| Configuration | Software resource checks | Tool approval after this change |
| --- | --- | --- |
| `enabled: true` | Explicit dependency read baseline plus user read/write/deny; uncovered resources denied | Normal Tool rules, no Home-external special branch |
| `enabled: false` or omitted | No software path restriction; host account/OS access applies | Same normal Tool rules, no Home-external special branch |

These tools remain host processes/operations. Software validation is not MXC
OS isolation. No new config fields, per-Agent policy or live application:
Settings saves still require restart to change the resource policy.
No implicit Agent Home/cwd, per-Exec TEMP or automatically copied OS-baseline
grant is added to host tools. The shared explicit read baseline below is a new
implementation of the accepted design, with delivery evidence in the Plan.

## 2. System baseline and trusted execution resources

### System access

Retain Windows `%SystemRoot%\System32` as an explicit read dependency. Do not
add the whole Windows, Program Files, Program Files (x86) or ProgramData trees,
or a new SysWOW64 grant based only on one-machine compatibility observations.
Windows ACL baseline is independent access, not an explicit authored policy;
observed unreadable exceptions are not added to our deny list.

Linux Exec keeps MXC's existing system mount baseline: system binaries/libraries
and selected system configuration read-only, with backend-created `/proc`,
`/dev` and private `/tmp` views. Do not duplicate those grants, mount the host
root or expose its temporary directories. These backend views are not
automatically reproduced by software checks in host file tools.

### Explicit dependency reads

| Resource | Access | Exec | Host file tools with Sandbox enabled |
| --- | --- | --- | --- |
| Windows actual System32 directory | read | Retain explicit grant | Share explicit read rule |
| Current Node executable directory | read | Retain explicit grant | Share explicit read rule |
| Fixed trusted Bootstrap and required nearest package manifest | read | Retain explicit grants | Share explicit read rules |
| Existing Linux npm runtime library selected by the adapter | read | Retain explicit grant when present | Share selected explicit read rule |
| Unique per-Exec temporary root and private HOME/cache | write | Retain owned dynamic grant | Not an automatic host-file grant |
| Windows volume enumeration | metadata | Retain current request | Not copied as a software read grant |
| Other backend/OS system baseline access | Backend-specific | Leave native behavior unchanged | No inferred software grant; require an explicit rule |

Builtin Environment selects the explicit dependency reads once through the
existing installation/runtime path logic and supplies the same selection to
Exec and host file checks. User lists remain user configuration; do not persist
generated installation paths into their Settings lists. Path identity still
requires operation-time checks as described below.

These reads are a default read-only baseline, not immutable protection:
same-path read/write conflicts resolve to read, while more-specific user write
rules can permit intentional exceptions. Do not add proactive write-conflict
startup rejection. Preserve current Exec required-path denial failures and
native precedence; do not silently ignore user restrictions.

Only actual resources needed by the trusted sandbox entry qualify. A JS
distribution currently needs Node/Bootstrap/manifest; an exe wrapper may still
need them, whereas embedded resources need no external path grant. External
helpers/DLLs qualify only when the real packaging requires sandbox access.
Do not implement a hypothetical packaging abstraction, automatically grant the
whole installation, or enumerate all task Shell/Python/Java/.NET environments.
Only-host-used program/SDK files are not made readable merely because they
belong to my-agent. PATH discovery remains deferred.

## 3. Directory permissions

- `read`: reading and permitted listing/search, not mutation.
- `write`: reading and mutation, including creating, overwriting and deleting.
- `deny`: exclusion from broader grants; uncovered resources are already denied.
- Same normalized path uses `deny > read > write`; ancestor/descendant overlap
  uses the most-specific rule. A specific grant can be an exception to a denied
  or read-only parent.
- A directory grant covers its descendants, including new files/directories.
  Within an authorized write directory, ordinary creation needs no per-file
  grant or additional approval. Actual created parents must also be writable;
  a grant to one file does not authorize creating unrelated parent directories.
- Match directory boundaries, not partial string prefixes. Windows identity
  matching is case-insensitive; Linux is case-sensitive.

The policy must consider real paths of configured rules and actual targets,
including existing ancestors of missing targets. Verify path facts for an
operation rather than freezing filesystem alias results for the process lifetime.
Dangling links and realpath errors must not become success-shaped grants.
This does not eliminate TOCTOU races, reconcile every hard-link/bind-mount alias
or reproduce all backend/OS precedence details.

## 4. Tool operations

### Reading, listing and search

Check explicit roots/targets before reading or enumerating. Filter inaccessible
children before returning names or entering their directories; content search
also checks the files it actually reads. An inaccessible explicit target fails.

When searching/listing from an allowed ancestor, skip a denied directory
entirely; do not enumerate it to discover permitted descendants. An explicitly
authorized child can still be used directly as a target or search root.
Retain current ordering, ignored directories, result limits and relative output.
Do not add recursive symlink traversal as part of this change.

### Writes and links

Authorize actual writes and any directory creation. Reads/edits/overwrites
through a link check its real target. Unchanged relative-path resolution and
display do not imply access permission.

Deleting or replacing a link itself checks the directory entry under its real
parent, without following the link to delete the target. The entry still needs
write authority; do not grant its parent merely to permit deletion.
Existing content-copy moves check actual source reads, destination writes,
directory creation and source removal; they are not treated as pure rename.
Unreliable path resolution fails explicitly rather than relaxing the policy.

### Multi-file patches

Before any hunk mutation, preflight all affected read/write/delete targets,
including move destinations and needed directory creation. A permission failure
in any hunk leaves earlier hunks unapplied.

This is permission preflight, not a transaction: later I/O or hunk-matching
failures can still leave partial changes. Recheck path facts at relevant actual
operations; do not promise concurrent replacement protection or add rollback.

## 5. Approval and errors

Remove only the Home-external special path-approval branch after the seven
tools are wired, or in the same delivery. Retain:

- Tool-name `tools.deny` as final in `manual` and `allow_all`.
- `manual` Exec current-call approval even when Exec matches allow.
- Other tools matching allow proceed without extra Home-external approval;
  unmatched calls require normal approval and fail closed if it is unavailable.
- `allow_all` authorizes non-denied calls but does not bypass resource checks.
- Agent Home-relative resolution, display and existing private Exec TEMP rules.

With Sandbox off, allowed external file operations no longer require special
approval, including when no approval capability exists. This is an intentional
authorization change, not unchanged off-mode behavior or a new safety guarantee.

Resource denial returns `outcome: 'failed'` with an explicit path-policy reason.
Traversal skips policy-denied entries; policy-resolution/check failures propagate,
not masked as empty listings or successful no-match results. Preserve unrelated
existing file I/O semantics unless a change is required for these checks.
Normal approval may occur before a resource failure. No automatic grant, retry
outside Sandbox or approval-driven bypass is introduced.

## 6. Ownership, validation and adoption

Builtin Environment owns explicit dependency read selection, the shared
software helper and operation call sites. Reuse local helpers, not a new backend
or authorization framework.
Runtime forwards startup config through existing contribution assembly and
removes the approval branch; no new Core filesystem dependency or policy registry.

Focused tests must verify enabled/off behavior, actual reads/writes and unchanged
files on rejected patches; directory inheritance, same-path and child exceptions;
alias/missing-target and link-entry operations; listing/content filtering; and
normal allow/deny/Exec approval with no Home-external distinction.
Baseline checks cover matching Exec/host-tool explicit reads, rejection of
ordinary writes to baseline resources, allowed more-specific write exceptions,
retained Exec startup/TEMP ownership and no copied OS/per-Exec host-file grants.
Current package validation covers real installed resources, not future exe formats.
Use small existing tool/policy test cases and temporary filesystem fixtures;
do not retain obsolete tests or build a runtime-by-runtime test inventory.

Owner accepted the [Plan](plan.md), this design
and scoped amendments to [Sandbox Execution](../../../specifications/sandbox-execution.md),
[Tools and Hooks](../../../specifications/tools-and-hooks.md), affected configuration
clauses and [ADR-028](../../../decisions/adr-028-mxc-windows-exec.md).
Do not label those amendments implemented or validated until checks and owner
acceptance support that status. Independent review is not implementation approval.
The expanded design passed independent review and owner approval on 2026-11-25.
Implementation and recorded Windows/Linux-software checks are complete. The
owner confirmed Windows manual verification on 2026-11-25; this does not claim
Linux manual verification or native Linux MXC revalidation.
