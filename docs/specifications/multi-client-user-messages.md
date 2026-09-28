# Multi-client User Messages Specification

> Status: Stable Authority
> Contract status: Implemented and Validated
> Verified: 2026-09-28
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
  timestamp: number;
};

type UserMessageBoundEvent = {
  type: 'user_message_bound';
  sessionId: string;
  turnId: string;
  messageId: string;
  binding: 'steering';
};
```

A standalone `run_start.originMessageId` equals the originating message ID. A steering claim emits one `user_message_bound` for each claimed message. Message identity is independent from Turn identity.

## Assembly and emission

- Emit once after successful assembly and immediately before FIFO append.
- String input becomes text without summaries; text blocks join with two newlines.
- Base64 images produce summaries with MIME and decoded bytes; unknown/future blocks produce `other`.
- Raw base64 and source data never enter event JSON.
- Degenerate input emits neither event nor Run.
- Attachment validation is atomic; any failure rejects the complete input before this event, queueing, or Provider invocation.
- Session history remains written exactly once by Runner/Session.

## Routing invariants

- Standalone requests retain message ID through queueing into `run_start`.
- Steering claim emits `user_message_bound`; intake does not predict binding.
- A claimed message keeps FIFO order and does not replace the active Turn's origin route.
- Text and multimodal messages share the same FIFO and capability checks.
- Different sessions remain isolated; same-session admission keeps Runtime ordering.
- WebSocket origin receives its own message. CLI renders external WebSocket messages but does not echo its local input.
- CLI/library input uses `originClientId: null`; that value does not distinguish those two sources.
- Fanout failure does not change queueing or Runner outcome.
- Abort may later drop a queued request already broadcast; [Abort](abort.md) owns the terminal drop event.

## Acceptance scenarios

Cover intake and binding event shapes; standalone ordering `user_message -> run_start -> output -> run_end`; steering ordering `user_message -> user_message_bound -> continuation`; atomic attachment rejection with no event; multimodal steering; degenerate input; no base64 leakage; future block safety; two-client origin-inclusive Fanout; CLI echo behavior; one transcript append; Session isolation; cancellation of unbound queued input; and no history replay on subscription.

## Related authority

[Channels](../architecture/channels.md) owns transport facts, [Runtime](../architecture/runtime.md) owns routing, and [Attachments](attachments-support.md) owns Media/drop semantics.
