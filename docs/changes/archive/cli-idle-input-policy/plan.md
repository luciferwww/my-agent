# CLI Idle Input Policy Plan

> Status: Completed, validated, owner-accepted, and archived
> Date: 2026-10-08
> Owner: Project owner
> Classification: Architecture Slice
> Authorization: Owner accepted the Specification and authorized complete Delivery on 2026-10-08
> Acceptance: Owner accepted the completed Delivery on 2026-10-08
> Specification: [CLI Idle Input Policy Specification](specification.md)
> Validation: [Validation Matrix](validation.md)

## 1. Outcome

Make the readline CLI explicitly turn-at-a-time: ordinary messages, slash
commands, and numbered selectors are available only while no Runtime Turn is
producing events for the CLI. During an active Turn, output remains live and
the only input paths are Ctrl+C Abort and a Runtime-requested Approval.

This removes the misleading appearance of local Steering support and prevents
an externally started Turn from leaving a stale ordinary prompt underneath
streaming delta output.

## 2. Scope

- Track active Turns from paired `run_start` and `run_end` events inside
  `CliChannel`.
- Suspend an outstanding ordinary prompt or selector when the first active
  Turn starts.
- Wait for all visible active Turns to finish before opening the next ordinary
  prompt.
- Keep text, Thinking, Tool, error, and completion presentation live while
  ordinary input is suspended.
- Preserve Ctrl+C Abort during active work.
- Preserve Approval as the only Runtime-requested input exception, with its
  existing priority over ordinary prompts.
- Discard a partially entered ordinary line when a Turn suspends its prompt;
  never dispatch it after the Turn ends.
- Document that CLI Steering is unsupported and synchronize Current
  Architecture.

## 3. Non-goals

- No TUI, cursor-redraw framework, buffered delta display, or fixed Overlay.
- No local Steering submission during an active Turn.
- No new Core, Runtime, Channel, or Agent event types.
- No change to Runtime queueing, Steering claims, Abort, or Approval policy.
- No guarantee that a terminal driver will suppress echo if a user types while
  no ordinary prompt is present; such input is not dispatched.
- No change to WebSocket behavior.

## 4. Delivery plan

| Plan Item | Status | Work | Exit condition |
|---|---|---|---|
| CIIP-P0 Contract | Completed | Accept busy semantics, exceptions, and validation matrix | Owner accepted Specification and authorized Delivery on 2026-10-08 |
| CIIP-P1 Input gate | Completed | Add active-Turn tracking, prompt suspension, idle waiting, and stop convergence in `CliChannel` | Focused lifecycle tests pass |
| CIIP-P2 Documentation | Completed | Update CLI help/README wording and Current Architecture | Documentation matches implemented behavior |
| CIIP-P3 Validation | Completed | Run focused CLI tests, unit tier, lint/type-check, and diff checks | Validation matrix records final evidence |

Dependency order: CIIP-P0 -> CIIP-P1 -> CIIP-P2 -> CIIP-P3.

## 5. Gates and risks

### Delivery gate

- Owner accepts the Specification.
- Production changes remain inside `CliChannel`.
- Existing Runtime event and Abort/Approval capabilities remain authoritative.

### Completion gate

- No ordinary prompt is active while any tracked Turn is active.
- A suspended partial line cannot dispatch after idle resumes.
- Duplicate or unmatched terminal events cannot make the busy count negative.
- Stop cannot hang while the input loop is waiting for idle.
- Existing command, Approval, Abort, and presentation tests remain green.

The primary risks are prompt cancellation races, multiple concurrent Turn
events, and shutdown while waiting for idle.
