# Media

> Status: Current Authority
> Authority: Current implemented media behavior
> Verified: 2026-09-16
> Ownership: Inbound media validation, limits, MIME verification, image optimization, drop reasons, and canonical content-block normalization
> Ownership key: media-validation-and-normalization

---

## 1. Boundary

`src/core/media/` owns the attachment pipeline between [Channel](channels.md) input and Runtime queue admission. It validates ordered inbound text/image blocks and returns canonical `ChatContentBlock[]` plus structured dropped-item reasons.

Channel owns transport and wire shape. Runtime invokes Media, assembles optional dropped-item notice text, broadcasts summaries, and chooses queued or steering delivery. [Prompt](prompt.md) owns Context Hook placement. [Model Resolution](model-resolution.md) validates the resulting requested media kinds. Provider adapters own SDK/wire conversion.

## 2. Inbound pipeline

```text
string | InboundContentBlock[]
             |
             v
processInboundMessage(...)
├── text blocks pass through in order
├── image-count and decoded-byte budgets
├── MIME allowlist and header sniffing
├── optional image optimization
└── normalized blocks + dropped[]
```

A string is returned unchanged. Array input remains a canonical block array even if it contains only text. Rejection of one image does not fail the whole message: accepted blocks keep relative order, and each rejected image records its original block index.

Image count ignores text blocks. The aggregate budget is charged after base64 decode and the per-item check, before MIME/metadata validation and optimization. Node base64 decoding may tolerate invalid characters; unreadable decoded bytes are rejected by metadata sniffing rather than accepted as an image.

## 3. Limits and supported formats

| Constraint | Current value |
|---|---:|
| Supported image MIME | PNG, JPEG, WebP, GIF |
| Maximum images per message | 20 |
| Maximum decoded bytes per attachment | 10 MiB |
| Maximum decoded image bytes charged per message | 10 MiB |
| Optimization threshold and target | 2 MiB |
| WebSocket frame ceiling | 15 MiB |

Declared MIME must match the sniffed header. The header parser extracts dimensions for PNG, baseline/progressive JPEG, WebP VP8/VP8L/VP8X, and GIF87a/GIF89a. JPEG EXIF orientations 5–8 swap displayed width/height. Unsupported WebP variants and malformed metadata are treated as unreadable by the attachment pipeline.

## 4. Image normalization and optimization

`processImageAttachment()` applies the MIME allowlist, verifies bytes, and attaches verified dimensions. A small accepted image preserves its verified MIME and bytes as canonical base64.

Images larger than 2 MiB are passed to Sharp. The optimizer:

1. applies EXIF rotation;
2. proportionally constrains the longest side to at most 2000 pixels;
3. flattens transparency over white;
4. emits JPEG using quality steps 85, 75, 65, 55, then 45;
5. accepts the first output at or below the 2 MiB target.

If decoding/encoding fails or no quality step fits, the image is dropped as `resize_failed`. Successful optimization reports before/after bytes, applied maximum side, and quality for diagnostics; those details are not Channel events.

## 5. Drop results

The pipeline exposes neutral Core reasons:

| Reason | Meaning |
|---|---|
| `unsupported_mime` | declared type is outside the allowlist |
| `mime_mismatch` | detected image type differs from the declaration |
| `metadata_unreadable` | image metadata cannot be established |
| `too_large` | one decoded attachment exceeds 10 MiB |
| `resize_failed` | optimization cannot produce an accepted image |
| `limit_exceeded` | image count exceeds 20 |
| `total_exceeded` | the next decoded image would exceed the 10 MiB message budget |

Media does not own user-visible wording. Runtime currently appends one aggregate notice when drops occurred and otherwise skips a degenerate message with no meaningful text or accepted attachment.

## 6. Downstream use

Runtime normalization precedes `user_message` broadcast and queued/steering classification. Broadcast exposes only attachment summaries—type, MIME, byte count, and optional dimensions—never base64. Pure-attachment steering is visible to Channel clients but is not injected into the text-only steering inbox. Runner requirements derive the `image` media kind from normalized content before Model Resolution.

## 7. Evidence

| Kind | Evidence |
|---|---|
| Source | [Attachment pipeline](../../src/core/media/attachment-pipeline.ts), [Media constants](../../src/core/media/constants.ts), [Image metadata](../../src/core/media/image-metadata.ts), [Image optimizer](../../src/core/media/image-optimize.ts), [Runtime intake](../../src/runtime/RuntimeApp.ts), [WebSocket Channel](../../src/builtins/channels/websocket/WebSocketChannel.ts) |
| Tests | [Attachment pipeline tests](../../src/core/media/attachment-pipeline.test.ts), [Image metadata tests](../../src/core/media/image-metadata.test.ts), [Image optimizer tests](../../src/core/media/image-optimize.test.ts), [Runtime intake tests](../../src/runtime/RuntimeApp.intake.test.ts), [WebSocket Channel tests](../../src/builtins/channels/websocket/WebSocketChannel.test.ts) |
| Controlling authority | [Attachments Support Specification](../specifications/attachments-support.md), [Runner Turn Flow Specification](../specifications/runner-turn-flow.md), [Model Resolution Specification](../specifications/model-resolution.md) |
