# ADR-001: Tool Result Closure and Recovery

> Status: Accepted
> Decision status: Accepted
> Decision date: 2026-09-01
> Owner: Project owner
> Authority: Durable decision
> Supersedes: Only the earlier Abort contract decision that controlled Abort intentionally leaves complete orphan Tool Uses for next-Turn repair; crash and unknown-failure repair remains

## Context

A strict Provider requires every complete persisted Tool Call to have a same-ID Tool Result. Delaying all missing-result repair until a later Turn restores structural validity but loses execution facts: a completed side effect, a confirmed cancellation, and a call that never started become indistinguishable.

Controlled Abort still has in-process execution facts. A crash, forced termination, persistence failure, legacy transcript, or unknown defect may not. Recovery must preserve that distinction and must not imply safe replay.

## Decision drivers

- Preserve every real terminal Tool result.
- Close controlled-Abort calls before the Turn settles when persistence succeeds.
- Describe unknown outcomes honestly.
- Never implicitly replay a side-effecting Tool.
- Retain Provider-valid transcript structure without introducing a workflow journal.

## Options considered

1. Repair every missing result on the next Turn: small but discards execution facts.
2. Close controlled Abort in the current Turn and retain unknown repair: preserves known facts without durable workflow machinery.
3. Persist a resumable Tool journal: stronger recovery but requires operation identity, idempotency, and resume semantics not justified by current requirements.

## Decision

Choose option 2.

### Controlled Abort closure

For every complete Tool Call emitted by the model:

| Observed state | Required result |
|---|---|
| Completed successfully before cancellation wins | Preserve the real success |
| Completed with failure before cancellation wins | Preserve the real failure |
| Started and positively confirmed cancelled | Synthetic aborted/cancelled failure |
| Not started because the Turn stopped launching Tools | Synthetic `not_executed` failure |

Actual terminal completion wins a race with cancellation. `signal.aborted` alone does not prove cancellation. A started Tool that ignores Abort may finish; its real result is preserved. After observing Abort, Runner launches no later Tool Calls and closes them as not executed.

This decision does not require or authorize a static `supportsAbort` Tool capability. Runner classifies outcomes from actual completion, failure, positively confirmed cancellation, and whether the call started; declared capability metadata is not a substitute for those execution facts.

If closure persistence fails, the system cannot claim durable closure and must not send the damaged history to a Provider before repair.

### Crash and unknown recovery

Next-Turn repair remains a safety net for crash, forced termination, persistence failure, legacy history, and unknown defects:

- retain every durable real result;
- synthesize only missing Tool Call IDs;
- classify their outcomes as unknown, not cancelled, failed, or not executed;
- remain idempotent and never replace a real result;
- sanitize or discard an incomplete streamed Tool Use that never became a valid Tool Call.

Repair closes the interrupted Turn for a later valid request. It does not resume that Turn or automatically re-execute an unknown Tool Call.

## Consequences

### Positive

- Controlled Abort preserves real outcomes and distinguishes unstarted work.
- Unknown recovery remains honest about ambiguous side effects.
- Strict Provider pairing remains protected.
- No checkpoint engine or durable Tool journal is introduced.

### Negative

- Abort may wait for a started Tool that ignores its signal.
- A process crash cannot reconstruct an in-memory-only result.
- Unknown side effects require later inspection or domain-specific idempotency.
- The Runner requires one closure path that Abort cannot bypass.

## Implemented status and validation

Controlled-Abort closure is implemented and verified: Runner preserves terminal results, stops launching later calls, records same-ID `not_executed` results, and persists closure before settlement. Unknown/crash repair remains the recovery safety net.

| Kind | Evidence |
|---|---|
| Current facts | [Runner](../architecture/runner.md), [Session](../architecture/session.md) |
| Source/tests | [AgentRunner](../../src/core/runner/AgentRunner.ts), [AgentRunner tests](../../src/core/runner/AgentRunner.test.ts) |
| Stable contract | [Abort Specification](../specifications/abort.md), [Runner Turn Flow Specification](../specifications/runner-turn-flow.md) |
| Migration evidence | [AF-04 plan](../changes/archive/af-04-characterization-fitness/plan.md), [Target Architecture](../changes/active/architecture-foundation/target-architecture.md) |
| Process | [Development Workflow](../governance/development-workflow.md) |

Exact user-visible text, event payloads, and persistence layout are contract/implementation details rather than part of this decision.
