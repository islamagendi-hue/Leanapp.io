import { describe, expect, it } from "vitest";
import { attributionEvidence, isExternalReferrer, MAX_ADSERVICES_TOKEN_LENGTH } from "./attribution-context";
import { LIMITS, normalizeEvent } from "./schema";

const now = new Date("2026-10-05T10:00:00Z");
const opts = { now, fallbackEventId: () => "generated" };
const base = { type: "track", event_name: "page_viewed", event_id: "e1", anonymous_id: "a1", timestamp: "2026-10-05T09:59:00Z" };

function ok(raw: unknown) {
  const r = normalizeEvent(raw, opts);
  if (!r.ok) throw new Error(JSON.stringify(r.errors));
  return r;
}

describe("context.attribution (typed, backward compatible)", () => {
  it("accepts the well-known keys and keeps them as sent", () => {
    const attribution = {
      utm_source: "google",
      utm_medium: "cpc",
      utm_campaign: "ramadan",
      utm_id: "123",
      gclid: "Cj0KCQ",
      landing_url: "https://shop.example/landing?utm_source=google",
      referrer: "https://www.google.com/",
      campaign_id: "c1",
      adset_id: "s1",
      ad_id: "ad1",
      fbp: "fb.1.1700000000000.123",
      fbc: "fb.1.1700000000000.IwAR",
      touch: "first",
    };
    const r = ok({ ...base, context: { platform: "web", attribution } });
    expect(r.event.context.attribution).toEqual(attribution);
    expect(r.warnings).toEqual([]);
  });

  it("still accepts custom string keys, as the old string map did", () => {
    const r = ok({ ...base, context: { attribution: { deep_link_url: "myapp://p", partner: "x" } } });
    expect(r.event.context.attribution).toEqual({ deep_link_url: "myapp://p", partner: "x" });
  });

  it("keeps the old limits: keys up to 60 characters, values up to 1,000", () => {
    expect(normalizeEvent({ ...base, context: { attribution: { ["k".repeat(61)]: "v" } } }, opts).ok).toBe(false);
    expect(normalizeEvent({ ...base, context: { attribution: { utm_source: "x".repeat(1001) } } }, opts).ok).toBe(false);
    expect(normalizeEvent({ ...base, context: { attribution: { utm_source: 5 } } }, opts).ok).toBe(false);
  });

  it("allows a longer AdServices token than other values", () => {
    const token = "t".repeat(2500);
    expect(ok({ ...base, context: { platform: "ios", attribution: { adservices_token: token } } }).event.context.attribution).toEqual({ adservices_token: token });
    expect(normalizeEvent({ ...base, context: { attribution: { adservices_token: "t".repeat(MAX_ADSERVICES_TOKEN_LENGTH + 1) } } }, opts).ok).toBe(false);
  });

  it("drops a touch that is neither first nor latest, and non-URL landing/referrer values, with warnings", () => {
    const r = ok({ ...base, context: { attribution: { utm_source: "x", touch: "middle", landing_url: "javascript:alert(1)", referrer: "android-app://x" } } });
    expect(r.event.context.attribution).toEqual({ utm_source: "x" });
    expect(r.warnings.map((w) => w.field)).toEqual(["context.attribution.touch", "context.attribution.landing_url", "context.attribution.referrer"]);
  });
});

describe("validation the owner asked about", () => {
  it("rejects events older than 31 days (delayed beyond the window)", () => {
    const old = new Date(now.getTime() - (LIMITS.maxPastDays * 86_400_000 + 60_000)).toISOString();
    const r = normalizeEvent({ ...base, timestamp: old }, opts);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0]).toMatchObject({ field: "timestamp" });
  });

  it("keeps the client time of a delayed event inside the window", () => {
    const late = new Date(now.getTime() - 3 * 86_400_000).toISOString();
    expect(ok({ ...base, timestamp: late }).event.timestamp).toBe(late);
  });

  it("warns when an event has no event_id (retries cannot be de-duplicated)", () => {
    const r = ok({ ...base, event_id: undefined });
    expect(r.event.event_id).toBe("generated");
    expect(r.warnings.map((w) => w.field)).toContain("event_id");
  });

  it("accepts an event without any attribution (no source is invented)", () => {
    const r = ok(base);
    expect(r.event.context.attribution).toBeUndefined();
  });
});

describe("attributionEvidence", () => {
  it("finds UTMs, click ids, campaign ids and an external referrer", () => {
    const e = attributionEvidence({ utm_source: "meta", fbclid: "IwAR", sccid: "s", campaign_id: "c1", referrer: "https://l.facebook.com/", landing_url: "https://shop.example/" });
    expect(e).toMatchObject({ utm: { utm_source: "meta" }, clickIds: { fbclid: "IwAR", ScCid: "s" }, campaignIds: { campaign_id: "c1" }, externalReferrer: "https://l.facebook.com/", hasTouch: true });
  });

  it("is not a touch when the only signal is an internal referrer or a landing page (direct)", () => {
    expect(attributionEvidence({ landing_url: "https://shop.example/a", referrer: "https://www.shop.example/b" }).hasTouch).toBe(false);
    expect(attributionEvidence({ landing_url: "https://shop.example/a" }).hasTouch).toBe(false);
    expect(attributionEvidence({ fbp: "fb.1.1.2" }).hasTouch).toBe(false);
    expect(attributionEvidence(null).hasTouch).toBe(false);
  });

  it("treats a referrer without a landing URL as external, and ignores unparsable ones", () => {
    expect(isExternalReferrer("https://news.example/", undefined)).toBe(true);
    expect(isExternalReferrer("not a url", "https://shop.example/")).toBe(false);
    expect(isExternalReferrer(undefined, "https://shop.example/")).toBe(false);
  });
});
