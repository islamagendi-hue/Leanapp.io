import { msg } from "@/i18n/translate";
import { ProviderError, qs, requestJson, type Classifier } from "./http";
import { missingFields, num, type AdAdapter, type AdDailyRow } from "./types";

/**
 * TikTok API for Business (Marketing API v1.3), read-only reporting.
 *   GET business-api.tiktok.com/open_api/v1.3/advertiser/info/        advertiser name, currency, timezone
 *   GET business-api.tiktok.com/open_api/v1.3/report/integrated/get/  BASIC report, AUCTION_AD level,
 *       dimensions ad_id + stat_time_day, page / page_size (≤ 1000)
 * Header Access-Token. TikTok answers HTTP 200 with a non-zero `code` on
 * errors; code 40100 (too many requests) is retried. Advertiser access tokens
 * are long-lived: there is no refresh step.
 * NOT VERIFIED against a live advertiser account.
 */
const HOST = "business-api.tiktok.com";
const BASE = `https://${HOST}/open_api/v1.3`;

export const tiktokClassifier: Classifier = (status, body) => {
  const b = body as { code?: number; message?: string; request_id?: string } | null;
  if (status >= 200 && status < 300 && b && b.code === 0) return null;
  const code = b?.code;
  const text = `TikTok ${status}${code !== undefined ? ` (code ${code})` : ""}: ${b?.message ?? "request failed"}${b?.request_id ? ` [request_id ${b.request_id}]` : ""}`;
  const pc = code !== undefined ? String(code) : null;
  if (status === 429 || code === 40100) return new ProviderError("rate_limited", text, status, pc);
  if (status === 401 || status === 403 || /access[_ ]token|unauthori[sz]ed|permission/i.test(b?.message ?? "")) return new ProviderError("auth", text, status, pc);
  if (status >= 500) return new ProviderError("transient", text, status, pc);
  return new ProviderError("permanent", text, status, pc);
};

const ids = (v: string | undefined) => (v ?? "").split(/[\s,]+/).map((x) => x.replace(/\D/g, "")).filter(Boolean);
const PAGE_SIZE = 1000;

export const tiktokAdapter: AdAdapter = {
  provider: "tiktok_ads",
  defaultSpendSource: "tiktok",
  secrets: [{ key: "access_token", label: msg("Marketing API access token"), required: true }],
  settings: [{ key: "ad_account_ids", label: msg("Advertiser IDs (comma-separated, digits)"), required: true, pattern: /^[\d,\s]+$/ }],
  missing: (secrets, settings) => [...missingFields(tiktokAdapter.secrets, secrets), ...missingFields(tiktokAdapter.settings, settings)],

  async prepare(secrets) {
    if (!secrets.access_token) throw new ProviderError("auth", "No access token stored.");
    return { accessToken: secrets.access_token };
  },

  async listAccounts(session, settings, http) {
    const wanted = ids(settings.ad_account_ids);
    if (!wanted.length) return [];
    const body: { data?: { list?: { advertiser_id?: string | number; name?: string; currency?: string; timezone?: string }[] } } = await requestJson(
      { url: `${BASE}/advertiser/info/?${qs({ advertiser_ids: wanted, fields: ["advertiser_id", "name", "currency", "timezone"] })}`, headers: { "Access-Token": session.accessToken }, allowedHosts: [HOST] },
      tiktokClassifier,
      http,
    );
    return (body.data?.list ?? []).map((a) => ({ id: String(a.advertiser_id ?? ""), name: a.name ?? null, currency: a.currency ?? null, timezone: a.timezone ?? null })).filter((a) => a.id);
  },

  async report(session, _settings, q, http) {
    if (!q.account.currency) throw new ProviderError("permanent", "TikTok did not return the advertiser's currency.");
    const page = q.cursor ? Number(q.cursor) : 1;
    const body: { data?: { list?: { dimensions?: Record<string, string>; metrics?: Record<string, string> }[]; page_info?: { page?: number; total_page?: number } } } = await requestJson(
      {
        url: `${BASE}/report/integrated/get/?${qs({
          advertiser_id: q.account.id,
          report_type: "BASIC",
          data_level: "AUCTION_AD",
          dimensions: ["ad_id", "stat_time_day"],
          metrics: ["campaign_id", "campaign_name", "adgroup_id", "adgroup_name", "ad_name", "spend", "impressions", "clicks", "conversion"],
          start_date: q.from,
          end_date: q.to,
          page,
          page_size: PAGE_SIZE,
        })}`,
        headers: { "Access-Token": session.accessToken },
        allowedHosts: [HOST],
      },
      tiktokClassifier,
      http,
    );
    const rows: AdDailyRow[] = (body.data?.list ?? []).map(({ dimensions: d = {}, metrics: m = {} }) => ({
      day: String(d.stat_time_day ?? "").slice(0, 10),
      accountId: q.account.id,
      currency: q.account.currency!.toUpperCase(),
      campaignId: String(m.campaign_id ?? ""),
      campaignName: m.campaign_name ?? null,
      adsetId: String(m.adgroup_id ?? ""),
      adsetName: m.adgroup_name ?? null,
      adId: String(d.ad_id ?? ""),
      adName: m.ad_name ?? null,
      impressions: num(m.impressions),
      clicks: num(m.clicks),
      spend: num(m.spend),
      conversions: m.conversion === undefined ? null : num(m.conversion),
    }));
    const total = body.data?.page_info?.total_page ?? 1;
    return { rows, next: page < total ? String(page + 1) : undefined };
  },
};
