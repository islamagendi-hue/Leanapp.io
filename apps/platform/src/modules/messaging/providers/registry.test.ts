import { describe, expect, it } from "vitest";
import { checkMedia, HEADER_MEDIA, mmsAllowed } from "./media";
import { CAPABILITIES, can, CAPABILITY_STATUSES, MESSAGING_PROVIDERS, messagingProvider, providersForChannel, WHATSAPP_PROVIDERS } from "./registry";

const MB = 1024 * 1024;

describe("messaging provider registry", () => {
  it("declares every capability with a known status, once per provider", () => {
    const ids = MESSAGING_PROVIDERS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const p of MESSAGING_PROVIDERS) {
      expect(Object.keys(p.capabilities).sort()).toEqual([...CAPABILITIES].sort());
      for (const s of Object.values(p.capabilities)) expect(CAPABILITY_STATUSES).toContain(s);
    }
  });

  it("only marks capabilities implemented for providers LeanApp connects (or built-in in-app)", () => {
    for (const p of MESSAGING_PROVIDERS) {
      const implemented = Object.values(p.capabilities).includes("implemented");
      if (!p.integration && p.id !== "leanapp_in_app") expect(implemented, p.id).toBe(false);
    }
    // Descriptor-only providers are never sendable.
    for (const id of ["360dialog", "infobip", "gupshup", "wati", "unifonic", "respond_io"]) {
      expect(messagingProvider(id)).not.toBeNull();
      expect(can(id, "send_template")).toBe(false);
      expect(messagingProvider(id)!.integration).toBeNull();
    }
    // Unconfirmed providers are entirely unverified.
    expect(Object.values(messagingProvider("unifonic")!.capabilities).every((s) => s === "unverified")).toBe(true);
    expect(Object.values(messagingProvider("respond_io")!.capabilities).every((s) => s === "unverified")).toBe(true);
  });

  it("implements Meta and Twilio for WhatsApp, and SMS only through Twilio", () => {
    expect(WHATSAPP_PROVIDERS.every((id) => can(id, "send_template") && can(id, "template_list"))).toBe(true);
    expect(can("whatsapp_cloud", "template_create")).toBe(true);
    expect(can("twilio", "template_create")).toBe(false);
    expect(providersForChannel("sms").filter((p) => can(p.id, "send_session")).map((p) => p.id)).toEqual(["twilio"]);
    expect(messagingProvider("nope")).toBeNull();
    expect(can("nope", "send_template")).toBe(false);
  });
});

describe("media checks", () => {
  const asset = (mime: string, size: number) => ({ id: "a", mime, size });

  it("applies Meta's WhatsApp limits by kind and type", () => {
    expect(checkMedia("whatsapp_cloud", "whatsapp", asset("image/jpeg", 2 * MB))).toMatchObject({ ok: true, rule: { kind: "image" } });
    expect(checkMedia("whatsapp_cloud", "whatsapp", asset("image/png; charset=binary", 1 * MB), "image").ok).toBe(true);
    const big = checkMedia("whatsapp_cloud", "whatsapp", asset("image/jpeg", 6 * MB));
    expect(big.ok).toBe(false);
    expect(!big.ok && big.reason).toMatch(/at most 5 MB/);
    const gif = checkMedia("whatsapp_cloud", "whatsapp", asset("image/gif", 1000));
    expect(!gif.ok && gif.reason).toMatch(/image\/gif/);
    // A VIDEO header doesn't take an image.
    expect(checkMedia("whatsapp_cloud", "whatsapp", asset("image/jpeg", 1000), HEADER_MEDIA.VIDEO).ok).toBe(false);
    expect(checkMedia("whatsapp_cloud", "whatsapp", asset("application/pdf", 20 * MB), HEADER_MEDIA.DOCUMENT).ok).toBe(true);
  });

  it("refuses media where the provider doesn't declare it", () => {
    expect(checkMedia("gupshup", "whatsapp", asset("image/jpeg", 1000)).ok).toBe(false);
    expect(checkMedia("whatsapp_cloud", "sms", asset("image/jpeg", 1000)).ok).toBe(false);
    expect(checkMedia("unknown", "sms", asset("image/jpeg", 1000))).toEqual({ ok: false, reason: "Unknown provider." });
  });

  it("keeps SMS text-only except Twilio MMS to +1 numbers", () => {
    expect(checkMedia("twilio", "sms", asset("image/jpeg", 1 * MB)).ok).toBe(true);
    expect(mmsAllowed("twilio", "+14155550100")).toBe(true);
    expect(mmsAllowed("twilio", "+966501234567")).toBe(false);
    expect(mmsAllowed("whatsapp_cloud", "+14155550100")).toBe(false);
  });
});
