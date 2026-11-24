# Linux MXC Support

> Status: Accepted
> Date: 2026-11-24
> Owner: Project owner
> Archived: 2026-11-24
> Scope: Owner-accepted Linux delivery; archive, test-service stop and scoped commit authorized; no push

The owner accepted delivery and authorized archive, stopping the independent
WSL test Agent and committing the Linux changes on 2026-11-24. The service exited
cleanly; its Home and login credentials were preserved. Earlier phase limits
below describe their respective approvals, not a remaining delivery blocker.

The owner accepted the Linux design and bounded Spike results and authorized
implementation on 2026-11-24. Earlier review-only limits below are provenance.
The Linux amendments to ADR-028 and Sandbox Execution own the durable contract.

## Requirement and current state

The owner requested WSL2/Linux feasibility research and continued design.
The initial [Spike](spike-specification.md) passed 18 bounded checks;
[Results](spike-results.md) record exact host/capabilities and limitations.

Follow-up probes confirmed that the SDK publishes a `bwrap` host-root handle
before some setup failures, and that precreated private HOME/native temp work.
The [Draft Specification](specification.md) therefore retains trusted readiness
signaling without copying Windows profile preparation.

The Linux amendment now preserves Windows behavior while adding the accepted
offline Linux execution route. Research review limits below are historical;
current production work is authorized, but system changes, commit/push and final
delivery acceptance are not automatic.

The owner explicitly chose continued design review on 2026-11-24. The Draft now
names the shared-versus-OS-specific bootstrap boundary, exact host-versus-
namespace PID mapping, case-sensitive Linux validation and rejection of broad
mounts that would shadow private `/tmp`. These are proposed contracts, not
newly passed implementation checks or authority amendments.

## Items and gates

| ID | Item | State | Dependency/exit |
|---|---|---|---|
| LINUX-0 | Bounded Ubuntu WSL2 feasibility | Completed | Owner accepted bounded Results |
| LINUX-1 | Linux integration design | Completed | Owner accepted reviewed contract and authority amendments |
| LINUX-2 | Implement accepted Linux adapter | Completed | Existing control/Registry reused with explicit platform env/path/PID selection |
| LINUX-3 | Validate and deliver | Completed | Automated and recorded manual results accepted by owner within the first Linux scope |

Do not read item order as authorization. Research/test harnesses are disposable
and are not the product adapter. Existing Windows authority cannot be silently
changed while implementing a Linux experiment.

## Scope discipline

Reuse existing config, command-control, ProcessRegistry and Runtime startup
owners. First Linux profile is offline bubblewrap with original cwd. No second
registry, provider framework, proxy, macOS, quotas, file-tool migration or automatic
copy/writeback. Do not grant host HOME/Windows drives to make a tool pass.

## Validation and closeout

### Owner basic manual test, 2026-11-24

The owner ran the prepared `node check.cjs` through the real WSL Agent after
Copilot device authorization. The supplied screenshot reported exit code 0,
stdout containing `MANUAL_SANDBOX_OK`, and empty stderr.

The script covers allowed file reads/writes, an external readonly file's read/
write-denial, nested denied contents, and private temporary-file creation.
Record this as owner-reported basic Agent validation, not independent replay of
the screenshot or general upstream-provider certification.

This result does not include manual network denial, background/yield termination
or shutdown cleanup. Those have automated evidence above/below but are not
claimed as owner manual tests; final delivery acceptance remains separate.

The owner excluded network testing from this manual round while network enablement
is still being discussed; the current execution policy was not changed. One
bounded parent/child heartbeat fixture was prepared for background/yield,
termination and cleanup tests, with a verification mode checking both heartbeats
stop changing. No duplicate production test suite or model call was added.

### Owner background lifecycle test, 2026-11-24

The owner supplied a screenshot reporting a successful background `exec`,
both `PARENT_READY` and `CHILD_READY` in Process logs, explicit Process kill,
terminal status `aborted`, and the follow-up verifier output
`PROCESS_TREE_STOPPED`.

Record this as owner-reported background startup/termination and known parent/
child cleanup validation. It does not establish manual yield or foreground
Abort results. Network testing remains excluded from this manual round.

### Owner yield lifecycle test, 2026-11-24

The owner supplied a screenshot reporting `yieldMs: 25` without immediate
background mode, `yielded: true` and `running` status, both parent/child readiness
markers, explicit Process kill with terminal `aborted`, and
`PROCESS_TREE_STOPPED` from the verifier.

Record this as owner-reported yield handoff/termination and known descendant
cleanup validation. Foreground Abort remains unconfirmed manually; network
testing remains outside this manual round.

### Owner foreground cleanup test, 2026-11-24

The owner supplied a screenshot showing the foreground `exec` request with
`timeout: 90` and no background/yield setting, followed by the separate verifier
request and output `PROCESS_TREE_STOPPED`.

Record the successful owner-reported post-foreground parent/child cleanup result.
The collapsed command cards do not independently expose the stop action or
canonical Abort status; no raw event replay was collected in this step.
Basic permissions/TEMP, background termination, yield termination and
post-foreground cleanup now have owner manual evidence. Manual networking remains
excluded, and formal delivery closeout is separate.

### Recorded execution evidence

- Ubuntu 22.04/WSL2, non-root user, kernel 6.18.58.1, Linux Node 24.22.3 and
  privately unpacked bubblewrap 0.6.1. SDK remains 1.1.0; no OS installation.
- Independent Linux dependencies were restored with scripts disabled. The local
  validation lock's mirror URLs were changed to official npm downloads with exact
  versions/integrity preserved after mirror timeouts; production lock was unchanged.
- Verified official SQLite 12.8.0 Node 24 Linux prebuild used only in validation.
  A first download did not follow the release redirect and produced an empty file;
  checksum rejection prevented extraction. The correctly redirected artifact
  matched the official SHA-256 before use.
- Shared tests cover case-sensitive env/root, reserved values, temp-alias denial,
  namespace versus host PID, unavailable backend, cancellation and cleanup.
  Real Linux integration passed eight MXC plus three existing process checks.
- Full Linux Unit initially found an unchanged directory-name fixture exceeding
  POSIX's UTF-8 component limit. The fixture was adapted without production behavior
  changes, preserving Unicode/JSON truncation coverage. The complete suite then
  passed; a duplicate `/tmp/` normalization case was subsequently removed.
- Full Linux build/Host audit passed (408 files), client asset audit passed (62),
  root/workspace lint passed and all 16 Fitness checks passed with one worker.
- Fresh installed artifact completed a true Agent Turn using synthetic local SSE,
  one manual approval, actual Framework Exec, denied contents/private temp and
  converged shutdown. Early verifier attempts omitted required usage/assumed
  synchronous Tool messages; those were fixture errors, corrected without product
  changes. No real Provider or credential was used.
- Windows shared Unit and six sandbox plus three process integrations passed.
  Validation applies to this host and profile, not every Linux distro/policy.

Final Linux validation: all 2,109 Unit cases passed across 144 files; eight MXC
plus three existing process integration cases passed. Lint, full build, final
408-file Host audit and all 16 Fitness checks passed. The established full
`verify:package` passed with 481 package files, empty/configured Home startup,
Extension/API/client/Settings checks and the installed CLI.

That final CLI check exposed a POSIX entry issue: npm's bin is a symlink, while
Node's module URL names the resolved file. The existing lexical entry guard
therefore exited without invoking the Host. Canonicalizing argv's entry path
fixed this directly coupled Linux packaging issue. Windows's 53 Host tests and
type checking passed after the fix.

Final Windows platform regressions passed 42 shared/locator Unit cases (five
Linux-only cases skipped), six sandbox plus three managed-process integrations
(two Linux-only cases skipped), and type checking. Independent read-only review
found no significant issue in the Linux increment or the narrow CLI entry fix;
the reviewer did not rerun native tests.

User-requested test discipline retained the existing cross-platform suite rather
than adding parallel copies. One repeated normalization input was removed; the
Unicode fixture still exercises the same truncation behavior with legal POSIX
names. No coverage or generic runtime framework was added.

Owned per-run fixtures, install-projects and listeners were cleaned. Download
archives/caches were removed; the prepared portable Linux tools and independent
validation working copy remain available for owner testing. No OS/global Node
installation, Windows dependency replacement, commit or push occurred.

The owner accepted the recorded Linux Agent manual results and current delivery.
Additional distribution/architecture/policy support remains future work, not a
claim of this release. The local synthetic Provider is not
evidence of real upstream model compatibility. No network-proxy/quotas or
broader WSL interop guarantee was introduced.

Draft work uses document/link/whitespace checks. Once accepted, implement one
working Linux caller and verify exact permissions/output/lifecycle, not just SDK
availability. Preserve failed-policy and setup errors and confirm cleanup.

Run in independent Linux dependencies and retain Windows source/tests unchanged
except directly required shared lifecycle extraction. Native Linux distro breadth,
missing-deny/OverlayFS capabilities and packaging remain explicit gates.

Durable accepted changes belong in owning ADR/Specifications and verified
implemented architecture/guidance. This non-authoritative Change may not become
the authority or imply delivery before implementation validation.
