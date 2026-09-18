# Media

> Status: Current Authority
> Authority: Current implemented media behavior
> Verified: 2026-09-18
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

`constants.ts` centralizes supported PNG/JPEG/WebP/GIF types and count, decoded-byte, optimization, and frame limits. `image-metadata.ts` verifies the declared type against sniffed bytes and extracts displayed dimensions. [Attachments Support](../specifications/attachments-support.md) owns exact limits and acceptance semantics.

## 4. Image normalization and optimization

`processImageAttachment()` applies the allowlist, verifies bytes, and attaches dimensions. Oversized accepted images pass through the Sharp-backed optimizer for EXIF rotation, bounded resizing, transparency flattening, and JPEG quality reduction; failure returns a structured drop rather than throwing the whole message.

## 5. Drop results

The pipeline returns neutral Core drop reasons for unsupported/mismatched/unreadable media, size/count/aggregate limits, and failed optimization. Media does not own user-visible wording; Runtime assembles the aggregate notice.

## 6. Downstream use

Runtime normalizes before broadcast and routing, exposes summary metadata rather than base64, and derives the `image` requirement before Model Resolution. Steering and persistence behavior belongs to the [Attachments Support Specification](../specifications/attachments-support.md).

## 7. Evidence

| Kind | Evidence |
|---|---|
| Source | [Attachment pipeline](../../src/core/media/attachment-pipeline.ts), [Runtime intake](../../src/runtime/RuntimeApp.ts) |
| Tests | [Attachment pipeline tests](../../src/core/media/attachment-pipeline.test.ts), [Runtime intake tests](../../src/runtime/RuntimeApp.intake.test.ts) |
| Controlling authority | [Attachments Support Specification](../specifications/attachments-support.md), [Model Resolution Specification](../specifications/model-resolution.md) |
