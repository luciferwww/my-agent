/**
 * Attachment / media pipeline constants.
 *
 * Single source of truth for size limits, MIME allowlist, and pipeline defaults.
 * Imported by media/* modules, WebSocketChannel (maxPayload), and RuntimeApp
 * (drop-notice toggle).
 */

/** Inline-vs-host threshold. Blocks larger than this MAY be hosted off-band in future. */
export const ATTACHMENT_INLINE_THRESHOLD_BYTES = 2 * 1024 * 1024;

/** Hard per-attachment cap on raw inbound bytes (post-base64-decode). */
export const ATTACHMENT_RAW_MAX_BYTES = 10 * 1024 * 1024;

/** Hard per-message cap across the sum of all attachment raw bytes. */
export const ATTACHMENT_TOTAL_MAX_BYTES = 10 * 1024 * 1024;

/** Hard cap on attachment count per inbound message. */
export const MAX_ATTACHMENTS_PER_MESSAGE = 20;

/** WebSocket frame ceiling. Slightly larger than ATTACHMENT_TOTAL to absorb JSON/base64 overhead. */
export const WS_MAX_PAYLOAD_BYTES = 15 * 1024 * 1024;

/** Default for whether dropped-attachment notices are appended to the assistant-visible message. */
export const ATTACHMENT_DROP_NOTICE_DEFAULT = true;

/** Allowlist of inbound image MIME types. */
export const SUPPORTED_IMAGE_MIME = [
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
] as const;

export type SupportedImageMime = (typeof SUPPORTED_IMAGE_MIME)[number];
