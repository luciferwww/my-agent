# Session Message Scheduler Extraction

> Status: Accepted
> Date: 2026-11-11
> Owner: Project owner
> Classification: Architecture Slice
> Design: [Specification](specification.md), [Proposed decision](decision.md)

## Outcome and evidence

Extract the existing Session FIFO, Root scheduling busy fact, and steering
waiters from RuntimeApp into one private, directly testable Runtime owner.
This is an ownership extraction, not a new scheduling algorithm or product
feature. Success means less intertwined state in RuntimeApp with unchanged
observable message, Turn, Abort, and Shutdown behavior.

Current source ownership is concentrated in
[`RuntimeApp.ts`](../../../../src/runtime/RuntimeApp.ts):
`messageQueueBySession`, `inFlightSessions`, and `steeringWaiters` jointly serve
intake, standalone launch, steering, Session busy checks, Abort, and Shutdown.
The existing queued payload lives in
[`queue-types.ts`](../../../../src/runtime/scheduling/queue-types.ts).

[ADR-017](../../../decisions/adr-017-session-message-queue-and-steering-claim.md)
originally explicitly rejected a new scheduler module. This extraction needed
owner acceptance of a bounded decision amendment; it was not already
authorized by the original FIFO decision or the earlier Settings acceptance.

## Scope and non-goals

- One private `src/runtime/session-message-scheduler.ts` implementation and its
  direct tests; migrate all consumers of the three existing state collections.
- RuntimeApp retains actual execution, request gates, routing, events,
  cancellation controllers, generation/policy capture, and global lifecycle.
- Preserve existing FIFO, steering, model/reasoning, cancellation, and
  noncooperative-worker behavior.
- No public API, event/wire shape, configuration, dependency, UI, Core contract,
  Provider, Runner algorithm, Memory, or Settings changes.
- No scheduler framework, ports, callback registry, second queue, leases,
  acknowledgments, persistence, priority, new timeout, or compatibility path.
- Synchronize only directly affected architecture/decision documentation.
  Do not fold unrelated documentation drift or research corrections into this
  Change.

## Work items and gates

| Item | Status | Exit criterion |
|---|---|---|
| SMS-1: Confirm design | Completed | Owner accepted Plan, Specification, and the ADR-017 amendment, and authorized Delivery on 2026-11-11 |
| SMS-2: Extract state owner | Completed | One owner replaced all three RuntimeApp collections; first 8 focused tests passed |
| SMS-3: Verify integration | Completed | 270 selected unit tests, 3 integration cases, 8 Fitness checks, lint, and build passed; owner accepted results |
| SMS-4: Review and synchronize | Completed | Direct review found no blocker; ADR/current architecture synchronized; final documentation checks recorded below |
| SMS-5: Delivery acceptance | Completed | Owner accepted delivery/validation and authorized archive on 2026-11-11, explicitly without commit or push |

SMS-2 depends on SMS-1; SMS-3 depends on SMS-2; SMS-4 depends on SMS-3;
SMS-5 depends on SMS-4. No production edit before the design gate passes.

## Risks and controls

- Busy reservation must happen synchronously with standalone dequeue. Remove
  the old independent busy fact rather than mirroring it.
- Request terminalization is not worker convergence. Early cancellation must
  not release Session serialization or generation pins.
- Sampling model execution resources and Agent policy at enqueue would change
  semantics. Keep their existing Runtime admission points.
- Steering ownership transfers at atomic prefix removal; do not replay a batch
  after persistence failure.
- Preserve existing event/fanout and Abort/Shutdown ordering in RuntimeApp.
- If implementation requires a new behavior, lifecycle mechanism, or unresolved
  concurrency assumption, stop the affected work and return to the design gate.

## Validation

Baseline on Node.js 22.22.2:

```text
npm test -- src/runtime/RuntimeApp.intake.test.ts src/runtime/RuntimeApp.test.ts
2 files passed; 98 tests passed.
```

Delivery checks are defined in the [Specification](specification.md#acceptance-and-validation).
Documentation-only preparation requires local-link and whitespace checks, not
a production build. Baseline results do not establish extraction correctness.

### Delivery results

All commands below used process-local `fnm exec --using=22.22.2 --`; no shared
Node version or dependencies were changed.

| Check | Result |
|---|---|
| Immediate direct scheduler tests after extraction | 8 passed |
| Scheduler, RuntimeApp intake/lifecycle, AgentRunner and Tool-pipeline suites | 5 files, 191 tests passed |
| Runtime Builder, CompositionCoordinator, RuntimeCompositionManager, RequestCompletionGate, SessionCoordinator, Subagent orchestration | 6 files, 79 tests passed |
| Acquisition-to-Runtime integration | 3 passed, including a real local WebSocket |
| FT-01, FT-03, FT-13 | 6 passed; scheduler classified Application without an exemption |
| FT-12 Current Architecture, run separately | 2 passed |
| Root and workspace lint | Passed |
| Production build | Passed; 62 Client assets and 388 Host files verified; 121 Relay tests passed |
| Direct listener-cleanup test refinement | 8 scheduler tests passed again; actual AbortSignal listener counts verified |
| Final documentation | 8 documents, 187 local links/anchors, and whitespace passed; FT-12 passed again |

The first migrated Runtime run had six failures because existing tests
directly seeded/read the removed private Map. Those fixtures were migrated to
typed scheduler operations, without restoring a compatibility Map. The
subsequent combined Runtime/Runner run passed all 191 cases.

The new startup-failure regression proves that failed generation capture
releases the reservation, does not replay the failed input, and permits the
next message. The existing nonresponsive-Root regression now also asserts that
the scheduler remains busy after public terminalization and releases only
after actual worker convergence.

The existing Client chunk-size warning remains; no bundling change was made.
These checks use controlled Providers/fixtures, not live-model E2E or manual
browser acceptance. No UI contract changed.

### Direct delivery review

Direct source/call-site review found no blocking issue:

- The old FIFO, busy Set, and waiter Map names are absent from Runtime source
  and tests; no shadow state or forwarding alias remains.
- Intake, logging, Session busy checks, Abort discovery/drop, steering
  claim/waiting, standalone selection/release, and Shutdown all use the one
  scheduler owner.
- RuntimeApp retains event fanout, request gates, routes, generation/policy
  admission, controllers, worker tracking, and shared-budget Shutdown.
- Reservation release is attached to actual worker settlement, including
  startup rejection, rather than the public terminal Promise.
- There is still one production private Root launch call site. The existing
  test-only private execution helper now reserves through the scheduler;
  no public direct Root API was added.
- The new module imports only its existing queued-payload type; there is no
  framework, public export, new dependency, or scheduling-policy change.

This was direct review, not independent-agent review.

## Authorization and current limits

The owner authorized local integration and preparation, then allowed autonomous
completion except decisions requiring owner participation. The local
`refactor/runtime-boundaries` branch contains the accepted Settings delivery;
this Change is isolated on `refactor/session-message-scheduler`.

The owner explicitly accepted the Plan, Specification, and bounded ADR-017
amendment and authorized implementation and validation on 2026-11-11.
[ADR-025](../../../decisions/adr-025-private-session-message-scheduler.md)
records the accepted exception. Commit, push, and PR remain outside the
authorization.

The owner subsequently accepted delivery and validation results and authorized
archiving this Change on 2026-11-11, explicitly without commit or push. The
Specification is Validated and all work items are Completed. This archive
preserves delivery provenance; current ownership belongs to ADR-025 and the
Runtime architecture topic. At archive time, no commit, push, or merge of this
delivery had been performed.

The owner subsequently authorized one local commit of this accepted Change on
2026-11-11. The commit excludes the pre-existing research document changes.
Push, merge, PR creation, and another refactor remain outside this
authorization.

Process authority: [Development Workflow](../../../governance/development-workflow.md).
