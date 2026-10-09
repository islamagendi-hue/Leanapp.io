import { describe, expect, it } from "vitest";
import { gif, jpeg, mp4, pdf, png, svg, webpLossless, webpLossy, webpVp8x } from "./fixtures.test-helper";
import { cleanFolder, cleanName, cleanTags, checkFile, maxUploadBytes, MediaValidationError } from "./policy";
import { imageDimensions, isAnimated, sniffMime } from "./signature";

describe("signature sniffing", () => {
  it("recognises each accepted type by its bytes", () => {
    expect(sniffMime(jpeg(10, 10))).toBe("image/jpeg");
    expect(sniffMime(png(10, 10))).toBe("image/png");
    expect(sniffMime(webpVp8x(10, 10))).toBe("image/webp");
    expect(sniffMime(gif(10, 10))).toBe("image/gif");
    expect(sniffMime(mp4())).toBe("video/mp4");
    expect(sniffMime(mp4("3gp5"))).toBe("video/3gpp");
    expect(sniffMime(pdf())).toBe("application/pdf");
  });

  it("refuses SVG, HTML, text and unknown containers", () => {
    expect(sniffMime(svg())).toBeNull();
    expect(sniffMime(new TextEncoder().encode("<html><script>x</script></html>"))).toBeNull();
    expect(sniffMime(new Uint8Array([0x42, 0x4d, 1, 2, 3, 4]))).toBeNull(); // BMP
    expect(sniffMime(mp4("qt  "))).toBeNull(); // QuickTime
    expect(sniffMime(new Uint8Array())).toBeNull();
  });

  it("reads dimensions from the headers", () => {
    expect(imageDimensions(png(1200, 600), "image/png")).toEqual({ width: 1200, height: 600 });
    expect(imageDimensions(jpeg(640, 480), "image/jpeg")).toEqual({ width: 640, height: 480 });
    expect(imageDimensions(webpVp8x(3000, 2000), "image/webp")).toEqual({ width: 3000, height: 2000 });
    expect(imageDimensions(webpLossless(321, 123), "image/webp")).toEqual({ width: 321, height: 123 });
    expect(imageDimensions(webpLossy(800, 400), "image/webp")).toEqual({ width: 800, height: 400 });
    expect(imageDimensions(gif(48, 32), "image/gif")).toEqual({ width: 48, height: 32 });
    expect(imageDimensions(pdf(), "application/pdf")).toBeNull();
  });

  it("returns null for a truncated JPEG with no frame header", () => {
    expect(imageDimensions(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0, 0, 0, 0, 0, 0]), "image/jpeg")).toBeNull();
  });

  it("detects animation", () => {
    expect(isAnimated(gif(10, 10, 1), "image/gif")).toBe(false);
    expect(isAnimated(gif(10, 10, 3), "image/gif")).toBe(true);
    expect(isAnimated(webpVp8x(10, 10, true), "image/webp")).toBe(true);
    expect(isAnimated(png(10, 10), "image/png")).toBe(false);
  });
});

describe("upload policy", () => {
  it("accepts a file whose declared type matches its bytes, or a generic type", () => {
    expect(checkFile(png(100, 50), "image/png")).toMatchObject({ mime: "image/png", kind: "image", width: 100, height: 50, extension: "png" });
    expect(checkFile(jpeg(100, 50), "image/jpg").mime).toBe("image/jpeg");
    expect(checkFile(pdf(), "application/octet-stream")).toMatchObject({ mime: "application/pdf", kind: "document", width: null });
    expect(checkFile(gif(10, 10, 2), "")).toMatchObject({ kind: "gif", animated: true });
  });

  it("refuses spoofed, unsupported, empty, oversized and huge-dimension files", () => {
    const fails = (b: Uint8Array, type: string, max?: number) => expect(() => checkFile(b, type, max)).toThrow(MediaValidationError);
    fails(png(10, 10), "image/jpeg"); // declared type disagrees with the bytes
    fails(svg(), "image/svg+xml");
    fails(new TextEncoder().encode("hello"), "image/png"); // a renamed text file
    fails(new Uint8Array(), "image/png");
    fails(png(10, 10, 2000), "image/png", 1000);
    fails(png(9000, 10), "image/png");
    fails(new Uint8Array([0xff, 0xd8, 0xff, 0xda, 0, 2]), "image/jpeg"); // unreadable header
  });

  it("caps the configured upload limit", () => {
    expect(maxUploadBytes({})).toBe(4 * 1024 * 1024);
    expect(maxUploadBytes({ MEDIA_MAX_UPLOAD_BYTES: "1000" })).toBe(1000);
    expect(maxUploadBytes({ MEDIA_MAX_UPLOAD_BYTES: String(500 * 1024 * 1024) })).toBe(9 * 1024 * 1024);
    expect(maxUploadBytes({ MEDIA_MAX_UPLOAD_BYTES: "nope" })).toBe(4 * 1024 * 1024);
  });

  it("cleans names, folders and tags", () => {
    expect(cleanName("C:\\Users\\me\\photo\u0007.png")).toBe("photo.png");
    expect(cleanName("../../etc/passwd")).toBe("passwd");
    expect(cleanName("   ")).toBe("file");
    expect(cleanFolder(" Campaigns / Ramadan Offers // ")).toBe("campaigns/ramadan-offers");
    expect(cleanFolder("../..")).toBeNull();
    expect(cleanFolder("عروض/رمضان")).toBe("عروض/رمضان");
    expect(cleanTags("Sale, sale ,  Hero  Banner,,")).toEqual(["sale", "hero banner"]);
    expect(cleanTags(Array.from({ length: 30 }, (_, i) => `t${i}`))).toHaveLength(20);
  });
});
