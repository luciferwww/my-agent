# Session Permission Modes Validation

> Status: Implemented, Validated, and Accepted
> Date: 2026-09-23
> Owner: Project owner
> Related Plan: [Plan](plan.md)
> Contract: [Session Permission Modes Specification](session-permission-modes-specification.md)

## 1. Implementation evidence

| Boundary | Evidence |
|---|---|
| Runtime state | `SessionPermissionRegistry` owns process-local `manual | allow_all` state, change notifications, lifecycle deletion, shutdown clearing, and Pending Session expiry cleanup |
| Tool policy | Effective deny remains final; Allow All authorizes every other registered Tool; Manual forces Approval for Exec and external structured paths before static allow |
| Live authorization | Runner reads the root Session mode for each Tool call; attached Child execution receives the same live callback |
| Pending Approval | Elevation settles only the selected Session's pending requests with `source: 'session_allow_all'`; late decisions retain first-settlement behavior |
| Session lifecycle | Create supports an atomic initial mode; archive/delete clear state; unarchive/fork initialize Manual; restart/resume cannot restore elevation |
| WebSocket | Strict create/query/set messages return authoritative state, broadcast changes to Session audiences, close mode-authorized Approval UI, and subscribe safely across Runtime startup/shutdown |
| CLI | `/permission` shows mode; `/permission manual` revokes; `/permission allow_all` requires explicit typed confirmation after a security warning |
| HTML client | Selector supports atomic first-Session elevation, authoritative reconnect query, confirmation, persistent warning, revocation, and no browser persistence |
| Stable authority | Approval, Tools, Runtime, Channels, Session, Configuration, and Built-in Tools documentation describes the implemented contract |

## 2. Executed validation

| Check | Result |
|---|---|
| Focused Session permission, Tool policy, Runner, Subagent, Runtime, CLI, WebSocket, and HTML tests | 170/170 passed before final lifecycle fixes; affected focused reruns also passed |
| `npm test` on final source state | 101 files, 1,097 tests passed |
| `npm run test:integration` on final source state | 6 files, 18 tests passed |
| `npm run test:fitness` on final source state | 12 files, 40 tests passed |
| `npm run lint` on final source state | Main and relay TypeScript checks passed |
| `npm run build` on final source state | Main and Host builds passed; Host audit passed for 326 files; relay verification passed 45/45 |
| `npm run verify:websocket-host` on final source state | Passed |
| Changed-document local links | Passed |
| `git diff --check` | Passed on the final closeout edits |

## 3. Independent review

The independent review reported two Medium lifecycle issues:

1. Runtime Shutdown left elevated permission state observable through the retained application handle. Runtime now clears the registry in the shutdown path after Turn drain/convergence, including failed shutdown.
2. Lazy expiration of Pending Sessions did not remove their permission entries. `PendingSessionRegistry` now reports expired IDs, and Runtime removes the coupled permission state.

Both fixes have focused regression coverage and pass TypeScript validation. No remaining Critical, High, or Medium issue is known.

## 4. Manual acceptance

The project owner completed manual acceptance on 2026-09-23, covering:

- CLI warning, typed confirmation, show, elevation, and revocation flow;
- HTML initial-session and existing-session selection, warning visibility, confirmation cancellation, reconnect synchronization, and revocation;
- unattended execution behavior after the controlling Client disconnects.

The Change is complete and archived.
