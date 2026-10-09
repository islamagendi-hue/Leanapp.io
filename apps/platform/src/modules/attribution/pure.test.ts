import { describe, expect, it } from "vitest";
import { buildRequest, networkEventName } from "./networks";
import {
  backoffSeconds, clickSignals, isOrganicUtm, mergeCampaignRows, destinationFor, expandMacros, extractRevenue, isBot, isPrefetch, MAX_POSTBACK_ATTEMPTS, networkOfSource,
  parseQuery, parseUserAgent, retryable, unknownMacros, type LinkDestinations,
} from "./pure";
import { assertPostbackUrlShape, isPrivateAddress } from "./url-safety";

const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1";
const ANDROID = "Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36";
const DESKTOP = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const TIKTOK_INAPP = "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/120.0 Mobile Safari/537.36 trill_330 BytedanceWebview/d8a21c6";

const link: LinkDestinations = {
  code: "abc12345", source: "tiktok", medium: "paid_social", campaign: "ramadan", ad_group: "ksa", creative: "v1",
  ios_url: "https://apps.apple.com/app/id123", android_url: "https://play.google.com/store/apps/details?id=com.example",
  web_url: "https://example.com/app", deep_link_path: "/offers/ramadan",
};

describe("user agents and bots", () => {
  it("classifies platforms", () => {
    expect(parseUserAgent(IPHONE)).toEqual({ os: "ios", major: "17" });
    expect(parseUserAgent(ANDROID)).toEqual({ os: "android", major: "14" });
    expect(parseUserAgent(DESKTOP).os).toBe("other");
  });
  it("filters crawlers, unfurlers and scripts but not in-app browsers", () => {
    for (const ua of ["facebookexternalhit/1.1", "Twitterbot/1.0", "WhatsApp/2.23.20.0 A", "Slackbot-LinkExpanding 1.0", "curl/8.4.0", "Googlebot/2.1 (+http://www.google.com/bot.html)", "", null]) {
      expect(isBot(ua), String(ua)).toBe(true);
    }
    for (const ua of [IPHONE, ANDROID, DESKTOP, TIKTOK_INAPP]) expect(isBot(ua)).toBe(false);
  });
  it("detects prefetches", () => {
    expect(isPrefetch(new Headers({ "sec-purpose": "prefetch;prerender" }))).toBe(true);
    expect(isPrefetch(new Headers({ purpose: "prefetch" }))).toBe(true);
    expect(isPrefetch(new Headers({ accept: "text/html" }))).toBe(false);
  });
});

describe("destinations", () => {
  it("sends Android to Play with the click id in the referrer", () => {
    const url = new URL(destinationFor(link, "android", "lac_123456789"));
    expect(url.host).toBe("play.google.com");
    expect(url.searchParams.get("id")).toBe("com.example");
    const ref = new URLSearchParams(url.searchParams.get("referrer")!);
    expect(ref.get("click_id")).toBe("lac_123456789");
    expect(ref.get("utm_source")).toBe("tiktok");
    expect(ref.get("utm_campaign")).toBe("ramadan");
    expect(ref.get("deep_link")).toBe("/offers/ramadan");
  });
  it("sends iOS to the App Store and others to the web fallback", () => {
    expect(destinationFor(link, "ios", "lac_x")).toBe("https://apps.apple.com/app/id123");
    const web = new URL(destinationFor(link, "other", "lac_123456789"));
    expect(web.host).toBe("example.com");
    expect(web.searchParams.get("click_id")).toBe("lac_123456789");
  });
  it("falls back when a destination is missing", () => {
    expect(destinationFor({ ...link, ios_url: null }, "ios", null)).toMatch(/^https:\/\/example\.com\/app/);
    expect(destinationFor({ ...link, web_url: null }, "other", null)).toBe("https://apps.apple.com/app/id123");
  });
});

describe("click signals", () => {
  it("reads the install referrer from context.campaign (native SDKs)", () => {
    const s = clickSignals({ campaign: { install_referrer: "click_id=lac_abcdefgh12&utm_source=tiktok&utm_campaign=ramadan", referrer_click_timestamp_seconds: 1 } });
    expect(s.clickId).toEqual({ value: "lac_abcdefgh12", key: "install_referrer" });
    expect(s.utm.source).toBe("tiktok");
  });
  it("decodes a URL-encoded referrer", () => {
    expect(clickSignals({ attribution: { install_referrer: "click_id%3Dlac_abcdefgh12%26utm_source%3Dsnap" } }).clickId?.value).toBe("lac_abcdefgh12");
  });
  it("reads click ids from deep links and context, ignoring foreign click_id values", () => {
    expect(clickSignals({ attribution: { deep_link_url: "myapp://offers?click_id=lac_abcdefgh12" } }).clickId?.key).toBe("deep_link");
    expect(clickSignals({ attribution: { click_id: "lac_abcdefgh12" } }).clickId?.key).toBe("click_id");
    expect(clickSignals({ attribution: { click_id: "someone-elses-id" } }).clickId).toBeNull();
  });
  it("finds ad-network click ids", () => {
    expect(clickSignals({ attribution: { ttclid: "E.C.P.abc" } }).networkClickId).toEqual({ param: "ttclid", value: "E.C.P.abc", network: "tiktok" });
    expect(clickSignals({ campaign: { gclid: "Cj0K" } }).networkClickId?.network).toBe("google");
    expect(clickSignals({ attribution: { ScCid: "x1" } }).networkClickId?.network).toBe("snapchat");
    expect(clickSignals({}).networkClickId).toBeNull();
  });
  it("survives odd shapes", () => {
    expect(clickSignals({ attribution: "nope", campaign: [1, 2] } as never).clickId).toBeNull();
    expect(parseQuery("%E0%A4%A")).toEqual({});
  });
  it("maps sources to networks", () => {
    expect(networkOfSource("TikTok Ads")).toBe("tiktok");
    expect(networkOfSource("instagram")).toBe("meta");
    expect(networkOfSource("google_ads")).toBe("google");
    expect(networkOfSource("snapchat")).toBe("snapchat");
    expect(networkOfSource("newsletter")).toBeNull();
  });
});

describe("revenue", () => {
  it("extracts revenue and currency", () => {
    expect(extractRevenue("purchase_completed", { revenue: 549, currency: "sar" })).toEqual({ revenue: 549, currency: "SAR" });
    expect(extractRevenue("subscription_started", { price: "29", currency: "AED" })).toEqual({ revenue: 29, currency: "AED" });
    expect(extractRevenue("refund_completed", { refund_amount: 100, currency: "SAR" })).toEqual({ revenue: -100, currency: "SAR" });
    expect(extractRevenue("signup_completed", {})).toEqual({ revenue: null, currency: null });
  });
});

describe("postback macros and retries", () => {
  it("expands and validates macros", () => {
    expect(expandMacros("https://x.io/p?c={click_id}&e={event}&v={revenue}&m={unknown}", { click_id: "lac_a b", event: "install", revenue: null }))
      .toBe("https://x.io/p?c=lac_a%20b&e=install&v=&m=");
    expect(unknownMacros("https://x.io/?a={click_id}&b={nope}")).toEqual(["nope"]);
  });
  it("backs off then gives up", () => {
    expect([1, 2, 3, 4, 5].map(backoffSeconds)).toEqual([60, 300, 1800, 7200, 43200]);
    expect(backoffSeconds(MAX_POSTBACK_ATTEMPTS)).toBeNull();
    expect(retryable(null)).toBe(true);
    expect(retryable(503)).toBe(true);
    expect(retryable(429)).toBe(true);
    expect(retryable(400)).toBe(false);
  });
});

describe("network requests (not verified with live networks)", () => {
  const payload = { event: "install", event_id: "install:1", timestamp: 1_700_000_000, network_click_id: "abc", revenue: null, currency: null, platform: "android" };
  it("builds TikTok, Snap and Meta requests", () => {
    const tt = buildRequest("tiktok", { config: { tiktok_app_id: "7123" }, credentials: { access_token: "tok" }, payload: { ...payload, network_click_param: "ttclid" } });
    expect(tt.ok && tt.request.headers["Access-Token"]).toBe("tok");
    expect(tt.ok && JSON.parse(tt.request.body!).data[0]).toMatchObject({ event: "InstallApp", user: { ttclid: "abc" }, event_id: "install:1" });
    const snap = buildRequest("snapchat", { config: { snap_app_id: "s1" }, credentials: { access_token: "tok" }, payload: { ...payload, network_click_param: "ScCid" } });
    expect(snap.ok && snap.request.url).toBe("https://tr.snapchat.com/v3/s1/events?access_token=tok");
    const meta = buildRequest("meta", { config: { dataset_id: "d1" }, credentials: { access_token: "tok" }, payload: { ...payload, event: "purchase_completed", revenue: 10, currency: "SAR" } });
    expect(meta.ok && JSON.parse(meta.request.body!).data[0]).toMatchObject({ event_name: "Purchase", custom_data: { value: 10, currency: "SAR" } });
  });
  it("requires a Google click id and token for Google Ads", () => {
    const cfg = { customer_id: "123-456-7890", conversion_action_id: "99" };
    expect(buildRequest("google", { config: cfg, credentials: { developer_token: "d" }, payload, accessToken: "at" }).ok).toBe(false);
    const g = buildRequest("google", { config: cfg, credentials: { developer_token: "d" }, payload: { ...payload, network_click_param: "gclid" }, accessToken: "at" });
    expect(g.ok && g.request.url).toBe("https://googleads.googleapis.com/v18/customers/1234567890:uploadClickConversions");
    expect(g.ok && JSON.parse(g.request.body!).conversions[0]).toMatchObject({ gclid: "abc", conversionAction: "customers/1234567890/conversionActions/99" });
  });
  it("names events per network and honours overrides", () => {
    expect(networkEventName("snapchat", { event: "re_engagement" })).toBe("APP_OPEN");
    expect(networkEventName("tiktok", { event: "signup_completed" })).toBe("CompleteRegistration");
    expect(networkEventName("tiktok", { event: "install" }, { install: "Download" })).toBe("Download");
  });
});

describe("postback URL safety", () => {
  it("blocks private destinations when deployed", () => {
    const prod = { VERCEL_ENV: "production" };
    expect(() => assertPostbackUrlShape("http://example.com/x", prod)).toThrow();
    expect(() => assertPostbackUrlShape("https://127.0.0.1/x", prod)).toThrow();
    expect(() => assertPostbackUrlShape("https://localhost/x", prod)).toThrow();
    expect(() => assertPostbackUrlShape("https://user:pw@example.com/x", prod)).toThrow();
    expect(assertPostbackUrlShape("https://example.com/x", prod).host).toBe("example.com");
    expect(assertPostbackUrlShape("http://127.0.0.1:9999/x", {}).port).toBe("9999");
  });
  it("knows private ranges", () => {
    for (const ip of ["10.1.2.3", "172.16.0.1", "192.168.1.1", "169.254.169.254", "127.0.0.1", "::1", "fd00::1", "::ffff:10.0.0.1", "100.64.0.1"]) expect(isPrivateAddress(ip), ip).toBe(true);
    for (const ip of ["8.8.8.8", "2001:4860:4860::8888"]) expect(isPrivateAddress(ip), ip).toBe(false);
  });
});

describe("isOrganicUtm", () => {
  it("treats store and direct referrers as organic, campaigns as not", () => {
    expect(isOrganicUtm({ source: "google-play", medium: "organic" })).toBe(true);
    expect(isOrganicUtm({ source: "(direct)", medium: "(none)" })).toBe(true);
    expect(isOrganicUtm({ source: "Organic" })).toBe(true);
    expect(isOrganicUtm({ source: "tiktok", medium: "paid" })).toBe(false);
    expect(isOrganicUtm({ source: "google", medium: "cpc" })).toBe(false);
    expect(isOrganicUtm({})).toBe(false);
  });
});

describe("mergeCampaignRows", () => {
  it("gives one row per source and campaign, revenue kept per currency", () => {
    const rows = mergeCampaignRows([
      { source: "tiktok", campaign: "eid", currency: "SAR", conversions: 30, revenue: 3000 },
      { source: "tiktok", campaign: "eid", currency: null, conversions: 100, revenue: 0 },
      { source: "tiktok", campaign: "eid", currency: "AED", conversions: 2, revenue: 150 },
      { source: "meta", campaign: null, currency: null, conversions: 5, revenue: 0 },
    ]);
    expect(rows).toEqual([
      { source: "tiktok", campaign: "eid", conversions: 132, revenue: [{ currency: "SAR", amount: 3000 }, { currency: "AED", amount: 150 }] },
      { source: "meta", campaign: null, conversions: 5, revenue: [] },
    ]);
  });
});
