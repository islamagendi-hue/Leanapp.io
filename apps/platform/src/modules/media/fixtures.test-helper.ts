/** Minimal file headers for tests: enough bytes for signature sniffing and dimension parsing. */
const u16be = (n: number) => [(n >> 8) & 0xff, n & 0xff];
const u16le = (n: number) => [n & 0xff, (n >> 8) & 0xff];
const u24le = (n: number) => [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff];
const u32be = (n: number) => [(n >>> 24) & 0xff, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));
const pad = (bytes: number[], extra = 64) => new Uint8Array([...bytes, ...new Array(extra).fill(0)]);

export function png(width: number, height: number, extra = 64): Uint8Array {
  return pad([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...u32be(13), ...ascii("IHDR"), ...u32be(width), ...u32be(height), 8, 6, 0, 0, 0], extra);
}

export function jpeg(width: number, height: number, extra = 64): Uint8Array {
  const app0 = [0xff, 0xe0, ...u16be(16), ...ascii("JFIF"), 0, 1, 1, 0, 0, 1, 0, 1, 0, 0];
  const sof = [0xff, 0xc2, ...u16be(17), 8, ...u16be(height), ...u16be(width), 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1];
  return pad([0xff, 0xd8, ...app0, ...sof], extra);
}

export function webpVp8x(width: number, height: number, animated = false): Uint8Array {
  return pad([...ascii("RIFF"), 0, 0, 0, 0, ...ascii("WEBP"), ...ascii("VP8X"), 10, 0, 0, 0, animated ? 0x02 : 0, 0, 0, 0, ...u24le(width - 1), ...u24le(height - 1)]);
}

export function webpLossless(width: number, height: number): Uint8Array {
  const bits = ((width - 1) & 0x3fff) | (((height - 1) & 0x3fff) << 14);
  return pad([...ascii("RIFF"), 0, 0, 0, 0, ...ascii("WEBP"), ...ascii("VP8L"), 0, 0, 0, 0, 0x2f, bits & 0xff, (bits >> 8) & 0xff, (bits >> 16) & 0xff, (bits >>> 24) & 0xff]);
}

export function webpLossy(width: number, height: number): Uint8Array {
  return pad([...ascii("RIFF"), 0, 0, 0, 0, ...ascii("WEBP"), ...ascii("VP8 "), 0, 0, 0, 0, 0, 0, 0, 0x9d, 0x01, 0x2a, ...u16le(width), ...u16le(height)]);
}

export function gif(width: number, height: number, frames = 1): Uint8Array {
  const frame = [0x21, 0xf9, 0x04, 0, 0, 0, 0, 0, 0x2c, 0, 0, 0, 0, ...u16le(width), ...u16le(height), 0];
  return pad([...ascii("GIF89a"), ...u16le(width), ...u16le(height), 0, 0, 0, ...new Array(frames).fill(frame).flat(), 0x3b]);
}

export const mp4 = (brand = "isom") => pad([0, 0, 0, 0x18, ...ascii("ftyp"), ...ascii(brand), 0, 0, 2, 0]);
export const pdf = () => pad(ascii("%PDF-1.7\n"));
export const svg = () => new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
