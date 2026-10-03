# Runner Steering Simplification Validation

> Status: Accepted and Archived
> Date: 2026-09-28
> Owner: Project owner
> Plan: [Runner Steering Simplification Plan](plan.md)
> Specification: [Runner Steering Simplification Specification](runner-steering-simplification-specification.md)
> Decision: [ADR-017](../../../decisions/adr-017-session-message-queue-and-steering-claim.md)

## Delivered behavior

- Every accepted Channel user message enters one Runtime-owned per-Session FIFO.
- An active Turn synchronously claims only the largest contiguous compatible
  FIFO prefix at a Runner-owned safe point.
- Model and media incompatibility stop claim without skipping, removal, or
  requeue.
- Runner keeps no pending steering batch; an empty claim closes steering for
  the Turn.
- FIFO intake creates no Root request gate. Standalone launch creates the gate,
  while claimed messages bind through `user_message_bound`.
- Message-level `maxLlmCalls`, intake-time `deliveryMode`, the steering inbox,
  terminal promotion, and the public direct `RuntimeApplication.runTurn()` API
  are removed.
- Abort and Shutdown remove only unclaimed FIFO work and emit correlated
  cancellation.

## Review and acceptance

- Initial independent design review returned five blocking findings.
- The design was revised to define the public API break, execution-policy
  call-limit boundary, cancellation binding semantics, final claim ordering,
  and shared Model-reference normalization.
- Independent re-review returned `PASS` with no unresolved design items.
- The project owner completed manual testing and accepted the implementation
  on 2026-09-28.

## Validation results

| Check | Result |
|---|---|
| Focused affected tests | Pass: 221/221 |
| Full Unit suite | Pass: 1,153/1,153 |
| Integration suite | Pass: 18/18 |
| Architecture Fitness | Pass: 43/43 |
| Copilot Relay Unit through build | Pass: 46/46 |
| Workspace lint and TypeScript | Pass |
| Build and Host build audit | Pass; audit covered 336 files |
| Obsolete-path source search | Pass: no steering inbox, promotion, delivery mode, pending Runner batch, or direct Root Run API |
| Modified-file comment audit | Pass: no Chinese code comments remain |
| `git diff --check` | Pass |
| Manual testing | Pass; accepted by project owner |

## Exceptions

None.
