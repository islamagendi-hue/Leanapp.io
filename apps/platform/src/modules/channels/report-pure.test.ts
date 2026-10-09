import { describe, expect, it } from "vitest";
import { buildChannelReport, type ChannelReportInput } from "./report-pure";

const key = (o: Partial<{ source: string | null; medium: string | null; network: string | null; match_type: string; match_key: string | null; referrer_host: string | null }> = {}) => ({
  source: null, medium: null, network: null, match_type: "organic", match_key: null, ...o,
});
const fresh = { lastClickAt: null, lastAttributionAt: null, lastProcessedAt: null, lastConversionAt: null, lastSpendDay: null, lastSpendSavedAt: null };

function input(o: Partial<ChannelReportInput> = {}): ChannelReportInput {
  return {
    model: "last_touch", classify: {}, attributions: [], clicks: [], cohort: [], growthMeasured: false, conversions: [], spend: [],
    firstTouchFallback: 0, providerReported: 0, freshness: fresh, ...o,
  };
}

describe("buildChannelReport", () => {
  const tiktok = key({ source: "tiktok", medium: "paid_social", network: "tiktok", match_type: "deterministic" });
  const base = input({
    attributions: [
      { ...tiktok, kind: "install", n: 10, ios: 0 },
      { ...key({ source: "tiktok", match_type: "reported", network: "tiktok" }), kind: "install", n: 4, ios: 1 },
      { ...tiktok, kind: "re_engagement", n: 2, ios: 0 },
      { ...key({ match_key: "store_organic" }), kind: "install", n: 3, ios: 0 },
      { ...key(), kind: "install", n: 7, ios: 5 },
      { ...key({ source: "newsletter", medium: "email", match_type: "deterministic" }), kind: "reinstall", n: 1, ios: 0 },
      { ...key({ source: "tiktok", network: "tiktok", match_type: "probabilistic" }), kind: "install", n: 2, ios: 0 },
    ],
    clicks: [{ source: "tiktok", medium: "paid_social", network: "tiktok", n: 100 }, { source: "qr", medium: "offline", network: null, n: 9 }],
    conversions: [
      { ...tiktok, credited: true, kind: "purchase", currency: "SAR", n: 5, revenue: 500 },
      { ...tiktok, credited: true, kind: "signup", currency: null, n: 8, revenue: 0 },
      { ...key(), credited: false, kind: "purchase", currency: "USD", n: 1, revenue: 9.99 },
    ],
    spend: [{ day: "2026-10-01", source: "tiktok", campaign: "", currency: "SAR", amount: 320 }],
    providerReported: 12,
  });

  it("puts every install, click and conversion on exactly one channel", () => {
    const r = buildChannelReport(base);
    const tk = r.channels.find((c) => c.key === "tiktok_ads")!;
    expect(tk).toMatchObject({ clicks: 100, installs: 16, reengagements: 2, purchases: 5, signups: 8, conversions: 13 });
    expect(tk.evidence).toMatchObject({ deterministic: 10, observed: 4, modeled: 2, none: 0 });
    expect(tk.revenue).toEqual([{ currency: "SAR", amount: 500 }]);
    expect(tk.spend).toEqual([{ currency: "SAR", amount: 320 }]);
    expect(tk.cpi).toEqual([{ currency: "SAR", amount: 20 }]);
    expect(tk.cpa).toEqual([{ currency: "SAR", amount: 64 }]);
    expect(r.channels.find((c) => c.key === "app_store")?.installs).toBe(3);
    expect(r.channels.find((c) => c.key === "email")?.reinstalls).toBe(1);
    expect(r.channels.find((c) => c.key === "qr")?.clicks).toBe(9);
    const sum = r.channels.reduce((s, c) => s + c.installs + c.reinstalls, 0);
    expect(sum).toBe(r.coverage.installs);
    expect(r.totals.conversions).toBe(14);
  });

  it("keeps unattributed apart from organic and reports coverage", () => {
    const r = buildChannelReport(base);
    const un = r.channels.find((c) => c.key === "unattributed")!;
    expect(un).toMatchObject({ installs: 7, group: "none", conversions: 1 });
    expect(r.channels.find((c) => c.key === "app_store")?.group).toBe("organic");
    expect(r.coverage).toMatchObject({ installs: 27, attributed: 20, unattributed: 7, iosUnattributed: 5, conversions: 14, conversionsCredited: 13, providerReported: 12 });
    // Channels with no source sort last.
    expect(r.channels.at(-1)?.group).toBe("none");
  });

  it("reports activation and retention only when measured", () => {
    const cohortRow = { ...tiktok, people: 10, activated: 6, d1_eligible: 10, d1: 4, d7_eligible: 8, d7: 2, d30_eligible: 0, d30: 0 };
    const off = buildChannelReport({ ...base, cohort: [cohortRow] });
    expect(off.channels.find((c) => c.key === "tiktok_ads")).toMatchObject({ newUsers: 10, activated: null, retention: null });
    expect(off.totals.retention).toBeNull();
    const on = buildChannelReport({ ...base, cohort: [cohortRow], growthMeasured: true });
    expect(on.channels.find((c) => c.key === "tiktok_ads")?.retention).toEqual([
      { day: 1, eligible: 10, retained: 4 }, { day: 7, eligible: 8, retained: 2 }, { day: 30, eligible: 0, retained: 0 },
    ]);
    expect(on.totals.activated).toBe(6);
  });

  it("applies custom rules and counts the first-touch fallback only for first touch", () => {
    const r = buildChannelReport({
      ...base, model: "first_touch", firstTouchFallback: 3,
      classify: { customChannels: [{ key: "custom_radio", label: "Radio", group: "paid" }], rules: [{ id: "r", priority: 1, channel: "custom_radio", conditions: { source: ["newsletter"] } }] },
    });
    expect(r.channels.find((c) => c.key === "custom_radio")).toMatchObject({ label: "Radio", reinstalls: 1, builtIn: false });
    expect(r.coverage.firstTouchFallback).toBe(3);
    expect(buildChannelReport({ ...base, firstTouchFallback: 3 }).coverage.firstTouchFallback).toBe(0);
  });
});

describe("web touches, last non-direct and source classes", () => {
  it("counts web touches per channel apart from installs, classifying referrers", () => {
    const r = buildChannelReport(input({
      attributions: [
        { ...key({ source: "newsletter", medium: "email", match_type: "reported", match_key: "utm_parameters" }), kind: "web_touch", n: 4, ios: 0 },
        { ...key({ match_type: "reported", match_key: "referrer", referrer_host: "www.google.com" }), kind: "web_touch", n: 3, ios: 0 },
        { ...key({ match_type: "reported", match_key: "referrer", referrer_host: "blog.partner.io" }), kind: "web_touch", n: 2, ios: 0 },
        { ...key({ source: "direct", match_key: "direct" }), kind: "web_touch", n: 5, ios: 0 },
        { ...key({ source: "zz_unrecognised", match_type: "reported", match_key: "utm_parameters" }), kind: "web_touch", n: 1, ios: 0 },
      ],
    }));
    const by = (k: string) => r.channels.find((c) => c.key === k)!;
    expect(by("email")).toMatchObject({ webTouches: 4, installs: 0, sourceClass: "owned" });
    expect(by("organic_search")).toMatchObject({ webTouches: 3, sourceClass: "organic" });
    expect(by("referral_site")).toMatchObject({ webTouches: 2, sourceClass: "referral" });
    expect(by("direct")).toMatchObject({ webTouches: 5, sourceClass: "direct" });
    expect(by("unknown")).toMatchObject({ webTouches: 1, sourceClass: "unknown" });
    expect(r.totals.webTouches).toBe(15);
    expect(r.coverage).toMatchObject({ webTouches: 15, installs: 0 });
  });

  it("reports the last non-direct fallback only under that model", () => {
    const conv = { ...key({ source: "tiktok", network: "tiktok", match_type: "deterministic" }), credited: true, kind: "purchase" as const, currency: "SAR", n: 2, revenue: 50 };
    const lnd = buildChannelReport(input({ model: "last_non_direct", conversions: [conv], lastNonDirectFallback: 3, firstTouchFallback: 9 }));
    expect(lnd.model).toBe("last_non_direct");
    expect(lnd.coverage).toMatchObject({ lastNonDirectFallback: 3, firstTouchFallback: 0, conversionsCredited: 2 });
    expect(lnd.channels.find((c) => c.key === "tiktok_ads")).toMatchObject({ purchases: 2, sourceClass: "paid" });
    expect(buildChannelReport(input({ conversions: [conv], lastNonDirectFallback: 3 })).coverage.lastNonDirectFallback).toBe(0);
  });

  it("shows conversions with no touch as unattributed", () => {
    const r = buildChannelReport(input({ conversions: [{ ...key(), credited: false, kind: "signup", currency: null, n: 4, revenue: 0 }] }));
    expect(r.channels.find((c) => c.key === "unattributed")).toMatchObject({ signups: 4, sourceClass: "unattributed" });
    expect(r.coverage).toMatchObject({ conversions: 4, conversionsCredited: 0 });
  });
});
