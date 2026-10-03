# Session Permission Modes Specification

> Status: Implemented, Validated, and Accepted
> Date: 2026-09-22
> Owner: Project owner
> Related Plan: [Session Permission Modes Plan](plan.md)
> Authorization: Delivery authorized by project owner on 2026-09-22.

## 1. Purpose

Define one proactive, ephemeral Session permission switch for supervised and
unattended Agent execution without adding persistent grants or claiming a
Sandbox boundary.

## 2. Terms

### Manual permissions

`manual` applies effective deny/allow policy, mandatory high-risk checks, and
current-call Approval. It is the default.

### Allow all for this Session

`allow_all` automatically authorizes each Tool call that is not denied by the
effective Tool policy. It is a live Runtime Session state, not a saved user
Approval or configuration default.

### Hard deny

A match in effective `tools.deny`. It is final, creates no Approval request,
cannot be overridden, and returns a denied Tool result at execution.

## 3. Public types

```ts
export type SessionPermissionMode = 'manual' | 'allow_all';

export interface SessionPermissionState {
  readonly sessionId: string;
  readonly mode: SessionPermissionMode;
  readonly changedAt: number;
  readonly changedByClientId?: string;
}

export type ToolAuthorizationSource =
  | 'static_allow'
  | 'session_allow_all'
  | 'user_approval';
```

`changedByClientId` is bounded operator/audit context. It does not bind mode
lifetime to a Client connection.

## 4. Runtime Application Contract

```ts
interface RuntimeApplication {
  createSession(input?: {
    permissionMode?: SessionPermissionMode;
    originClientId?: string;
  }): Promise<{
    sessionId: string;
    permission: SessionPermissionState;
  }>;

  getSessionPermissionMode(sessionId: string): SessionPermissionState;

  setSessionPermissionMode(input: {
    sessionId: string;
    mode: SessionPermissionMode;
    originClientId?: string;
  }): SessionPermissionState;
}
```

- Omitted create mode means `manual`.
- Only exact enum values are accepted.
- Creation and initial-mode installation are one atomic Runtime operation.
- Query/change accepts a live pending or materialized unarchived Session.
- Missing, deleted, or archived Sessions fail with the existing classified
  Session error pattern.
- A same-value request is idempotent and returns the authoritative state.
- A mode change is synchronous with respect to subsequent authorization
  decisions in the single Runtime process.
- No LLM-visible Tool exposes these methods.

## 5. Storage

Runtime owns:

```ts
class SessionPermissionRegistry {
  private readonly states: Map<string, SessionPermissionState>;
}
```

Rules:

- absence means `manual`;
- only non-default or explicit live state needs a Map entry;
- state is not written to `config.json`;
- state is not written to the Session transcript or metadata store;
- state is not written to Memory, Agent Context, Client storage, or Extension
  configuration;
- Client disconnect does not remove state;
- Runtime Shutdown naturally destroys all state.

Persisted Session identity and transcript remain owned by `SessionManager`.

## 6. Authorization decision

The effective Tool policy receives Session mode at each Tool authorization
point:

```ts
type ToolPolicyDecision =
  | { readonly outcome: 'deny'; readonly reason: 'deny_rule' }
  | {
      readonly outcome: 'allow';
      readonly source: 'static_allow' | 'session_allow_all';
    }
  | { readonly outcome: 'requires_approval' };
```

Decision order:

```ts
if (matchesEffectiveDeny(toolName)) {
  return { outcome: 'deny', reason: 'deny_rule' };
}

if (permissionMode === 'allow_all') {
  return { outcome: 'allow', source: 'session_allow_all' };
}

if (requiresMandatoryManualApproval(toolName, input)) {
  return { outcome: 'requires_approval' };
}

if (matchesEffectiveAllow(toolName)) {
  return { outcome: 'allow', source: 'static_allow' };
}

return { outcome: 'requires_approval' };
```

### Manual

- Exec requires current-call Approval even if `tools.allow` matches.
- Any lexically external declared structured target requires current-call
  Approval even if `tools.allow` matches.
- Other allow matches execute without Approval.
- Other unmatched calls request Approval.
- Missing Approval capability fails closed with its existing classification.

### Allow All

- Deny match returns a denied Tool result.
- Every other registered Tool call executes without an Approval interaction.
- This includes Exec, external structured targets, otherwise-unmatched Tools,
  Root calls, and attached Child calls.
- Approval capability and origin Client availability are irrelevant.

## 7. Denied Tool behavior

Configuration projection continues to hide denied Tool definitions from the
Model where the existing projection can do so. Execution retains a final deny
check.

An execution-time deny:

- does not emit `approval_requested`;
- does not abort or fail the Runtime Turn;
- does not mutate mode;
- does not allow user override;
- produces the existing bounded denied Tool result so the Model can choose
  another approach;
- records `deny_rule` without copying sensitive Tool input into logs.

## 8. Current-call Approval

Existing Approval result semantics remain:

```ts
type ApprovalDecision = 'allow' | 'deny';
```

The dialog decision applies only to the concrete current call. This Change does
not add “allow for Session” to the Approval dialog and does not create
per-command grants.

The Session mode control is a separate proactive operation.

### Pending Approval convergence

When a Session changes from `manual` to `allow_all`:

- Runtime finds every pending Approval for that Session;
- each is settled exactly once as authorized by `session_allow_all`;
- no synthetic `ApprovalDecision='allow'` is attributed to a user;
- origin binding no longer blocks those calls;
- pending approvals in other Sessions are unchanged;
- late Client responses are ignored under existing first-settlement rules.

When a Session changes from `allow_all` to `manual`, no Tool already executing
is cancelled. Future calls use Manual policy.

## 9. Root and Child execution

- Mode belongs to the live Root Session.
- Every attached Child execution reads the Root Session's current mode at each
  Tool authorization point.
- A Child cannot mutate mode.
- Forked Sessions do not inherit mode.
- Transient Child transcript identity does not create a separate permission
  authority.
- Effective Child deny policy remains final. Allow All does not widen Tools
  excluded by Parent/Child capability resolution or effective deny.

## 10. Lifecycle

| Event | Required behavior |
|---|---|
| Pending Session creation | install explicit mode atomically, otherwise Manual |
| First message/materialization | preserve live mode |
| Subsequent Turn | preserve live mode |
| Turn completion/failure/Abort | preserve live mode |
| Client disconnect/reconnect/replacement | preserve live mode |
| Manual to Allow All | settle Session pending approvals; future calls auto-authorize |
| Allow All to Manual | future calls use Manual; active calls continue |
| Archive | remove state |
| Unarchive | Manual |
| Delete | remove state |
| Fork | new Session is Manual |
| Runtime Shutdown/restart | remove all state |
| Resume persisted Session | Manual |

Archive and delete retain existing busy-Session restrictions.

## 11. Channel Contract

Transport-neutral control messages:

```ts
interface GetSessionPermissionModeRequest {
  readonly type: 'get_session_permission_mode';
  readonly sessionId: string;
}

interface SetSessionPermissionModeRequest {
  readonly type: 'set_session_permission_mode';
  readonly sessionId: string;
  readonly mode: SessionPermissionMode;
}

interface SessionPermissionModeChanged {
  readonly type: 'session_permission_mode_changed';
  readonly sessionId: string;
  readonly mode: SessionPermissionMode;
  readonly changedAt: number;
}
```

- Only an authenticated/connected user-facing Channel route may submit a
  change.
- Change is applied by Runtime, not stored by the Channel.
- The authoritative result is sent to the requester and broadcast to all
  Clients observing the Session.
- A later Client queries current state during Session synchronization.
- Malformed mode, missing Session, and archived Session return bounded errors.
- Mode-control messages are not AgentEvents and are not written to transcript.

## 12. Client presentation

### HTML

The Session permission selector contains:

```text
Manual permissions
Allow all for this Session
```

Selecting Allow All requires confirmation that:

- all non-denied Tool calls run without asking;
- arbitrary Shell and external filesystem effects are possible;
- executable/dependency integrity is not verified;
- mode remains active after Client disconnect;
- mode ends on revoke, archive/delete, or Runtime restart.

While active, the Session displays a persistent warning indicator. Selecting
Manual revokes mode for future calls.

### CLI

CLI exposes equivalent explicit commands or selector controls to:

- show current mode;
- set Manual;
- set Allow All with confirmation.

Non-interactive Host callers use the Runtime Application API rather than a
project-controlled configuration file.

## 13. Multi-client behavior

- Runtime state is authoritative.
- One Client's accepted change affects the shared Session.
- All observing Clients receive the same change event.
- Disconnecting the changing Client does not revoke mode.
- A stale Client update does not override a later authoritative update if the
  transport supports request/version correlation.
- UI must not infer mode from local state alone.

## 14. Audit and observability

Record bounded facts for:

- mode changes: Session ID, previous/new mode, timestamp, optional Client ID;
- automatic authorization: Session ID, Turn ID, Tool name,
  `source='session_allow_all'`;
- deny: Session ID, Turn ID, Tool name, `reason='deny_rule'`.

Do not log secrets or complete Tool input by default. An Allow All decision is
never reported as a concrete user Approval.

## 15. Security statement

Allow All is an explicit Session elevation, not a Sandbox:

- it does not constrain Shell command effects;
- it does not confine paths to Agent Home;
- it does not constrain network access;
- it does not verify executable, script, dependency, PATH, or package
  integrity;
- it does not terminate already-running or background processes when revoked.

The hard deny list is the only Tool-level boundary that remains inside this
mode. Future Sandbox work must remain a separate control.

## 16. Acceptance scenarios

- Manual behavior remains compatible except that Exec allow-list matching no
  longer bypasses current-call Approval.
- Allow All can be selected atomically before the first Turn.
- Unknown future Tool names/inputs proceed unattended when registered and not
  denied.
- Deny remains final and returns a normal denied Tool result.
- Exec and external structured paths auto-authorize only in Allow All.
- Pending Session approvals resume when mode changes to Allow All.
- Other Sessions remain isolated.
- Disconnect does not interrupt unattended execution.
- Mode revocation affects the next Tool decision.
- Root/Child policy and deny precedence remain correct.
- Archive/delete/fork/restart/resume reset semantics are enforced.
- CLI and HTML display authoritative state and risk.
- No production path persists mode.

Follow [Development Workflow](../../../governance/development-workflow.md).
