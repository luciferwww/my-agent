import { describe, it, expect } from 'vitest';
import { sniffImage } from './image-metadata.js';

// ── Builders for minimal valid images (headers only — sniffer never reads pixels) ────────

function buildPng(width: number, height: number): Uint8Array {
  const out = new Uint8Array(33);
  // 8-byte signature
  out.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  // IHDR length = 13 (BE)
  out[8] = 0; out[9] = 0; out[10] = 0; out[11] = 13;
  // 'IHDR'
  out.set([0x49, 0x48, 0x44, 0x52], 12);
  // width BE
  out[16] = (width >>> 24) & 0xff;
  out[17] = (width >>> 16) & 0xff;
  out[18] = (width >>> 8) & 0xff;
  out[19] = width & 0xff;
  // height BE
  out[20] = (height >>> 24) & 0xff;
  out[21] = (height >>> 16) & 0xff;
  out[22] = (height >>> 8) & 0xff;
  out[23] = height & 0xff;
  // bit_depth=8, color_type=2, compression=0, filter=0, interlace=0
  out[24] = 8; out[25] = 2; out[26] = 0; out[27] = 0; out[28] = 0;
  // CRC placeholder (sniffer doesn't validate)
  return out;
}

function buildJpeg(width: number, height: number, orientation?: number): Uint8Array {
  const segments: number[] = [];
  // SOI
  segments.push(0xff, 0xd8);
  if (orientation !== undefined) {
    // APP1 segment with EXIF orientation
    // Layout: FFE1 + segLen(2 BE) + "Exif\0\0" + TIFF header (II 2A 00 + IFD0 offset 08 00 00 00)
    //   + numEntries(2 LE) + 1 entry (Orientation tag 0x0112 SHORT count=1 value=orientation in low bytes)
    //   + next IFD offset (4 = 0)
    const exif: number[] = [];
    exif.push(0x45, 0x78, 0x69, 0x66, 0x00, 0x00); // "Exif\0\0"
    exif.push(0x49, 0x49, 0x2a, 0x00);             // little-endian TIFF
    exif.push(0x08, 0x00, 0x00, 0x00);             // IFD0 offset = 8
    exif.push(0x01, 0x00);                          // numEntries = 1 (LE)
    // Entry: tag=0x0112, type=3 (SHORT), count=1, value=orientation (low 2 bytes of value field, LE)
    exif.push(0x12, 0x01);                          // tag 0x0112 LE
    exif.push(0x03, 0x00);                          // type 3 LE
    exif.push(0x01, 0x00, 0x00, 0x00);              // count 1 LE
    exif.push(orientation & 0xff, 0x00, 0x00, 0x00); // value LE
    exif.push(0x00, 0x00, 0x00, 0x00);              // next IFD = 0
    const segLen = exif.length + 2;
    segments.push(0xff, 0xe1, (segLen >> 8) & 0xff, segLen & 0xff, ...exif);
  }
  // SOF0: FFC0 + segLen(8) + precision(8) + height(2 BE) + width(2 BE) + components(1)
  segments.push(0xff, 0xc0);
  segments.push(0x00, 0x08); // segLen = 8
  segments.push(0x08);       // precision
  segments.push((height >> 8) & 0xff, height & 0xff);
  segments.push((width >> 8) & 0xff, width & 0xff);
  segments.push(0x01);       // 1 component (header only — no actual scan data needed for sniff)
  // EOI
  segments.push(0xff, 0xd9);
  return new Uint8Array(segments);
}

function buildWebpVp8x(width: number, height: number): Uint8Array {
  // RIFF + size + WEBP + VP8X + chunk size(4 LE) + flags(1) + reserved(3) + (w-1)(3 LE) + (h-1)(3 LE)
  const out = new Uint8Array(30);
  out.set([0x52, 0x49, 0x46, 0x46], 0); // RIFF
  // file size — sniffer doesn't validate
  out[4] = 22; out[5] = 0; out[6] = 0; out[7] = 0;
  out.set([0x57, 0x45, 0x42, 0x50], 8);  // WEBP
  out.set([0x56, 0x50, 0x38, 0x58], 12); // VP8X
  out[16] = 10; out[17] = 0; out[18] = 0; out[19] = 0; // chunk size = 10
  out[20] = 0; // flags
  out[21] = 0; out[22] = 0; out[23] = 0; // reserved
  const w1 = width - 1;
  const h1 = height - 1;
  out[24] = w1 & 0xff;
  out[25] = (w1 >> 8) & 0xff;
  out[26] = (w1 >> 16) & 0xff;
  out[27] = h1 & 0xff;
  out[28] = (h1 >> 8) & 0xff;
  out[29] = (h1 >> 16) & 0xff;
  return out;
}

function buildGif(width: number, height: number, variant: '87a' | '89a' = '89a'): Uint8Array {
  const out = new Uint8Array(13);
  out.set([0x47, 0x49, 0x46, 0x38, variant === '89a' ? 0x39 : 0x37, 0x61], 0);
  out[6] = width & 0xff;
  out[7] = (width >> 8) & 0xff;
  out[8] = height & 0xff;
  out[9] = (height >> 8) & 0xff;
  out[10] = 0; out[11] = 0; out[12] = 0; // packed, bg index, aspect
  return out;
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('sniffImage', () => {
  describe('positive cases', () => {
    it('parses PNG width/height', () => {
      const r = sniffImage(buildPng(320, 240), 'image/png');
      expect(r).toEqual({ ok: true, metadata: { width: 320, height: 240, mediaType: 'image/png' } });
    });

    it('parses JPEG width/height (no EXIF)', () => {
      const r = sniffImage(buildJpeg(640, 480), 'image/jpeg');
      expect(r).toEqual({ ok: true, metadata: { width: 640, height: 480, mediaType: 'image/jpeg' } });
    });

    it('parses WebP (VP8X) width/height', () => {
      const r = sniffImage(buildWebpVp8x(800, 600), 'image/webp');
      expect(r).toEqual({ ok: true, metadata: { width: 800, height: 600, mediaType: 'image/webp' } });
    });

    it('parses GIF89a width/height', () => {
      const r = sniffImage(buildGif(120, 90, '89a'), 'image/gif');
      expect(r).toEqual({ ok: true, metadata: { width: 120, height: 90, mediaType: 'image/gif' } });
    });

    it('parses GIF87a width/height', () => {
      const r = sniffImage(buildGif(60, 40, '87a'), 'image/gif');
      expect(r).toEqual({ ok: true, metadata: { width: 60, height: 40, mediaType: 'image/gif' } });
    });
  });

  describe('EXIF orientation', () => {
    it('swaps w/h for orientation 6 (portrait taken in landscape sensor)', () => {
      // Stored as 480 wide × 640 tall; orientation 6 says "rotate 90 CW", so display is 640×480.
      // Per spec: orientations 5/6/7/8 swap w/h.
      const r = sniffImage(buildJpeg(480, 640, 6), 'image/jpeg');
      expect(r).toEqual({ ok: true, metadata: { width: 640, height: 480, mediaType: 'image/jpeg' } });
    });

    it('does NOT swap w/h for orientation 1', () => {
      const r = sniffImage(buildJpeg(480, 640, 1), 'image/jpeg');
      expect(r).toEqual({ ok: true, metadata: { width: 480, height: 640, mediaType: 'image/jpeg' } });
    });

    it('swaps for orientations 5, 7, 8 as well', () => {
      for (const o of [5, 7, 8]) {
        const r = sniffImage(buildJpeg(100, 200, o), 'image/jpeg');
        expect(r.ok).toBe(true);
        if (r.ok) expect(r.metadata).toEqual({ width: 200, height: 100, mediaType: 'image/jpeg' });
      }
    });
  });

  describe('negative cases', () => {
    it('returns mime_mismatch when bytes are PNG but declared JPEG', () => {
      const r = sniffImage(buildPng(10, 10), 'image/jpeg');
      expect(r).toEqual({ ok: false, reason: 'mime_mismatch' });
    });

    it('returns mime_mismatch when declared MIME is unsupported (image/bmp)', () => {
      const r = sniffImage(buildPng(10, 10), 'image/bmp');
      expect(r).toEqual({ ok: false, reason: 'mime_mismatch' });
    });

    it('returns unreadable for truncated 8-byte input', () => {
      const r = sniffImage(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), 'image/png');
      expect(r).toEqual({ ok: false, reason: 'unreadable' });
    });

    it('returns unreadable when no magic matches the bytes', () => {
      const r = sniffImage(new Uint8Array([0x00, 0x00, 0x00, 0x00, 0x00, 0x00]), 'image/png');
      expect(r).toEqual({ ok: false, reason: 'unreadable' });
    });

    it('returns unsupported_variant for unknown WebP chunk', () => {
      const out = buildWebpVp8x(10, 10);
      // Corrupt VP8X tag to VP8? (unknown)
      out[12] = 0x56; out[13] = 0x50; out[14] = 0x38; out[15] = 0x3f;
      const r = sniffImage(out, 'image/webp');
      expect(r).toEqual({ ok: false, reason: 'unsupported_variant' });
    });
  });
});
