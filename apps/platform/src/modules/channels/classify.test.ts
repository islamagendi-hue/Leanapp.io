import { describe, expect, it } from "vitest";
import { classifyAttribution, classifyTouch, evidenceOf, type ChannelRule } from "./classify";
import { normalizeTouch } from "./normalize";
import { BUILT_IN_CHANNELS, channelInfo, CLICK_ID_CHANNELS, LINK_PRESETS, linkPreset } from "./registry";

const ch = (params: Record<string, string>, ctx = {}) => classifyTouch(normalizeTouch(params), ctx).channel;

describe("registry", () => {
  it("has unique keys and every click id maps to a paid channel", () => {
    const keys = BUILT_IN_CHANNELS.map((c) => c.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const c of Object.values(CLICK_ID_CHANNELS)) expect(channelInfo(c).group).toBe("paid");
  });

  it("covers every required channel family", () => {
    const keys = new Set(BUILT_IN_CHANNELS.map((c) => c.key));
    for (const k of [
      "meta_ads", "google_ads", "tiktok_ads", "snapchat_ads", "apple_search_ads", "linkedin_ads", "pinterest_ads", "x_ads",
      "organic_search", "organic_social", "content", "app_store", "referral_site", "direct", "unknown", "unattributed",
      "whatsapp", "email", "sms", "push", "web_push", "in_app", "website",
      "referral_program", "affiliate", "influencer", "partner", "qr", "store_pos", "event", "call_center", "manual",
    ]) expect(keys.has(k), k).toBe(true);
  });

  it("keeps direct, unknown and unattributed apart and never organic", () => {
    for (const k of ["direct", "unknown", "unattributed"]) expect(channelInfo(k).group).toBe("none");
  });

  it("maps the old deep link preset ids", () => {
    expect(linkPreset("paid")?.id).toBe("google_ads");
    expect(linkPreset("social_organic")?.medium).toBe("social");
    expect(linkPreset("email")?.source).toBe("email");
    expect(linkPreset("nope")).toBeUndefined();
    expect(LINK_PRESETS.every((p) => p.source && p.medium)).toBe(true);
  });

  it("labels custom channels and falls back for unknown keys", () => {
    expect(channelInfo("custom_radio", [{ key: "custom_radio", label: "Radio", group: "paid" }])).toMatchObject({ label: "Radio", group: "paid", builtIn: false });
    expect(channelInfo("custom_gone")).toMatchObject({ label: "custom_gone", group: "custom" });
  });
});

describe("normalizeTouch", () => {
  it("normalises UTMs, ids, click ids, referral ids and custom dimensions and keeps raw", () => {
    const t = normalizeTouch({
      utm_source: " TikTok ", utm_medium: "Paid Social", utm_campaign: "Ramadan 2026", utm_id: "123", utm_content: "video_a", utm_term: "riyadh",
      ttclid: "T1", sccid: "S1", ref: "ABC", referrer: "https://www.google.com/search?q=x", utm_creative_format: "video", cd_tier: "gold", other: "kept",
    });
    expect(t).toMatchObject({
      source: "tiktok", medium: "paid_social", campaign: "Ramadan 2026", campaignId: "123", content: "video_a", term: "riyadh",
      clickIds: { ttclid: "T1", ScCid: "S1" }, referralId: "ABC", referrerHost: "google.com", custom: { utm_creative_format: "video", cd_tier: "gold" },
    });
    expect(t.raw.other).toBe("kept");
    expect(t.raw.utm_source).toBe("TikTok");
  });

  it("prefers utm_* over plain aliases and ignores empty values", () => {
    expect(normalizeTouch({ source: "b", utm_source: "a", medium: "" })).toMatchObject({ source: "a", medium: null });
  });
});

describe("classifyTouch", () => {
  it("click ids win: paid network", () => {
    expect(ch({ gclid: "x" })).toBe("google_ads");
    expect(ch({ gbraid: "x", utm_source: "newsletter" })).toBe("google_ads");
    expect(ch({ fbclid: "x" })).toBe("meta_ads");
    expect(ch({ ScCid: "x" })).toBe("snapchat_ads");
    expect(ch({ li_fat_id: "x" })).toBe("linkedin_ads");
    expect(ch({ twclid: "x" })).toBe("x_ads");
    expect(ch({ epik: "x" })).toBe("pinterest_ads");
  });

  it("paid mediums go to the source's paid channel, unknown sources stay unknown", () => {
    expect(ch({ utm_source: "facebook", utm_medium: "cpc" })).toBe("meta_ads");
    expect(ch({ utm_source: "instagram", utm_medium: "paid_social" })).toBe("meta_ads");
    expect(ch({ utm_source: "google", utm_medium: "app" })).toBe("google_ads");
    expect(ch({ utm_source: "apple_search_ads", utm_medium: "cpc" })).toBe("apple_search_ads");
    expect(ch({ utm_source: "someadnet", utm_medium: "cpc" })).toBe("unknown");
  });

  it("organic: only when the data says so", () => {
    expect(ch({ utm_source: "google-play", utm_medium: "organic" })).toBe("app_store");
    expect(ch({ utm_source: "google", utm_medium: "organic" })).toBe("organic_search");
    expect(ch({ utm_source: "instagram", utm_medium: "social" })).toBe("organic_social");
    expect(ch({ utm_source: "facebook", utm_medium: "referral" })).toBe("referral_site");
    expect(ch({ utm_source: "mystery", utm_medium: "organic" })).toBe("unknown");
    expect(ch({ referrer: "https://www.bing.com/" })).toBe("organic_search");
    expect(ch({ referrer: "https://l.instagram.com/" })).toBe("organic_social");
    expect(ch({ referrer: "https://news.example.org/a" })).toBe("referral_site");
    expect(ch({ referrer: "https://apps.apple.com/app/id1" })).toBe("app_store");
  });

  it("owned, referral and offline channels by medium or source", () => {
    expect(ch({ utm_source: "newsletter", utm_medium: "email" })).toBe("email");
    expect(ch({ utm_source: "whatsapp" })).toBe("whatsapp");
    expect(ch({ utm_medium: "sms" })).toBe("sms");
    expect(ch({ utm_medium: "push" })).toBe("push");
    expect(ch({ utm_medium: "web_push" })).toBe("web_push");
    expect(ch({ utm_medium: "in_app" })).toBe("in_app");
    expect(ch({ utm_source: "instagram", utm_medium: "influencer" })).toBe("influencer");
    expect(ch({ utm_source: "qr", utm_medium: "offline" })).toBe("qr");
    expect(ch({ utm_medium: "affiliate" })).toBe("affiliate");
    expect(ch({ utm_medium: "pos" })).toBe("store_pos");
    expect(ch({ utm_source: "event" })).toBe("event");
    expect(ch({ utm_medium: "call_center" })).toBe("call_center");
    expect(ch({ ref: "FRIEND1" })).toBe("referral_program");
    expect(ch({ utm_source: "partner", utm_medium: "partner" })).toBe("partner");
  });

  it("direct, unknown and unattributed are distinct", () => {
    expect(ch({ utm_source: "(direct)", utm_medium: "(none)" })).toBe("direct");
    expect(ch({ utm_source: "direct" })).toBe("direct");
    expect(ch({ utm_source: "zzz" })).toBe("unknown");
    expect(ch({})).toBe("unattributed");
  });

  it("custom rules come first, by priority, and need an existing channel", () => {
    const rules: ChannelRule[] = [
      { id: "b", priority: 20, channel: "custom_radio", conditions: { source: ["radio"] } },
      { id: "a", priority: 10, channel: "custom_radio", conditions: { campaignPrefix: "fm_" } },
      { id: "c", priority: 5, channel: "custom_missing", conditions: { source: ["radio"] } },
      { id: "d", priority: 30, channel: "partner", conditions: { source: ["acme"], medium: ["cpc"] } },
    ];
    const ctx = { rules, customChannels: [{ key: "custom_radio", label: "Radio", group: "paid" as const }] };
    expect(classifyTouch(normalizeTouch({ utm_source: "radio" }), ctx)).toEqual({ channel: "custom_radio", reason: "custom_rule", ruleId: "b" });
    expect(classifyTouch(normalizeTouch({ utm_source: "x", utm_campaign: "FM_eid" }), ctx).ruleId).toBe("a");
    expect(ch({ utm_source: "acme", utm_medium: "cpc" }, ctx)).toBe("partner");
    expect(ch({ utm_source: "acme", utm_medium: "email" }, ctx)).toBe("email");
  });

  it("an empty rule never matches everything", () => {
    expect(ch({ utm_source: "zzz" }, { rules: [{ id: "e", priority: 1, channel: "email", conditions: {} }] })).toBe("unknown");
  });
});

describe("classifyAttribution", () => {
  const row = (o: Partial<Parameters<typeof classifyAttribution>[0]>) => ({ source: null, medium: null, network: null, match_type: "organic", match_key: null, ...o });

  it("no match is unattributed, not organic", () => {
    expect(classifyAttribution(row({})).channel).toBe("unattributed");
  });

  it("an organic store referrer is app store discovery; direct stays direct", () => {
    expect(classifyAttribution(row({ match_key: "store_organic" })).channel).toBe("app_store");
    expect(classifyAttribution(row({ match_key: "direct" })).channel).toBe("direct");
  });

  it("uses the stored network for click-id attributions", () => {
    expect(classifyAttribution(row({ match_type: "deterministic", source: "tiktok", medium: "paid_social", network: "tiktok" })).channel).toBe("tiktok_ads");
    expect(classifyAttribution(row({ match_type: "reported", source: "my-dsp", network: "google" })).channel).toBe("google_ads");
  });

  it("labels evidence honestly", () => {
    expect(evidenceOf("deterministic")).toBe("deterministic");
    expect(evidenceOf("reported")).toBe("observed");
    expect(evidenceOf("probabilistic")).toBe("modeled");
    expect(evidenceOf("organic")).toBe("none");
    expect(evidenceOf("organic", "store_organic")).toBe("observed");
  });
});
