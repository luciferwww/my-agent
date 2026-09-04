import { describe, it, expect } from 'vitest';
import sharp from 'sharp';
import { randomBytes } from 'node:crypto';
import {
  processImageAttachment,
  processInboundMessage,
} from './attachment-pipeline.js';
import type { InboundContentBlock } from '../../adapters/channel/types.js';
import type { ChatContentBlock } from '../model-invocation/index.js';

// ── Builders ────────────────────────────────────────────────────────────────

function buildMinimalPng(width: number, height: number): Uint8Array {
  const out = new Uint8Array(33);
  out.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  out[8] = 0; out[9] = 0; out[10] = 0; out[11] = 13;
  out.set([0x49, 0x48, 0x44, 0x52], 12);
  out[16] = (width >>> 24) & 0xff;
  out[17] = (width >>> 16) & 0xff;
  out[18] = (width >>> 8) & 0xff;
  out[19] = width & 0xff;
  out[20] = (height >>> 24) & 0xff;
  out[21] = (height >>> 16) & 0xff;
  out[22] = (height >>> 8) & 0xff;
  out[23] = height & 0xff;
  out[24] = 8; out[25] = 2; out[26] = 0; out[27] = 0; out[28] = 0;
  return out;
}

/** PNG header (sniff-valid) padded with zeros to a target size; sharp will reject it. */
function buildFakeLargePng(targetBytes: number): Uint8Array {
  const out = new Uint8Array(targetBytes);
  out.set(buildMinimalPng(100, 100), 0);
  return out;
}

async function makeNoisePng(width: number, height: number): Promise<Uint8Array> {
  const channels = 3;
  const raw = randomBytes(width * height * channels);
  const buf = await sharp(raw, { raw: { width, height, channels } }).png().toBuffer();
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}

function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}

// ── processImageAttachment ──────────────────────────────────────────────────

describe('processImageAttachment', () => {
  it('accepts a small valid PNG without resizing', async () => {
    const png = buildMinimalPng(400, 300);
    const r = await processImageAttachment(png, 'image/png');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.block.type).toBe('image');
      expect(r.resized).toBeUndefined();
      const img = r.block as Extract<ChatContentBlock, { type: 'image' }>;
      expect(img.source.media_type).toBe('image/png');
      expect(img.dimensions).toEqual({ width: 400, height: 300 });
    }
  });

  it('resizes oversized images and outputs JPEG', async () => {
    // 1500×1500 noise PNG ≈ 2.5–3 MB, comfortably above the 2 MB inline threshold.
    const png = await makeNoisePng(1500, 1500);
    expect(png.byteLength).toBeGreaterThan(2 * 1024 * 1024);
    const r = await processImageAttachment(png, 'image/png');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.resized).toBeDefined();
      const img = r.block as Extract<ChatContentBlock, { type: 'image' }>;
      expect(img.source.media_type).toBe('image/jpeg');
      expect(img.dimensions.width).toBeGreaterThan(0);
      expect(img.dimensions.height).toBeGreaterThan(0);
    }
  });

  it('rejects unsupported MIME', async () => {
    const r = await processImageAttachment(buildMinimalPng(10, 10), 'image/bmp');
    expect(r).toEqual({ ok: false, reason: 'unsupported_mime' });
  });

  it('reports mime_mismatch when header does not match declared MIME', async () => {
    const png = buildMinimalPng(10, 10);
    const r = await processImageAttachment(png, 'image/jpeg');
    expect(r).toEqual({ ok: false, reason: 'mime_mismatch' });
  });

  it('reports metadata_unreadable for garbage bytes', async () => {
    const r = await processImageAttachment(new Uint8Array([1, 2, 3, 4, 5]), 'image/png');
    expect(r).toEqual({ ok: false, reason: 'metadata_unreadable' });
  });

  it('reports resize_failed when sharp cannot decode an oversized blob', async () => {
    // Valid PNG header so sniff succeeds, but body is zeros — sharp will fail to decode.
    const fake = buildFakeLargePng(3 * 1024 * 1024);
    const r = await processImageAttachment(fake, 'image/png');
    expect(r).toEqual({ ok: false, reason: 'resize_failed' });
  });
});

// ── processInboundMessage ───────────────────────────────────────────────────

describe('processInboundMessage', () => {
  it('passes plain text strings through unchanged', async () => {
    const r = await processInboundMessage('hello world');
    expect(r).toEqual({ normalized: 'hello world', dropped: [] });
  });

  it('returns an array (not a string) when input is an all-text array', async () => {
    const r = await processInboundMessage([{ type: 'text', text: 'a' }]);
    expect(Array.isArray(r.normalized)).toBe(true);
    expect(r.dropped).toEqual([]);
  });

  it('keeps text and records a single bad image without wholesale failure', async () => {
    const msg: InboundContentBlock[] = [
      { type: 'text', text: 'see this' },
      // BMP declared — unsupported MIME, will land in dropped[]
      {
        type: 'image',
        source: { type: 'base64', media_type: 'image/png', data: toBase64(new Uint8Array([1, 2, 3])) },
      },
    ];
    // Force unsupported MIME by post-mutating (channel-side wire type is constrained).
    (msg[1] as { source: { media_type: string } }).source.media_type = 'image/bmp';
    const r = await processInboundMessage(msg);
    expect(Array.isArray(r.normalized)).toBe(true);
    const arr = r.normalized as ChatContentBlock[];
    expect(arr).toHaveLength(1);
    expect(arr[0]!.type).toBe('text');
    expect(r.dropped).toEqual([{ blockIndex: 1, reason: 'unsupported_mime' }]);
  });

  it('drops the 21st image with limit_exceeded; counts images not array index', async () => {
    const blocks: InboundContentBlock[] = [];
    // 2 leading text blocks must not consume image slots
    blocks.push({ type: 'text', text: 'a' });
    blocks.push({ type: 'text', text: 'b' });
    for (let i = 0; i < 21; i++) {
      blocks.push({
        type: 'image',
        source: {
          type: 'base64',
          media_type: 'image/png',
          data: toBase64(buildMinimalPng(10 + i, 10 + i)),
        },
      });
    }
    const r = await processInboundMessage(blocks);
    const arr = r.normalized as ChatContentBlock[];
    expect(arr).toHaveLength(22); // 2 text + 20 images
    expect(r.dropped).toEqual([{ blockIndex: blocks.length - 1, reason: 'limit_exceeded' }]);
  });

  it('drops a single attachment whose raw decode exceeds 10 MB', async () => {
    // Build 11 MB of zero bytes → base64 encode
    const big = new Uint8Array(11 * 1024 * 1024);
    big.set(buildMinimalPng(10, 10), 0);
    const msg: InboundContentBlock[] = [
      {
        type: 'image',
        source: { type: 'base64', media_type: 'image/png', data: toBase64(big) },
      },
    ];
    const r = await processInboundMessage(msg);
    expect(r.normalized).toEqual([]);
    expect(r.dropped).toEqual([{ blockIndex: 0, reason: 'too_large' }]);
  });

  it('drops blocks that push cumulative bytes over the total budget', async () => {
    // 6 blocks × ~1.9 MB. All sniff-valid (header), all under inline threshold so
    // optimizeImage is NEVER invoked. After 5 blocks totalBytes ≈ 9.5 MB; 6th tips over 10 MB.
    const SIZE = Math.floor(1.9 * 1024 * 1024);
    const blocks: InboundContentBlock[] = [];
    for (let i = 0; i < 6; i++) {
      blocks.push({
        type: 'image',
        source: {
          type: 'base64',
          media_type: 'image/png',
          data: toBase64(buildFakeLargePng(SIZE)),
        },
      });
    }
    const r = await processInboundMessage(blocks);
    const arr = r.normalized as ChatContentBlock[];
    expect(arr).toHaveLength(5);
    expect(r.dropped).toEqual([{ blockIndex: 5, reason: 'total_exceeded' }]);
  });
});
