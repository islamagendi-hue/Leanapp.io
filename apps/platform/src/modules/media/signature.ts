/**
 * File type detection from the bytes themselves (magic numbers), and image
 * dimensions read from the file headers, with no image library. The type a
 * browser declares is never trusted on its own: it must agree with what the
 * bytes say (see ./policy.ts). SVG and anything else not listed is refused,
 * since it can carry script. Pure.
 */

export const MEDIA_MIME_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif", "video/mp4", "video/3gpp", "application/pdf"] as const;
export type MediaMime = (typeof MEDIA_MIME_TYPES)[number];
export type MediaKind = "image" | "gif" | "video" | "document";

export const KIND_OF: Record<MediaMime, MediaKind> = {
  "image/jpeg": "image",
  "image/png": "image",
  "image/webp": "image",
  "image/gif": "gif",
  "video/mp4": "video",
  "video/3gpp": "video",
  "application/pdf": "document",
};

export const EXTENSION_OF: Record<MediaMime, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
  "video/mp4": "mp4",
  "video/3gpp": "3gp",
  "application/pdf": "pdf",
};

const ascii = (b: Uint8Array, at: number, len: number) => String.fromCharCode(...b.subarray(at, at + len));
const startsWith = (b: Uint8Array, sig: number[], at = 0) => b.length >= at + sig.length && sig.every((v, i) => b[at + i] === v);

/** The type the bytes are, or null when they are none of the accepted types. */
export function sniffMime(b: Uint8Array): MediaMime | null {
  if (startsWith(b, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (startsWith(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (b.length >= 12 && ascii(b, 0, 4) === "RIFF" && ascii(b, 8, 4) === "WEBP") return "image/webp";
  if (b.length >= 6 && (ascii(b, 0, 6) === "GIF87a" || ascii(b, 0, 6) === "GIF89a")) return "image/gif";
  if (b.length >= 5 && ascii(b, 0, 5) === "%PDF-") return "application/pdf";
  // ISO base media (MP4 / 3GPP): a box size, then "ftyp" and the major brand.
  if (b.length >= 12 && ascii(b, 4, 4) === "ftyp") {
    const brand = ascii(b, 8, 4);
    if (/^3g[p2]/.test(brand)) return "video/3gpp";
    if (["isom", "iso2", "iso4", "iso5", "iso6", "mp41", "mp42", "avc1", "M4V ", "dash", "mmp4"].includes(brand)) return "video/mp4";
  }
  return null;
}

export interface Dimensions {
  width: number;
  height: number;
}

const u16be = (b: Uint8Array, i: number) => (b[i] << 8) | b[i + 1];
const u16le = (b: Uint8Array, i: number) => b[i] | (b[i + 1] << 8);
const u24le = (b: Uint8Array, i: number) => b[i] | (b[i + 1] << 8) | (b[i + 2] << 16);
const u32be = (b: Uint8Array, i: number) => ((b[i] << 24) >>> 0) + ((b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]);

function jpegSize(b: Uint8Array): Dimensions | null {
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) return null;
    const marker = b[i + 1];
    if (marker === 0xff) {
      i += 1; // fill byte
      continue;
    }
    // Markers without a length.
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2;
      continue;
    }
    const len = u16be(b, i + 2);
    if (len < 2) return null;
    // Start-of-frame markers (baseline, progressive, …), not DHT (C4), JPG (C8) or DAC (CC).
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      const height = u16be(b, i + 5);
      const width = u16be(b, i + 7);
      return width && height ? { width, height } : null;
    }
    if (marker === 0xda) return null; // start of scan before any frame header
    i += 2 + len;
  }
  return null;
}

function pngSize(b: Uint8Array): Dimensions | null {
  if (b.length < 24 || ascii(b, 12, 4) !== "IHDR") return null;
  const width = u32be(b, 16);
  const height = u32be(b, 20);
  return width && height ? { width, height } : null;
}

function webpSize(b: Uint8Array): Dimensions | null {
  if (b.length < 30) return null;
  const chunk = ascii(b, 12, 4);
  if (chunk === "VP8 ") {
    // Key frame start code 9d 01 2a, then 14-bit width and height.
    if (!startsWith(b, [0x9d, 0x01, 0x2a], 23)) return null;
    return { width: u16le(b, 26) & 0x3fff, height: u16le(b, 28) & 0x3fff };
  }
  if (chunk === "VP8L") {
    if (b[20] !== 0x2f) return null;
    const bits = b[21] | (b[22] << 8) | (b[23] << 16) | (b[24] << 24);
    return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
  }
  if (chunk === "VP8X") return { width: u24le(b, 24) + 1, height: u24le(b, 27) + 1 };
  return null;
}

function gifSize(b: Uint8Array): Dimensions | null {
  if (b.length < 10) return null;
  const width = u16le(b, 6);
  const height = u16le(b, 8);
  return width && height ? { width, height } : null;
}

/** Width and height from the image header; null for video and PDF, or when the header is unreadable. */
export function imageDimensions(b: Uint8Array, mime: MediaMime): Dimensions | null {
  switch (mime) {
    case "image/jpeg": return jpegSize(b);
    case "image/png": return pngSize(b);
    case "image/webp": return webpSize(b);
    case "image/gif": return gifSize(b);
    default: return null;
  }
}

/** True when an animated GIF or WebP is likely (more than one frame / ANIM chunk). */
export function isAnimated(b: Uint8Array, mime: MediaMime): boolean {
  if (mime === "image/gif") {
    // Count image descriptors after graphic control extensions: two or more frames means animation.
    let frames = 0;
    for (let i = 0; i + 2 < b.length && frames < 2; i++) if (b[i] === 0x21 && b[i + 1] === 0xf9 && b[i + 2] === 0x04) frames++;
    return frames >= 2;
  }
  if (mime === "image/webp" && b.length >= 21 && ascii(b, 12, 4) === "VP8X") return (b[20] & 0x02) !== 0;
  return false;
}
