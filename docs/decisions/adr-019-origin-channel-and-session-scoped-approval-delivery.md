# ADR-019: Origin-Channel and Session-scoped Approval Delivery

> Status: Accepted
> Decision date: 2026-10-10
> Owner: Project owner
> Related Plan/Specification: [Plan](../changes/active/session-scoped-approval-delivery/plan.md) and [Specification](../changes/active/session-scoped-approval-delivery/specification.md)
> Supersedes: none

## Context

Binding Approval to one Origin Client makes browser disconnection reject a
still-live Tool call. Unconditionally routing an Origin Turn to unrelated
Channels instead can leave the user waiting in a UI that cannot show Approval.
Reopened Sessions also need to discover current pending requests, including
Sessions not currently being displayed.

## Options considered

1. Keep Origin Client binding: smallest audience, but temporary connection loss
   ends the request.
2. Broadcast every request to all Interaction Channels: broad reachability,
   but loses the Origin Turn's Channel boundary.
3. Remove Client eligibility, retain an existing Origin Channel boundary, and
   remove that restriction only when Origin Channel is absent.

## Decision

Choose option 3. A receiving Channel must match the Origin Channel when one
exists. With no Origin Channel, all Channels are candidates. The existing
interaction interface becomes required; unsupported Channels return
unavailable. Runtime does not pre-check a separate Approval-support flag.
This is admission and delivery, not automatic Tool approval; no accepted
delivery still fails closed.

Keep Runtime's existing canonical pending state and first-settlement behavior.
Add a read-only global or Session-filtered query using existing Approval request
types. Runtime does not create Channel-filtered query wrappers. Each Channel
reuses its local side-effect-free acceptance logic for delivery and queried
requests. This exposes pending data to Channel implementations, but decisions
still obey Runtime's Origin Channel rule. Existing Approval requests carry
optional `originChannelId` and retain `originClientId`, both supplied by Runtime
and preserved in realtime and query paths. Channels use this source context
for their own acceptance and presentation decisions, excluding requests owned
by another Origin Channel. Runtime does not use Client identity or view state
to determine eligibility; WebSocket removes Origin Client restrictions.

Keep shared Session entries unchanged. Bundled chat fetches the Session list
and all locally acceptable pending requests at startup and periodically, then
derives Session indicators from its local pending collection. Refresh cycles,
caching, and navigation are chat UX, not Runtime or other Channel requirements.
Access to pending data does not grant decision authority outside the Origin
Channel rule.

Channel wire adapters and presentation stay module-owned. Pending query
supplements existing realtime interaction. No new data wrappers, generic
notification subsystem, or Approval type-location migration is required.

## Consequences

- Closing a browser no longer owns Approval settlement. Remove the dedicated
  `onInteractionUnavailable` notification/forwarding and Runtime
  `origin_disconnected` settlement path, not just WebSocket's producer.
  Initial delivery failure, Turn Abort, and Runtime Shutdown remain unchanged.
- Reopened Sessions can retrieve current pending requests.
- Chat can indicate pending requests using its local collection; other Channels
  choose their own query and display policy.
- No-Origin delivery requires partial-delivery handling and closure convergence
  across Channels; one accepted delivery suffices and the first decision wins.
- User Allow/Deny closure must update other presentations, and CLI must close
  only its matching prompt.
- Pending state remains process-local and does not survive Runtime restart.
- Chat indicators are not a global summary of work in other Origin Channels.

## Migration and validation

Preserve existing Approval types, public type export paths, realtime request
delivery, Tool policy, Abort, and Shutdown. Requiring interaction changes the
Channel public contract, so existing Plugin implementations must adapt by
handling requests or explicitly returning unavailable. Channel adapters change
only as needed for the delivery rule, pending query, and
all-outcome closure.

The Plan and Specification own implementation details and focused validation.
Automation execution, unread tracking, and Channel hot-reload recovery remain
outside this Change.

## Review gate

Owner accepted this decision, the Plan, and Specification and explicitly
authorized Delivery on 2026-10-10. Validation and closeout remain outstanding.

Process authority: [Development Workflow](../governance/development-workflow.md).
