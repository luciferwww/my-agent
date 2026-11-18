# Host-managed Logging

> Status: Delivery accepted; Logging-only source candidate validated, scoped commit authorized
> Authority: Non-authoritative delivery record; may be cleaned up at any time.
> Date: 2026-11-18
> Owner: Project owner
> Classification: Architecture Slice
> Design: [Accepted Specification](specification.md)
> Authorization: Owner accepted the independently reviewed design, authorized Delivery, reported manual verification passed, and explicitly accepted delivery on 2026-11-18. After isolated validation, the owner separately authorized the 23-path Logging-only commit. Push, merge and archive are not authorized.

## Outcome

The same Agent Home configuration starts in CLI or service mode without the
user having to switch logging outputs. Product Runtime startup always enables
file logging. The standalone Host selects Console logging according to its
invocation: no ordinary Console Logger with `--cli`, Console plus File otherwise.
Necessary CLI interaction and fatal/emergency diagnostics remain visible.

Remove `logger.console.enabled` and `logger.file.enabled`. Keep existing level
filtering and make file retention part of the Logger implementation, not a
second startup configuration task.

## Confirmed direction

On 2026-11-18 the owner agreed to automatic output selection and always-on file
logging, then authorized this branch and Plan/Specification preparation.
The owner subsequently selected:

- UTC daily files retained for seven days; no size-based rotation in this Change.
- Failure to initialize writable file logging prevents startup.
- Runtime file-write failures are explicitly reported but do not stop the Agent.
- Direct removal of the two `enabled` fields without migration or compatibility;
  use existing generic unknown-field validation.

These decisions established the drafting scope. After independent read-only
review returned PASS with no required corrections, the owner accepted the
completed Plan/Specification on 2026-11-18. Design acceptance does not claim
implementation or validation and does not authorize Delivery.

## Source evidence and owning contracts

- [Logger configuration](../../../../src/platform/logger/config.ts) owns level
  validation and adapter defaults. Console is currently enabled and File
  disabled by default. Adapter `enabled` is currently a permitted field.
- [Configuration loading](../../../../src/platform/config/agent-config-loader.ts)
  already validates Logger unknown fields before returning the application
  projection; errors retain the complete `logger.*` field path. Removing
  `enabled` from the admitted contract needs no retired-field detector.
- [Standalone Host](../../../../src/hosts/standalone/standalone-host.ts)
  currently rejects CLI plus Console Logger before Runtime creation.
  Its [existing tests](../../../../src/hosts/standalone/standalone-host.test.ts)
  require that conflict, so tests and the implementation must change together.
- [Runtime Bootstrap](../../../../src/runtime/composition/bootstrap.ts)
  currently selects both adapters from document flags and configures Logger
  before Extension Acquisition. Keep one configuration path and startup buffer.
- [FileAdapter](../../../../src/platform/logger/FileAdapter.ts) already writes
  queued JSONL entries to UTC date-named files. It has a bounded queue but no
  expired-file cleanup or size rotation. Its optional error callback is not
  connected by Bootstrap; creating the directory does not establish that the
  current log file can be opened.
- [Observability](../../../architecture/observability.md) owns implemented
  Logger behavior; [Configuration](../../../specifications/configuration.md)
  owns the public document boundary; the
  [Standalone Host contract](../../../specifications/standalone-service-host.md)
  owns terminal presentation and process policy. Those documents remain
  unchanged until accepted behavior is implemented and verified.

## Scope and non-goals

In scope:

- Remove the two document switches while retaining global and per-output levels.
- Pass one Host-selected, generic Console-output policy into Runtime Bootstrap.
- Always construct the product File adapter under the existing Agent Home.
- Keep UTC daily JSONL files and add narrowly scoped seven-day cleanup.
- Verify startup file opening, report asynchronous logging failures without
  recursion, and preserve truthful close/shutdown reporting.
- Update dependent fixtures, focused tests and directly owning documentation.

Out of scope:

- Size-based rotation, total disk quotas, compression or remote log shipping.
- New Logger manager, logging framework, dependency or output-mode detector.
- TTY-based policy, inspection of concrete Channel instances, or CLI knowledge
  inside Platform Logger or Runtime.
- A new logging Settings page, live reconfiguration, environment switches,
  configuration migration or automatic edits to existing Agent Homes.
- Changes to log payloads, a new general redaction system, Model/Tool behavior,
  or management of multiple Runtime instances in one process.
- Fixing unrelated native-image/dependency changes already in the worktree.

## Artifact rationale

Use a Plan plus change-local Specification for the public configuration,
generic Runtime startup option, file lifecycle and failure contracts.
Preserve current module ownership and dependency direction; no new ADR or
Spike is proposed. Reassess before implementation if review uncovers a change
to an accepted architectural ownership decision or an unresolved lifecycle
assumption requiring an experiment.

## Plan items and gates

| Item | Status | Exit criterion |
|---|---|---|
| HML-1: Review and accept design | Completed | Independent read-only review passed without required corrections; owner accepted Plan/Specification on 2026-11-18 |
| HML-2: Update configuration and startup routing | Completed | Both switches removed; Host-selected Console policy reaches the sole Bootstrap path; default Runtime file logging and retained level behavior verified |
| HML-3: Complete file lifecycle and diagnostics | Completed | Startup opening, seven-day cleanup, bounded failure reporting, partial-start cleanup and close behavior meet the Specification |
| HML-4: Validate and synchronize authority | Completed | Focused behavior, real temporary-Home Host checks, relevant regression/lint/build and owning documentation pass |
| HML-5: Accept delivery | Completed | Owner reported manual verification passed and explicitly accepted delivery on 2026-11-18; subsequently authorized the scoped Logging commit only, without push/merge/archive |

HML-2 depends on HML-1. HML-3 depends on HML-2. HML-4 depends on HML-2 and
HML-3. HML-5 depends on HML-4.

The owner's subsequent "继续" authorized HML-2 through HML-4.

## Independent review and design acceptance

On 2026-11-18 an independent read-only reviewer returned PASS with no actionable
design findings. The review covered source/contract consistency, ownership,
configuration cutover, retention, partial initialization, bounded failure
diagnostics, close/deadline behavior and validation scope. No files were edited,
services started or tests run by that review.

The owner subsequently confirmed design acceptance with "通过", then authorized
Delivery with "继续". Implementation and runtime validation are complete;
the owner's subsequent manual-verification result is recorded below.

## Validation and delivery closeout

The [Specification](specification.md#acceptance-and-validation) defines the
required behavioral matrix. Preparation validates document links and whitespace
only, not production behavior.

Delivery should combine focused Logger, configuration, Bootstrap and Host
selectors in the existing Unit runner. Add a real disposable-Home Host check
that does not mock away Logger configuration, proving both mode routing and
actual file records. Disable Memory and avoid live Providers, downloads and
paid calls. Exercise the generated Host entry when validating exit diagnostics.
Reuse existing shutdown tests and deadline policy, then run relevant regression,
`npm run lint` and `npm run build`; do not run builds concurrently with tests
that consume mutable output.

Synchronize Observability and Configuration architecture, Configuration and
Standalone Host specifications, Runtime startup option documentation, user
guidance and maintained examples only with verified delivered facts. Do not
rewrite historical Changes or existing user configurations.

Work on `feat/host-managed-logging`. Preserve and exclude the pre-existing
CONTRIBUTING, dependency/native-image and image-processing edits. No production
files or the owner's `test-workspace2` configuration are modified by preparation.

Follow [Development Workflow](../../../governance/development-workflow.md).

### Delivered and verified on 2026-11-18

- Removed both output switches through existing generic field validation;
  retained global/local levels. Standalone passes generic Console intent into
  Bootstrap's sole adapter composition step, with File always first.
- File startup opens and verifies the current regular file. Serialized UTC
  retention, bounded emergency diagnostics and honest loss-at-close reporting
  are implemented. Logger cleans attempted initialization resources, preserves
  the primary start failure and attempts every adapter close.
- Combined Unit selectors for Logger, configuration loading, Standalone Host,
  Runtime Builder and RuntimeApp: **256 passed in 9 files**.
- Real temporary-Home logging integration: **5 passed**. The checks use actual
  Logger/File adapters and cover default/explicit Console policy, startup
  records, unusable destination and shutdown loss attribution.
- Architecture Fitness: **16 passed in 10 files**. `npm run lint` passed root
  and workspace type checks. `npm run build` passed client generation, **62**
  asset checks, **400** Host build-file audit and **121** Relay Unit cases.
  The existing client chunk-size warning remains informational and out of scope.
- Generated Host entry checked in three disposable Homes: CLI exit **0** with
  readiness, EOF shutdown and file records but no ordinary Console records;
  service exit **0** with Console and file records; unusable logs destination
  exit **1** with stderr and no readiness. Memory and both installed Extensions
  were disabled; no network, downloads or paid model calls were used.
- Initial validation fixes: corrected one Host spy assertion; used a partial
  filesystem mock because native ESM namespace exports cannot be redefined;
  verified opened destination type because Windows can allow append-open on
  a directory. The disposable generated-entry checker initially used the
  retired global Extension switch; corrected it to per-entry disablement.
- Synchronized the owning specifications, current architecture, configuration
  guide and README. All **229 local links/anchors in 10 changed documents**
  and `git diff --check` passed. Pre-existing unrelated edits and the owner's selected Home
  configuration were not edited. No commit, push or archive was performed.

### Owner manual verification

On 2026-11-18 the owner reported that this Change passed manual verification.
No individual manual scenarios or additional results were specified; do not
infer coverage beyond that confirmation.

This records the owner's manual-verification result separately from the
automated evidence above. It does not authorize commit, push, merge or archive,
or change the separately recorded PID-lock delivery status.

### Owner delivery acceptance and proposed commit scope

On 2026-11-18 the owner explicitly accepted Logging delivery and authorized
preparing its submission boundary without committing. Keep this Change active;
commit, push, merge and archive still require separate authorization.

Use the existing PID-lock commit `77ca2c7` as the base for one Logging-only
candidate covering the following **23 paths**:

**Production (six paths)**

- [Standalone Host](../../../../src/hosts/standalone/standalone-host.ts)
- [FileAdapter](../../../../src/platform/logger/FileAdapter.ts)
- [Logger](../../../../src/platform/logger/Logger.ts)
- [Logger configuration](../../../../src/platform/logger/config.ts)
- [Bootstrap](../../../../src/runtime/composition/bootstrap.ts)
- [Runtime option types](../../../../src/runtime/types.ts)

**Tests (seven paths)**

- [Standalone Host tests](../../../../src/hosts/standalone/standalone-host.test.ts)
- [Real logging integration](../../../../src/hosts/standalone/logging.integration.test.ts)
- [Configuration validation tests](../../../../src/platform/config/agent-config-loader.test.ts)
- [FileAdapter tests](../../../../src/platform/logger/FileAdapter.test.ts)
- [Logger tests](../../../../src/platform/logger/Logger.test.ts)
- [RuntimeApp fixture](../../../../src/runtime/RuntimeApp.test.ts)
- [PID integration fixture](../../../../src/runtime/composition/agent-home-lock.integration.test.ts)

**Documentation (ten paths)**

- [README](../../../../README.md)
- [Configuration architecture](../../../architecture/configuration.md)
- [Observability architecture](../../../architecture/observability.md)
- [Runtime architecture](../../../architecture/runtime.md)
- [Changes index](../../README.md)
- [Configuration guide](../../../guides/configuration.md)
- [Configuration specification](../../../specifications/configuration.md)
- [Standalone Host specification](../../../specifications/standalone-service-host.md)
- [This Plan](plan.md)
- [Logging Specification](specification.md)

The remaining Bootstrap and Runtime/Host documentation diffs are Logging-only
after the PID split. The PID integration fixture contributes only
`consoleLogging: false`; it does not change the committed lock behavior.

Exclude all current changes in the dependency manifests, CONTRIBUTING,
image optimization and the native-image compatibility integration test.
They belong to the separate sharp/native-image work. Do not amend or duplicate
the committed PID implementation.

This inventory does not authorize staging or commit. Subsequent isolated
source validation is recorded below, separately from earlier mixed-worktree
evidence. The original index remains empty.

### Isolated Logging-only source validation

After the owner requested continuation, prepared a disposable detached worktree
on `77ca2c7` containing exactly the 23 Logging paths above. Verified that the
dependency manifests, contributor guidance and image-optimization source remain
at that commit's baseline, and the unrelated native-image test is absent.

The candidate passed:

- **260 Unit cases in nine files**, covering Logger, configuration loading,
  standalone Host and dependent Runtime/Builder behavior.
- **12 integration cases in two files**: five actual Logger cases and seven
  real-process PID cases, including retained ownership after failed Channel
  retirement and GC.
- **16 Fitness cases in ten files**, run alone with `--maxWorkers=1`.
  The first run, concurrent with Unit/integration runners, timed out in nine
  cases. No assertions, timeout limits or production code were changed.
  Running the same suite alone with one worker passed within the existing
  per-test limits; the initial timeout result is not omitted from this record.
- Full build, including root/Host TypeScript compilation, **62 client asset
  checks**, the **400-file Host audit**, and **121 Relay Unit cases**.
  Workspace and Vue type checks also passed. The existing bundle-size warning
  remains informational.
- Three generated Host-entry checks in disposable Homes: CLI exit **0** with
  real startup file records, readiness and no ordinary Console records; service
  exit **0** with Console and file records; unusable logs destination exit **1**
  with stderr and no readiness. All three config files remained unchanged.
  Memory and both installed Extensions were disabled; no live Provider,
  embedding download or paid model call was used.

This is isolated source validation using the existing installed dependencies
through a temporary junction, not a clean dependency installation or installed
tarball test, and not execution on another operating system. All **28** original
working-file hashes were verified unchanged before recording these results.
Only the delivery documents were subsequently updated. No original-index
staging, commit, push, merge or archive was performed.

### Scoped commit authorization

On 2026-11-18 the owner explicitly selected submission of the Logging changes,
without push or archive. This authorizes the previously confirmed 23-path
Logging-only commit on top of `77ca2c7`, excluding all five sharp/native-image
paths. It supersedes the earlier preparation-only authorization, not the
separate restrictions on push, merge and archive.

Commit preparation updates authorization records only; the validated production
and test implementation is unchanged. Retain the isolated validation results
and their dependency/platform limitations above. Keep this Change active until
archive is separately authorized.
