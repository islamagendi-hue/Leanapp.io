/**
 * Postback request builders. `custom` is a URL template with macros and is
 * fully tested. The ad-network builders follow each network's public API
 * documentation but are NOT VERIFIED WITH THE LIVE NETWORKS: they need the
 * customer's own accounts and tokens, which we don't have. The UI and
 * docs/attribution.md say so.
 *
 *   tiktok    TikTok Events API 2.0   POST business-api.tiktok.com/open_api/v1.3/event/track/
 *   snapchat  Snap Conversions API v3 POST tr.snapchat.com/v3/{snap_app_id}/events
 *   meta      Meta Conversions API    POST graph.facebook.com/{version}/{dataset_id}/events
 *   google    Google Ads API          POST googleads.googleapis.com/{version}/customers/{id}:uploadClickConversions
 */
import { expandMacros, type PostbackPayload } from "./pure";

export const NETWORKS = ["custom", "tiktok", "snapchat", "meta", "google"] as const;
export type Network = (typeof NETWORKS)[number];

export interface NetworkSpec {
  label: string;
  verified: boolean;
  /** Non-secret settings (stored in `config`). */
  config: { key: string; label: string; required: boolean }[];
  /** Secret settings (encrypted in `credentials_enc`). */
  credentials: { key: string; label: string; required: boolean }[];
  /** Ad-network click id the network needs to match the user, if any. */
  clickIdParam?: string;
}

export const NETWORK_SPECS: Record<Network, NetworkSpec> = {
  custom: {
    label: "Custom URL",
    verified: true,
    config: [],
    credentials: [{ key: "authorization", label: "Authorization header (optional)", required: false }],
  },
  tiktok: {
    label: "TikTok Events API",
    verified: false,
    config: [{ key: "tiktok_app_id", label: "TikTok App ID", required: true }],
    credentials: [{ key: "access_token", label: "Events API access token", required: true }],
    clickIdParam: "ttclid",
  },
  snapchat: {
    label: "Snap Conversions API",
    verified: false,
    config: [{ key: "snap_app_id", label: "Snap App ID", required: true }],
    credentials: [{ key: "access_token", label: "Conversions API token", required: true }],
    clickIdParam: "ScCid",
  },
  meta: {
    label: "Meta Conversions API",
    verified: false,
    config: [
      { key: "dataset_id", label: "Dataset (app) ID", required: true },
      { key: "api_version", label: "Graph API version (default v21.0)", required: false },
    ],
    credentials: [{ key: "access_token", label: "System user access token", required: true }],
    clickIdParam: "fbclid",
  },
  google: {
    label: "Google Ads click conversions",
    verified: false,
    config: [
      { key: "customer_id", label: "Customer ID (digits only)", required: true },
      { key: "conversion_action_id", label: "Conversion action ID", required: true },
      { key: "login_customer_id", label: "Manager (login) customer ID", required: false },
      { key: "api_version", label: "API version (default v18)", required: false },
    ],
    credentials: [
      { key: "developer_token", label: "Developer token", required: true },
      { key: "client_id", label: "OAuth client ID", required: true },
      { key: "client_secret", label: "OAuth client secret", required: true },
      { key: "refresh_token", label: "OAuth refresh token", required: true },
    ],
    clickIdParam: "gclid",
  },
};

export interface PostbackRequest {
  url: string;
  method: "GET" | "POST";
  headers: Record<string, string>;
  body?: string;
}

export type BuildResult = { ok: true; request: PostbackRequest } | { ok: false; error: string };

type Cfg = Record<string, string | undefined>;

const isRevenue = (p: PostbackPayload) => p.revenue !== null && p.revenue !== undefined && p.revenue !== "" && Number(p.revenue) > 0;

/** The network's standard event name for our event (overridable per postback with config.event_map). */
export function networkEventName(network: Network, p: PostbackPayload, eventMap?: Record<string, string>): string {
  const ev = String(p.event ?? "");
  if (eventMap?.[ev]) return eventMap[ev];
  const install = ev === "install" || ev === "reinstall";
  const reengage = ev === "re_engagement";
  const signup = /sign_?up|registration/.test(ev);
  const names: Record<Exclude<Network, "custom" | "google">, [string, string, string, string]> = {
    // install, re-engagement, purchase, registration
    tiktok: ["InstallApp", "LaunchAPP", "Purchase", "CompleteRegistration"],
    snapchat: ["APP_INSTALL", "APP_OPEN", "PURCHASE", "SIGN_UP"],
    meta: ["MobileAppInstall", "fb_mobile_activate_app", "Purchase", "CompleteRegistration"],
  };
  if (network === "custom" || network === "google") return ev;
  const n = names[network];
  if (install) return n[0];
  if (reengage) return n[1];
  if (isRevenue(p)) return n[2];
  if (signup) return n[3];
  return ev;
}

const seconds = (p: PostbackPayload) => Number(p.timestamp) || Math.floor(Date.now() / 1000);
const money = (p: PostbackPayload) => (isRevenue(p) ? { value: Number(p.revenue), currency: String(p.currency ?? "USD") } : null);

export function buildRequest(
  network: Network,
  opts: { urlTemplate?: string | null; method?: "GET" | "POST"; config: Cfg & { event_map?: unknown }; credentials: Cfg; payload: PostbackPayload; accessToken?: string },
): BuildResult {
  const p = opts.payload;
  const c = opts.config;
  const s = opts.credentials;
  const eventMap = c.event_map && typeof c.event_map === "object" ? (c.event_map as Record<string, string>) : undefined;
  const json = { "Content-Type": "application/json" };
  switch (network) {
    case "custom": {
      if (!opts.urlTemplate) return { ok: false, error: "No URL template." };
      const url = expandMacros(opts.urlTemplate, p);
      const headers: Record<string, string> = s.authorization ? { Authorization: s.authorization } : {};
      if (opts.method === "POST") return { ok: true, request: { url, method: "POST", headers: { ...headers, ...json }, body: JSON.stringify(p) } };
      return { ok: true, request: { url, method: "GET", headers } };
    }
    case "tiktok": {
      if (!s.access_token || !c.tiktok_app_id) return { ok: false, error: "TikTok App ID and access token are required." };
      const m = money(p);
      const body = {
        event_source: "app",
        event_source_id: c.tiktok_app_id,
        data: [{
          event: networkEventName("tiktok", p, eventMap),
          event_time: seconds(p),
          event_id: p.event_id,
          user: p.network_click_id && p.network_click_param === "ttclid" ? { ttclid: p.network_click_id } : {},
          ...(m ? { properties: { value: m.value, currency: m.currency } } : {}),
        }],
      };
      return { ok: true, request: { url: "https://business-api.tiktok.com/open_api/v1.3/event/track/", method: "POST", headers: { ...json, "Access-Token": s.access_token }, body: JSON.stringify(body) } };
    }
    case "snapchat": {
      if (!s.access_token || !c.snap_app_id) return { ok: false, error: "Snap App ID and token are required." };
      const m = money(p);
      const body = {
        data: [{
          event_name: networkEventName("snapchat", p, eventMap),
          event_time: seconds(p),
          event_id: p.event_id,
          action_source: "app",
          user_data: p.network_click_id && p.network_click_param === "ScCid" ? { sc_click_id: p.network_click_id } : {},
          ...(m ? { custom_data: { value: m.value, currency: m.currency } } : {}),
        }],
      };
      const url = `https://tr.snapchat.com/v3/${encodeURIComponent(c.snap_app_id)}/events?access_token=${encodeURIComponent(s.access_token)}`;
      return { ok: true, request: { url, method: "POST", headers: json, body: JSON.stringify(body) } };
    }
    case "meta": {
      if (!s.access_token || !c.dataset_id) return { ok: false, error: "Dataset ID and access token are required." };
      const m = money(p);
      const fbc = p.network_click_id && p.network_click_param === "fbclid" ? `fb.1.${seconds(p) * 1000}.${p.network_click_id}` : undefined;
      const body = {
        data: [{
          event_name: networkEventName("meta", p, eventMap),
          event_time: seconds(p),
          event_id: p.event_id,
          action_source: "app",
          user_data: fbc ? { fbc } : {},
          ...(m ? { custom_data: { value: m.value, currency: m.currency } } : {}),
          app_data: { advertiser_tracking_enabled: 0, application_tracking_enabled: 0, extinfo: [p.platform === "ios" ? "i2" : "a2", "", "", "", "", "", "", "", "", "", "", "", "", "", "", ""] },
        }],
      };
      const version = c.api_version || "v21.0";
      const url = `https://graph.facebook.com/${encodeURIComponent(version)}/${encodeURIComponent(c.dataset_id)}/events?access_token=${encodeURIComponent(s.access_token)}`;
      return { ok: true, request: { url, method: "POST", headers: json, body: JSON.stringify(body) } };
    }
    case "google": {
      if (!c.customer_id || !c.conversion_action_id || !s.developer_token) return { ok: false, error: "Customer ID, conversion action and developer token are required." };
      if (!(p.network_click_id && ["gclid", "gbraid", "wbraid"].includes(String(p.network_click_param)))) return { ok: false, error: "No Google click id (gclid / gbraid / wbraid) on this attribution." };
      if (!opts.accessToken) return { ok: false, error: "No OAuth access token." };
      const customer = c.customer_id.replace(/\D/g, "");
      const m = money(p);
      const when = new Date(seconds(p) * 1000).toISOString().replace("T", " ").replace(/\.\d+Z$/, "+00:00");
      const conversion: Record<string, unknown> = {
        [String(p.network_click_param)]: p.network_click_id,
        conversionAction: `customers/${customer}/conversionActions/${c.conversion_action_id.replace(/\D/g, "")}`,
        conversionDateTime: when,
        orderId: p.event_id,
        ...(m ? { conversionValue: m.value, currencyCode: m.currency } : {}),
      };
      const headers: Record<string, string> = { ...json, Authorization: `Bearer ${opts.accessToken}`, "developer-token": s.developer_token };
      if (c.login_customer_id) headers["login-customer-id"] = c.login_customer_id.replace(/\D/g, "");
      const version = c.api_version || "v18";
      return {
        ok: true,
        request: {
          url: `https://googleads.googleapis.com/${encodeURIComponent(version)}/customers/${customer}:uploadClickConversions`,
          method: "POST",
          headers,
          body: JSON.stringify({ conversions: [conversion], partialFailure: true }),
        },
      };
    }
  }
}

/** Google OAuth refresh → access token (not verified with a live account). */
export async function googleAccessToken(creds: Cfg, fetchImpl: typeof fetch = fetch): Promise<string> {
  const res = await fetchImpl("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: creds.client_id ?? "",
      client_secret: creds.client_secret ?? "",
      refresh_token: creds.refresh_token ?? "",
    }),
    signal: AbortSignal.timeout(10_000),
  });
  const body = (await res.json().catch(() => ({}))) as { access_token?: string; error?: string };
  if (!res.ok || !body.access_token) throw new Error(`Google OAuth token refresh failed (${res.status}${body.error ? `: ${body.error}` : ""})`);
  return body.access_token;
}
