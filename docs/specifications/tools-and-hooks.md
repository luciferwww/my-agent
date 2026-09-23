# Tools and Hooks Specification

> Status: Stable Authority
> Contract status: Implemented and Validated
> Verified: 2026-09-18
> Authority: Stable Tool and Hook contract

## Scope

Own canonical Tool definitions/calls/results/context, portable schemas and validation, Tool/Hook contribution staging, immutable projections, Hook identity/order, before-interceptor transformation, policy/approval ordering, observer settlement, and Tool Result closure boundaries.

Provider wire codecs, Channel lifecycle, Runtime generations, parallel Tool execution, durable Tool journals/replay, and arbitrary Hook dependency graphs are excluded.

## Tool contract

The canonical Tool Result type admits `success`, `unknown_tool`, `denied`, `invalid_input`, `unavailable`, `failed`, `aborted`, `not_executed`, and `outcome_unknown`. Current in-Turn execution produces the first eight outcomes. `outcome_unknown` is reserved for a canonical representation of unknown execution state; next-Turn transcript repair currently persists a neutral Provider-facing Tool Result block rather than emitting that canonical outcome.

```ts
interface ToolExecutionContext {
  readonly sessionId: string;
  readonly turnId: string;
  readonly callId: string;
  readonly signal: AbortSignal;
}
```

Definitions use the portable schema profile accepted by Registry validation. Provider adapters encode that canonical definition independently.

## Hook contract and ordering

Hook kinds are `before_tool_call`, `after_tool_call`, `before_compaction`, and `after_compaction`. Ordering is priority descending, then Unit ID ascending, then contribution ID ascending. Registration order never breaks ties.

`before_tool_call` interceptors run sequentially and may transform input. Observers start concurrently and do not transform canonical results or Compaction candidates.

## Tool execution pipeline

1. Decode and resolve the Tool Call.
2. Pair unknown/malformed calls without entering before hooks.
3. Run before interceptors sequentially.
4. Validate final transformed input.
5. Apply deny, live Session permission mode, mandatory Manual-mode checks, then allow/approval policy.
6. Request approval when required.
7. Execute only after authorization.
8. Produce one canonical terminal result.
9. Run after observers.
10. Persist the complete exchange and settle observers before next Model invocation or Turn completion.
11. After Abort, do not start later Tools; close them as `not_executed`.

A real terminal Tool result wins an Abort race. `signal.aborted` alone does not prove cancellation. Unknown crash/persistence recovery synthesizes only missing same-ID transcript pairings with neutral recovery content, never replaces a real result, and never replays automatically.

## Policy and visibility

Explicit deny removes matching Provider-visible definitions and rejects stale/hallucinated calls at execution. Deny is final in both `manual` and `allow_all`. In `allow_all`, every other registered Tool is automatically authorized. In `manual`, Exec and lexically external structured filesystem targets require current-call approval even when statically allowed; internal allowed Tools bypass approval, while unmatched Tools request approval. Any required approval fails closed when the capability is absent. Session permission does not grant Hook authority, provide filesystem or network confinement, or verify executable integrity.

## Observer settlement

For `after_tool_call`, `before_compaction`, and `after_compaction`, each handler settles independently as fulfilled, rejected, aborted, or timed out. The default per-handler deadline is five seconds. Turn Abort reaches observer-local signals. Late completion cannot mutate Tool results, Session, events, Compaction, or Turn outcome; failures produce bounded diagnostics only. `after_compaction` runs only after Session commit.

## Acceptance scenarios

Cover portable-schema validation, deterministic contribution conflict/order, transformed-input validation, malformed/unknown pairing, visibility plus runtime deny, approval classifications, sequential interceptors, concurrent observers, timeout/Abort, late isolation, persistence before next invocation, controlled Abort closure, and unknown next-Turn repair.

## Related authority

[ADR-001](../decisions/adr-001-tool-result-closure-and-recovery.md) owns Tool Result closure and [ADR-002](../decisions/adr-002-context-budgeting-and-compaction-recovery.md) owns context recovery decisions. [Approval Lifecycle](approval-lifecycle.md) owns approval terminalization and [Abort](abort.md) owns cross-cutting cancellation.
