# ADR-001: Tool Result Closure and Recovery

## Status

- **Status:** Accepted
- **Date:** 2026-09-01
- **Owner:** 项目所有者
- **Related Plan / Spec:** [AF-04 Characterization and Fitness Execution Plan](../roadmap/af-04-characterization-fitness-plan.md), [Core Abort Spec](core-abort-spec.md), [Target Architecture](target-architecture.md)
- **Supersedes:** Replaces only the Core Abort Spec §7.2 decision that controlled Abort intentionally leaves complete orphan Tool Uses for next-Turn repair, plus §7.3's inclusion of controlled Abort in generic unknown-cause repair. It retains D6 and §7.3 repair for crash and unknown failures, and does not rewrite implemented current facts.

The project owner accepted this ADR on 2026-09-01. Follow the approval and state rules in the [Development Workflow](../development-workflow.md). Production behavior remains unchanged until a separately approved Module Spec and Architecture Slice are implemented and validated.

## Context

AF-04 CH-03 verified that the current Tool loop preserves Tool Call/Result pairing for ordinary deny, invalid, error, and completed paths, but a controlled Abort between sequential Tool calls can return before the accumulated Tool Results are persisted. The next Turn then repairs every missing ID with the same synthetic result, including both a Tool that completed and a Tool that never started.

The repair restores provider-valid transcript structure, but it loses execution facts. That is unsafe for tools with external side effects because a later Turn cannot distinguish a completed operation from one that never ran. A process crash presents a different constraint: if no durable Tool Result or operation receipt exists, history alone cannot prove whether the Tool executed.

The current [Core Abort Spec](core-abort-spec.md) intentionally assigns orphan repair to the next Turn. It remains the implemented baseline until a separately approved Architecture Slice changes production behavior.

The Accepted [Target Architecture](target-architecture.md) already requires Tool Call/Result pairing. This ADR does not reopen that invariant; it proposes the finer outcome classification and closure timing for controlled Abort versus unknown recovery.

## Decision Drivers

- Every complete, persisted `tool_use` must eventually have a same-ID `tool_result` before the transcript is sent to a strict Provider.
- A real completed or failed result must not be replaced by a synthetic cancellation or recovery result.
- Controlled Abort has live in-process execution facts that should be preserved before the Turn settles.
- Crash recovery must not claim that an operation was cancelled or never executed when its outcome is unknowable.
- Recovery must not implicitly replay side-effecting operations.
- The first migration should not introduce a durable workflow engine, Tool journal, or general resume protocol.

## Options Considered

### Option A: Use next-Turn repair for every missing result

Keep the current behavior: controlled Abort and crash recovery both leave orphan Tool Uses for the next Turn to close with one generic synthetic result.

This is small and provider-safe, but discards completed results, conflates cancelled, unstarted, and unknown outcomes, and can encourage unsafe retries.

### Option B: Close controlled Abort in the current Turn and retain repair for unknown failures

Before a controlled-Abort Turn settles, preserve real terminal results and synthesize only the outcomes known from current control flow. Keep next-Turn repair for crash, persistence failure, and legacy corruption where the outcome cannot be proven.

This separates normal cancellation from disaster recovery without adding durable workflow machinery.

### Option C: Persist a resumable Tool execution journal

Durably record planned, started, completed, failed, and cancelled transitions and resume or reconcile pending work after restart.

This can provide stronger recovery guarantees, but requires operation identity, idempotency, journal/transcript consistency, pending-work ownership, and an explicit resume contract. AF-04 has not established a requirement for that complexity.

## Decision

Choose **Option B**.

### Controlled Abort

For every complete Tool Use emitted by the model, a controlled-Abort path with successful session persistence closes the Tool Call/Result pair before returning its aborted outcome:

| Observed Tool Call state | Required semantic result |
|---|---|
| Completed successfully before cancellation wins | Preserve the real successful result |
| Completed with failure before cancellation wins | Preserve the real failure result |
| Started and positively confirmed cancelled | Synthetic aborted/cancelled error result |
| Not started because the Turn stopped launching Tools | Synthetic not-executed error result |

Actual terminal completion wins a race with cancellation. `signal.aborted === true` alone is not proof that a Tool was cancelled.

A Tool that does not respond to `AbortSignal` and has already started is allowed to finish under the existing Tool contract; its real result is preserved. The Runner guarantees that it stops launching subsequent Tools after observing Abort.

No static `supportsAbort` capability is required for this migration. The Runner classifies the outcome from actual return, failure, confirmed cancellation, and whether the call was started.

If the closure write itself fails, the system cannot claim durable current-Turn closure. It must surface or record that persistence failure and must not send the damaged transcript to a Provider before repair closes the missing IDs. The caller-facing terminal classification and bounded retry behavior for this case are deferred to the required Module Spec.

### Crash and unknown failure recovery

Next-Turn history repair remains a safety net for process crash, forced termination, persistence failure, legacy history, and unknown defects:

- retain every durable real Tool Result already present;
- synthesize results only for missing Tool Call IDs;
- describe those missing outcomes as unknown rather than aborted, failed, or not executed;
- remain idempotent and never replace a real result with a synthetic result.

An incomplete streamed Tool Use that never formed a valid Tool Call is sanitized or discarded rather than assigned a fabricated Tool Result.

### Turn boundary and replay

Recovery closes the interrupted Turn so a later Provider request receives valid history. It does not resume the old Turn or automatically execute an unknown Tool Call. A new user input starts a new Turn, which may inspect external state and plan a safe follow-up.

This ADR does not freeze exact user-visible text, TypeScript types, persistence layout, Event fields, or Provider mapping. Those details require an Accepted Module Spec before production implementation.

## Consequences

### Positive

- Controlled Abort preserves real Tool outcomes and distinguishes cancellation from calls that never started.
- Crash recovery remains honest about ambiguous external side effects.
- Strict Provider pairing remains protected.
- Existing next-Turn repair stays useful as a final safety net.
- No checkpoint engine or durable Tool journal is introduced prematurely.

### Negative

- A controlled Abort may wait for an already-started Tool that ignores `AbortSignal`.
- Crash recovery cannot reconstruct a result that existed only in process memory.
- Unknown side effects require a later Turn to inspect external state or use a domain idempotency mechanism.
- The Tool loop needs a common closure path so Abort cannot bypass result persistence.

## Validation

- AF-04 CH-03 characterization in [AgentRunner.test.ts](../../src/core/runner/AgentRunner.test.ts) reproduces controlled Abort after the first of two Tool calls and verifies the current next-Turn generic repair.
- Existing CH-03 cases verify pairing for deny, invalid/unknown, and thrown Tool outcomes.
- [OpenClaw transcript repair](../../../openclaw/src/agents/session-transcript-repair.ts) demonstrates layered write/replay hygiene with synthetic missing-result repair.
- [Codex Tool cancellation](https://github.com/openai/codex/blob/main/codex-rs/core/src/tools/parallel.rs) preserves a completed race outcome and otherwise emits a same-call-ID aborted output.
- [LangGraph interrupt tests](https://github.com/langchain-ai/langgraph/blob/main/libs/langgraph/tests/test_pregel_async.py) show that resumable pending work requires explicit checkpoint and state-update semantics rather than implicit transcript repair.

## Migration and Rollback

1. Keep the CH-03 test as the current-behavior characterization until a production Slice is approved.
2. Accept a narrow Module Spec defining the closure flow, semantic result mapping, persistence failure behavior, and focused tests.
3. Change the Tool loop so controlled Abort reaches a common Tool Result closure path before the Turn settles.
4. Add target contract tests for completed-result preservation, confirmed cancellation, not-started closure, unknown crash repair, and no implicit replay.
5. Replace only the obsolete current-behavior assertions after the new contract tests pass; retain crash-repair coverage.

Rollback must preserve provider-valid pairing. Reverting the controlled closure path may restore the current delayed repair behavior, but must not remove next-Turn repair or silently replay missing Tool Calls.

## Follow-up

- [x] Project owner accepted this ADR on 2026-09-01.
- [ ] Link an approved Defect or Architecture Slice before production changes.
- [ ] Write and accept the Module Spec required by the Development Workflow.
- [ ] Implement and validate the controlled-Abort closure contract.
- [ ] Update Core Abort Spec and Current Architecture after production behavior changes.