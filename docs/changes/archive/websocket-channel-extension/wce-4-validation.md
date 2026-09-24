# WCE-4 Authority and Closeout Validation

> Status: Accepted and Archived
> Date: 2026-09-24
> Plan: [WebSocket Channel Extension Plan](plan.md)
> Specification: [WebSocket Channel Extension Specification](websocket-channel-extension-specification.md)
> Decision: [ADR-015](../../../decisions/adr-015-host-local-and-extension-delivered-channels.md)

## Outcome

WCE-4 completed stable-authority convergence, final Extension API ownership
review, independent code review, residual scans, and the complete delivery
gate set. The Change was implemented, validated, accepted, and archived by the
project owner on 2026-09-24.

## Final authority

- Standalone defaults to zero Host-local Channels and adds only CLI for
  `--cli`.
- WebSocket is an explicitly enabled first-party Extension. Standalone has no
  WebSocket identity, factory, configuration, or completion branch.
- Runtime remains the sole owner of Unit creation, staging, publication,
  lifecycle, completion observation, retirement, and shutdown.
- The WebSocket package owns its Descriptor, transport policy, `ws`
  dependency, HTML client, browser launch, tests, and security boundary.
- ADR-013 is partially superseded for Builtin Channel selection/default
  liveness; its Agent Home and Host-neutral configuration decisions remain
  accepted.
- ADR-007 is partially superseded only for WebSocket source ownership.

## Extension API boundary

The final public delta is limited to demonstrated Extension-author needs:

- scoped `ExtensionLogger` access through `ExtensionLoadContext`;
- Channel contribution, lifecycle, interaction, Runtime-capability, event,
  and Session-permission value contracts projected through the Channel owner;
- `ChannelOperationError`, used by Runtime to normalize concrete Session and
  Media failures before they cross the Channel boundary.

The public API does not expose concrete `SessionError`,
`AttachmentValidationError`, WebSocket payload policy, Acquisition internals,
Runtime/Bootstrap state, Host state, or mutable global logger configuration.
The WebSocket Extension imports Host contracts only through
`my-agent/extension-api`.

## Independent review

The final independent review reported three high-confidence findings. The
project owner explicitly assigned HTTP/browser deployment security to the
operational boundary; one protocol-ownership finding was fixed in the Channel:

| Severity | Finding | Resolution | Regression evidence |
|---|---|---|---|
| Critical | Cross-origin sites could connect to the loopback WebSocket without authentication | Owner disposition: accepted at the Channel layer. Authentication, TLS, Origin/Host policy, and exposure hardening belong to the operational proxy/gateway | README, architecture, Specification, and non-goals state the boundary explicitly |
| High | Model-controlled Markdown reached the bundled page's `v-html` sink | Owner disposition: the single-page HTML is a minimal reference/debugging client, not the production website or a browser-security boundary | Presentation-specific HTML capability tests were removed; production websites own their rendering policy |
| High | A foreign client could resolve another client's pending approval | Resolution now requires the pending approval's logical `clientId`; rejected foreign/unknown submissions do not consume the route | Two-client approval-origin regression |

The subsequent owner-requested synchronization audit clarified that the
bundled single-page HTML is only a minimal reference/debugging client; its
presentation-specific source assertions were removed rather than treating it
as the production website. The temporary Channel-layer token, Origin, Host,
CSP, and HTML-sanitizer additions were removed so deployment security remains
an operational concern rather than a transport API.

## Multi-Session follow-up

The owner-requested follow-up remains inside the WebSocket Extension boundary:

- the existing audience maps are explicitly treated as many-to-many, allowing
  one logical client to participate in multiple concurrent Sessions;
- Approval request and closure payloads now retain `sessionId` and `turnId`,
  while pending routes retain `clientId`, `sessionId`, and `turnId`;
- a queued `request_end` payload is enriched with the Session already resolved
  by the Channel from `originMessageId`;
- the bundled reference client keeps separate in-memory UI state per Session
  and routes background events to that state rather than the currently visible
  Session;
- Session switching no longer waits for another Session's Turn to finish;
- reconnect/resume, event replay, and explicit subscribe/unsubscribe remain
  outside this follow-up.

No Host, Runtime, Core, or Extension API surface changed for this behavior.

## Final validation

Validated on 2026-09-24:

| Gate | Result |
|---|---|
| Workspace lint and TypeScript checks | Passed |
| WebSocket Extension focused suite | 4 files / 48 tests passed |
| Unit | 104 files / 1,129 tests passed with one worker |
| Integration | 6 files / 18 tests passed with one worker |
| Architecture Fitness | 13 files / 43 tests passed |
| Build | Passed |
| Host build audit | 334 files passed |
| Copilot Relay package tests | 3 files / 45 tests passed |
| Explicit source-tree WebSocket Extension Host smoke | Passed |
| Installed npm package verification | Passed; 354 files |
| Independent review findings | 1 protocol issue fixed; 2 deployment/UI findings explicitly dispositioned by owner |
| Documentation links and stale-authority scan | Passed through FT-09 |
| Legacy source-layout convergence | Passed through FT-13 |
| `git diff --check` | Passed |

The full Unit and Integration suites used one worker because concurrent
Windows worker scheduling can exceed unrelated five-second process-test
timeouts. Focused WebSocket tests also passed independently.

Installed-package verification ran with npm engine-strict disabled only in the
verification process because the local runtime is Node 20.16.0 while the
package correctly retains its Node 22.x engine requirement.

## Residual result

- No Host source references the WebSocket Extension identity, implementation,
  or Unit factory.
- The old Builtin WebSocket directory and top-level HTML client are absent.
- Old paths remain only in explicit forbidden-path regression assertions or
  superseded historical decision context.
- `WS_MAX_PAYLOAD_BYTES` remains private to the WebSocket package.
- The two unrelated untracked research JSON files were not modified.

## Archive

The project owner accepted this Change on 2026-09-24. Its complete delivery
record is retained under `docs/changes/archive/websocket-channel-extension/`.
