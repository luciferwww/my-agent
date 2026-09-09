# Core Media Current Architecture

> Status: Current Authority
> Verified: 2026-09-09
> Ownership: inbound media validation, limits, MIME verification, image optimization, drop reasons, and canonical content-block normalization
> Ownership key: media-validation-and-normalization

## 1. Boundary

`src/core/media/` owns the pure attachment/media pipeline between Channel input and Runtime queue admission. It validates ordered inbound text/image blocks and produces canonical `ChatContentBlock[]` plus structured dropped-item reasons.

Channel owns transport and wire shape. Runtime invokes the pipeline and decides how dropped-item notices enter the Turn. Prompt owns Context Hook text placement. Model Resolution validates requested media capabilities. Provider adapters own SDK/wire conversion. Media does not absorb those responsibilities.

## 2. Inbound pipeline

```text
string | InboundContentBlock[]
             |
             v
processInboundMessage(...)
├── text blocks pass through in order
├── image count and decoded-byte budgets
├── MIME allowlist + byte sniffing
├── optional image optimization
└── accepted canonical blocks + dropped[]
```

`processInboundMessage()` returns a plain string unchanged. Array input remains canonical block-array input even when it contains only text. One rejected image does not fail the whole message; accepted blocks retain their relative order and each rejection records its original block index.

## 3. Validation and limits

The current policy is defined in `constants.ts`:

| Constraint | Current value |
|---|---:|
| supported image MIME | PNG, JPEG, WebP, GIF |
| maximum images per message | 20 |
| maximum decoded bytes per attachment | 10 MiB |
| maximum decoded bytes per message | 10 MiB |
| optimization threshold | 2 MiB |
| WebSocket frame ceiling | 15 MiB |

Image count ignores text blocks. Aggregate bytes count decoded image bytes that passed the per-item size check. Declared MIME must match sniffed bytes; base64 decoding alone is not treated as proof of a valid image.

## 4. Image normalization

`processImageAttachment()` applies the MIME allowlist, reads image metadata, and optimizes images above the inline threshold. Accepted image blocks use canonical base64 media content and include verified dimensions. Optimization reports before/after byte counts and applied size/quality for diagnostics, not Channel events.

The pipeline returns neutral drop reasons:

- `unsupported_mime`, `mime_mismatch`, `metadata_unreadable`;
- `too_large`, `resize_failed`;
- message-level `limit_exceeded`, `total_exceeded`.

These reasons are Core facts. Channel presentation and Runtime-visible notice text are projections owned outside this module.

## 5. Downstream use

Runtime runs media normalization before user-message broadcast and queue/steering classification. Broadcast events expose summaries only—type, MIME, byte count, and optional dimensions—never raw base64. Prompt may prepend Context Hook text while preserving normalized block order. Model Resolution receives the resulting requested media kinds before Runner starts.

See [Channel](./adapter_channel.md), [Prompt](./core_prompt.md), and [Model Resolution](./core_model_resolution.md) for those boundaries.

## 6. Evidence

| Kind | Evidence |
|---|---|
| Source | [attachment-pipeline.ts](../../../src/core/media/attachment-pipeline.ts), [constants.ts](../../../src/core/media/constants.ts), [image-metadata.ts](../../../src/core/media/image-metadata.ts), [image-optimize.ts](../../../src/core/media/image-optimize.ts), [RuntimeApp.ts](../../../src/runtime/RuntimeApp.ts) |
| Tests | [attachment-pipeline.test.ts](../../../src/core/media/attachment-pipeline.test.ts), [image-metadata.test.ts](../../../src/core/media/image-metadata.test.ts), [image-optimize.test.ts](../../../src/core/media/image-optimize.test.ts), [RuntimeApp.intake.test.ts](../../../src/runtime/RuntimeApp.intake.test.ts) |
| Controlling authority | [Attachments Support Spec](../attachments-support-spec.md), [Core Runner Turn Flow Spec](../core-runner-turn-flow-spec.md), [Model Resolution Module Spec](../model-resolution-module-spec.md) |
