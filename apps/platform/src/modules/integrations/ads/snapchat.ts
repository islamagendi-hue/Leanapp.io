import { msg } from "@/i18n/translate";
import { addDays } from "../status";
import { ProviderError, qs, requestJson, type Classifier } from "./http";
import { missingFields, num, type AdAdapter, type AdDailyRow, type Secrets } from "./types";

/**
 * Snap Marketing API, read-only reporting.
 *   POST accounts.snapchat.com/login/oauth2/access_token      refresh_token → access token (short-lived; refresh
 *                                                             tokens may rotate and are stored again)
 *   GET  adsapi.snapchat.com/v1/adaccounts/{id}               name, currency, timezone
 *   GET  adsapi.snapchat.com/v1/adaccounts/{id}/campaigns     campaign names (paging.next_link)
 *   GET  adsapi.snapchat.com/v1/adaccounts/{id}/stats         granularity=DAY, breakdown=campaign,
 *                                                             fields=impressions,swipes,spend (spend in micro-currency)
 * Day boundaries are the ad account's timezone (start_time / end_time at local midnight).
 * Reported at campaign level: ad set and ad ids stay empty. Swipes are counted as clicks.
 * NOT VERIFIED against a live Snap ad account.
 */
const API = "adsapi.snapchat.com";
const AUTH = "accounts.snapchat.com";

export const snapClassifier: Classifier = (status, body) => {
  const b = body as { request_status?: string; debug_message?: string; display_message?: string; error_code?: string; request_id?: string } | null;
  if (status >= 200 && status < 300 && (!b?.request_status || b.request_status.toUpperCase() === "SUCCESS")) return null;
  const text = `Snap ${status}${b?.error_code ? ` (${b.error_code})` : ""}: ${b?.debug_message ?? b?.display_message ?? "request failed"}${b?.request_id ? ` [request_id ${b.request_id}]` : ""}`;
  if (status === 401 || status === 403) return new ProviderError("auth", text, status, b?.error_code ?? null);
  if (status === 429) return new ProviderError("rate_limited", text, status, b?.error_code ?? null);
  if (status >= 500) return new ProviderError("transient", text, status, b?.error_code ?? null);
  return new ProviderError("permanent", text, status, b?.error_code ?? null);
};

const tokenClassifier: Classifier = (status, body) => {
  if (status >= 200 && status < 300) return null;
  const err = (body as { error?: string } | null)?.error;
  if (status === 400 || status === 401) return new ProviderError("auth", `Snap OAuth ${status}${err ? `: ${err}` : ""}`, status, err ?? null);
  return status >= 500 || status === 429 ? new ProviderError("transient", `Snap OAuth ${status}`, status) : new ProviderError("permanent", `Snap OAuth ${status}`, status);
};

/** "+03:00" style UTC offset of `timeZone` at local midnight of `day`. */
export function utcOffset(timeZone: string, day: string): string {
  const probe = new Date(`${day}T12:00:00Z`);
  const part = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "longOffset" }).formatToParts(probe).find((p) => p.type === "timeZoneName")?.value ?? "GMT";
  const m = /GMT([+-]\d{2}):?(\d{2})?/.exec(part);
  return m ? `${m[1]}:${m[2] ?? "00"}` : "+00:00";
}

export function snapAppCredentials(secrets: Secrets, env: Record<string, string | undefined> = process.env) {
  const own = secrets.oauth_app !== "leanapp";
  return { clientId: own ? secrets.client_id : env.SNAPCHAT_CLIENT_ID, clientSecret: own ? secrets.client_secret : env.SNAPCHAT_CLIENT_SECRET };
}

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

export const snapchatAdapter: AdAdapter = {
  provider: "snapchat_ads",
  defaultSpendSource: "snapchat",
  secrets: [
    { key: "client_id", label: msg("OAuth client ID"), required: true },
    { key: "client_secret", label: msg("OAuth client secret"), required: true },
    { key: "refresh_token", label: msg("OAuth refresh token"), required: true },
  ],
  settings: [{ key: "ad_account_ids", label: msg("Ad account IDs (comma-separated)"), required: true, pattern: /^[0-9a-f,\s-]+$/i }],
  missing(secrets, settings) {
    const own = secrets.oauth_app !== "leanapp";
    const specs = own ? snapchatAdapter.secrets : snapchatAdapter.secrets.filter((s) => s.key === "refresh_token");
    return [...missingFields(specs, secrets), ...missingFields(snapchatAdapter.settings, settings)];
  },

  async prepare(secrets, _settings, http) {
    const app = snapAppCredentials(secrets);
    if (!app.clientId || !app.clientSecret) throw new ProviderError("config", "Snap OAuth client is not configured.");
    if (!secrets.refresh_token) throw new ProviderError("auth", "No refresh token stored.");
    const body: { access_token?: string; refresh_token?: string; expires_in?: number } = await requestJson(
      {
        url: `https://${AUTH}/login/oauth2/access_token`,
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "refresh_token", client_id: app.clientId, client_secret: app.clientSecret, refresh_token: secrets.refresh_token }).toString(),
        allowedHosts: [AUTH],
      },
      tokenClassifier,
      http,
    );
    if (!body.access_token) throw new ProviderError("auth", "Snap returned no access token.");
    const rotated = body.refresh_token && body.refresh_token !== secrets.refresh_token ? { ...secrets, refresh_token: body.refresh_token } : undefined;
    return { accessToken: body.access_token, updatedSecrets: rotated, expiresAt: body.expires_in ? new Date(Date.now() + body.expires_in * 1000) : null };
  },

  async listAccounts(session, settings, http) {
    const out = [];
    for (const id of (settings.ad_account_ids ?? "").split(/[\s,]+/).filter(Boolean)) {
      const body: { adaccounts?: { adaccount?: { id?: string; name?: string; currency?: string; timezone?: string } }[] } = await requestJson(
        { url: `https://${API}/v1/adaccounts/${encodeURIComponent(id)}`, headers: auth(session.accessToken), allowedHosts: [API] },
        snapClassifier,
        http,
      );
      const a = body.adaccounts?.[0]?.adaccount;
      if (a?.id) out.push({ id: a.id, name: a.name ?? null, currency: a.currency ?? null, timezone: a.timezone ?? null });
    }
    return out;
  },

  async report(session, _settings, q, http) {
    const tz = q.account.timezone || "UTC";
    if (!q.account.currency) throw new ProviderError("permanent", "Snap did not return the ad account's currency.");
    // Campaign names (one listing per report call; accounts rarely have more than a few hundred campaigns).
    const names = new Map<string, string>();
    let next: string | undefined = `https://${API}/v1/adaccounts/${encodeURIComponent(q.account.id)}/campaigns`;
    for (let page = 0; next && page < 20; page++) {
      const body: { campaigns?: { campaign?: { id?: string; name?: string } }[]; paging?: { next_link?: string } } = await requestJson({ url: next, headers: auth(session.accessToken), allowedHosts: [API] }, snapClassifier, http);
      for (const c of body.campaigns ?? []) if (c.campaign?.id) names.set(c.campaign.id, c.campaign.name ?? "");
      next = body.paging?.next_link;
    }
    const end = addDays(q.to, 1);
    const body: {
      timeseries_stats?: { timeseries_stat?: { breakdown_stats?: { campaign?: { id?: string; timeseries?: { start_time?: string; stats?: Record<string, number> }[] }[] } } }[];
    } = await requestJson(
      {
        url: `https://${API}/v1/adaccounts/${encodeURIComponent(q.account.id)}/stats?${qs({
          granularity: "DAY",
          breakdown: "campaign",
          fields: "impressions,swipes,spend",
          start_time: `${q.from}T00:00:00${utcOffset(tz, q.from)}`,
          end_time: `${end}T00:00:00${utcOffset(tz, end)}`,
        })}`,
        headers: auth(session.accessToken),
        allowedHosts: [API],
      },
      snapClassifier,
      http,
    );
    const rows: AdDailyRow[] = [];
    for (const s of body.timeseries_stats ?? []) {
      for (const c of s.timeseries_stat?.breakdown_stats?.campaign ?? []) {
        for (const p of c.timeseries ?? []) {
          const day = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(String(p.start_time)));
          rows.push({
            day, accountId: q.account.id, currency: q.account.currency.toUpperCase(),
            campaignId: String(c.id ?? ""), campaignName: names.get(String(c.id)) || null,
            adsetId: "", adsetName: null, adId: "", adName: null,
            impressions: num(p.stats?.impressions), clicks: num(p.stats?.swipes),
            spend: Math.round(num(p.stats?.spend) / 10_000) / 100, conversions: null,
          });
        }
      }
    }
    return { rows };
  },
};
