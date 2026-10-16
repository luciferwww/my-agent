# CLI Channel Interaction Parity Plan

> Status: Implemented, validated, and owner-accepted
> Date: 2026-10-08
> Owner: Project owner
> Classification: Architecture Slice
> Authorization: Owner accepted the Specification and authorized complete Delivery on 2026-10-08
> Acceptance: Owner accepted complete Delivery on 2026-10-08
> Specification: [CLI Channel Interaction Parity Specification](specification.md)
> Validation: [Validation Matrix](validation.md)

## 1. Outcome

Bring the built-in CLI Channel's operator controls closer to the WebSocket
Channel where terminal interaction can express the same Runtime-owned
capabilities without introducing a second source of truth.

The CLI already supports interactive Approval, Model Catalog selection,
Session selection and lifecycle commands, Session permission modes, Thinking
event presentation, and abort. This Change makes those controls discoverable,
adds the missing message-level Thinking and effort selection, and gives an
operator bounded visual context after switching to an existing Session.

## 2. Scope

- Add `/help` as the discoverable index for existing CLI commands.
- Give every selection command a consistent hybrid interface: no arguments
  open a numbered selector, while explicit arguments remain available for
  direct use.
- Add `/reasoning` to show the current Thinking and effort selections, the
  effective Model, and its declared reasoning capabilities.
- Add `/thinking [default|on|off]`.
- Add `/effort [default|none|minimal|low|medium|high|xhigh|max]`.
- Validate non-default selections against the current effective Model Catalog
  entry before accepting them and again before dispatch.
- Enforce the same invalid-combination rules as the bundled Web client.
- Reset incompatible selections to `default`, with an explicit notice, when
  Model selection or Model capabilities change.
- Attach a non-default CLI selection to each ordinary `ChannelRunRequest`.
- Preserve omission of `reasoning` when both selections are `default`.
- After `/session use <sessionId>` succeeds, display the latest 20 persisted
  history records in chronological order through the existing Session
  capability.
- Bound the complete historical display to 80 rendered lines or 16,384
  pre-style UTF-16 code units, preserving the newest content and explicitly
  marking omitted content.
- Keep existing Approval, Model, Session, permission, Thinking presentation,
  and Ctrl+C behavior covered and documented.
- Update CLI usage documentation and focused tests.

## 3. Non-goals

- No new Runtime, Session, Model Catalog, Approval, or Channel public types.
- No global or persisted reasoning defaults.
- No reasoning inheritance from Session history.
- No terminal UI framework, full-screen TUI, searchable picker, mouse input,
  or persistent status bar.
- No `/history` command, earlier-history pagination, or full Transcript replay.
- No image attachment input for CLI.
- No attempt to reproduce browser layout, streaming cards, or visual controls.
- No change to Provider protocol mapping or capability declaration.

## 4. Delivery plan

| Plan Item | Status | Work | Exit condition |
|---|---|---|---|
| CCP-P0 Contract | Completed | Accept Plan, command grammar, capability rules, and validation matrix | Owner accepted the Specification and authorized Delivery on 2026-10-08 |
| CCP-P1 Selection and reasoning controls | Completed | Implement the shared numbered-selector interaction, reasoning selection, capability validation, reconciliation, and request projection | Focused selector, reasoning command, and dispatch tests pass |
| CCP-P2 Session context and discoverability | Completed | Apply the selector contract to existing Model, Session, and permission choices; display bounded recent history after Session switching; add `/help`; and synchronize README | History/help/documentation tests and affected CLI tests pass |
| CCP-P3 Validation | Completed | Run focused CLI tests, default unit tier, lint/type-check, and diff checks | Validation matrix records final evidence |

Dependency order: CCP-P0 -> CCP-P1 -> CCP-P2 -> CCP-P3.

## 5. Gates and risks

### Delivery gate

- The project owner accepts the Specification.
- Default CLI requests remain byte-for-behavior compatible at the
  `ChannelRunRequest` boundary by omitting `reasoning`.
- The CLI consumes only `ChannelRuntimeCapabilities`; it does not reach into
  Runtime or Provider implementation details.

### Completion gate

- Invalid and unsupported selections never reach Runtime intake.
- Model changes cannot leave a stale non-default selection active.
- Session switching cannot dump unbounded history into the terminal.
- Existing Approval, Model, Session, permission, and abort tests remain green.
- README command documentation matches implemented grammar.

Primary risks are stale Model capability state, ambiguous defaults, command
grammar drift, selector/Approval prompt ownership, and excessive historical
terminal output. The Specification resolves these without adding a new
capability layer, history protocol, or terminal UI framework.
