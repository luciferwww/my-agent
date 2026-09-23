# Session Permission Modes Plan

> Status: Complete and Accepted
> Date: 2026-09-22
> Owner: Project owner
> Type: Architecture Slice
> Specification: [Session Permission Modes Specification](session-permission-modes-specification.md)
> Authorization: Delivery authorized by project owner on 2026-09-22.

## 1. Outcome

Add one explicit, server-owned permission mode to each live Session:

```ts
type SessionPermissionMode = 'manual' | 'allow_all';
```

- `manual` preserves interactive Approval behavior.
- `allow_all` automatically authorizes every registered Tool call that is not
  blocked by the effective `tools.deny` policy.
- `tools.deny` remains final and cannot be bypassed by either mode or a user
  Approval.
- Mode state survives Client disconnect so a long-running task can continue
  unattended, but it does not survive Session archive/delete, fork, Runtime
  restart, or later Session resume.

## 2. Problem

Current Approval is current-call and origin-bound. A task cannot receive
permission until it makes a concrete Tool call, and it remains blocked if the
origin Client disconnects or no user is available to respond.

That model is appropriate for supervised work but cannot support long-running
unattended tasks whose future Tool names and parameters are not predictable.
Adding command-pattern or exact-call grants would reduce repeated prompts but
would not solve unknown future calls.

The required capability is therefore a proactive Session switch, not an
Approval cache:

```text
Manual permissions
Allow all for this Session
```

## 3. Scope

- Define `manual` and `allow_all` as the only Session permission modes.
- Default every pending, materialized, unarchived, forked, and resumed Session
  to `manual`.
- Store non-default mode state only in Runtime process memory.
- Add Runtime Application APIs to create/query/change Session permission mode.
- Permit an atomic `allow_all` selection when a Session is created.
- Add Channel requests/responses and Client controls for mode query/change.
- Broadcast mode changes to all Clients observing the affected Session.
- Keep mode state after the Client that selected it disconnects.
- Make `tools.deny` final in both modes.
- In `allow_all`, authorize all other registered Tool calls without creating a
  current-call Approval interaction, including:
  - Exec;
  - structured targets outside Agent Home;
  - Tools not present in `tools.allow`;
  - Root and attached Child Agent Tool calls in the Session execution tree.
- When switching `manual -> allow_all`, settle already-pending Approval
  interactions for that Session as mode-authorized so a blocked task resumes.
- When switching `allow_all -> manual`, affect only future authorization
  decisions; do not terminate Tool calls that have already started.
- Return a normal denied Tool result if an execution-time deny check is hit so
  the Model may choose another available approach.
- Record authorization source as policy deny, static allow, Session Allow All,
  or current-call user Approval.
- Update CLI and HTML Client presentation.
- Update Approval, Tools, Runtime, Channels, Session, Configuration, and
  architecture authority plus Fitness coverage.

## 4. Non-goals

- A filesystem, process, network, container, VM, or OS Sandbox.
- Executable path, hash, signature, package, script, or dependency integrity.
- Persistent `allow_all` in `config.json`, Session transcript, Memory, Agent
  Context, browser storage, or a grant database.
- Project, Agent, application-global, cross-Session, or cross-process Allow All.
- Exact-command, command-prefix, wildcard, directory, domain, Tool-family, or
  persistent Approval grants.
- Model-, Tool-, Hook-, Child-, Extension-, or prompt-initiated permission mode
  changes.
- Automatically killing active or background processes when mode is revoked.
- Letting Allow All override `tools.deny`.
- Treating Allow All as evidence that a user inspected a concrete Tool input.

## 5. Security rule

The effective decision order is:

```text
effective tools.deny
  -> Session permission mode
  -> mandatory Manual-mode checks
  -> effective tools.allow
  -> current-call Approval
  -> fail closed
```

In `allow_all`:

```text
deny match -> reject
otherwise  -> allow without asking
```

The mode grants the Agent the Host authority exposed by every non-denied Tool.
Without a Sandbox, this includes arbitrary Shell and external filesystem
effects. UI and documentation must state this directly.

## 6. Ownership

### Runtime Session

Runtime owns:

- the in-memory Session permission registry;
- defaulting and lifecycle cleanup;
- mode query/change;
- Root/Child effective-mode propagation;
- pending-Approval convergence during mode elevation;
- change fanout and audit facts.

### Platform Tool Policy

Application Tool Policy owns:

- final deny matching;
- Manual-mode path/Exec checks;
- static allow matching;
- returning a classified authorization decision.

It does not persist or mutate Session mode.

### Approval

Approval continues to own concrete current-call interaction lifecycle in
`manual`. An `allow_all` decision is not represented as a user-approved
current-call result.

### Channels and Clients

Channels transport authenticated user/operator mode-control requests. Clients
display current state, confirmation, warnings, and changes. An LLM-visible Tool
is never added for mode mutation.

### Session persistence

`SessionManager` continues to own persisted identity, metadata, and transcript.
Permission mode is intentionally excluded from that persistence.

## 7. Runtime lifecycle

| Transition | Effective mode |
|---|---|
| Create with no explicit mode | `manual` |
| Create with explicit `allow_all` | `allow_all` |
| Client disconnect/reconnect | unchanged |
| New Turn in same live Session | unchanged |
| Root spawns attached Child | inherits live Root Session mode |
| Turn Abort/failure/completion | unchanged |
| Switch `manual -> allow_all` | immediate for pending and future calls |
| Switch `allow_all -> manual` | future calls only |
| Archive | reset/remove |
| Unarchive | `manual` |
| Delete | reset/remove |
| Fork | new Session is `manual` |
| Runtime Shutdown/restart | reset/remove |
| Resume persisted Session after restart | `manual` |

## 8. Delivery slices

| Slice | Status | Outcome | Exit condition |
|---|---|---|---|
| SPM-0 Contract acceptance | Complete | Mode, precedence, lifecycle, and security wording are accepted; Delivery is explicitly authorized | Plan and Specification accepted; explicit Delivery approval recorded |
| SPM-1 Runtime state and control | Complete | Runtime owns validated in-memory state, APIs, lifecycle cleanup, and pending-Approval convergence | Runtime/Session/Approval tests pass |
| SPM-2 Tool authorization | Complete | Deny remains final; Allow All automatically authorizes every other Root/Child call with classified audit source | Tool policy, Runner, Exec, external-path, and Child tests pass |
| SPM-3 Channel and Client UX | Complete | CLI/WebSocket/HTML expose query/change, warnings, broadcast, reconnect, and revocation | Channel/client capability and integration tests pass |
| SPM-4 Authority and closeout | Complete | Stable authority and Fitness lock final behavior | Full validation, independent review, and owner acceptance completed |

Only one Slice may be `In Progress`.

## 9. Validation strategy

### Focused

- Every Session defaults to `manual`.
- Atomic create with `allow_all` prevents a first-Tool Approval race.
- Mode changes apply atomically at the next authorization decision.
- Deny wins over static allow, Allow All, pending Approval, Root, and Child use.
- Denied calls return a normal denied Tool result without aborting the Turn.
- Allow All bypasses interactive Approval for Exec, external structured paths,
  and otherwise-unmatched Tools.
- Authorization events distinguish `session_allow_all` from `user_approval`.
- Switching to Allow All settles all pending approvals in that Session only.
- Other Sessions and pending interactions remain isolated.
- Switching to Manual does not terminate an already-started Tool.
- Disconnect does not reset the mode.
- Archive/delete/reset/restart/resume/fork semantics match the lifecycle table.
- Child execution observes the live Root Session mode and final deny policy.
- LLM, Tool, Hook, Extension, and Child surfaces cannot change mode.
- Multiple Clients observe one authoritative mode and receive change events.

### Final

- `npm test`
- `npm run test:integration`
- `npm run test:fitness`
- `npm run lint`
- `npm run build`
- WebSocket Host smoke
- `git diff --check`
- Changed-document link validation
- Independent review

## 10. Stop conditions

Return to design review if Delivery requires:

- persistence across Runtime restart or Session resume;
- a global/default Allow All configuration;
- a command/path/domain/prefix grant engine;
- a new Sandbox or integrity-verification claim;
- project-controlled permission escalation;
- Allow All overriding deny;
- a second active Session-mode authority;
- silently treating automatic authorization as user Approval.

## 11. Closeout

- Stable Approval, Tools, Runtime, Channels, Session, and Configuration
  authority describe the final behavior.
- The Current Architecture records the Runtime-only state boundary.
- The Change records security limitations and full validation.
- Archive only after project-owner acceptance.
- Commit and push remain separate explicit actions.

Follow [Development Workflow](../../../governance/development-workflow.md).
