# Provider-owned Model Catalog Plan

> Status: Validated
> Date: 2026-11-18
> Owner: Project owner
> Classification: Architecture Slice
> Specification: [Provider-owned Model Catalog](specification.md)
> Decision: [ADR-027](../../../decisions/adr-027-provider-owned-model-catalog.md)
> Authority: Non-authoritative Change execution record

## Outcome and confirmed scope

On 2026-11-18 the owner explicitly accepted the design and authorized ADR/stable
contract synchronization, implementation and validation. After accepting final
delivery, the owner authorized archive, commit and push of the current branch
on 2026-11-18. Unrelated worktree changes remain excluded.

This is a system-wide Provider model-discovery/catalog contract change, not a
Copilot Relay-only enhancement. Core and every Provider implementation must
adopt the new boundary; discovery sources remain Provider-specific. Relay's
offline startup behavior is one application of that boundary.

The owner confirmed the following boundary on 2026-11-18:

- Core does not cache model catalogs. Each catalog query calls Providers,
  validates their results, and aggregates the response.
- Each Provider decides whether to cache and when to update its own model state.
  Core does not impose a TTL or an upstream refresh policy.
- Catalog updates do not require Unit recreation or Registry generation reload.
- Relay startup discovery failure must emit an explicit warning with the
  endpoint and concrete cause, but must not prevent Provider registration.
- CLI and WebSocket presentation query on demand when their last catalog
  attempt is too old, and query again after an explicit model-unavailable
  error while also informing the user. No periodic timer is required.
- Relay owns its discovery timestamp/cache and invalidates that cache before
  propagating a reliably identified upstream model-not-found error.
- A failed Provider discovery clears that Provider's current model catalog;
  it does not silently retain the last successful list.
- The owner accepted empty-list discovery tolerance on 2026-11-18: expected
  discovery failures log a warning with the concrete cause and return an empty
  model list. Do not add a client-visible Provider availability/error protocol.
  Clients need not distinguish discovery failure from a valid empty catalog.
- Clients request catalogs without a force/rediscover flag. No automatic
  model switch or retry of the failed invocation is introduced.
- The owner accepted 60-second intervals on 2026-11-18 for Channel
  display-time catalog checks and Relay discovery-cache expiry. These are
  internal defaults, not new configuration settings or polling timers.
- The owner accepted a 5-second Relay discovery-failure retry interval on
  2026-11-18. During that interval, catalog reads return the empty model list
  without another upstream attempt. Once elapsed, a subsequent query may retry;
  no background retry is scheduled.
- A query started before Provider disable may return its captured results
  afterwards. The owner accepted this ordering on 2026-11-18. Preserve default
  stop/retirement behavior without adding query pins or a new drain gate;
  resource closure may instead cause an explicit query failure.

The owner subsequently accepted the detailed contract and authorized
implementation and validation. The owner accepted final delivery on 2026-11-18.
The later closeout authorization covers archive, commit and current-branch push,
not a branch switch or merge.

## Baseline evidence before implementation

The following describes the starting point, not the delivered implementation.

- Relay awaits discovery inside Unit creation; rejection prevents registration:
  [Relay Unit](../../../../extensions/copilot-relay-provider/copilot-relay-provider-unit.ts).
- The Provider publishes a frozen `models` array and routes invocations using
  its captured model map:
  [Relay Provider](../../../../extensions/copilot-relay-provider/copilot-relay-provider.ts).
- Core currently reads that array for membership and catalog projection:
  [ModelResolver](../../../../src/core/model-resolution/ModelResolver.ts),
  [RuntimeApp](../../../../src/runtime/RuntimeApp.ts).
- Composition reuses unchanged Unit instances:
  [RuntimeCompositionManager](../../../../src/runtime/composition/runtime-composition-manager.ts).
- WebSocket catalog queries return the current Runtime catalog; the client
  queries after handshake and on existing model-selection failure paths:
  [Channel](../../../../extensions/websocket-channel/WebSocketChannel.ts),
  [Client](../../../../extensions/websocket-channel/client/src/App.vue).
- CLI catalog access is currently synchronous and reports generic readiness
  failures: [CLI Channel](../../../../src/builtins/channels/cli/CliChannel.ts).
- Relay HTTP errors retain a structured upstream error code, but classify
  HTTP 404 as `invalid_request`, not specifically model-not-found:
  [Responses Client](../../../../extensions/copilot-relay-provider/responses-client.ts).
  The shared error contract has no dedicated model-not-found classification:
  [Invocation Errors](../../../../src/core/model-invocation/errors.ts).

## Non-goals

No automatic model fallback, selection-policy redesign, invocation retry,
timer-driven polling, background probing, catalog-change push, Core catalog
TTL, client force-refresh flag, new cache framework, or WebSocket listener-error
tolerance. Channel query triggers and error-driven Provider invalidation are in
scope; automatic reselection is not.

## Plan items and gates

| Item | Status | Exit criterion |
|---|---|---|
| PMC-1: Define contract and migration | Completed | Independent rereview found no high-confidence defect; owner accepted design and Delivery on 2026-11-18 |
| PMC-2: Migrate Provider and Core boundaries | Completed | Provider-owned query/state, Core validation/aggregation, Relay nonfatal startup discovery, and all directly dependent callers use one authoritative path |
| PMC-3: Validate and synchronize authority | Completed | Full Unit suite, relevant integrations, Fitness, lint/build and documentation checks passed; durable contracts and Current Architecture synchronized |
| PMC-4: Owner acceptance and closeout | Completed | Owner accepted delivery and authorized archive, commit and current-branch push on 2026-11-18; Change archived with authority transferred |

PMC-2 depends on PMC-1; PMC-3 depends on PMC-2; PMC-4 depends on PMC-3.

## Contract preparation

Source tracing covered Provider registration validation, catalog reads, Root
and Child resolution, Settings model tests/projections, invocation routing,
CLI, WebSocket, and Extension API exports. The accepted Specification defines exact
async boundaries and captured per-model invocation Ports. Unrelated
composition/lifecycle refactoring remains excluded.

[Model Resolution Specification](../../../specifications/model-resolution.md)
was amended before implementation to replace immutable Provider-instance
catalogs and synchronous membership checks with Provider-owned async reads.
[ADR-004](../../../decisions/adr-004-provider-model-identity-and-facts-ownership.md)
deliberately leaves catalog storage/refresh unfrozen, while preserving immutable
per-Turn bindings.
[ADR-016](../../../decisions/adr-016-unified-builtin-llm-provider.md) records the
prior public ABI and private model router. Accepted ADR-027 revises that ABI
boundary while retaining Provider fact ownership and immutable Turn binding.
It is a durable decision outside this Change; authority does not depend on
retaining this record.

## Technical preparation baseline

These observations motivated the accepted migration and are retained as history.

- Registry normalization currently copies `models` and entry-level routing:
  [Registry builder](../../../../src/runtime/composition/registry-builder.ts).
- Root and Child resolution and Settings model tests use synchronous
  `ModelResolver.resolve`:
  [Root](../../../../src/runtime/RuntimeApp.ts),
  [Child](../../../../src/runtime/subagent-orchestration.ts),
  [Settings test](../../../../src/runtime/settings/model-test.ts).
- Settings currently performs synchronous catalog projections and catalog reads
  after publication/rollback:
  [Settings manager](../../../../src/runtime/settings/settings-manager.ts).
  Async migration must preserve truthful file/application outcomes.
- Both Relay wire Clients share HTTP error normalization, but stream errors
  currently lose structured fields:
  [Responses](../../../../extensions/copilot-relay-provider/responses-client.ts),
  [Chat](../../../../extensions/copilot-relay-provider/chat-client.ts).
- The existing `invalid_model` fixture proves diagnostics survive Host
  canonicalization, not that Relay uses that code for missing models:
  [Protocol test](../../../../extensions/copilot-relay-provider/responses-client.test.ts).
- Agent error events currently type `category` as resolution-only, while
  invocation classification is a separate structural error contract:
  [Agent events](../../../../src/core/runner/types.ts),
  [Invocation errors](../../../../src/core/model-invocation/errors.ts).
  The proposal reuses the event envelope to expose the common missing-model
  trigger; it does not add a catalog availability protocol.
- Public [OpenAI structured-error guidance](https://developers.openai.com/api/docs/guides/agents-api/errors)
  supports code-based handling and documents `model_not_found`, but is not
  evidence of this Relay deployment's HTTP/SSE behavior. The proposed exact-code
  compatibility rule must be fixture-tested; no live Relay claim is made.

## Validation strategy

Start with regressions proving repeated Core queries reach the Provider and
same-instance Provider state changes appear without Unit recreation. Cover
Provider cache independence, complete-state replacement, explicit discovery
warnings and empty-list tolerance, startup registration despite discovery outage, cancellation, membership
and fact validation, and stable already-resolved invocation bindings. Add
timestamp-controlled Channel checks and explicit-error refresh cases, plus
Relay invalidation-before-error-delivery and discovery-failure-clears-state
cases. Negative cases must prove generic HTTP 404, authentication, rate limiting,
and transport failures are not mistaken for model-not-found.

Migrate Built-in and Relay Providers and validate real catalog callers,
including WebSocket and Settings. Run the existing relevant Unit/contract and
Integration suites, lint, build, and documentation navigation/link checks.
Do not introduce a new Fitness gate merely to freeze API spelling.

## Delivery status and worktree discipline

Provider/Core/Runtime/Settings/Channel implementation, validation and authority
synchronization are complete; the owner accepted final delivery on 2026-11-18. The existing sharp/native-image
changes in the worktree are excluded.
Do not reopen the archived PID-lock or Host-managed Logging Changes.

2026-11-18 preparation validation: all 33 local links in the Plan,
Specification and decision proposal resolved; whitespace checks passed.
The existing FT-12 documentation navigation/link suite passed both tests on
Node 22.22.2 with one worker. This validates documentation only, not the
proposed Provider behavior. At that preparation checkpoint, no production files or accepted authority
documents were modified, and no commit or branch switch was performed.

### Implementation validation, 2026-11-18

All commands used existing dependencies and Node 22.22.2 on Windows.

| Gate | Command / result |
|---|---|
| Root, Relay, WebSocket and Vue types | `npm run lint` passed |
| Complete Unit suite | `npm test -- --maxWorkers=2`: 138 files, 2,110 tests passed |
| Extension acquisition and WebSocket integration | `npm run test:integration -- src\extension\acquisition\acquisition-runtime.integration.test.ts extensions\websocket-channel\WebSocketChannel.integration.test.ts --maxWorkers=1`: 2 files, 4 tests passed |
| Full Fitness | `npm run test:fitness -- --maxWorkers=1 --testTimeout=60000`: 10 files, 16 tests passed |
| Production build | `npm run build` passed, including 62 Client asset checks, Host audit (402 files), and 138 Relay cases |
| Whitespace / documentation | `git diff --check`, all 268 local links across 14 changed documents, and existing FT-12 navigation/link checks passed |

Focused regressions cover cache-free repeated reads, exact 60-second/5-second
thresholds, tolerated startup/discovery outages, per-waiter cancellation,
in-flight invalidation, old-binding guards, captured protocol routing,
HTTP/SSE missing-model classification in both Clients, Runner propagation,
truthful Settings enrichment failures, and CLI/Vue display-time recovery.
The Vue tests mount the actual App and exercise the empty picker and correlated
error retry, rather than only matching source text.

Validation exposed obsolete empty-Port and source-loaded JS fixtures; these
were migrated to the accepted ABI. Shared test-only Provider adapters live in
`src/test-fixtures/`, excluded from production-source classification while the
existing FT-13 rule continues rejecting production imports of test fixtures.
One initial concurrent Fitness run exceeded FT-07's default 5-second compiler
budget. The recorded full rerun was isolated with the explicit timeout above;
no production behavior or test assertion was weakened.

No live Relay model-not-found response was available. Exact-code behavior is
verified with controlled HTTP/SSE fixtures, not a live upstream compatibility
claim. Unknown codes recover through ordinary cache expiry. No fresh-install,
cross-platform or standalone browser visual-validation claim is made.

The existing branch is retained. At the initial delivery checkpoint, no commit,
push or archive had been performed.

2026-11-18 review follow-up: the owner accepted reusing a catalog query started
before a missing-model error; no follow-up-query queue is added. Fixed CLI
synchronous-throw recovery by deferring query execution until pending assignment.
One recovery regression was added; all 51 CLI tests, root TypeScript and
whitespace checks passed. The full-suite results above precede this minimal fix.
Final post-fix revalidation also passed: root/workspace/Vue lint, all 2,111 Unit
tests across 138 files, and the complete production build with Client/Host audits
and 138 Relay cases.

2026-11-18 owner acceptance: the owner confirmed "通过" after final post-fix
validation. Delivery is accepted. The owner subsequently authorized archive,
commit and push of `feat/host-managed-logging`, excluding unrelated changes.

Process authority: [Development Workflow](../../../governance/development-workflow.md).
