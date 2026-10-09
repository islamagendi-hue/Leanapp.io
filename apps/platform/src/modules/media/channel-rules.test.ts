import { describe, expect, it } from "vitest";
import { acceptedMimes, issueText, validateMediaForChannel, type MediaFacts } from "./channel-rules";

const MB = 1024 * 1024;
const jpg = (size = 200_000, w = 1024, h = 512): MediaFacts => ({ mime: "image/jpeg", kind: "image", sizeBytes: size, width: w, height: h });
const webp: MediaFacts = { mime: "image/webp", kind: "image", sizeBytes: 100_000, width: 800, height: 400 };
const gifA: MediaFacts = { mime: "image/gif", kind: "gif", sizeBytes: 300_000, width: 400, height: 200, animated: true };
const video = (size = 5 * MB): MediaFacts => ({ mime: "video/mp4", kind: "video", sizeBytes: size });
const doc: MediaFacts = { mime: "application/pdf", kind: "document", sizeBytes: 2 * MB };
const codes = (r: { errors: { code: string }[] }) => r.errors.map((e) => e.code);

describe("validateMediaForChannel", () => {
  it("push: JPEG/PNG up to 1 MB; iOS needs a service extension", () => {
    const ok = validateMediaForChannel(jpg(), { channel: "push" });
    expect(ok.ok).toBe(true);
    expect(ok.requiresPublicUrl).toBe(true);
    expect(ok.warnings.map((w) => w.code)).toContain("ios_extension");
    expect(validateMediaForChannel(jpg(), { channel: "push", iosNotificationServiceExtension: true }).warnings.map((w) => w.code)).not.toContain("ios_extension");
    expect(validateMediaForChannel(jpg(), { channel: "push", platforms: ["android"] }).warnings).toEqual([]);
    expect(codes(validateMediaForChannel(jpg(2 * MB), { channel: "push" }))).toEqual(["size"]);
    expect(codes(validateMediaForChannel(gifA, { channel: "push" }))).toEqual(["type"]);
    expect(codes(validateMediaForChannel(webp, { channel: "push" }))).toEqual(["type"]);
    expect(validateMediaForChannel(jpg(100_000, 500, 1000), { channel: "push", platforms: ["android"] }).warnings.map((w) => w.code)).toEqual(["push_aspect"]);
  });

  it("whatsapp: media must match the approved template header type", () => {
    expect(validateMediaForChannel(jpg(), { channel: "whatsapp", whatsappHeader: "IMAGE" }).ok).toBe(true);
    expect(codes(validateMediaForChannel(jpg(6 * MB), { channel: "whatsapp", whatsappHeader: "IMAGE" }))).toEqual(["size"]);
    expect(codes(validateMediaForChannel(webp, { channel: "whatsapp", whatsappHeader: "IMAGE" }))).toEqual(["type"]);
    expect(codes(validateMediaForChannel(jpg(), { channel: "whatsapp", whatsappHeader: "VIDEO" }))).toEqual(["type"]);
    expect(validateMediaForChannel(video(), { channel: "whatsapp", whatsappHeader: "VIDEO" }).ok).toBe(true);
    expect(codes(validateMediaForChannel(video(17 * MB), { channel: "whatsapp", whatsappHeader: "VIDEO" }))).toEqual(["size"]);
    expect(validateMediaForChannel(doc, { channel: "whatsapp", whatsappHeader: "DOCUMENT" }).ok).toBe(true);
    expect(codes(validateMediaForChannel(jpg(), { channel: "whatsapp", whatsappHeader: "TEXT" }))).toEqual(["whatsapp_header"]);
    // Session (free-form) message: any WhatsApp media type within its limit.
    expect(validateMediaForChannel(doc, { channel: "whatsapp" }).ok).toBe(true);
    expect(codes(validateMediaForChannel(gifA, { channel: "whatsapp" }))).toEqual(["type"]);
  });

  it("email: linked JPEG/PNG/GIF; WebP and big files are warned", () => {
    expect(validateMediaForChannel(gifA, { channel: "email" }).ok).toBe(true);
    expect(validateMediaForChannel(webp, { channel: "email" }).warnings.map((w) => w.code)).toEqual(["email_webp"]);
    expect(validateMediaForChannel(jpg(2 * MB), { channel: "email" }).warnings.map((w) => w.code)).toEqual(["email_size"]);
    expect(codes(validateMediaForChannel(doc, { channel: "email" }))).toEqual(["type"]);
  });

  it("sms: none unless the provider declares MMS", () => {
    expect(codes(validateMediaForChannel(jpg(), { channel: "sms" }))).toEqual(["sms_no_media"]);
    const mms = { channel: "sms" as const, provider: "twilio", providerMedia: [{ kind: "image" as const, mimeTypes: ["image/jpeg", "image/png"], maxBytes: 5 * MB }] };
    expect(validateMediaForChannel(jpg(), mms).ok).toBe(true);
    expect(codes(validateMediaForChannel(webp, mms))).toEqual(["provider"]);
    expect(acceptedMimes({ channel: "sms" })).toEqual([]);
    expect(acceptedMimes(mms)).toEqual(["image/jpeg", "image/png"]);
  });

  it("a provider declaration narrows a channel", () => {
    const cap = { channel: "whatsapp" as const, provider: "x", providerMedia: [{ kind: "image" as const, mimeTypes: ["image/jpeg"], maxBytes: 1 * MB }] };
    expect(codes(validateMediaForChannel(jpg(2 * MB), cap))).toEqual(["provider"]);
    expect(acceptedMimes(cap)).toEqual(["image/jpeg"]);
  });

  it("in-app and web push accept WebP and GIF, with notes", () => {
    expect(validateMediaForChannel(webp, { channel: "in_app" }).ok).toBe(true);
    expect(validateMediaForChannel(gifA, { channel: "web_push" }).warnings.map((w) => w.code)).toEqual(["web_push_browsers"]);
    expect(codes(validateMediaForChannel(video(), { channel: "in_app" }))).toEqual(["type"]);
  });

  it("a deleted asset never validates", () => {
    expect(codes(validateMediaForChannel({ ...jpg(), deleted: true }, { channel: "push" }))).toContain("deleted");
  });

  it("fills values into issue text", () => {
    const r = validateMediaForChannel(jpg(2 * MB), { channel: "push" });
    expect(issueText(r.errors[0])).toBe("The file is larger than 1 MB, the limit for this channel.");
  });
});
