/**
 * Header-only image sniffer.
 *
 * Reads the leading bytes of an image to recover its MIME and pixel dimensions
 * without decoding the bitmap. Pure JS, zero deps. Never throws — every failure
 * returns a discriminated `{ ok: false }` variant.
 *
 * Supports: PNG, JPEG (with EXIF orientation 5/6/7/8 → swap w/h), WebP
 * (VP8 / VP8L / VP8X), GIF (87a/89a).
 */

import type { SupportedImageMime } from './constants.js';
import { SUPPORTED_IMAGE_MIME } from './constants.js';

export interface ImageMetadata {
  width: number;
  height: number;
  mediaType: SupportedImageMime;
}

export type SniffResult =
  | { ok: true; metadata: ImageMetadata }
  | { ok: false; reason: 'unreadable' | 'mime_mismatch' | 'unsupported_variant' };

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function bytesEqual(bytes: Uint8Array, offset: number, expected: number[]): boolean {
  if (bytes.length < offset + expected.length) return false;
  for (let i = 0; i < expected.length; i++) {
    if (bytes[offset + i] !== expected[i]) return false;
  }
  return true;
}

function readU16BE(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] << 8) | bytes[offset + 1];
}

function readU16LE(bytes: Uint8Array, offset: number): number {
  return bytes[offset] | (bytes[offset + 1] << 8);
}

function readU32BE(bytes: Uint8Array, offset: number): number {
  return (
    (bytes[offset] * 0x1000000) +
    ((bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3])
  );
}

function readU32LE(bytes: Uint8Array, offset: number): number {
  return (
    bytes[offset] |
    (bytes[offset + 1] << 8) |
    (bytes[offset + 2] << 16) |
    (bytes[offset + 3] * 0x1000000)
  );
}

function sniffWhich(bytes: Uint8Array): SupportedImageMime | null {
  if (bytesEqual(bytes, 0, PNG_MAGIC)) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg';
  }
  // RIFF....WEBP
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
  ) {
    return 'image/webp';
  }
  // GIF87a / GIF89a
  if (
    bytes.length >= 6 &&
    bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 &&
    bytes[3] === 0x38 && (bytes[4] === 0x37 || bytes[4] === 0x39) && bytes[5] === 0x61
  ) {
    return 'image/gif';
  }
  return null;
}

function parsePng(bytes: Uint8Array): SniffResult {
  // After 8-byte signature: chunk length(4 BE) + 'IHDR'(4) + width(4 BE) + height(4 BE)
  if (bytes.length < 24) return { ok: false, reason: 'unreadable' };
  if (bytes[12] !== 0x49 || bytes[13] !== 0x48 || bytes[14] !== 0x44 || bytes[15] !== 0x52) {
    return { ok: false, reason: 'unreadable' };
  }
  const width = readU32BE(bytes, 16);
  const height = readU32BE(bytes, 20);
  if (!width || !height) return { ok: false, reason: 'unreadable' };
  return { ok: true, metadata: { width, height, mediaType: 'image/png' } };
}

interface JpegRaw {
  width: number;
  height: number;
  orientation: number; // 1..8, defaults to 1
}

/** Read EXIF orientation from an APP1 segment payload. Returns 1 if absent / unparseable. */
function readExifOrientation(payload: Uint8Array): number {
  // payload starts after the 2-byte length; APP1 EXIF payload begins with "Exif\0\0"
  if (payload.length < 14) return 1;
  if (
    payload[0] !== 0x45 || payload[1] !== 0x78 || payload[2] !== 0x69 ||
    payload[3] !== 0x66 || payload[4] !== 0x00 || payload[5] !== 0x00
  ) {
    return 1;
  }
  const tiffStart = 6;
  if (tiffStart + 8 > payload.length) return 1;
  const b0 = payload[tiffStart];
  const b1 = payload[tiffStart + 1];
  let little: boolean;
  if (b0 === 0x49 && b1 === 0x49) little = true;
  else if (b0 === 0x4d && b1 === 0x4d) little = false;
  else return 1;

  const read16 = (o: number) => (little ? readU16LE(payload, o) : readU16BE(payload, o));
  const read32 = (o: number) => (little ? readU32LE(payload, o) : readU32BE(payload, o));

  // 0x002A magic, then IFD0 offset (4)
  if (read16(tiffStart + 2) !== 0x002a) return 1;
  const ifd0Offset = read32(tiffStart + 4);
  const ifd0Pos = tiffStart + ifd0Offset;
  if (ifd0Pos + 2 > payload.length) return 1;
  const numEntries = read16(ifd0Pos);
  const entriesStart = ifd0Pos + 2;
  if (entriesStart + numEntries * 12 > payload.length) return 1;
  for (let i = 0; i < numEntries; i++) {
    const entry = entriesStart + i * 12;
    const tag = read16(entry);
    if (tag === 0x0112) {
      // Orientation: SHORT (type=3); value lives in the low 2 bytes of the 4-byte value field
      const value = read16(entry + 8);
      if (value >= 1 && value <= 8) return value;
      return 1;
    }
  }
  return 1;
}

function parseJpegRaw(bytes: Uint8Array): JpegRaw | null {
  // Walk marker segments. Start past SOI (FFD8).
  let i = 2;
  let orientation = 1;
  while (i + 4 <= bytes.length) {
    if (bytes[i] !== 0xff) return null;
    // Skip fill bytes (FF FF ...)
    while (i < bytes.length && bytes[i] === 0xff) i++;
    if (i >= bytes.length) return null;
    const marker = bytes[i];
    i++;
    if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) {
      // Stand-alone markers (SOI/EOI/RSTn) have no payload — they should not appear here
      continue;
    }
    if (i + 2 > bytes.length) return null;
    const segLen = readU16BE(bytes, i);
    if (segLen < 2 || i + segLen > bytes.length) return null;

    if (marker === 0xe1) {
      // APP1 — possible EXIF
      const payload = bytes.subarray(i + 2, i + segLen);
      const o = readExifOrientation(payload);
      if (o !== 1) orientation = o;
    } else if (marker === 0xc0 || marker === 0xc2) {
      // SOF0 / SOF2: length(2) + precision(1) + height(2 BE) + width(2 BE)
      if (segLen < 7) return null;
      const height = readU16BE(bytes, i + 3);
      const width = readU16BE(bytes, i + 5);
      if (!width || !height) return null;
      return { width, height, orientation };
    }
    i += segLen;
  }
  return null;
}

function parseJpeg(bytes: Uint8Array): SniffResult {
  const raw = parseJpegRaw(bytes);
  if (!raw) return { ok: false, reason: 'unreadable' };
  let { width, height } = raw;
  if (raw.orientation >= 5 && raw.orientation <= 8) {
    [width, height] = [height, width];
  }
  return { ok: true, metadata: { width, height, mediaType: 'image/jpeg' } };
}

function parseWebp(bytes: Uint8Array): SniffResult {
  // RIFF(4) + size(4 LE) + 'WEBP'(4) + chunk header 'VP8 ' | 'VP8L' | 'VP8X' + chunk-size(4 LE) + payload
  if (bytes.length < 30) return { ok: false, reason: 'unreadable' };
  const tag = String.fromCharCode(bytes[12], bytes[13], bytes[14], bytes[15]);
  if (tag === 'VP8 ') {
    // Lossy: frame tag is 3 bytes, then 3-byte start code 9D 01 2A, then width(2 LE, 14 bits) + height(2 LE, 14 bits)
    // chunk payload starts at byte 20
    if (bytes.length < 30) return { ok: false, reason: 'unreadable' };
    const start = 20 + 3; // skip frame tag
    if (bytes[start] !== 0x9d || bytes[start + 1] !== 0x01 || bytes[start + 2] !== 0x2a) {
      return { ok: false, reason: 'unreadable' };
    }
    const w = readU16LE(bytes, start + 3) & 0x3fff;
    const h = readU16LE(bytes, start + 5) & 0x3fff;
    if (!w || !h) return { ok: false, reason: 'unreadable' };
    return { ok: true, metadata: { width: w, height: h, mediaType: 'image/webp' } };
  }
  if (tag === 'VP8L') {
    // Lossless: payload[0] = signature 0x2f; then 4 bytes packing 14-bit (width-1), 14-bit (height-1)
    const payload = 20;
    if (bytes[payload] !== 0x2f) return { ok: false, reason: 'unreadable' };
    const b0 = bytes[payload + 1];
    const b1 = bytes[payload + 2];
    const b2 = bytes[payload + 3];
    const b3 = bytes[payload + 4];
    const w = (((b1 & 0x3f) << 8) | b0) + 1;
    const h = (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6)) + 1;
    if (!w || !h) return { ok: false, reason: 'unreadable' };
    return { ok: true, metadata: { width: w, height: h, mediaType: 'image/webp' } };
  }
  if (tag === 'VP8X') {
    // Extended: 1 byte flags, 3 bytes reserved, then canvas-width-1 (3 LE) + canvas-height-1 (3 LE)
    const payload = 20;
    if (bytes.length < payload + 10) return { ok: false, reason: 'unreadable' };
    const w =
      (bytes[payload + 4] | (bytes[payload + 5] << 8) | (bytes[payload + 6] << 16)) + 1;
    const h =
      (bytes[payload + 7] | (bytes[payload + 8] << 8) | (bytes[payload + 9] << 16)) + 1;
    if (!w || !h) return { ok: false, reason: 'unreadable' };
    return { ok: true, metadata: { width: w, height: h, mediaType: 'image/webp' } };
  }
  return { ok: false, reason: 'unsupported_variant' };
}

function parseGif(bytes: Uint8Array): SniffResult {
  // Logical screen descriptor at byte 6: width(2 LE) + height(2 LE)
  if (bytes.length < 10) return { ok: false, reason: 'unreadable' };
  const w = readU16LE(bytes, 6);
  const h = readU16LE(bytes, 8);
  if (!w || !h) return { ok: false, reason: 'unreadable' };
  return { ok: true, metadata: { width: w, height: h, mediaType: 'image/gif' } };
}

/**
 * Parse MIME + dimensions from raw bytes. Header-only (typically reads < 256 bytes);
 * never decodes pixels; never throws. Failures take a discriminated union branch.
 */
export function sniffImage(bytes: Uint8Array, declaredMime: string): SniffResult {
  if (!SUPPORTED_IMAGE_MIME.includes(declaredMime as SupportedImageMime)) {
    return { ok: false, reason: 'mime_mismatch' };
  }
  const actual = sniffWhich(bytes);
  if (!actual) return { ok: false, reason: 'unreadable' };
  if (actual !== declaredMime) return { ok: false, reason: 'mime_mismatch' };

  switch (actual) {
    case 'image/png':
      return parsePng(bytes);
    case 'image/jpeg':
      return parseJpeg(bytes);
    case 'image/webp':
      return parseWebp(bytes);
    case 'image/gif':
      return parseGif(bytes);
  }
}
