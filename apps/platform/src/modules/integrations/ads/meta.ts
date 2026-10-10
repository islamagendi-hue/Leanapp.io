import { msg } from "@/i18n/translate";
import { ProviderError, qs, requestJson, type Classifier } from "./http";
import { missingFields, num, type AdAdapter, type AdDailyRow } from "./types";

/**
 * Meta Marketing API (Graph API), read-only reporting.
 *   GET graph.facebook.com/{version}/me/adaccounts            ad accounts the token can read
 *   GET graph.facebook.com/{version}/act_{id}/insights         level=ad, time_increment=1
 * Pagination follows `paging.next` (same host only). Token: a system user or
 * long-lived user token with `ads_read`; Meta has no refresh token, so an
 * expired token (error code 190) needs reconnecting.
 * Throttling arrives as HTTP 400/403 with error codes 4, 17, 32, 613 or
 * 80000–80014 and is retried with backoff.
 * NOT VERIFIED against a live ad account (needs the customer's token).
 */
export const META_DEFAULT_VERSION = "v23.0";
const HOST = "graph.facebook.com";

interface MetaError { error?: { message?: string; code?: number; error_subcode?: number; fbtrace_id?: string } }

export const metaClassifier: Classifier = (status, body) => {
  const e = (body as MetaError | null)?.error;
  if (status >= 200 && status < 300 && !e) return null;
  const code = e?.code;
  const text = `Meta ${status}${code ? ` (code ${code}${e?.error_subcode ? `/${e.error_subcode}` : ""})` : ""}: ${e?.message ?? "request failed"}${e?.fbtrace_id ? ` [fbtrace_id ${e.fbtrace_id}]` : ""}`;
  const pc = code != null ? String(code) : null;
  if (code === 190 || code === 102 || code === 10 || (code !== undefined && code >= 200 && code < 300)) return new ProviderError("auth", text, status, pc);
  if (code === 4 || code === 17 || code === 32 || code === 613 || (code !== undefined && code >= 80000 && code <= 80014) || status === 429) {
    return new ProviderError("rate_limited", text, status, pc);
  }
  if (code === 1 || code === 2 || status >= 500) return new ProviderError("transient", text, status, pc);
  return new ProviderError("permanent", text, status, pc);
};

const version = (s: Record<string, string>) => {
  const v = s.api_version?.trim() || META_DEFAULT_VERSION;
  if (!/^v\d{1,3}\.\d$/.test(v)) throw new ProviderError("config", "The Graph API version looks like v23.0.");
  return v;
};

const accountId = (id: string) => id.replace(/^act_/, "").replace(/\D/g, "");

/** Sum of the actions whose type is listed (e.g. "mobile_app_install"); null when none are listed. */
export function metaConversions(actions: unknown, types: string[]): number | null {
  if (!types.length) return null;
  if (!Array.isArray(actions)) return 0;
  return actions.reduce((sum: number, a: { action_type?: string; value?: string }) => (types.includes(String(a?.action_type)) ? sum + num(a?.value) : sum), 0);
}

export const metaAdapter: AdAdapter = {
  provider: "meta_ads",
  defaultSpendSource: "meta",
  secrets: [{ key: "access_token", label: msg("Access token with ads_read (system user recommended)"), required: true }],
  settings: [
    { key: "ad_account_ids", label: msg("Ad account IDs (comma-separated, digits)"), required: true, pattern: /^[\d,\s]+$/ },
    { key: "api_version", label: msg("Graph API version (default v23.0)"), required: false },
    { key: "conversion_action_types", label: msg("Action types counted as conversions (optional, e.g. mobile_app_install)"), required: false },
  ],
  missing: (secrets, settings) => [...missingFields(metaAdapter.secrets, secrets), ...missingFields(metaAdapter.settings, settings)],

  async prepare(secrets) {
    if (!secrets.access_token) throw new ProviderError("auth", "No access token stored.");
    return { accessToken: secrets.access_token };
  },

  async listAccounts(session, settings, http) {
    const out = [];
    let url: string | undefined = `https://${HOST}/${version(settings)}/me/adaccounts?${qs({ fields: "account_id,name,currency,timezone_name", limit: 100, access_token: session.accessToken })}`;
    for (let page = 0; url && page < 20; page++) {
      const body: { data?: { account_id?: string; id?: string; name?: string; currency?: string; timezone_name?: string }[]; paging?: { next?: string } } =
        await requestJson({ url, allowedHosts: [HOST] }, metaClassifier, http);
      for (const a of body.data ?? []) out.push({ id: accountId(a.account_id ?? a.id ?? ""), name: a.name ?? null, currency: a.currency ?? null, timezone: a.timezone_name ?? null });
      url = body.paging?.next;
    }
    return out.filter((a) => a.id);
  },

  async report(session, settings, q, http) {
    const types = (settings.conversion_action_types ?? "").split(/[\s,]+/).filter(Boolean);
    const url = q.cursor ?? `https://${HOST}/${version(settings)}/act_${accountId(q.account.id)}/insights?${qs({
      level: "ad",
      time_increment: 1,
      time_range: { since: q.from, until: q.to },
      fields: ["date_start", "account_currency", "campaign_id", "campaign_name", "adset_id", "adset_name", "ad_id", "ad_name", "impressions", "clicks", "spend", ...(types.length ? ["actions"] : [])].join(","),
      limit: 500,
      access_token: session.accessToken,
    })}`;
    const body: { data?: Record<string, unknown>[]; paging?: { next?: string } } = await requestJson({ url, allowedHosts: [HOST] }, metaClassifier, http);
    const rows: AdDailyRow[] = (body.data ?? []).map((r) => ({
      day: String(r.date_start),
      accountId: accountId(q.account.id),
      currency: String(r.account_currency ?? q.account.currency ?? "").toUpperCase(),
      campaignId: String(r.campaign_id ?? ""),
      campaignName: (r.campaign_name as string) ?? null,
      adsetId: String(r.adset_id ?? ""),
      adsetName: (r.adset_name as string) ?? null,
      adId: String(r.ad_id ?? ""),
      adName: (r.ad_name as string) ?? null,
      impressions: num(r.impressions),
      clicks: num(r.clicks),
      spend: num(r.spend),
      conversions: metaConversions(r.actions, types),
    }));
    return { rows, next: body.paging?.next };
  },
};
