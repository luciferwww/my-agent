# Settings Boundary Extraction Specification

> Status: Validated
> Date: 2026-11-11
> Owner: Project owner
> Related Plan: [Settings Boundary Extraction](plan.md)
> Related Decision: [ADR-024](../../../decisions/adr-024-settings-contract-and-model-test-ownership.md)
> Authorization: Owner accepted this design and authorized bounded Delivery on 2026-11-11
> Implementation: Extracted and wired; scoped checks passed after the separately authorized FT-01 correction; owner accepted delivery and validation and authorized archive on 2026-11-11, without a commit
> Authority: Archived Change design and acceptance record; durable ownership belongs to ADR-024 and current behavior remains in stable Specifications

## 1. Purpose and observable outcome

Preserve all externally observable Settings behavior while isolating model Test
resource ownership and removing Settings contract ownership from Channel.
Smaller files alone do not satisfy acceptance.

## 2. Scope and non-goals

Scope is limited to the two extractions in the [Plan](plan.md#2-scope).
Its non-goals are binding. In particular, section-view extraction and existing
unrelated Fitness failures are not implementation tasks in this Change.

## 3. Boundaries and dependency direction

Accepted boundaries:

- `src/core/settings/` owns the three transport-neutral Settings contracts, with
  `types.ts` and a re-export-only `index.ts`. It has no Runtime, Platform,
  Channel, Provider or configuration implementation dependency.
- Channel imports and composes SettingsCapability; it does not own its types.
  Settings implementations and other consumers import the Settings entry directly.
- `src/runtime/settings/model-test.ts` owns Test admission after manager dispatch,
  active Test records, execution, cancellation and cleanup. It does not own saves,
  section revisions, applied configuration or Agent policy.
- SettingsManager remains the sole update transaction owner and coordinates
  overall Settings admission and shutdown. It delegates Tests without retaining
  a second Test collection, temporary Unit or pin.
- The Test module receives explicit narrow dependencies, not SettingsManager or
  RuntimeApp. Existing Provider Unit, resolver, snapshot access and deadline
  mechanisms are reused. The saved-document/revision/file-state facts needed for
  credential retention are read from the manager at the existing Test preparation
  point, without another mutable document or revision registry.

Existing shared result construction, validation and sanitized error mapping may
move to a private Settings helper only where both extracted paths actually use
them. Keep one definition of shared error classes and mapping; the Test module
must not import SettingsManager, nor call a broad manager failure callback.
Update Runtime Builder's existing failure-helper import if that helper moves.
Do not put Runtime error handling in the transport-neutral contract module.

Keep the existing SettingsManager location for this Change. Do not move unrelated
Runtime composition files to make the new directory look complete.

## 4. Public and structural contracts

Keep the existing Settings request/result shapes, supported actions, error codes,
unknown domain input/output and correlation semantics unchanged. Do not strengthen
the public envelope into section-specific unions as part of the move.

`my-agent/extension-api` retains its existing Settings export names and entry
point, re-exporting the one authoritative definition. Internal Channel Settings
re-exports are removed after all repository consumers migrate; no duplicate types,
permanent forwarding implementation or new published package is introduced.

The Test module must be directly testable with Fake invocation/Unit dependencies
and controlled deadlines without constructing the full SettingsManager or Runtime.
Its exact private interface must remain limited to executing a Test, closing
admission and reporting shutdown convergence; do not build a pluggable framework.

## 5. Behavior and invariants

The following existing authority remains binding:

- [Runtime Composition](../../../specifications/runtime-composition.md):
  serialized updates, publication outcomes, model Tests and shutdown.
- [Configuration](../../../specifications/configuration.md):
  section persistence, credential intents and revision ownership.
- [Channel](../../../specifications/channel.md):
  the shared Settings capability and unchanged WebSocket envelope.
- [Agent Management](../../../specifications/agent-management.md):
  prepare before persistence, publish after success, startup definition snapshots,
  pending-restart isolation and independent section revisions.

Load still waits for updates. Tests do not newly join the update queue or acquire
save/reload authority. Preserve the existing point at which a Test samples saved
credentials and revisions or captures a loaded generation. Do not serialize
previously concurrent Tests as a side effect of extraction.

## 6. Lifecycle, failures and security

- A candidate Built-in Test uses an unpublished temporary Unit with existing
  factory/staging behavior; it never changes the saved document or publication.
- A loaded Provider Test owns its generation pin until actual work settles.
  Neither branch creates Sessions, Turns or Agent execution events.
- Preserve the fixed 30,000 ms total deadline and existing cancellation behavior.
  Returning a timeout or closing error is not proof of resource release.
- The Test module retains pending creation/invocation/cleanup and failed-cleanup
  ownership. It reports failures and residuals through existing Settings shutdown
  aggregation, using the same remaining budget rather than a fresh timeout.
- SettingsManager closes dispatch and updates; the Test owner closes Test
  admission and aborts active Tests. Shutdown coordination must not double-stop
  temporary Units or release loaded pins before actual convergence.
- Start update and Test convergence observation together against the existing
  absolute shutdown deadline. Do not wait for updates before beginning Test
  shutdown, create a second budget, or treat a returned Test result as convergence.
- Preserve safe credential metadata, explicit keep/replace/clear intent checks,
  error sanitization and existing logging. Do not expose raw credentials, request
  input or upstream response bodies in new diagnostics.

## 7. Compatibility and migration

Migrate real callers in each extraction and remove the superseded implementation
in the same delivery. Keep SettingsManager integration tests for dispatch,
transactions and shutdown; move lifecycle-specific cases to the new module
without losing coverage. Public Extension re-exports remain the supported facade,
not a temporary compatibility path.

No temporary compatibility path is proposed. If an actual caller requires one,
pause that part and confirm its owner, expiry and deletion criteria before adding it.

## 8. Acceptance and validation

| Area | Required evidence |
|---|---|
| Independent Test module | Fake-based tests for candidate and loaded Providers, revision/credential checks, 30,000 ms timeout, cancellation, preparation failure, noncooperative work and failed cleanup |
| Resource convergence | Loaded generation remains pinned across publication until settlement; temporary resources remain owned after response timeout; shutdown reports residuals and does not stop twice |
| Settings integration | Existing SettingsManager and AgentPolicyState tests; load/update serialization, unchanged revisions, rollback/publication outcomes and Agent-policy invariants |
| Real callers and contracts | Runtime Settings integration in RuntimeApp tests, WebSocketChannel Settings protocol tests and acquisition-to-Runtime integration; Extension API type/build checks; no consumer imports Settings types from Channel |
| Architecture | Relevant FT-01 and FT-13 checks updated only for the new boundaries; a dependency check rejects new Settings contracts depending on Channel or Runtime |
| Final Gates | `npm run lint`, `npm run build`, affected integration/regression checks, documentation link checks and `git diff --check` |

Run the smallest focused check after the first substantive change. Use existing
test runners, fake timers and fixtures; add no validation dependency. Extend
Host/package verification only if the changed exports or packaging surface require
it. Do not duplicate behavioral assertions as documentation snapshots or freeze
the proposed file tree in permanent tests.

Record baseline failures separately from introduced failures. Required Gates
cannot be declared passed while blocked. Design and delivery review must check
single ownership, real-caller migration and absence of unrelated work; this Draft
does not claim that delivery review or owner delivery acceptance has occurred.

Use these existing focused selectors, adding the new Test-module file when it
exists:

```bash
npm test -- src/runtime/settings/model-test.test.ts src/runtime/settings-manager.test.ts src/runtime/agent-policy-state.test.ts src/runtime/RuntimeApp.test.ts
npm test -- extensions/websocket-channel/WebSocketChannel.test.ts -t "Settings protocol"
npm run test:integration -- src/extension/acquisition/acquisition-runtime.integration.test.ts
npm run test:fitness -- src/architecture-fitness/ft-01-boundaries.test.ts src/architecture-fitness/ft-13-source-layout-convergence.test.ts
```

The selectors define future Delivery checks; they were not run as evidence of this
documentation-only design review. Do not expand to unrelated suites unless an
affected boundary or a failure justifies it.

## 9. Open decisions

- None. The owner accepted the bounded Plan, ADR, structural boundaries and
  validation matrix on 2026-11-11; delivery acceptance is separate.

No unresolved boundary or ownership decision may be deferred into implementation.
