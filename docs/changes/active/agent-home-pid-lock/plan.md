# Agent Home PID File Lock

> Status: Delivery accepted for the approved Windows scope; scoped commit authorized, archive pending
> Authority: Non-authoritative preparation record; may be cleaned up at any time.
> Date: 2026-11-18
> Owner: Project owner
> Classification: Architecture Slice
> Related design: [Specification](specification.md)
> Validation prerequisite: [Native-lock Spike](spike-specification.md), [Results](spike-results.md)
> Authorization: Owner authorized isolated validation, then explicitly approved fs-native-extensions, Windows-first implementation with Linux/macOS pre-release validation, and retained locks on incomplete cleanup on 2026-11-18. Owner accepted the approved delivery scope, then separately authorized the PID-only commit on the same date. Push, merge and archive are not authorized.

## Outcome and boundaries

Keep `.my-agent.pid` readable for operators while a held operating-system lock,
not the recorded PID's apparent liveness, controls admission to an Agent Home.
Process death releases ownership without deleting a stale marker or waiting
for a heartbeat timeout.

Do not introduce a database lock, heartbeat/lease service, automatic process
termination, forced takeover, network-filesystem support, new user settings or
logging changes. Never test against the owner's selected Home.

The current implementation uses exclusive file creation, closes its descriptor
after writing metadata, probes PID liveness and renames a presumed stale file.
It does reclaim dead PIDs; it does not hold a kernel lock. Its two Unit tests
cover ordinary exclusion/release and an absent PID, not process-death release,
PID reuse or simultaneous recovery. See
[current source](../../../../src/runtime/composition/agent-home-lock.ts),
[tests](../../../../src/runtime/composition/agent-home-lock.test.ts) and
[Runtime ownership](../../../architecture/runtime.md).

## Approach and evidence

Use the conventional local-machine pattern: open a stable file without
truncation, attempt a nonblocking exclusive OS lock, write owner metadata only
after acquisition, and retain the handle until safe release.

Node's `wx` is exclusive creation, not a held lock. Do not equate holding an
ordinary Node file handle with denying writes or deletion on all platforms.
Unix advisory locks also do not make manual deletion of the pathname safe.

Upstream alternatives inspected on 2026-11-18:

- [proper-lockfile](https://github.com/moxystudio/node-proper-lockfile#design)
  documents atomic directory creation plus mtime heartbeat and stale thresholds.
  It is an established option, but does not implement the agreed held-lock
  contract. Do not silently substitute it.
- [fs-native-extensions](https://github.com/holepunchto/fs-native-extensions)
  documents `tryLock`/`unlock`, whole-file BSD locks on macOS, advisory-lock
  limitations and Windows-specific operations. Its published source includes
  native-addon loading and no bundled TypeScript declarations in the inspected
  package manifest. It is a candidate, not an accepted or locally verified
  dependency; popularity is not asserted.

Keep platform behavior behind the existing lock helper, not a general lock
framework. A narrowly scoped declaration may be needed for a verified untyped
dependency; no unsafe casts, runtime fallback or alternate PID-only mode.

## Items and gates

| Item | Status | Exit criterion |
|---|---|---|
| PFL-1: Accept target and validation | Completed | Owner confirmed the target direction and authorized isolated validation with "继续" on 2026-11-18; detailed native/lifecycle blockers remain explicit |
| PFL-2: Verify candidate | Completed for approved scope | Windows x64: 11 fixture tests passed, including 12 races and six forced restarts; owner accepted Linux/macOS execution as a pre-release gate rather than a Delivery blocker |
| PFL-3: Finalize design and dependency | Completed | Owner accepted native dependency, platform policy and conservative retained ownership; ADR-026 records the decision |
| PFL-4: Implement and validate | Completed for approved scope | High failed-Channel-stop finding corrected; 76 focused Unit cases, seven real-process integration cases and root/workspace lint passed after the fix; scoped independent follow-up found no blocker; fresh tarball installation remains unverified |
| PFL-5: Accept delivery | Completed | Owner accepted PID-lock delivery on 2026-11-18, explicitly without a commit; remaining validation limits retained; commit/push/archive require separate authorization |

PFL-2 depends on PFL-1; PFL-3 on PFL-2; PFL-4 on PFL-3; PFL-5 on PFL-4.
Native choice and Windows mechanics are supported by the Spike. Owner accepted
the remaining platform limitation and lifecycle policy before Delivery.

## Required closeout

Use disposable Homes and actual Node child processes. Verify simultaneous
acquisition, clean release, hard termination, stale/malformed metadata,
metadata readability without releasing ownership, startup failure and
shutdown behavior. Include descriptor leaks and error classification.
Run focused lock/Runtime/Host tests first, then relevant integration, lint,
build and generated-entry checks. Use existing tools; no paid calls, model
downloads or unrelated live services.

Review current Runtime release sites explicitly: they currently release at
shutdown even when the report has residuals. Define safe handoff for residual
Home writers before acceptance; do not silently broaden shutdown policy.

Cutover requires all old-protocol instances to stop once. Old and new binaries
do not cooperate on the same lock protocol. No compatibility PID-liveness
gate, automatic killing or live upgrade is proposed.

Keep this Change separate from unaccepted Host-managed Logging delivery and
pre-existing contributor/dependency/native-image edits. Do not switch branches,
stash, commit or carry those changes into a published PID-lock change without
explicit owner direction. Implementation integrates the accepted dependency
into the already-dirty manifests without removing the owner's sharp override.

Follow [Development Workflow](../../../governance/development-workflow.md).

## Validation milestone

On 2026-11-18 the isolated Spike returned a provisional Windows-only pass.
The [Results](spike-results.md) record native API evidence, the required
out-of-record Windows lock range, the absence of Linux/macOS runtime evidence
and unsafe current release sites when Home writers have not converged.
Those Spike results alone did not authorize production changes. The owner's
subsequent explicit approvals authorized the Delivery recorded below.

## Windows delivery validation on 2026-11-18

- Replaced marker creation/PID probing/stale renaming with a held native lock.
  Keep the stable, inspectable file after release, and retain failed owners'
  handles against GC until process exit.
- Bootstrap reports cleanup convergence to Builder and closes created Session
  resources on failure. Builder preserves candidate-cleanup blockers even if
  later composition shutdown is empty. Failed/residual or unexpectedly thrown
  shutdown retains the lock instead of unconditionally releasing it in `finally`.
- Direct lock Unit tests cover retained records, unrelated live PID, malformed/
  empty content, same-process exclusion, racing acquisition and repeated release.
  Expanded selectors covering Runtime, Host, Logger and config loading:
  **565 tests in 34 files passed**.
- Real-process integration: **six PID-lock cases passed**, covering races,
  metadata inspection, hard-kill recovery, actual Runtime completed/incomplete
  shutdown and safe/unsafe failed-startup cleanup. Tests drop the closed Runtime
  reference and force GC before checking retained ownership.
  Existing actual Logger integration: **five passed**; combined **11 cases**.
- **16 Fitness tests in 10 files**, root/workspace lint, and full build passed.
  Build also verified **62** client assets, **400** Host files and **121** Relay
  Unit cases. The existing client chunk-size warning remains informational.
- Generated Host CLI checks used disposable Homes with Memory and installed
  Extensions disabled: readable PID, contender exit **1**, normal EOF close,
  hard-kill/restart, unchanged config and no ordinary Console records passed.
  Service Console output/exit **0** and unusable-log fatal exit **1** also passed.
- Native dependency is pinned at **1.5.3**; loading its prebuilt addon passed.
  The existing sharp **0.33.5** override remains deduplicated.
- A fresh tarball was packed, but its clean install exceeded the bounded
  install timeout. An offline alternative failed with `ETARGET` for the
  pre-existing `ajv@^8.20.0` requirement. Do not infer the package/version is
  globally unavailable from an offline cache failure. Installed-tarball
  execution therefore remains **unverified**, distinct from successful
  generated-entry/native-load checks using current dependencies.
- Re-test clean package installation using a registry/cache that resolves the
  declared dependency tree, then repeat installed CLI contention/exit/restart
  and native loading. Do not lower existing dependency ranges or lengthen
  deadlines to mask that environment limitation.
- Linux/macOS execution remains the owner-approved **pre-release gate**.
  Source/binary presence and Windows results are not runtime evidence there.
- Fixed validation findings: startup candidate cleanup errors were not visible
  in an empty subsequent shutdown report; typed cleanup closures needed stable
  captures; the child-worker test harness needed an explicit nonrecursive type;
  residual assertions now respect canonical sorting without leaking a Logger
  mock into later tests.
- Synchronized ADR-026, Runtime contracts/architecture, Host contract and user
  troubleshooting. All **224 local links/anchors across 11 documents**, new-file
  whitespace and `git diff --check` passed. Unrelated contributor/native-image
  source hashes were unchanged. The selected user Home and unrelated
  source edits were not changed. No user process was killed and no commit,
  push, branch switch or archive was performed. Disposable validation artifacts
  were removed; production behavior is covered by retained regression tests.

### Platform admission amendment

On 2026-11-18 the owner requested removal of the platform restriction. Removed
the Windows/Linux/macOS allowlist without adding warnings solely for unvalidated
systems. Native loading and lock capability decide availability; Windows retains
its readable-metadata lock range and other platforms request whole-file locks.
No PID-only fallback or additional supported-platform claim was introduced.

Seven focused lock Unit cases and root/workspace lint passed, as did whitespace
checks. The regression test substitutes an unlisted platform name while using
the real host backend; it proves removal of artificial admission, not execution
on FreeBSD or another OS. Existing cross-platform and fresh-install validation
limitations remain unchanged.

## Independent implementation review

On 2026-11-18 the owner requested an independent implementation review. A
read-only reviewer found one **High** delivery blocker, subsequently confirmed
against the relevant source:

- A retired Channel whose `stop()` rejects can remain active, but the
  lifecycle owner's next stop attempt returns successfully solely because
  `stopStarted` is already true. A later Runtime shutdown can therefore see
  empty failure/residual arrays and release Home ownership despite the
  surviving Channel.
- The reviewer reproduced the actual Composition Manager sequence in memory:
  retirement reported a failed residual, subsequent shutdown reported completion,
  and the underlying Channel stop call count stayed at one.
- Relevant source:
  [Channel lifecycle handoff](../../../../src/runtime/composition/runtime-composition-manager.ts)
  and [lock-release gate](../../../../src/runtime/composition/runtime-builder.ts).
- Required correction: preserve the failed stop outcome rather than converting
  a prior attempt into confirmed closure; add failed-retirement-then-shutdown
  regression evidence proving Home ownership remains retained.

The review did not modify production files or run live services. The following
correction was performed separately after the owner requested continuation.

### Finding correction and regression validation

The owner authorized continuation and emphasized avoiding overdesign or scope
expansion. The correction changes only two production locations: the Channel
owner caches its original stop Promise, preserving rejection without another
Channel stop call, and the lifecycle ledger includes retained failures even
when another retry is not allowed. Builder's release gate, lock protocol,
shutdown budget and retry limits are unchanged.

- New synchronous-throw and rejected-Promise regressions reproduced the false
  completion before correction. They now preserve the failed owner across
  repeated shutdown reports after retirement has fully settled.
- The existing persistent-failure test now verifies failures remain reported
  both without retry and after the retry limit, without extra stop attempts.
- A real Runtime child-process regression reproduced completed lock release
  before correction. It now reports the failed Channel and `agent-home-lock`
  residual, remains locked after dropping the Runtime reference and forcing GC,
  rejects another process, and permits acquisition only after owner exit.
- **76 Unit cases in five files**, **seven real-process PID integration cases**,
  and root/workspace lint passed on Windows after correction.
- The earlier full build and broader validation counts predate this localized
  defect fix; they were not rerun or relabeled as post-fix evidence.

The reported High finding is corrected and regression-validated. This initial
validation was not an independent-review pass; the subsequent scoped review is
recorded below. Owner delivery acceptance and the remaining platform/install
limitations are unchanged. No commit, push or archive is authorized by this
correction.

### Independent follow-up review

The owner explicitly selected an independent review of the correction only.
The read-only review found **no blocking finding** within the two production
edits and their dependent shutdown/lock-release chain:

- The cached Channel stop Promise preserves synchronous throws and asynchronous
  rejections rather than reporting a successful no-op.
- Retained lifecycle failures continue to block Builder's lock-release gate
  when retry is disallowed or exhausted.
- The reviewer ran **35 manager/lifecycle Unit cases** and the **one targeted
  real-child failed-retirement integration case** successfully, including
  contention after GC and acquisition after owner exit.

This is a scoped Windows follow-up result, not a fresh review of unrelated
dirty work or a full-build/cross-platform/package-install validation. Delivery
acceptance, commit, push and archive remain separate owner decisions.

## Owner delivery acceptance

On 2026-11-18 the owner explicitly selected "accept PID-lock delivery, without
committing yet." This accepts the approved Windows-scoped behavior and recorded
evidence, including the corrected High finding and scoped independent review.
It does not accept or publish the separate Host-managed Logging Change.

Linux/macOS execution remains a pre-release gate. Fresh installed-tarball
execution remains unverified after the documented installation limitations.
Acceptance does not convert either limitation into passing evidence.

Keep this Change active until separately authorized to archive. No commit,
push, merge, branch switch or archive is authorized by this acceptance.

## Scoped commit authorization and isolated validation

After reviewing the PID-only submission boundary, the owner explicitly requested
the commit on 2026-11-18. This later authorization permits the scoped commit only,
not push, merge or archive.

Prepared a disposable detached worktree from the original HEAD and assembled
the 24-path PID-only candidate. Shared Bootstrap and documentation exclude
Host-managed Logging changes; the new PID integration fixture omits the
Logging-only Console option. Dependency manifests retain baseline sharp and
all existing lock records, adding only `fs-native-extensions` and its five new
transitive packages. Structured assertions verified this dependency boundary.

The isolated source candidate passed **76 focused Unit cases**, **seven
real-process PID integration cases**, and the **full build**, including
**62 client asset checks**, the **400-file Host audit**, and **121 Relay Unit
cases**. The pre-existing client bundle-size warning remains informational.
Validation reused the existing installed dependency tree through a temporary
junction; it does not prove a clean dependency installation or installed-tarball
execution. Linux/macOS execution and the recorded fresh-install limitation
remain open.

The original worktree's Logging and unrelated sharp/native-image changes are
excluded from this commit and remain available for separate delivery.
