/**
 * Ad-provider adapters against mocked HTTP (no real provider is called).
 * These check our request shapes, paging, parsing, retries and error
 * classification as documented by each provider; they are not a live verification.
 */
import { describe, expect, it } from "vitest";
import { googleAdapter, gaqlFor } from "./google";
import { backoffMs, ProviderError, requestJson, type HttpOptions } from "./http";
import { metaAdapter, metaClassifier, metaConversions } from "./meta";
import { snapchatAdapter, utcOffset } from "./snapchat";
import { tiktokAdapter, tiktokClassifier } from "./tiktok";

interface Call { url: string; init: RequestInit }
type Reply = { status?: number; body: unknown; headers?: Record<string, string> };

function fakeFetch(handler: (url: URL, init: RequestInit, n: number) => Reply) {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const r = handler(new URL(url), init, calls.length);
    return new Response(typeof r.body === "string" ? r.body : JSON.stringify(r.body), { status: r.status ?? 200, headers: r.headers });
  }) as unknown as typeof fetch;
  const http: HttpOptions = { fetchImpl, baseDelayMs: 0, sleep: async () => {} };
  return { calls, http };
}

describe("http", () => {
  it("retries rate limits and transient errors, then succeeds", async () => {
    const { calls, http } = fakeFetch((_u, _i, n) => (n === 1 ? { status: 429, body: {}, headers: { "retry-after": "0" } } : n === 2 ? { status: 503, body: {} } : { body: { ok: 1 } }));
    await expect(requestJson({ url: "https://graph.facebook.com/x", allowedHosts: ["graph.facebook.com"] }, metaClassifier, http)).resolves.toEqual({ ok: 1 });
    expect(calls).toHaveLength(3);
  });

  it("does not retry permanent or auth errors, and stops at the attempt limit", async () => {
    const auth = fakeFetch(() => ({ status: 400, body: { error: { code: 190, message: "expired", fbtrace_id: "Ab1" } } }));
    const err = await requestJson<never>({ url: "https://graph.facebook.com/x", allowedHosts: ["graph.facebook.com"] }, metaClassifier, auth.http).catch((e: unknown) => e as ProviderError);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err).toMatchObject({ kind: "auth", providerCode: "190" });
    expect(err.message).toContain("fbtrace_id Ab1");
    expect(auth.calls).toHaveLength(1);

    const busy = fakeFetch(() => ({ status: 400, body: { error: { code: 17, message: "User request limit reached" } } }));
    await expect(requestJson({ url: "https://graph.facebook.com/x", allowedHosts: ["graph.facebook.com"] }, metaClassifier, { ...busy.http, maxAttempts: 3 })).rejects.toMatchObject({ kind: "rate_limited" });
    expect(busy.calls).toHaveLength(3);
  });

  it("refuses unexpected hosts (paging URLs from responses) and respects the request budget", async () => {
    const { calls, http } = fakeFetch(() => ({ body: {} }));
    await expect(requestJson({ url: "https://evil.example/x", allowedHosts: ["graph.facebook.com"] }, metaClassifier, http)).rejects.toMatchObject({ kind: "permanent" });
    await expect(requestJson({ url: "http://graph.facebook.com/x", allowedHosts: ["graph.facebook.com"] }, metaClassifier, http)).rejects.toMatchObject({ kind: "permanent" });
    const budget = { remaining: 1, used: 0 };
    await requestJson({ url: "https://graph.facebook.com/x", allowedHosts: ["graph.facebook.com"] }, metaClassifier, { ...http, budget });
    await expect(requestJson({ url: "https://graph.facebook.com/x", allowedHosts: ["graph.facebook.com"] }, metaClassifier, { ...http, budget })).rejects.toMatchObject({ kind: "rate_limited" });
    expect(calls).toHaveLength(1);
  });

  it("honours Retry-After, else backs off exponentially", () => {
    expect(backoffMs(1, 1000, "5")).toBe(5000);
    expect(backoffMs(3, 1000, null)).toBe(4000);
    expect(backoffMs(20, 1000, null)).toBe(30_000);
  });
});

describe("Meta Marketing API", () => {
  it("lists ad accounts and reads ad-level daily insights across pages", async () => {
    const { calls, http } = fakeFetch((u) => {
      if (u.pathname.endsWith("/me/adaccounts")) return { body: { data: [{ account_id: "123", name: "Main", currency: "SAR", timezone_name: "Asia/Riyadh" }] } };
      if (u.searchParams.get("after") === "p2") return { body: { data: [{ date_start: "2026-10-02", account_currency: "SAR", campaign_id: "c1", campaign_name: "Eid", adset_id: "s1", adset_name: "KSA", ad_id: "a2", ad_name: "Video", impressions: "50", clicks: "4", spend: "3.5" }] } };
      return {
        body: {
          data: [{ date_start: "2026-10-01", account_currency: "SAR", campaign_id: "c1", campaign_name: "Eid", adset_id: "s1", adset_name: "KSA", ad_id: "a1", ad_name: "Img", impressions: "1000", clicks: "20", spend: "12.34", actions: [{ action_type: "mobile_app_install", value: "3" }, { action_type: "link_click", value: "9" }] }],
          paging: { next: "https://graph.facebook.com/v23.0/act_123/insights?after=p2" },
        },
      };
    });
    const session = await metaAdapter.prepare({ access_token: "tok" }, {}, http);
    const settings = { ad_account_ids: "123", conversion_action_types: "mobile_app_install" };
    const accounts = await metaAdapter.listAccounts(session, settings, http);
    expect(accounts).toEqual([{ id: "123", name: "Main", currency: "SAR", timezone: "Asia/Riyadh" }]);
    const p1 = await metaAdapter.report(session, settings, { account: accounts[0], from: "2026-10-01", to: "2026-10-02" }, http);
    expect(p1.rows[0]).toMatchObject({ day: "2026-10-01", campaignId: "c1", adId: "a1", impressions: 1000, clicks: 20, spend: 12.34, conversions: 3, currency: "SAR" });
    const p2 = await metaAdapter.report(session, settings, { account: accounts[0], from: "2026-10-01", to: "2026-10-02", cursor: p1.next }, http);
    expect(p2.next).toBeUndefined();
    expect(p2.rows[0]).toMatchObject({ adId: "a2", conversions: 0 });
    const insights = new URL(calls[1].url);
    expect(insights.pathname).toBe("/v23.0/act_123/insights");
    expect(insights.searchParams.get("level")).toBe("ad");
    expect(insights.searchParams.get("time_increment")).toBe("1");
    expect(JSON.parse(insights.searchParams.get("time_range")!)).toEqual({ since: "2026-10-01", until: "2026-10-02" });
  });

  it("needs a token, an account and a well-formed version", async () => {
    expect(metaAdapter.missing({}, {})).toHaveLength(2);
    expect(metaAdapter.missing({ access_token: "x" }, { ad_account_ids: "1" })).toEqual([]);
    const { http } = fakeFetch(() => ({ body: {} }));
    await expect(metaAdapter.listAccounts({ accessToken: "t" }, { api_version: "23" }, http)).rejects.toMatchObject({ kind: "config" });
    expect(metaConversions(undefined, [])).toBeNull();
  });
});

describe("Google Ads API", () => {
  it("refreshes the token, then pages GAQL results with the developer token", async () => {
    const { calls, http } = fakeFetch((u, init) => {
      if (u.host === "oauth2.googleapis.com") return { body: { access_token: "ya29", expires_in: 3599 } };
      if (u.pathname.endsWith(":listAccessibleCustomers")) return { body: { resourceNames: ["customers/1112223333"] } };
      const body = JSON.parse(String(init.body));
      return body.pageToken
        ? { body: { results: [{ segments: { date: "2026-10-02" }, customer: { currencyCode: "AED" }, campaign: { id: "9", name: "Brand" }, adGroup: { id: "8", name: "G" }, adGroupAd: { ad: { id: "7" } }, metrics: { impressions: "10", clicks: "1", costMicros: "2500000" } }] } }
        : { body: { results: [{ segments: { date: "2026-10-01" }, customer: { currencyCode: "AED" }, campaign: { id: "9", name: "Brand" }, adGroup: { id: "8", name: "G" }, adGroupAd: { ad: { id: "7", name: "" } }, metrics: { impressions: "100", clicks: "5", costMicros: "12340000", conversions: 2.5 } }], nextPageToken: "n2" } };
    });
    const secrets = { developer_token: "dev", client_id: "cid", client_secret: "cs", refresh_token: "rt" };
    const settings = { ad_account_ids: "111-222-3333", api_version: "v21", login_customer_id: "999-000-1111" };
    expect(googleAdapter.missing(secrets, settings)).toEqual([]);
    const session = await googleAdapter.prepare(secrets, settings, http);
    expect(session.accessToken).toBe("ya29");
    expect(await googleAdapter.listAccounts(session, settings, http)).toEqual([{ id: "1112223333", name: null, currency: null, timezone: null }]);
    const account = { id: "1112223333", name: null, currency: null, timezone: null };
    const p1 = await googleAdapter.report(session, settings, { account, from: "2026-10-01", to: "2026-10-02" }, http);
    expect(p1.rows[0]).toMatchObject({ day: "2026-10-01", currency: "AED", campaignId: "9", adsetId: "8", adId: "7", adName: null, spend: 12.34, conversions: 2.5 });
    const p2 = await googleAdapter.report(session, settings, { account, from: "2026-10-01", to: "2026-10-02", cursor: p1.next }, http);
    expect(p2.rows[0].spend).toBe(2.5);
    const search = calls.find((c) => c.url.endsWith("/v21/customers/1112223333/googleAds:search"))!;
    const h = search.init.headers as Record<string, string>;
    expect(h["developer-token"]).toBe("dev");
    expect(h["login-customer-id"]).toBe("9990001111");
    expect(h.Authorization).toBe("Bearer ya29");
    expect(JSON.parse(String(search.init.body)).query).toBe(gaqlFor("2026-10-01", "2026-10-02"));
  });

  it("requires an API version and treats invalid_grant as an auth error", async () => {
    expect(googleAdapter.missing({ refresh_token: "r", oauth_app: "leanapp" }, { ad_account_ids: "1" })).toEqual(["Google Ads API version (e.g. v21)"]);
    const { http } = fakeFetch(() => ({ status: 400, body: { error: "invalid_grant" } }));
    await expect(googleAdapter.prepare({ developer_token: "d", client_id: "c", client_secret: "s", refresh_token: "r" }, {}, http)).rejects.toMatchObject({ kind: "auth" });
    expect(() => gaqlFor("2026-10-01'; DROP", "2026-10-02")).toThrow();
  });
});

describe("TikTok Business API", () => {
  it("reads advertiser info and pages the integrated report", async () => {
    const { calls, http } = fakeFetch((u) => {
      if (u.pathname.endsWith("/advertiser/info/")) return { body: { code: 0, data: { list: [{ advertiser_id: "700", name: "Shop", currency: "USD", timezone: "Etc/GMT" }] } } };
      const page = Number(u.searchParams.get("page"));
      return { body: { code: 0, data: { list: [{ dimensions: { ad_id: `ad${page}`, stat_time_day: "2026-10-01 00:00:00" }, metrics: { campaign_id: "c", campaign_name: "Launch", adgroup_id: "g", adgroup_name: "G", ad_name: "A", spend: "4.20", impressions: "300", clicks: "6", conversion: "2" } }], page_info: { page, total_page: 2 } } } };
    });
    const session = await tiktokAdapter.prepare({ access_token: "tt" }, {}, http);
    const [account] = await tiktokAdapter.listAccounts(session, { ad_account_ids: "700" }, http);
    expect(account).toEqual({ id: "700", name: "Shop", currency: "USD", timezone: "Etc/GMT" });
    const p1 = await tiktokAdapter.report(session, {}, { account, from: "2026-10-01", to: "2026-10-01" }, http);
    expect(p1.next).toBe("2");
    expect(p1.rows[0]).toMatchObject({ day: "2026-10-01", adId: "ad1", spend: 4.2, impressions: 300, conversions: 2, currency: "USD" });
    const p2 = await tiktokAdapter.report(session, {}, { account, from: "2026-10-01", to: "2026-10-01", cursor: p1.next }, http);
    expect(p2.next).toBeUndefined();
    const report = new URL(calls[1].url);
    expect(report.searchParams.get("data_level")).toBe("AUCTION_AD");
    expect(JSON.parse(report.searchParams.get("dimensions")!)).toEqual(["ad_id", "stat_time_day"]);
    expect((calls[1].init.headers as Record<string, string>)["Access-Token"]).toBe("tt");
  });

  it("treats HTTP 200 with a non-zero code as an error, and 40100 as a rate limit", () => {
    expect(tiktokClassifier(200, { code: 0 })).toBeNull();
    expect(tiktokClassifier(200, { code: 40100, message: "Too many requests" })?.kind).toBe("rate_limited");
    expect(tiktokClassifier(200, { code: 40002, message: "Invalid param" })?.kind).toBe("permanent");
  });
});

describe("Snap Marketing API", () => {
  it("refreshes (keeping a rotated refresh token) and reads campaign daily stats in the account's timezone", async () => {
    const { calls, http } = fakeFetch((u) => {
      if (u.host === "accounts.snapchat.com") return { body: { access_token: "snapat", refresh_token: "rt2", expires_in: 1800 } };
      if (u.pathname === "/v1/adaccounts/acc-1") return { body: { request_status: "SUCCESS", adaccounts: [{ adaccount: { id: "acc-1", name: "Snap KSA", currency: "SAR", timezone: "Asia/Riyadh" } }] } };
      if (u.pathname.endsWith("/campaigns")) return { body: { request_status: "SUCCESS", campaigns: [{ campaign: { id: "cmp", name: "Summer" } }] } };
      return {
        body: {
          request_status: "SUCCESS",
          timeseries_stats: [{ timeseries_stat: { breakdown_stats: { campaign: [{ id: "cmp", timeseries: [
            { start_time: "2026-10-01T00:00:00.000+03:00", stats: { impressions: 900, swipes: 30, spend: 15_500_000 } },
            { start_time: "2026-10-02T00:00:00.000+03:00", stats: { impressions: 100, swipes: 2, spend: 1_000_000 } },
          ] }] } } }],
        },
      };
    });
    const secrets = { client_id: "c", client_secret: "s", refresh_token: "rt1" };
    const session = await snapchatAdapter.prepare(secrets, {}, http);
    expect(session.updatedSecrets).toEqual({ ...secrets, refresh_token: "rt2" });
    const [account] = await snapchatAdapter.listAccounts(session, { ad_account_ids: "acc-1" }, http);
    const page = await snapchatAdapter.report(session, {}, { account, from: "2026-10-01", to: "2026-10-02" }, http);
    expect(page.rows).toEqual([
      expect.objectContaining({ day: "2026-10-01", campaignId: "cmp", campaignName: "Summer", impressions: 900, clicks: 30, spend: 15.5, currency: "SAR", adId: "" }),
      expect.objectContaining({ day: "2026-10-02", spend: 1 }),
    ]);
    const stats = new URL(calls.at(-1)!.url);
    expect(stats.searchParams.get("start_time")).toBe("2026-10-01T00:00:00+03:00");
    expect(stats.searchParams.get("end_time")).toBe("2026-10-03T00:00:00+03:00");
    expect(stats.searchParams.get("breakdown")).toBe("campaign");
  });

  it("formats UTC offsets", () => {
    expect(utcOffset("Asia/Riyadh", "2026-10-01")).toBe("+03:00");
    expect(utcOffset("UTC", "2026-10-01")).toBe("+00:00");
    expect(utcOffset("America/New_York", "2026-01-15")).toBe("-05:00");
  });
});
