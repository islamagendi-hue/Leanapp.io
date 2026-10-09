import { describe, expect, it } from "vitest";
import {
  clickLookbackDays, conversionWindowDays, creditEvidence, describeMatch, fnv1a, isWeakTouch, maxClickLookbackDays, maxConversionWindowDays, parseWindowOverrides,
  pickCredits, webMatch, webTouchOf, type CreditCandidate, type WindowSettings,
} from "./pure-credit";

const DAY = 86_400_000;
const NOW = new Date("2026-06-01T12:00:00Z");
const ago = (days: number) => new Date(NOW.getTime() - days * DAY);
const settings: WindowSettings = { click_lookback_days: 7, conversion_window_days: 30, window_overrides: {} };

let seq = 0;
function touch(o: Partial<CreditCandidate> & { at: Date }): CreditCandidate {
  return {
    id: o.id ?? `t${String(++seq).padStart(3, "0")}`, kind: o.kind ?? "install", occurred_at: o.at,
    source: o.source ?? null, medium: o.medium ?? null, network: o.network ?? null, match_type: o.match_type ?? "organic", match_key: o.match_key ?? null,
    referrer_host: o.referrer_host ?? null,
  };
}
const paid = (at: Date, source = "tiktok") => touch({ at, source, network: source, match_type: "deterministic", match_key: "click_id" });
const direct = (at: Date) => touch({ at, kind: "web_touch", source: "direct", match_type: "organic", match_key: "direct" });
const unattributed = (at: Date) => touch({ at, kind: "reinstall" });

describe("windows per channel", () => {
  it("keeps only known channels and in-range whole numbers", () => {
    expect(parseWindowOverrides({
      meta_ads: { click_lookback_days: 28, conversion_window_days: "60" },
      google_ads: { click_lookback_days: 0 },
      tiktok_ads: { click_lookback_days: 7.5, conversion_window_days: 731 },
      not_a_channel: { click_lookback_days: 3 },
      direct: { click_lookback_days: 3 },
    })).toEqual({ meta_ads: { click_lookback_days: 28, conversion_window_days: 60 } });
    expect(parseWindowOverrides(null)).toEqual({});
    expect(parseWindowOverrides([1, 2])).toEqual({});
  });

  it("uses the channel's window, else the app-wide one, and searches with the longest", () => {
    const s: WindowSettings = { ...settings, window_overrides: { meta_ads: { click_lookback_days: 28 }, google_ads: { conversion_window_days: 90 } } };
    expect(clickLookbackDays(s, "meta_ads")).toBe(28);
    expect(clickLookbackDays(s, "google_ads")).toBe(7);
    expect(clickLookbackDays(s, null)).toBe(7);
    expect(conversionWindowDays(s, "google_ads")).toBe(90);
    expect(conversionWindowDays(s, "meta_ads")).toBe(30);
    expect(maxClickLookbackDays(s)).toBe(28);
    expect(maxConversionWindowDays(s)).toBe(90);
    expect(maxClickLookbackDays(settings)).toBe(7);
  });
});

describe("weak touches", () => {
  it("treats direct, organic-without-campaign and unattributed as weak, and known sources as not", () => {
    expect(isWeakTouch(direct(NOW))).toBe(true);
    expect(isWeakTouch(unattributed(NOW))).toBe(true);
    expect(isWeakTouch(touch({ at: NOW, match_type: "organic", match_key: "store_organic" }))).toBe(true);
    expect(isWeakTouch(paid(NOW))).toBe(false);
    expect(isWeakTouch(touch({ at: NOW, kind: "web_touch", match_type: "reported", match_key: "referrer", referrer_host: "google.com" }))).toBe(false);
    // Data no rule recognises is an explicit unknown source, not direct: it keeps credit.
    expect(isWeakTouch(touch({ at: NOW, kind: "web_touch", source: "my_newsletter_x", match_type: "reported", match_key: "utm_parameters" }))).toBe(false);
    // A campaign name without a source is an unknown source too, not "nothing".
    expect(isWeakTouch({ ...touch({ at: NOW, kind: "web_touch", match_type: "reported", match_key: "utm_parameters" }), campaign: "spring" })).toBe(false);
    expect(isWeakTouch(touch({ at: NOW, kind: "web_touch", match_type: "reported", match_key: "utm_parameters" }))).toBe(true);
  });
});

describe("pickCredits", () => {
  it("keeps last non-direct on the paid source when a later direct visit or organic reinstall comes in", () => {
    const p = paid(ago(10));
    const d = direct(ago(2));
    const r = unattributed(ago(1));
    const c = pickCredits([r, d, p], NOW, settings);
    expect(c.lastTouch?.id).toBe(r.id);
    expect(c.firstTouch?.id).toBe(p.id);
    expect(c.lastNonDirect?.id).toBe(p.id);
    expect(c.lastNonDirectFallback).toBe(false);
    expect(c.considered).toBe(3);
  });

  it("lets a newer known source take last non-direct credit", () => {
    const p = paid(ago(10), "tiktok");
    const g = paid(ago(3), "google");
    expect(pickCredits([p, g], NOW, settings).lastNonDirect?.id).toBe(g.id);
  });

  it("falls back to the last touch when no known source is in the window, and says so", () => {
    const d = direct(ago(2));
    const c = pickCredits([d], NOW, settings);
    expect(c.lastNonDirect?.id).toBe(d.id);
    expect(c.lastNonDirectFallback).toBe(true);
    expect(pickCredits([], NOW, settings)).toMatchObject({ lastTouch: null, firstTouch: null, lastNonDirect: null, lastNonDirectFallback: true });
  });

  it("ignores touches after the conversion and outside their channel's window", () => {
    const later = paid(new Date(NOW.getTime() + 60 * 60_000));
    const old = paid(ago(40), "tiktok");
    const c = pickCredits([later, old], NOW, settings);
    expect(c.lastTouch).toBeNull();
    expect(c.outsideWindow).toBe(1);
    expect(creditEvidence(c, settings).status).toBe("outside_window");
    // A longer window for TikTok brings the same touch back in.
    const s = { ...settings, window_overrides: { tiktok_ads: { conversion_window_days: 60 } } };
    expect(pickCredits([old], NOW, s).lastNonDirect?.id).toBe(old.id);
    // A touch a few minutes after the conversion counts within the clock-skew allowance.
    const skewed = paid(new Date(NOW.getTime() + 60_000));
    expect(pickCredits([skewed], NOW, settings, 5 * 60_000).lastTouch?.id).toBe(skewed.id);
  });

  it("is independent of row order, breaking time ties by id", () => {
    const a = paid(ago(5), "google");
    const b = { ...paid(ago(5), "tiktok"), id: "zzz" };
    const x = pickCredits([a, b], NOW, settings);
    const y = pickCredits([b, a], NOW, settings);
    expect(x.lastTouch?.id).toBe("zzz");
    expect(y.lastTouch?.id).toBe("zzz");
    expect(x.firstTouch?.id).toBe(y.firstTouch?.id);
  });

  it("records the evidence of the decision without personal data", () => {
    const p = paid(ago(10));
    const e = creditEvidence(pickCredits([p, direct(ago(1))], NOW, settings), settings);
    expect(e).toMatchObject({ status: "credited", last_non_direct: { id: p.id, channel: "tiktok_ads", window_days: 30 }, last_touch: { channel: "direct" }, last_non_direct_fallback: false });
    expect(creditEvidence(pickCredits([], NOW, settings), settings).status).toBe("no_touch");
  });
});

describe("describeMatch", () => {
  it("states method, confidence and limitations for every match", () => {
    expect(describeMatch("deterministic", "install_referrer")).toEqual({ method: "leanapp_click", confidence: "high", limitations: [] });
    expect(describeMatch("deterministic", "click_id", { deferred: true }).method).toBe("deferred_deep_link");
    expect(describeMatch("deterministic", "ttclid")).toEqual({ method: "network_click_recorded", confidence: "high", limitations: [] });
    expect(describeMatch("reported", "gclid")).toEqual({ method: "network_click_reported", confidence: "medium", limitations: ["self_reported"] });
    expect(describeMatch("reported", "fbclid")).toEqual({ method: "network_click_reported", confidence: "low", limitations: ["self_reported", "click_id_not_proof_of_ad"] });
    expect(describeMatch("reported", "install_referrer").method).toBe("play_install_referrer");
    expect(describeMatch("reported", "utm_parameters")).toEqual({ method: "utm_parameters", confidence: "medium", limitations: ["self_reported"] });
    expect(describeMatch("reported", "referrer")).toEqual({ method: "referrer", confidence: "low", limitations: ["referrer_only"] });
    expect(describeMatch("probabilistic", "ip_ua")).toEqual({ method: "probabilistic_ip_os", confidence: "low", limitations: ["modeled"] });
    expect(describeMatch("organic", "store_organic").method).toBe("store_organic");
    expect(describeMatch("organic", "direct").method).toBe("direct");
    expect(describeMatch("organic", null, { ios: true })).toEqual({ method: "none", confidence: "none", limitations: ["no_evidence", "ios_no_click_id"] });
  });
});

describe("webTouchOf", () => {
  const web = (attribution: Record<string, string>, extra: Record<string, unknown> = {}) => webTouchOf({ attribution, ...extra }, "web");

  it("reads UTM parameters, click ids, landing page and an external referrer", () => {
    const w = web({ utm_source: "newsletter", utm_medium: "email", utm_campaign: "june", landing_url: "https://shop.example.com/p?utm_source=x&email=a@b.c", referrer: "https://mail.google.com/" })!;
    expect(w.signals.utm).toMatchObject({ source: "newsletter", medium: "email", campaign: "june" });
    expect(w.landingPage).toBe("https://shop.example.com/p");
    expect(w.landingHost).toBe("shop.example.com");
    expect(w.referrerHost).toBe("mail.google.com");
    expect(webMatch(w)).toEqual({ matchType: "reported", matchKey: "utm_parameters" });
    expect(JSON.stringify(w)).not.toContain("a@b.c");
  });

  it("takes UTM parameters left in the landing URL when the context has none", () => {
    const w = web({ landing_url: "https://example.com/?utm_source=tiktok&utm_medium=paid_social&ttclid=E.C.P.1" })!;
    expect(w.signals.utm.source).toBe("tiktok");
    expect(w.signals.networkClickId).toMatchObject({ param: "ttclid", network: "tiktok" });
    expect(webMatch(w)).toEqual({ matchType: "reported", matchKey: "ttclid" });
  });

  it("is a touch with only a click id or only an external referrer", () => {
    expect(webMatch(web({ gclid: "Cj0-abc" })!)).toEqual({ matchType: "reported", matchKey: "gclid" });
    const ref = web({ referrer: "https://www.google.com/", landing_url: "https://example.com/" })!;
    expect(webMatch(ref)).toEqual({ matchType: "reported", matchKey: "referrer" });
    expect(ref.referrerHost).toBe("google.com");
  });

  it("is no touch without evidence: missing UTMs, internal referrer, not web, consent denied", () => {
    expect(web({ landing_url: "https://example.com/pricing" })).toBeNull();
    expect(web({ landing_url: "https://www.example.com/a", referrer: "https://example.com/b" })).toBeNull();
    expect(web({ landing_url: "https://app.example.com/a", referrer: "https://example.com/b" })).toBeNull();
    expect(web({})).toBeNull();
    expect(webTouchOf({ attribution: { utm_source: "x" } }, "ios")).toBeNull();
    expect(webTouchOf({ attribution: { utm_source: "x" }, platform: "web" }, null)).not.toBeNull();
    expect(web({ utm_source: "x" }, { consent: { attribution: false } })).toBeNull();
  });

  it("marks direct parameters as a direct touch, never as a source", () => {
    expect(webMatch(web({ utm_source: "(direct)", utm_medium: "(none)" })!)).toEqual({ matchType: "organic", matchKey: "direct" });
  });

  it("gives the same evidence the same signature, whatever else changes", () => {
    const a = web({ utm_source: "x", utm_campaign: "c", landing_url: "https://e.com/1", touch: "latest" })!;
    const b = web({ utm_source: "X", utm_campaign: "c", landing_url: "https://e.com/2" })!;
    const c = web({ utm_source: "x", utm_campaign: "d" })!;
    expect(a.signature).toBe(b.signature);
    expect(a.signature).not.toBe(c.signature);
    expect(a.touch).toBe("latest");
    expect(a.keys).toEqual(["landing_url", "utm_campaign", "utm_source"]);
    expect(fnv1a("")).toBe("811c9dc5");
  });

  it("keeps campaign, ad set and ad ids", () => {
    const w = web({ utm_source: "facebook", utm_medium: "paid_social", campaign_id: "120200", adset_id: "120201", ad_id: "120202", fbclid: "IwAR1" })!;
    expect(w).toMatchObject({ campaignId: "120200", adsetId: "120201", adId: "120202" });
  });
});
