import { ProviderError, qs, requestJson, type Classifier, type HttpOptions } from "./ads/http";
import { META_DEFAULT_VERSION } from "./ads/meta";
import type { AdProvider } from "./registry";

/**
 * OAuth "Connect with …" for ad reporting, through LeanApp's own provider
 * apps. Each needs the operator to register an app with the provider and set
 * its id and secret (env names below); until then the Connect button is not
 * shown and customers paste their own credentials instead. None of these
 * flows has been run against a live provider: connections made this way stay
 * "unverified" until a real call succeeds.
 *
 * CSRF: the state is 32 random bytes, stored only as a SHA-256 hash bound to
 * the user, organization and environment, single-use, valid 10 minutes, and
 * also set as an httpOnly SameSite=Lax cookie that must match on return
 * (service.ts / the callback route).
 */
export const OAUTH_ENV: Record<AdProvider, { id: string; secret: string; extra?: string[] }> = {
  meta_ads: { id: "META_APP_ID", secret: "META_APP_SECRET" },
  google_ads: { id: "GOOGLE_ADS_CLIENT_ID", secret: "GOOGLE_ADS_CLIENT_SECRET", extra: ["GOOGLE_ADS_DEVELOPER_TOKEN"] },
  tiktok_ads: { id: "TIKTOK_APP_ID", secret: "TIKTOK_APP_SECRET" },
  snapchat_ads: { id: "SNAPCHAT_CLIENT_ID", secret: "SNAPCHAT_CLIENT_SECRET" },
};

type Env = Record<string, string | undefined>;

export function oauthConfigured(provider: AdProvider, env: Env = process.env): boolean {
  const e = OAUTH_ENV[provider];
  return [e.id, e.secret, ...(e.extra ?? [])].every((k) => Boolean(env[k]?.trim()));
}

export const OAUTH_STATE_TTL_SECONDS = 600;
export const OAUTH_COOKIE = "la_oauth_state";

export function redirectUri(appUrl: string, provider: AdProvider): string {
  return `${appUrl.replace(/\/$/, "")}/integrations/oauth/${provider}/callback`;
}

export function authorizeUrl(provider: AdProvider, o: { redirectUri: string; state: string }, env: Env = process.env): string {
  const id = env[OAUTH_ENV[provider].id] ?? "";
  switch (provider) {
    case "meta_ads":
      return `https://www.facebook.com/${META_DEFAULT_VERSION}/dialog/oauth?${qs({ client_id: id, redirect_uri: o.redirectUri, state: o.state, scope: "ads_read", response_type: "code" })}`;
    case "google_ads":
      return `https://accounts.google.com/o/oauth2/v2/auth?${qs({
        client_id: id, redirect_uri: o.redirectUri, response_type: "code", scope: "https://www.googleapis.com/auth/adwords",
        access_type: "offline", prompt: "consent", include_granted_scopes: "true", state: o.state,
      })}`;
    case "tiktok_ads":
      return `https://business-api.tiktok.com/portal/auth?${qs({ app_id: id, state: o.state, redirect_uri: o.redirectUri })}`;
    case "snapchat_ads":
      return `https://accounts.snapchat.com/login/oauth2/authorize?${qs({ response_type: "code", client_id: id, redirect_uri: o.redirectUri, scope: "snapchat-marketing-api", state: o.state })}`;
  }
}

/** The authorization code from the callback's query (TikTok calls it auth_code). */
export function codeFrom(provider: AdProvider, params: URLSearchParams): string | null {
  const v = provider === "tiktok_ads" ? params.get("auth_code") ?? params.get("code") : params.get("code");
  return v && v.length <= 2048 ? v : null;
}

export interface ExchangeResult {
  secrets: Record<string, string>;
  scopes: string[];
  expiresAt: Date | null;
  /** Account ids the provider returned with the token (TikTok), to prefill settings. */
  accountIds?: string[];
}

const oauthClassifier: Classifier = (status, body) => {
  if (status >= 200 && status < 300) {
    const b = body as { code?: number; message?: string } | null;
    if (b && typeof b.code === "number" && b.code !== 0) return new ProviderError("auth", `OAuth: ${b.message ?? `code ${b.code}`}`, status, String(b.code));
    return null;
  }
  const b = body as { error?: string | { message?: string }; error_description?: string } | null;
  const e = typeof b?.error === "string" ? b.error : b?.error?.message;
  return new ProviderError(status >= 500 ? "transient" : "auth", `OAuth ${status}${e ? `: ${e}` : ""}`, status);
};

export async function exchangeCode(provider: AdProvider, code: string, redirect: string, http: HttpOptions = {}, env: Env = process.env): Promise<ExchangeResult> {
  const id = env[OAUTH_ENV[provider].id] ?? "";
  const secret = env[OAUTH_ENV[provider].secret] ?? "";
  if (!id || !secret) throw new ProviderError("config", "OAuth app is not configured.");
  switch (provider) {
    case "meta_ads": {
      const host = "graph.facebook.com";
      const short: { access_token?: string } = await requestJson(
        { url: `https://${host}/${META_DEFAULT_VERSION}/oauth/access_token?${qs({ client_id: id, client_secret: secret, redirect_uri: redirect, code })}`, allowedHosts: [host] }, oauthClassifier, http);
      if (!short.access_token) throw new ProviderError("auth", "Meta returned no access token.");
      const long: { access_token?: string; expires_in?: number } = await requestJson(
        { url: `https://${host}/${META_DEFAULT_VERSION}/oauth/access_token?${qs({ grant_type: "fb_exchange_token", client_id: id, client_secret: secret, fb_exchange_token: short.access_token })}`, allowedHosts: [host] }, oauthClassifier, http);
      return { secrets: { access_token: long.access_token ?? short.access_token, oauth_app: "leanapp" }, scopes: ["ads_read"], expiresAt: long.expires_in ? new Date(Date.now() + long.expires_in * 1000) : null };
    }
    case "google_ads": {
      const host = "oauth2.googleapis.com";
      const b: { refresh_token?: string; scope?: string } = await requestJson({
        url: `https://${host}/token`, method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "authorization_code", code, client_id: id, client_secret: secret, redirect_uri: redirect }).toString(), allowedHosts: [host],
      }, oauthClassifier, http);
      if (!b.refresh_token) throw new ProviderError("auth", "Google returned no refresh token. Remove LeanApp's access in your Google account and connect again.");
      return { secrets: { refresh_token: b.refresh_token, oauth_app: "leanapp" }, scopes: (b.scope ?? "").split(" ").filter(Boolean), expiresAt: null };
    }
    case "tiktok_ads": {
      const host = "business-api.tiktok.com";
      const b: { data?: { access_token?: string; advertiser_ids?: (string | number)[]; scope?: (string | number)[] } } = await requestJson({
        url: `https://${host}/open_api/v1.3/oauth2/access_token/`, method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ app_id: id, secret, auth_code: code }), allowedHosts: [host],
      }, oauthClassifier, http);
      if (!b.data?.access_token) throw new ProviderError("auth", "TikTok returned no access token.");
      return { secrets: { access_token: b.data.access_token, oauth_app: "leanapp" }, scopes: (b.data.scope ?? []).map(String), expiresAt: null, accountIds: (b.data.advertiser_ids ?? []).map(String) };
    }
    case "snapchat_ads": {
      const host = "accounts.snapchat.com";
      const b: { refresh_token?: string; scope?: string } = await requestJson({
        url: `https://${host}/login/oauth2/access_token`, method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "authorization_code", code, client_id: id, client_secret: secret, redirect_uri: redirect }).toString(), allowedHosts: [host],
      }, oauthClassifier, http);
      if (!b.refresh_token) throw new ProviderError("auth", "Snap returned no refresh token.");
      return { secrets: { refresh_token: b.refresh_token, oauth_app: "leanapp" }, scopes: (b.scope ?? "snapchat-marketing-api").split(" ").filter(Boolean), expiresAt: null };
    }
  }
}
