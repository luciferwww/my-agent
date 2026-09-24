/**
 * 附件管线（单附件 + 整条消息，纯函数）。
 *
 * - `processImageAttachment`：MIME 白名单 → sniff → 必要时 resize → 构造带 dimensions 的 ImageBlock。
 *   失败返回中性 `reason`（不耦合 channel / runtime）。
 * - `processInboundMessage`：纯文本直通；数组逐 block 处理；附件数量、单文件 / 总量字节上限在此层判定。
 *   附件与文本原子处理：任一附件失败时不返回任何可入队内容。
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
    if (!opt.ok) {
      return {
        ok: false,
        reason: opt.reason === 'cannot_fit_budget' ? 'too_large' : 'resize_failed',
      };
    }
    if (opt.bytes.byteLength > ATTACHMENT_INLINE_THRESHOLD_BYTES) {
      return { ok: false, reason: 'too_large' };
    }
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
  const attachments: Array<{
    blockIndex: number;
    block: Extract<InboundContentBlock, { type: 'image' }>;
    raw: Uint8Array;
  }> = [];
  let totalBytes = 0;
  let imageCount = 0;

  for (let i = 0; i < message.length; i++) {
    const b = message[i]!;
    if (b.type === 'text') {
      continue;
    }

    if (imageCount >= MAX_ATTACHMENTS_PER_MESSAGE) {
      dropped.push({ blockIndex: i, reason: 'limit_exceeded' });
      continue;
    }
    imageCount++;

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
    attachments.push({ blockIndex: i, block: b, raw });
  }

  if (dropped.length > 0) return { normalized: [], dropped };

  const normalizedImages = new Map<number, ChatContentBlock>();
  for (const attachment of attachments) {
    const r = await processImageAttachment(
      attachment.raw,
      attachment.block.source.mediaType,
    );
    if (!r.ok) {
      dropped.push({ blockIndex: attachment.blockIndex, reason: r.reason });
      continue;
    }
    normalizedImages.set(attachment.blockIndex, r.block);
  }

  if (dropped.length > 0) return { normalized: [], dropped };

  for (let i = 0; i < message.length; i++) {
    const block = message[i]!;
    out.push(block.type === 'text' ? block : normalizedImages.get(i)!);
  }
  return { normalized: out, dropped };
}
