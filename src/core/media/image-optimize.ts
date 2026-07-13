/**
 * Two-step image optimizer (sharp).
 *
 *   Step A — geometry: if max(w,h) > MAX_SIDE_PX, scale uniformly so the long side == MAX_SIDE_PX.
 *            Apply EXIF orientation via `.rotate()`, then flatten RGBA over white before JPEG encode.
 *   Step B — bytes: try JPEG_QUALITY_STEPS in order; first encode that fits `targetBytes` wins.
 *
 * Output is ALWAYS JPEG (decision 4: quality downgrade trades JSONL size for nothing the model cares about).
 * Returns a discriminated union — never throws on sharp errors.
 */

import sharp from 'sharp';
import type { ImageMetadata } from './image-metadata.js';

// ── Tunables (module-internal; no config surface) ────────────────────────────

const MAX_SIDE_PX = 2000;
const JPEG_QUALITY_STEPS = [85, 75, 65, 55, 45] as const;
const FLATTEN_BACKGROUND = '#ffffff';

// ── Types ────────────────────────────────────────────────────────────────────

export type OptimizeResult =
  | {
      ok: true;
      bytes: Uint8Array;
      metadata: ImageMetadata; // mediaType === 'image/jpeg' always
      appliedQuality: number;
      appliedMaxSide: number;
    }
  | { ok: false; reason: 'sharp_failed' | 'cannot_fit_budget'; detail: string };

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Resize + recompress until the output fits `targetBytes`.
 * Cheap fast-paths first; only invokes JPEG quality stepping when necessary.
 */
export async function optimizeImage(
  input: Uint8Array,
  targetBytes: number,
): Promise<OptimizeResult> {
  // Step A: probe + (conditional) downscale to MAX_SIDE_PX.
  let pipelineFactory: () => sharp.Sharp;
  let probedWidth: number;
  let probedHeight: number;
  let appliedMaxSide: number;

  try {
    const probe = sharp(input).rotate();
    const meta = await probe.metadata();
    if (!meta.width || !meta.height) {
      return { ok: false, reason: 'sharp_failed', detail: 'metadata missing width/height' };
    }
    probedWidth = meta.width;
    probedHeight = meta.height;
    const maxSide = Math.max(probedWidth, probedHeight);
    appliedMaxSide = Math.min(maxSide, MAX_SIDE_PX);

    pipelineFactory = () => {
      let p = sharp(input).rotate();
      if (maxSide > MAX_SIDE_PX) {
        p = p.resize({ width: MAX_SIDE_PX, height: MAX_SIDE_PX, fit: 'inside', withoutEnlargement: true });
      }
      return p.flatten({ background: FLATTEN_BACKGROUND });
    };
  } catch (err) {
    return { ok: false, reason: 'sharp_failed', detail: String(err) };
  }

  // Step B: walk quality ladder.
  let lastEncodedSize = -1;
  for (const quality of JPEG_QUALITY_STEPS) {
    let encoded: Buffer;
    try {
      encoded = await pipelineFactory()
        .jpeg({ quality, mozjpeg: true, chromaSubsampling: '4:2:0' })
        .toBuffer();
    } catch (err) {
      return { ok: false, reason: 'sharp_failed', detail: String(err) };
    }
    lastEncodedSize = encoded.byteLength;
    if (encoded.byteLength <= targetBytes) {
      // Re-probe final dimensions: downscale may have rounded by 1 px on odd inputs.
      const ratio = appliedMaxSide / Math.max(probedWidth, probedHeight);
      const finalW = Math.max(1, Math.round(probedWidth * Math.min(ratio, 1)));
      const finalH = Math.max(1, Math.round(probedHeight * Math.min(ratio, 1)));
      return {
        ok: true,
        bytes: new Uint8Array(encoded.buffer, encoded.byteOffset, encoded.byteLength),
        metadata: { width: finalW, height: finalH, mediaType: 'image/jpeg' },
        appliedQuality: quality,
        appliedMaxSide,
      };
    }
  }

  return {
    ok: false,
    reason: 'cannot_fit_budget',
    detail: `lowest quality still ${lastEncodedSize} bytes > target ${targetBytes}`,
  };
}
