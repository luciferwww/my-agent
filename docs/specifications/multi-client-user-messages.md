# Multi-client User Messages Specification

> Status: Stable Authority
> Contract status: Implemented and Validated
> Verified: 2026-09-21
> Authority: Stable multi-client user-message contract

## Scope

`user_message` is a first-class `AgentEvent` broadcast through the common Runtime Fanout path to all clients in the relevant session, including the origin. It provides live visibility and correlation; it does not append transcript history or replay old messages to a newly connected client.

## Event contracts

```ts
interface AttachmentSummary {
  type: 'image' | 'other';
  name?: string;
  bytes?: number;
  mime?: string;
}

type UserMessageEvent = {
  type: 'user_message';
  sessionId: string;
  messageId: string;
  content: string;
  attachmentSummaries?: AttachmentSummary[];
  originClientId: string | null;
  deliveryMode: 'queued' | 'steering';
  timestamp: number;
};
```

A queued `run_start.originMessageId` equals the originating message ID. Message identity is independent from Turn identity. Steering does not immediately create a Turn; if it misses Runner's final safe point before normal completion, Runtime promotes it into the existing FIFO and its later `run_start.originMessageId` uses the same message ID.

## Assembly and emission

- Emit once after successful assembly and before queued/steering divergence.
- String input becomes text without summaries; text blocks join with two newlines.
- Base64 images produce summaries with MIME and decoded bytes; unknown/future blocks produce `other`.
- Raw base64 and source data never enter event JSON.
- Degenerate input emits neither event nor Run.
- Attachment validation is atomic; any failure rejects the complete input before this event, queueing, or Provider invocation.
- Session history remains written exactly once by Runner/Session.

## Routing invariants

- Queued requests retain message ID through queueing into `run_start`.
- Steering is broadcast with `deliveryMode: 'steering'` and does not interrupt or immediately start a Run. Normal terminal promotion emits no second `user_message` and does not mutate the original delivery mode.
- Promoted steering preserves FIFO order, origin route, and explicit launch overrides.
- Pure-image steering is visible but not inserted into the text-only steering inbox.
- Different sessions remain isolated; same-session admission keeps Runtime ordering.
- WebSocket origin receives its own message. CLI renders external WebSocket messages but does not echo its local input.
- CLI/library input uses `originClientId: null`; that value does not distinguish those two sources.
- Fanout failure does not change queueing or Runner outcome.
- Abort may later drop a queued request already broadcast; [Abort](abort.md) owns the terminal drop event.

## Acceptance scenarios

Cover queued and steering event shapes; ordering `user_message -> run_start -> output -> run_end`; direct and promoted message correlation; no duplicate event during promotion; atomic attachment rejection with no event; pure-image steering; degenerate input; no base64 leakage; future block safety; two-client origin-inclusive Fanout; CLI echo behavior; one transcript append; session isolation; and no history replay on subscription.

## Related authority

[Channels](../architecture/channels.md) owns transport facts, [Runtime](../architecture/runtime.md) owns routing, and [Attachments](attachments-support.md) owns Media/drop semantics.
