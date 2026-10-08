# CLI Idle Input Policy Specification

> Status: Implemented, validated, and owner-accepted
> Date: 2026-10-08
> Owner: Project owner
> Related Plan: [Plan](plan.md)

## 1. Purpose and boundary

The built-in readline CLI is a turn-at-a-time transport. It does not provide
local Steering input while a Turn is active.

This Specification changes only private `CliChannel` input ownership and
documentation. It does not change Core, Runtime, Session, Provider, WebSocket,
or public Channel contracts.

## 2. Busy authority

`CliChannel` maintains a set of active `turnId` values:

- `run_start` adds its `turnId`;
- `run_end` removes its `turnId`;
- duplicate `run_start` and unmatched `run_end` are idempotent.

The CLI is busy whenever the set is non-empty. The set is Channel-wide rather
than limited to the currently selected Session because any event rendered by
this CLI can disrupt its single terminal input surface.

`request_end` does not change the set because it represents a queued request
that never acquired a Turn. Other events do not infer busy state.

## 3. Ordinary input gate

Ordinary input includes:

- user messages;
- slash commands;
- numbered selectors;
- safety confirmations initiated by those commands.

Before opening an ordinary prompt, the input loop waits until the active-Turn
set is empty.

When the first `run_start` arrives while an ordinary question is active:

1. the question is aborted with a private suspension reason;
2. any partial ordinary line is cleared and cannot later dispatch;
3. the CLI prints a concise notice that input is paused and Ctrl+C remains
   available;
4. the input loop waits without opening another prompt;
5. after the final tracked `run_end`, the loop opens a fresh ordinary prompt.

A command or selector interrupted this way performs no mutation. The user must
invoke it again after the CLI becomes idle.

The CLI does not buffer or delay Runtime presentation while input is paused.

## 4. Input exceptions

### Ctrl+C

The existing readline SIGINT listener remains active while a Turn is running.
Ctrl+C continues to query and invoke Runtime Abort; the existing double-press
Channel-close behavior is unchanged.

### Approval

A Runtime-requested Approval remains interactive while a Turn is active because
the Turn is blocked on that decision. Approval retains priority over any
ordinary question and uses the existing y/n contract.

Completing or closing an Approval does not reopen ordinary input while any
tracked Turn remains active. The input loop resumes only after the final
`run_end`.

## 5. Lifecycle and failures

- `stop()` releases any waiter blocked on idle and aborts the active question.
- Input closure while waiting for idle settles Channel completion through the
  existing lifecycle.
- An error event does not independently clear busy state; paired `run_end`
  remains authoritative.
- Active-Turn state is in-memory only and resets with the Channel instance.
- No user text entered without an active ordinary question is converted into a
  `ChannelRunRequest`.

## 6. Compatibility

- Idle command grammar, selectors, Session history, reasoning projection,
  Approval, and Ctrl+C behavior remain unchanged.
- Runtime and WebSocket Steering behavior remains unchanged.
- The intentional behavioral change is that an external Turn now removes a
  stale CLI prompt until all visible Turns finish.
- No migration, compatibility flag, or dependency is required.
