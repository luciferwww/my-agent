# CLI Channel Interaction Parity Specification

> Status: Accepted
> Date: 2026-10-08
> Owner: Project owner
> Delivery: Implemented, validated, and owner-accepted on 2026-10-08
> Related Plan: [Plan](plan.md)

## 1. Purpose

Define the built-in CLI Channel command contract for discovering and selecting
the Runtime capabilities already exposed to Channels, including message-level
reasoning controls and bounded recent-history presentation after Session
switching.

This Specification extends CLI behavior only. It does not change Core,
Runtime, Session, Provider, WebSocket, or Extension contracts.

## 2. Existing capability baseline

The CLI retains these existing behaviors:

- Standalone composition enables interactive Approval.
- `/models`, `/model`, and `/model <providerId> <JSON-string-modelId>` query
  and select from the Runtime Model Catalog.
- `/sessions`, `/session`, `/session new`, `/session use`, `/session rename`,
  and `/session delete` manage the active Session.
- Runtime Session capabilities already expose active-branch history pages;
  current CLI Session switching does not present them in the terminal.
- `/permission`, `/permission manual`, and `/permission allow_all` control the
  Runtime-owned Session permission mode.
- Thinking stream events are rendered separately from answer text.
- Ctrl+C aborts active/queued work before the existing double-press exit path.

The CLI must continue to access these behaviors only through
`ChannelRuntimeCapabilities` and the Channel interaction adapter.

## 3. Command grammar

```text
/help

/models
/model
/model default
/model <providerId> <JSON-string-modelId>

/sessions
/session
/session new
/session use <sessionId>
/session rename <JSON-string|null>
/session delete

/permission
/permission manual|allow_all

/reasoning
/thinking
/thinking default|on|off
/effort
/effort default|none|minimal|low|medium|high|xhigh|max
```

Rules:

- `/help` lists the existing Model, Session, permission, reasoning, and abort
  controls. It does not invoke Runtime.
- `/models` and `/sessions` remain non-interactive catalog/list commands.
- `/reasoning` displays the effective Model, current selections, and supported
  non-default values.
- `/model`, `/session`, `/permission`, `/thinking`, and `/effort` are selection
  commands. Without arguments they open a numbered selector; with arguments
  they apply the direct command form.
- `/session new`, `/session rename`, and `/session delete` remain direct action
  commands rather than selector entries outside the `/session` selector.
- Unknown values produce a local usage error and do not mutate state.
- Commands are exact and case-sensitive, consistent with existing CLI command
  handling.

## 4. Shared selection interaction

Every selection command follows the same terminal interaction:

1. print a heading and a one-based numbered list;
2. mark the current effective selection;
3. ask for one number with a prompt that states blank input cancels;
4. apply the selected value through the same validation and mutation path as
   the equivalent direct command.

Selector contents are:

- `/model`: Runtime default plus every selectable Model in the current Catalog;
- `/session`: new-Session state plus every persisted Session;
- `/permission`: `manual` and `allow_all`;
- `/thinking`: `default` plus supported non-default Thinking values;
- `/effort`: `default` plus supported non-default effort values.

Selection rules:

- Empty input cancels with an explicit unchanged notice.
- A non-integer or out-of-range choice reports a local error, closes the
  selector, and leaves state unchanged.
- An unavailable capability or empty dynamic option set reports an explicit
  local error. Static `default` remains available for Model, Thinking, and
  effort whenever their owning capability can be queried.
- Model and Session labels use the existing terminal-safe formatting helpers.
- Choosing `allow_all` still requires the existing exact `ALLOW ALL`
  confirmation before mutation.
- Selecting a persisted Session is equivalent to `/session use <sessionId>`,
  including recent-history presentation. Selecting new-Session state is
  equivalent to `/session new`.
- Selectors do not invoke the ordinary message handler or dispatch a Model
  request.
- Only one CLI question owns input at a time. Approval prompts retain priority,
  and no selector can be opened from input consumed by an active Approval.

The direct forms remain the deterministic, automation-friendly interface.
Selectors are a convenience layer and do not define separate state or
validation behavior.

## 5. Effective Model and capability validation

The effective Model for CLI selection validation is:

1. the current valid CLI Model override;
2. otherwise the Runtime Catalog default when its state is `available`;
3. otherwise unavailable.

`default` is always selectable. A non-default value is selectable only when
the effective Model Catalog entry declares it:

- `capabilities.reasoning.thinking` owns `on` and `off`;
- `capabilities.reasoning.efforts` owns explicit effort values.

An absent or empty capability dimension exposes no non-default values. The CLI
must not infer support from Model IDs, Provider IDs, protocol names, or prior
successful requests.

Before every ordinary message dispatch, the CLI re-reads the Catalog:

- an unavailable Model override retains the existing local rejection;
- an incompatible reasoning selection is reset to `default` with an explicit
  notice before dispatch;
- validation failures do not silently send a different non-default value.

Selecting or clearing a Model override immediately reconciles both reasoning
dimensions against the resulting effective Model.

## 6. Combination rules

The CLI applies the same public reasoning constraints as Runtime/Web:

- `thinking=on` with `effort=none` is invalid;
- `thinking=off` permits only `effort=default` or `effort=none`;
- setting a value that would create an invalid pair is rejected without
  changing either current selection.

The CLI does not automatically promote an effort, enable Thinking, or guess an
alternative non-default value.

## 7. Request projection and lifetime

Selections are Channel-local process state:

```ts
thinking: 'default' | 'on' | 'off'
effort: ThinkingEffort
```

They are not persisted in Session records, config, Memory, or browser state,
and they are not changed by Session switching.

Projection rules:

- `thinking=default` omits `ReasoningPreference.thinking`;
- `effort=default` is omitted when Thinking is also `default`;
- when either dimension is non-default, the request includes a structured
  `ReasoningPreference`, using `effort: 'default'` when needed;
- both defaults omit `ChannelRunRequest.reasoning`, preserving current CLI
  behavior.

Runtime remains authoritative and performs its existing intake validation and
immutable per-Turn policy resolution.

## 8. Session switch history presentation

Model context restoration and terminal history presentation are separate
behaviors. Selecting an existing Session already determines which persisted
context Runtime uses for subsequent Turns. The behavior in this section only
gives the CLI operator visual context.

After `/session use <sessionId>` successfully selects an existing Session, the
CLI calls:

```ts
sessions.getHistory({
  sessionId,
  limit: 20,
})
```

Presentation rules:

- The CLI displays a clearly labeled `Recent session history` section. The
  value `20` is a persisted-record query limit, not a promise of 20
  conversation Turns or 20 fully rendered messages.
- Returned records are displayed in the chronological order supplied by the
  Session capability.
- User and Assistant text remain readable as conversation content.
- Thinking, Tool Use, and Tool Result content use compact, bounded previews
  consistent with existing CLI formatting rather than unbounded payload dumps.
- The complete section, including omission markers but excluding ANSI styling,
  is limited to 80 rendered lines or 16,384 UTF-16 code units, whichever is
  reached first.
- Budget selection retains a contiguous suffix of the page so the newest
  history is preferred. A single retained record that exceeds the remaining
  budget is truncated with an explicit marker.
- When `hasMore` is true or complete older records are excluded by the display
  budget, the section includes `[Earlier session history not shown]`. When a
  retained record is truncated, it includes
  `[Some recent session history content omitted]`.
- Projected image placeholders are displayed as text; encoded image data is
  never written to the terminal.
- An empty page produces an explicit empty-history notice.
- The history read does not call the ordinary message handler, dispatch a
  Model request, or mutate Model, reasoning, permission, or Session state.
- A history read failure reports an explicit local error but does not roll back
  the already successful Session switch.

This Change does not add a `/history` command, retain a pagination cursor, or
load records earlier than the latest 20. `/session new` does not attempt a
history read.

## 9. Errors and presentation

- Capability and usage errors are written locally with the existing red
  terminal style and do not call the message handler.
- Successful selection/status output uses the existing cyan/dim styles.
- Reconciliation names every reset dimension and the effective Model reason.
- Terminal output escapes Provider and Model display text through existing
  formatting helpers.
- Selector prompts are visually distinct from Approval prompts and return to
  the ordinary input loop after selection, cancellation, or error.

## 10. Compatibility

- Existing direct command grammar and ordinary message input remain valid.
- No-argument `/model`, `/session`, and `/permission` intentionally change
  from status-only output to a selector that marks the current value. Their
  existing information remains visible in that selector and in `/models`,
  `/sessions`, or `/reasoning` where applicable.
- Existing default requests omit reasoning and retain current Provider
  behavior.
- Existing Model override, Session selection, permission, Approval, Thinking
  rendering, and abort semantics are unchanged.
- Session switching remains successful when optional terminal history
  presentation fails.
- No compatibility flag or persisted-state migration is required. Direct
  commands remain stable, reasoning controls remain non-default, and history
  presentation is bounded.
