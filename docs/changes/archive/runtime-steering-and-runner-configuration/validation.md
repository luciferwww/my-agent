# Runtime Steering and Runner Configuration Validation

> Status: Complete and Accepted
> Date: 2026-09-21
> Plan: [Runtime Steering and Runner Configuration Plan](plan.md)
> Specification: [Runtime Steering and Runner Configuration Specification](runtime-steering-and-runner-configuration-specification.md)

## Delivered behavior

- Runtime owns `RuntimeConfig`, `steeringEnabled`, its `false` default, steering
  admission, inboxes, and normal terminal handoff.
- Runner owns `RunnerConfig`, optional `maxLlmCalls`, and safe-point batch
  injection.
- Platform composes and strictly validates the two module-owned leaf Contracts
  without duplicating their defaults.
- Omitted `maxLlmCalls` has no numeric cutoff; explicit positive limits retain
  `stopReason='max_llm_calls'`.
- Child Agents inherit the Parent effective optional limit unless their profile
  overrides it.
- Ready steering stays as distinct FIFO user messages with one continuation
  Model call.
- Unread steering after normal completion is promoted into the existing queue
  with message identity, route, and launch overrides preserved.
- Abort, explicit limit, thrown failure, and Shutdown discard unread steering.
- CLI and HTML render a generic configured-limit notice from the existing stop
  reason without modifying Assistant history.

## Automated evidence

| Check | Result |
|---|---|
| Focused configuration/Runner/Runtime tests before handoff work | Pass — 177 tests |
| Focused terminal handoff tests | Pass — 72 tests |
| Focused independent-review fixes | Pass — 88 tests |
| Focused Client and authority tests | Pass — 35 tests |
| Unit suite | Pass — 100 files, 1,083 tests |
| Integration suite | Pass — 6 files, 18 tests |
| Architecture Fitness suite | Pass — 12 files, 40 tests |
| TypeScript lint/typecheck | Pass — application and Copilot Relay workspace |
| Build | Pass — TypeScript builds, Host audit 324 files, Relay 45 tests |
| WebSocket Host smoke | Pass |
| `git diff --check` | Pass |
| Changed-document local link validation | Pass — 13 documents |

The first final Integration run was executed concurrently with the Unit and
Fitness suites. Its process-tree timeout case exceeded the five-second test
timeout while all other 17 tests passed. The failed file then passed 5/5 in
isolation, and the complete Integration suite subsequently passed 18/18 without
concurrent suite load.

## Independent review

The independent implementation review found two Medium issues:

1. An omitted Child profile limit did not inherit the Parent effective limit.
2. Abort during Runner's final asynchronous steering read could return the prior
   normal stop reason and allow Runtime promotion.

Both were fixed. Focused tests now prove Parent-limit inheritance and an aborted
result when cancellation occurs during the final steering read.

## Owner validation

The project owner accepted the delivered behavior and authorized Change
closeout/archive on 2026-09-21. The following checks remain useful as future
manual smoke scenarios rather than archive blockers:

Suggested checks before closeout:

1. Start with default configuration and confirm a busy-Session message queues as
   a later Turn.
2. Set `agents.defaults.runtime.steeringEnabled=true`; send input during a Tool
   call and confirm it is injected at the next safe point.
3. Send input after the final safe point and confirm it starts a later Turn
   without a duplicate user-message bubble.
4. Omit `runner.maxLlmCalls` and run a workflow exceeding 12 Model calls.
5. Set a small positive `runner.maxLlmCalls` and confirm partial output plus the
   generic CLI/HTML limit notice.
6. Abort with pending steering and confirm it is not promoted.

## Closeout

- Owner acceptance recorded on 2026-09-21.
- RSC-3 and the complete Change are closed.
- Plan, Specification, and validation record are archived together.
- Commit/push remain separate actions and require an explicit request.
