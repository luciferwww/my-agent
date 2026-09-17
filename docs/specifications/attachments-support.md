# Attachments Support Specification

> Status: Stable Authority
> Contract status: Implemented and Validated
> Verified: 2026-09-14
> Authority: Stable attachment ingress and media contract

## Scope

User input may be text or ordered content blocks. Version 1 accepts base64 PNG, JPEG, WebP, and GIF images. Channel validates wire shape; Media validates decoded bytes and normalizes content. One bad attachment does not reject the message.

Excluded: URLs/fetching, PDFs/documents, OCR, durable attachment stores/references, assistant-generated images, and attachment steering.

## Contracts

```ts
type InboundContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'base64'; media_type: 'image/png'|'image/jpeg'|'image/webp'|'image/gif'; data: string } };
```

Accepted images become canonical internal blocks with verified dimensions. Dimensions are internal and Provider adapters remove them from outbound SDK payloads.

Drop reasons are `unsupported_mime`, `mime_mismatch`, `metadata_unreadable`, `too_large`, `resize_failed`, `limit_exceeded`, and `total_exceeded`.

## Limits and normalization

- Maximum 20 images per message.
- Maximum decoded bytes per attachment and per message: 10 MiB.
- Images above 2 MiB and at most 10 MiB are optimized to JPEG at no more than 2 MiB.
- Maximum optimized side: 2000 pixels; quality attempts: 85, 75, 65, 55, 45; transparency is flattened onto white.
- WebSocket frame ceiling is 15 MiB.
- Aggregate budget charges decoded bytes before MIME, metadata, or optimization checks.
- Text and accepted-image order are preserved; drop indexes refer to original blocks.
- A string remains a string; an all-text block array remains an array.
- Pure failed attachments become an aggregate textual notice; content with no meaningful input is skipped.
- Resize success is silent; invalid image bytes are dropped rather than failing the whole intake path.
- Raw base64 never enters event or log payloads.

## Steering, persistence, and budgeting

Steering strips image blocks and forwards text only. Pure-image steering remains visible to clients but is not injected into Runner.

Session persists normalized inline image blocks. Runner estimates image tokens as `ceil(width / 28) * ceil(height / 28)`. Compaction presents textual image summaries to the summary model without changing persisted original blocks. Layer-1 Tool Result pruning does not prune images.

No attachment-specific Runtime/Agent event or Channel error is introduced. Attachment summaries contain type/name/bytes/MIME only; dimensions are not part of the current summary contract.

## Acceptance scenarios

Cover text-only preservation; supported and unsupported MIME; magic/MIME mismatch; corrupt metadata; optimization success/failure; count and aggregate limits; mixed valid/invalid blocks; pure failure notice; empty input; text-only steering; pure-image steering visibility; no raw payload in events; Provider dimension stripping; dimension-based token estimation; Compaction placeholder with persisted original; and concurrent-session isolation.

## Related authority

[Media](../architecture/media.md) owns current pipeline facts, [Channels](../architecture/channels.md) owns wire validation, [Runner](../architecture/runner.md) owns budgeting/Compaction, and [Multi-client User Messages](multi-client-user-messages.md) owns summary fanout.
