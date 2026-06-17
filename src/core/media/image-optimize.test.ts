import { describe, it, expect } from 'vitest';
import sharp from 'sharp';
import { optimizeImage } from './image-optimize.js';

// ── Helpers: build real images via sharp so the optimizer has something to decode ────

async function makeSolidPng(width: number, height: number, color = { r: 200, g: 100, b: 50 }): Promise<Uint8Array> {
  const buf = await sharp({
    create: { width, height, channels: 3, background: color },
  }).png().toBuffer();
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}

async function makeSemiTransparentPng(width: number, height: number): Promise<Uint8Array> {
  // Top half: opaque red; bottom half: fully transparent.
  const top = await sharp({
    create: { width, height: Math.floor(height / 2), channels: 4, background: { r: 220, g: 30, b: 30, alpha: 1 } },
  }).png().toBuffer();
  const bottom = await sharp({
    create: { width, height: height - Math.floor(height / 2), channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
  }).png().toBuffer();
  const buf = await sharp({
    create: { width, height, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
  })
    .composite([
      { input: top, top: 0, left: 0 },
      { input: bottom, top: Math.floor(height / 2), left: 0 },
    ])
    .png()
    .toBuffer();
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}

async function makeNoisePng(width: number, height: number): Promise<Uint8Array> {
  // High-entropy image: per-pixel pseudo-random RGB. Tiny resolution keeps the test fast.
  const channels = 3;
  const raw = Buffer.alloc(width * height * channels);
  let seed = 0xc0ffee;
  for (let i = 0; i < raw.length; i++) {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    raw[i] = seed & 0xff;
  }
  const buf = await sharp(raw, { raw: { width, height, channels } }).png().toBuffer();
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('optimizeImage', () => {
  it('passes through a small solid PNG at q=85', async () => {
    const input = await makeSolidPng(400, 300);
    const r = await optimizeImage(input, 2 * 1024 * 1024);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.appliedQuality).toBe(85);
      expect(r.metadata.mediaType).toBe('image/jpeg');
      expect(r.metadata.width).toBe(400);
      expect(r.metadata.height).toBe(300);
      expect(r.bytes.byteLength).toBeLessThanOrEqual(2 * 1024 * 1024);
    }
  });

  it('downscales when max side exceeds 2000px', async () => {
    const input = await makeSolidPng(2400, 1800);
    const r = await optimizeImage(input, 2 * 1024 * 1024);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.appliedMaxSide).toBe(2000);
      expect(r.metadata.width).toBe(2000);
      expect(r.metadata.height).toBe(1500);
    }
  });

  it('falls down the quality ladder when targetBytes is tight', async () => {
    const input = await makeNoisePng(1500, 1500);
    // q=85 noise of this size is ~1.4 MB; budget 1.1 MB forces at least one quality drop.
    const target = 1_100_000;
    const r = await optimizeImage(input, target);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.appliedQuality).toBeLessThan(85);
      expect(r.bytes.byteLength).toBeLessThanOrEqual(target);
    }
  });

  it('returns cannot_fit_budget when even q=45 exceeds target', async () => {
    const input = await makeNoisePng(2000, 2000);
    const r = await optimizeImage(input, 1024); // 1 KB — impossible for 2000² noise
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('cannot_fit_budget');
  });

  it('returns sharp_failed for non-image bytes', async () => {
    const r = await optimizeImage(new Uint8Array([0x00, 0x01, 0x02, 0x03, 0x04]), 1024 * 1024);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('sharp_failed');
  });

  it('flattens semi-transparent PNG over white (no black halo)', async () => {
    const input = await makeSemiTransparentPng(200, 200);
    const r = await optimizeImage(input, 2 * 1024 * 1024);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // Sample a pixel in the bottom (originally transparent) region: should be near-white, not near-black.
    const { data, info } = await sharp(Buffer.from(r.bytes)).raw().toBuffer({ resolveWithObject: true });
    const x = Math.floor(info.width / 2);
    const y = Math.floor(info.height * 0.9);
    const idx = (y * info.width + x) * info.channels;
    const [rr, gg, bb] = [data[idx], data[idx + 1], data[idx + 2]];
    // White-background expectation: each channel ≥ 230 (allow some JPEG noise)
    expect(rr).toBeGreaterThanOrEqual(230);
    expect(gg).toBeGreaterThanOrEqual(230);
    expect(bb).toBeGreaterThanOrEqual(230);
  });
});
