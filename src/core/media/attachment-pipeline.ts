/**
 * 附件管线（单附件 + 整条消息，纯函数）。
 *
 * - `processImageAttachment`：MIME 白名单 → sniff → 必要时 resize → 构造带 dimensions 的 ImageBlock。
 *   失败返回中性 `reason`（不耦合 channel / runtime）。
 * - `processInboundMessage`：纯文本直通；数组逐 block 处理；附件数量、单文件 / 总量字节上限在此层判定。
 *   **永不整体失败**——失败 / 超限的 block 进 `dropped[]`，其余进 `normalized`。
 *
 * 决策 8：失败即丢弃 + 由调用方装配文本占位。
 */

import type { ChatContentBlock } from '../model-invocation/index.js';
import type { InboundContentBlock } from '../channel/index.js';
import {
  SUPPORTED_IMAGE_MIME,
  ATTACHMENT_INLINE_THRESHOLD_BYTES,
  ATTACHMENT_RAW_MAX_BYTES,
  ATTACHMENT_TOTAL_MAX_BYTES,
  MAX_ATTACHMENTS_PER_MESSAGE,
  type SupportedImageMime,
} from './constants.js';
import { sniffImage } from './image-metadata.js';
import { optimizeImage } from './image-optimize.js';

// ── 类型 ────────────────────────────────────────────────────

/** 单附件级失败原因（中性词汇，不耦合 runtime / channel） */
export type AttachmentDropReason =
  | 'unsupported_mime'
  | 'mime_mismatch'
  | 'metadata_unreadable'
  | 'too_large'
  | 'resize_failed';

/** 整条消息级丢弃记录（含 processInboundMessage 内判定的额外原因） */
export interface DroppedAttachment {
  blockIndex: number;
  reason: AttachmentDropReason | 'limit_exceeded' | 'total_exceeded';
}

/** resize 已发生时的附加信息（仅供 verbose 日志，不发事件） */
export interface AttachmentResizedInfo {
  fromBytes: number;
  toBytes: number;
  finalMaxSide: number;
  finalQuality: number;
}

export type AttachmentResult =
  | { ok: true; block: ChatContentBlock; resized?: AttachmentResizedInfo }
  | { ok: false; reason: AttachmentDropReason };

export interface ProcessInboundResult {
  normalized: string | ChatContentBlock[];
  dropped: DroppedAttachment[];
}

// ── 单附件 ──────────────────────────────────────────────────

export async function processImageAttachment(
  rawBytes: Uint8Array,
  declaredMime: string,
): Promise<AttachmentResult> {
  if (!SUPPORTED_IMAGE_MIME.includes(declaredMime as SupportedImageMime)) {
    return { ok: false, reason: 'unsupported_mime' };
  }

  const sniff = sniffImage(rawBytes, declaredMime);
  if (!sniff.ok) {
    return {
      ok: false,
      reason: sniff.reason === 'mime_mismatch' ? 'mime_mismatch' : 'metadata_unreadable',
    };
  }

  let finalBytes: Uint8Array = rawBytes;
  let finalMeta = sniff.metadata;
  let resized: AttachmentResizedInfo | undefined;

  if (rawBytes.byteLength > ATTACHMENT_INLINE_THRESHOLD_BYTES) {
    const opt = await optimizeImage(rawBytes, ATTACHMENT_INLINE_THRESHOLD_BYTES);
    if (!opt.ok) return { ok: false, reason: 'resize_failed' };
    finalBytes = opt.bytes;
    finalMeta = opt.metadata;
    resized = {
      fromBytes: rawBytes.byteLength,
      toBytes: opt.bytes.byteLength,
      finalMaxSide: opt.appliedMaxSide,
      finalQuality: opt.appliedQuality,
    };
  }

  return {
    ok: true,
    block: {
      type: 'image',
      source: {
        type: 'base64',
        media_type: finalMeta.mediaType,
        data: Buffer.from(finalBytes).toString('base64'),
      },
      dimensions: { width: finalMeta.width, height: finalMeta.height },
    },
    ...(resized ? { resized } : {}),
  };
}

// ── 整条消息 ────────────────────────────────────────────────

export async function processInboundMessage(
  message: string | InboundContentBlock[],
): Promise<ProcessInboundResult> {
  if (typeof message === 'string') return { normalized: message, dropped: [] };

  const out: ChatContentBlock[] = [];
  const dropped: DroppedAttachment[] = [];
  let totalBytes = 0;
  let imageCount = 0;

  for (let i = 0; i < message.length; i++) {
    const b = message[i]!;
    if (b.type === 'text') {
      out.push(b);
      continue;
    }

    // limit_exceeded 按 image 数量判定，避免 text block 挤占名额
    if (imageCount >= MAX_ATTACHMENTS_PER_MESSAGE) {
      dropped.push({ blockIndex: i, reason: 'limit_exceeded' });
      continue;
    }
    imageCount++;

    // Buffer.from(str, 'base64') 不抛——非法字符静默丢弃，能解多少解多少；
    // 非法 base64 会在下游 sniffImage 处判 unreadable → metadata_unreadable
    const raw = Buffer.from(b.source.data, 'base64');

    if (raw.byteLength > ATTACHMENT_RAW_MAX_BYTES) {
      dropped.push({ blockIndex: i, reason: 'too_large' });
      continue;
    }
    if (totalBytes + raw.byteLength > ATTACHMENT_TOTAL_MAX_BYTES) {
      dropped.push({ blockIndex: i, reason: 'total_exceeded' });
      continue;
    }
    totalBytes += raw.byteLength;

    const r = await processImageAttachment(raw, b.source.media_type);
    if (!r.ok) {
      dropped.push({ blockIndex: i, reason: r.reason });
      continue;
    }
    out.push(r.block);
  }

  return { normalized: out, dropped };
}
