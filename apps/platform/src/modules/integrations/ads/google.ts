import { msg } from "@/i18n/translate";
import { ProviderError, requestJson, type Classifier, type HttpOptions } from "./http";
import { missingFields, num, type AdAdapter, type AdDailyRow, type Secrets, type Session } from "./types";

/**
 * Google Ads API, read-only reporting.
 *   POST oauth2.googleapis.com/token                                   refresh_token → access token (every run)
 *   GET  googleads.googleapis.com/{version}/customers:listAccessibleCustomers
 *   POST googleads.googleapis.com/{version}/customers/{id}/googleAds:search   GAQL, nextPageToken paging
 * Headers: Authorization Bearer, developer-token, login-customer-id (manager accounts).
 * The API version is required (Google retires versions about yearly; pick a
 * supported one from the release notes). Credentials come from the customer
 * (manual) or, for OAuth connections, LeanApp's own OAuth client and
 * developer token (GOOGLE_ADS_CLIENT_ID / _SECRET / _DEVELOPER_TOKEN).
 * NOT VERIFIED against a live Google Ads account.
 */
const API = "googleads.googleapis.com";
const TOKEN_HOST = "oauth2.googleapis.com";

interface GoogleError { error?: { code?: number; message?: string; status?: string; details?: { errors?: { errorCode?: Record<string, string>; message?: string }[] }[] } }

export const googleClassifier: Classifier = (status, body) => {
  if (status >= 200 && status < 300) return null;
  const e = (body as GoogleError | null)?.error;
  const inner = e?.details?.[0]?.errors?.[0];
  const code = inner?.errorCode ? Object.values(inner.errorCode)[0] : e?.status;
  const text = `Google Ads ${status}${code ? ` (${code})` : ""}: ${inner?.message ?? e?.message ?? "request failed"}`;
  if (status === 401 || code === "UNAUTHENTICATED" || code === "PERMISSION_DENIED" || code === "USER_PERMISSION_DENIED" || code === "DEVELOPER_TOKEN_NOT_APPROVED") {
    return new ProviderError("auth", text, status, code ?? null);
  }
  if (status === 429 || code === "RESOURCE_EXHAUSTED") return new ProviderError("rate_limited", text, status, code ?? null);
  if (status >= 500) return new ProviderError("transient", text, status, code ?? null);
  return new ProviderError("permanent", text, status, code ?? null);
};

const tokenClassifier: Classifier = (status, body) => {
  if (status >= 200 && status < 300) return null;
  const err = (body as { error?: string } | null)?.error;
  if (err === "invalid_grant" || err === "invalid_client" || err === "unauthorized_client") return new ProviderError("auth", `Google OAuth: ${err}`, status, err);
  return status >= 500 || status === 429 ? new ProviderError("transient", `Google OAuth ${status}`, status) : new ProviderError("permanent", `Google OAuth ${status}${err ? `: ${err}` : ""}`, status, err ?? null);
};

const digits = (v: string | undefined) => (v ?? "").replace(/\D/g, "");

/** Client id/secret and developer token: the customer's own, or LeanApp's for OAuth connections. */
export function googleAppCredentials(secrets: Secrets, env: Record<string, string | undefined> = process.env) {
  const own = secrets.oauth_app !== "leanapp";
  return {
    clientId: own ? secrets.client_id : env.GOOGLE_ADS_CLIENT_ID,
    clientSecret: own ? secrets.client_secret : env.GOOGLE_ADS_CLIENT_SECRET,
    developerToken: own ? secrets.developer_token : env.GOOGLE_ADS_DEVELOPER_TOKEN,
  };
}

function version(settings: Record<string, string>) {
  const v = settings.api_version?.trim();
  if (!v || !/^v\d{1,3}$/.test(v)) throw new ProviderError("config", "Set the Google Ads API version (for example v21) to one Google lists as supported.");
  return v;
}

function headers(session: Session, settings: Record<string, string>) {
  const h: Record<string, string> = { Authorization: `Bearer ${session.accessToken}`, "developer-token": session.extra?.developerToken ?? "", "Content-Type": "application/json" };
  const login = digits(settings.login_customer_id);
  if (login) h["login-customer-id"] = login;
  return h;
}

export function gaqlFor(from: string, to: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) throw new ProviderError("config", "Bad date range.");
  return [
    "SELECT segments.date, customer.currency_code, campaign.id, campaign.name, ad_group.id, ad_group.name,",
    "ad_group_ad.ad.id, ad_group_ad.ad.name, metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions",
    `FROM ad_group_ad WHERE segments.date BETWEEN '${from}' AND '${to}'`,
  ].join(" ");
}

export const googleAdapter: AdAdapter = {
  provider: "google_ads",
  defaultSpendSource: "google",
  secrets: [
    { key: "developer_token", label: msg("Developer token"), required: true },
    { key: "client_id", label: msg("OAuth client ID"), required: true },
    { key: "client_secret", label: msg("OAuth client secret"), required: true },
    { key: "refresh_token", label: msg("OAuth refresh token"), required: true },
  ],
  settings: [
    { key: "ad_account_ids", label: msg("Customer IDs (comma-separated, digits)"), required: true, pattern: /^[\d,\s-]+$/ },
    { key: "login_customer_id", label: msg("Manager (login) customer ID"), required: false },
    { key: "api_version", label: msg("Google Ads API version (e.g. v21)"), required: true, pattern: /^v\d{1,3}$/ },
  ],
  missing(secrets, settings) {
    const own = secrets.oauth_app !== "leanapp";
    const secretSpecs = own ? googleAdapter.secrets : googleAdapter.secrets.filter((s) => s.key === "refresh_token");
    return [...missingFields(secretSpecs, secrets), ...missingFields(googleAdapter.settings, settings)];
  },

  async prepare(secrets, _settings, http: HttpOptions) {
    const app = googleAppCredentials(secrets);
    if (!app.clientId || !app.clientSecret || !app.developerToken) throw new ProviderError("config", "Google Ads OAuth client or developer token is not configured.");
    if (!secrets.refresh_token) throw new ProviderError("auth", "No refresh token stored.");
    const body: { access_token?: string; expires_in?: number } = await requestJson(
      {
        url: `https://${TOKEN_HOST}/token`,
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "refresh_token", client_id: app.clientId, client_secret: app.clientSecret, refresh_token: secrets.refresh_token }).toString(),
        allowedHosts: [TOKEN_HOST],
      },
      tokenClassifier,
      http,
    );
    if (!body.access_token) throw new ProviderError("auth", "Google returned no access token.");
    return { accessToken: body.access_token, extra: { developerToken: app.developerToken }, expiresAt: body.expires_in ? new Date(Date.now() + body.expires_in * 1000) : null };
  },

  async listAccounts(session, settings, http) {
    const body: { resourceNames?: string[] } = await requestJson(
      { url: `https://${API}/${version(settings)}/customers:listAccessibleCustomers`, headers: headers(session, settings), allowedHosts: [API] },
      googleClassifier,
      http,
    );
    return (body.resourceNames ?? []).map((r) => ({ id: digits(r), name: null, currency: null, timezone: null })).filter((a) => a.id);
  },

  async report(session, settings, q, http) {
    const customer = digits(q.account.id);
    const body: { results?: Record<string, Record<string, unknown>>[]; nextPageToken?: string } = await requestJson(
      {
        url: `https://${API}/${version(settings)}/customers/${customer}/googleAds:search`,
        method: "POST",
        headers: headers(session, settings),
        body: JSON.stringify({ query: gaqlFor(q.from, q.to), ...(q.cursor ? { pageToken: q.cursor } : {}) }),
        allowedHosts: [API],
      },
      googleClassifier,
      http,
    );
    const rows: AdDailyRow[] = (body.results ?? []).map((r) => {
      const ad = (r.adGroupAd?.ad ?? {}) as Record<string, unknown>;
      return {
        day: String(r.segments?.date),
        accountId: customer,
        currency: String(r.customer?.currencyCode ?? q.account.currency ?? "").toUpperCase(),
        campaignId: String(r.campaign?.id ?? ""),
        campaignName: (r.campaign?.name as string) ?? null,
        adsetId: String(r.adGroup?.id ?? ""),
        adsetName: (r.adGroup?.name as string) ?? null,
        adId: String(ad.id ?? ""),
        adName: (ad.name as string) || null,
        impressions: num(r.metrics?.impressions),
        clicks: num(r.metrics?.clicks),
        spend: Math.round(num(r.metrics?.costMicros) / 10_000) / 100,
        conversions: r.metrics?.conversions === undefined ? 0 : num(r.metrics.conversions),
      };
    });
    return { rows, next: body.nextPageToken || undefined };
  },
};
