# Host-managed Logging Specification

> Status: Validated on a Logging-only source snapshot and owner delivery-accepted; archived on 2026-11-18
> Authority: Non-authoritative design record; may be cleaned up at any time.
> Date: 2026-11-18
> Owner: Project owner
> Related Plan: [Host-managed Logging](plan.md)
> Authorization: Owner accepted the independently reviewed design, authorized Delivery, and explicitly accepted delivery on 2026-11-18 after manual verification passed. Following isolated validation, the owner authorized the scoped Logging-only commit, then the archive and archive-only commit. Push and merge are not authorized.

## Purpose and observable outcome

An Agent Home needs no per-mode logging edits. File logging is always present
in product Runtime startup; the Host decides whether Console logging can share
its terminal. Failure of the file destination cannot silently remove all
operational diagnostics.

This records the accepted target and verified delivery. Durable implemented
contracts live in the owning Specifications and Current Architecture, not here.

## Scope and non-goals

Include Logger document validation, one generic Runtime startup option,
standalone output selection, file initialization/retention/failure behavior,
dependent tests and directly owning documentation.

Do not add a logging Settings surface, dynamic enablement, mode discovery,
size-based rotation, disk quotas, compression, external destinations,
multi-process logging coordination or a replacement Logger framework.
Seven-day retention limits file age, not daily volume or total disk usage.

## Boundaries and dependency direction

- Platform Logger owns the leaf configuration, defaults, adapters, buffering,
  filtering, file naming, retention and logging-failure diagnostics.
- Platform Configuration composes and validates the Logger leaf. It does not
  decide terminal policy or learn about CLI.
- Standalone Host owns invocation mode, terminal presentation and process exit
  policy. It supplies generic Console-output intent before Runtime creation.
- Runtime Bootstrap owns the single adapter composition/configuration step
  before acquisition and runtime diagnostics. It does not inspect argv, TTY
  state, concrete Channel identity or Channel completion to choose outputs.
- Runtime retains aggregate shutdown ordering and its existing shared deadline.
  A File adapter never exits the process or stops an Agent.
- Core logging call sites and Extension APIs do not gain mode-specific logic.

## Public and structural contracts

### Persisted configuration

Remove `enabled` from both Logger adapter document contracts. Preserve:

- `logger.minLevel`, default `info`;
- optional `logger.console.minLevel`;
- optional `logger.file.minLevel`.

The existing four levels and two-stage filtering remain unchanged: the global
threshold applies before any adapter-local threshold. Omitting adapter objects
or inspecting configuration must not materialize redundant values.

A complete ordinary logging configuration can be:

```json
{
  "logger": {
    "minLevel": "info"
  }
}
```

In this Change, the seven-day retention window is a module-owned policy, not a
new document setting. Do not add a file-enabled replacement, destination path,
rotation-size field or configurable transport list.

### Host and Runtime startup

Add one optional, startup-only generic `RuntimeAppOptions.consoleLogging`
boolean. Omission defaults to true for direct Runtime callers, preserving their
ordinary Console behavior; the file destination is unconditional.

Standalone explicitly supplies `consoleLogging: false` with `--cli` and true
without it. The same saved document is valid for both invocations. Remove the
obsolete CLI/Console conflict rejection rather than rewriting the document,
mutating the loaded snapshot or configuring Logger a second time.

| Caller | Ordinary log adapters |
|---|---|
| Standalone with `--cli` | File only |
| Standalone without `--cli` | File and Console |
| Direct Runtime caller with Console option omitted/true | File and Console |
| Direct Runtime caller with Console option false | File only |

This is a product Bootstrap guarantee, not a restriction on the low-level
`Logger.configure({ adapters })` API used by tests and explicit adapter clients.

### Terminal interaction

In CLI mode suppress ordinary Console Logger records at every severity, not
merely INFO records or stdout. Sending ordinary records to stderr would still
interfere with the terminal.

Preserve CLI startup/readiness, prompt, responses, approvals and command errors.
Fatal startup errors and exceptional file-logging failure diagnostics remain
visible on stderr. These are not a second ordinary Console Logger or a
fallback claim that file logging succeeded.

## File naming and retention

Use the existing `<agentHome>/logs` directory, `app` prefix, UTC date naming and
JSONL record format. Keep the existing queue bound and entry order.

The proposed retention window includes the current UTC calendar date and the
six preceding dates. For example, on 2026-11-18, retain files dated 2026-11-12
through 2026-11-18 and remove recognized files dated before 2026-11-12.

Run cleanup during File adapter startup and on the first write after the UTC
date advances. Use the actual UTC date, not elapsed milliseconds since startup
or the machine's local timezone. No maintenance timer is introduced: files
that expire while the process is idle can remain until the next cleanup trigger.
This trigger policy is part of the accepted design.

Delete only regular, non-symlink log files matching this adapter's exact prefix
and a valid UTC filename date before the cutoff. Do not delete the current
file, future-dated files, unrecognized names, other prefixes, directories,
symlinks, Memory recall data or any files outside the selected log directory.
Existing recognized daily files participate without a migration.

Cleanup must not race an append or close owned by this adapter. Reuse its
serialized asynchronous file work; do not add a worker or recursive directory
cleanup. Cleanup/read/unlink failures are explicit maintenance failures, not
permission to remove broader paths.

## Lifecycle and resource ownership

Initialize the File destination before reporting successful Logger setup.
Creating a directory alone is insufficient: verify real append/create opening
of the current log file and release any temporary handle. This does not promise
that later writes cannot fail.

Retain the one-time bounded startup buffer. Configure the selected adapters once,
then replay buffered entries using the existing filters. A failed initialization
must close any resources started during that attempt without masking its primary
error or reporting a successfully configured Logger.

Continue asynchronous, bounded file writes. No durability-per-record, fsync,
automatic replay of dropped records or crash-recovery guarantee is added.
Do not expand the queue when the filesystem fails.

Close stops new adapter admission and drains admitted work through the existing
Runtime shutdown budget. Preserve truthful failure/deadline attribution:
failed final writes are not reported as successfully persisted, and an
unsettled close cannot silently become completed.

## Failure, Abort, deadline and concurrency semantics

| Condition | Required behavior |
|---|---|
| Invalid Logger document | Existing field-attributed validation failure before Runtime creation |
| Cannot create/open the current file during initialization | Fail startup; Standalone uses its existing fatal stderr/exit-status path; no File-to-Console success fallback |
| Expired-file cleanup fails while the current destination is usable | Report maintenance failure, retain files that could not be removed, and continue; do not claim retention succeeded |
| Append fails after initialization | Explicit emergency stderr diagnostic; do not stop or roll back the Agent/Turn, infer success, or recursively log the failure through the failing adapter |
| Bounded queue overflows | Report loss explicitly and retain the queue bound; no new unbounded retry queue |
| Final flush fails or exceeds shutdown budget | Preserve the existing failure/residual report and primary shutdown reason |

Wire the currently optional File error-reporting path so production failures are
visible even in CLI mode and regardless of ordinary log thresholds. Diagnostics
identify the operation and available filesystem error code without dumping the
failed entry, raw configuration, credentials or application payloads.

Report at most once per uninterrupted append-failure episode, resetting after
a confirmed successful append; never print once per affected entry. Likewise,
report queue overflow once until the queue has drained below its bound, and
cleanup failure once until a successful cleanup. Tests must verify suppression
across repeated failures and a new diagnostic after recovery and recurrence.
This does not authorize a new diagnostics service, background retry mechanism
or notification protocol. Preserve existing error handling for ordinary
Console writes.

Log failure must not create new Model calls, cancel Tools or change permission
decisions. Do not change Agent Home locking or support concurrent writer
processes as part of this Change.

## Compatibility and migration

Use a direct cutover. Both `logger.console.enabled` and `logger.file.enabled`
cease to be admitted fields, for true and false alike.

Logger already rejects unknown fields, and Platform Configuration already maps
those errors to full document paths. Reuse that behavior after removing the
fields; do not add a pre-scan for old fields, special retired-field errors,
aliases, migration readers, silent ignored values or startup write-back.

Update maintained examples and dependent fixtures during Delivery. Existing
Agent Home documents need their obsolete fields removed manually; preparation
does not edit the owner's selected configuration. The replacement minimal
document works in both startup modes.

Logger changes remain startup-only. No Settings section or live policy
publication is introduced.

## Acceptance and validation

Use existing test runners and temporary Agent Homes, never the owner's logs.
Required behavior includes:

1. Sparse/default configuration and retained local/global levels resolve
   correctly. Both removed fields fail for boolean values through the same
   generic mechanism as an unrelated unknown Logger field, with exact paths.
2. CLI and service starts consume the same new-shape document. CLI gets only
   File; service gets File plus Console; direct Runtime callers follow the
   generic option. Do not assert only a helper's return value.
3. A real, non-mocked Logger writes startup and running records to the temporary
   Home, while CLI output has no ordinary Console Logger records and retains
   interaction/readiness. Service output and files contain expected records.
4. Startup file-open failure rejects startup and the generated Host entry exits
   unsuccessfully with visible diagnostics. No Provider/Memory initialization
   should be needed to establish this boundary.
5. Cleanup tests control UTC time and check the exact seven-date boundary,
   rollover, startup after inactivity, preservation of unrelated/symlink/future
   files, and explicit cleanup failure. No size cap is claimed or tested.
6. Inject append failure and queue overflow. Verify bounded non-recursive
   diagnostics and continued caller behavior, not just callback presence.
7. Cover partial adapter initialization cleanup, startup-buffer filtering,
   ordered flushing and close failure/deadline behavior without new timeouts.
8. Reuse focused Logger, configuration-loader, Runtime Bootstrap/application
   and standalone Host test files, then affected regression, lint and build.
   Include a generated-entry/temporary-Home check with no paid calls, embedding
   downloads, live Provider or existing Home edits.
9. Synchronize directly owning stable contracts, current architecture, user
   guidance and examples only after implementation. Check document links and
   whitespace. Do not add brittle prose snapshots or new Fitness exceptions.

Preparation performs link/whitespace checks only; it claims no implementation
or runtime validation. Independent read-only design review subsequently returned
PASS with no required corrections on 2026-11-18.

## Open questions and acceptance

The owner has selected retention scope, failure policy and direct cutover.
No remaining product alternatives are proposed. On 2026-11-18 the owner accepted
the design after independent review, including the precise UTC window, cleanup
triggers, generic option and lifecycle/failure details. Delivery still requires
separate explicit authorization; no implementation or validation is claimed.

Follow [Development Workflow](../../../governance/development-workflow.md).
