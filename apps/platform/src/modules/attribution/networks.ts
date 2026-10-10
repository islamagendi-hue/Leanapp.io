/**
 * Postback request builders. `custom` is a URL template with macros and is
 * fully tested. The ad-network builders follow each network's public API
 * documentation but are NOT VERIFIED WITH THE LIVE NETWORKS: they need the
 * customer's own accounts and tokens, which we don't have. The UI and
 * docs/attribution.md say so.
 *
 *   tiktok    TikTok Events API 2.0   POST business-api.tiktok.com/open_api/v1.3/event/track/
 *             event_source "app" (event_source_id = TikTok App ID) or "web"
 *             (event_source_id = pixel code: page.url, user.user_agent, ttclid,
 *             _ttp, hashed email / phone / external_id), chosen per postback
 *   snapchat  Snap Conversions API v3 POST tr.snapchat.com/v3/{snap_app_id | snap_pixel_id}/events
 *             action_source "MOBILE_APP" or "WEB" (event_source_url,
 *             client_user_agent, sc_click_id, sc_cookie1 from _scid, hashed
 *             em / ph / external_id), chosen per postback
 *   meta      Meta Conversions API    POST graph.facebook.com/{version}/{dataset_id}/events
 *             action_source "app" (app events) or "website" (Pixel + Conversions API:
 *             event_source_url, client_user_agent, fbp / fbc), chosen per postback
 *   google    Google Ads API          POST googleads.googleapis.com/{version}/customers/{id}:uploadClickConversions
 *             with Enhanced Conversions user identifiers (hashed email / phone) when allowed
 *
 * These builders only format and deliver: which events a network receives and
 * which click they are credited to are decided by the attribution engine
 * before a delivery is queued.
 */
import { expandMacros, type PostbackPayload } from "./pure";
import { actionSourceOf, googleUserIdentifiers, metaBrowserId, metaUserData, pixelCookieId, snapUserData, tiktokUserData, type RawUserData } from "./conversions";
import { msg } from "@/i18n/translate";

export const NETWORKS = ["custom", "tiktok", "snapchat", "meta", "google"] as const;
export type Network = (typeof NETWORKS)[number];

export interface ConfigField {
  key: string;
  label: string;
  required: boolean;
  /** A fixed list of values (the first is the default); shown as a select. */
  options?: { value: string; label: string }[];
  help?: string;
}

const USER_DATA_OPTIONS = [
  { value: "off", label: msg("Off: send no email, phone or user id") },
  { value: "with_consent", label: msg("Only when the user granted attribution consent") },
  { value: "unless_denied", label: msg("Unless the user denied attribution consent") },
];

/** The app / website / by-platform setting of Meta, TikTok and Snap postbacks (config.action_source). */
const actionSourceField = (app: string, website: string): ConfigField => ({
  key: "action_source", label: msg("Event source"), required: false,
  options: [
    { value: "app", label: app },
    { value: "website", label: website },
    { value: "auto", label: msg("By platform: web SDK events as website, others as app") },
  ],
});

export interface NetworkSpec {
  label: string;
  verified: boolean;
  /** Non-secret settings (stored in `config`). */
  config: ConfigField[];
  /** Secret settings (encrypted in `credentials_enc`). */
  credentials: { key: string; label: string; required: boolean }[];
  /** Ad-network click id the network needs to match the user, if any. */
  clickIdParam?: string;
}

export const NETWORK_SPECS: Record<Network, NetworkSpec> = {
  custom: {
    label: msg("Custom URL"),
    verified: true,
    config: [],
    credentials: [{ key: "authorization", label: msg("Authorization header (optional)"), required: false }],
  },
  tiktok: {
    label: "TikTok Events API",
    verified: false,
    config: [
      { key: "tiktok_app_id", label: "TikTok App ID", required: false, help: msg("For app events. Required unless Event source is website.") },
      { key: "tiktok_pixel_code", label: msg("TikTok Pixel code"), required: false, help: msg("For website events: the pixel code from TikTok Events Manager. Required unless Event source is app.") },
      actionSourceField(msg("App events"), msg("Website events (Pixel + Events API)")),
      { key: "send_user_data", label: msg("Hashed user data (website events)"), required: false, options: USER_DATA_OPTIONS,
        help: msg("SHA-256 hashes of the email and phone user properties and the user id, on website events only.") },
      { key: "test_event_code", label: msg("Test event code (optional)"), required: false, help: msg("From TikTok Events Manager → your pixel → Test events. Remove it when done.") },
    ],
    credentials: [{ key: "access_token", label: msg("Events API access token"), required: true }],
    clickIdParam: "ttclid",
  },
  snapchat: {
    label: "Snap Conversions API",
    verified: false,
    config: [
      { key: "snap_app_id", label: "Snap App ID", required: false, help: msg("For app events. Required unless Event source is website.") },
      { key: "snap_pixel_id", label: msg("Snap Pixel ID"), required: false, help: msg("For website events: the Pixel ID from Snap Events Manager. Required unless Event source is app.") },
      actionSourceField(msg("App events"), msg("Website events (Pixel + Conversions API)")),
      { key: "send_user_data", label: msg("Hashed user data (website events)"), required: false, options: USER_DATA_OPTIONS,
        help: msg("SHA-256 hashes of the email and phone user properties and the user id, on website events only.") },
    ],
    credentials: [{ key: "access_token", label: msg("Conversions API token"), required: true }],
    clickIdParam: "ScCid",
  },
  meta: {
    label: "Meta Conversions API",
    verified: false,
    config: [
      { key: "dataset_id", label: msg("Dataset (app) ID"), required: true, help: msg("For website events this is the dataset of your Meta Pixel (the Pixel ID).") },
      { key: "api_version", label: msg("Graph API version (default v21.0)"), required: false },
      actionSourceField(msg("App events (Conversions API for apps)"), msg("Website events (Pixel + Conversions API)")),
      { key: "send_user_data", label: msg("Hashed user data (advanced matching)"), required: false, options: USER_DATA_OPTIONS,
        help: msg("SHA-256 hashes of the email and phone user properties and the user id.") },
      { key: "test_event_code", label: msg("Test event code (optional)"), required: false, help: msg("From Events Manager → Test events. Events sent with it appear there and are not used for ads; remove it when done.") },
    ],
    credentials: [{ key: "access_token", label: msg("System user access token"), required: true }],
    clickIdParam: "fbclid",
  },
  google: {
    label: msg("Google Ads click conversions"),
    verified: false,
    config: [
      { key: "customer_id", label: msg("Customer ID (digits only)"), required: true },
      { key: "conversion_action_id", label: msg("Conversion action ID"), required: true },
      { key: "login_customer_id", label: msg("Manager (login) customer ID"), required: false },
      { key: "api_version", label: msg("API version (default v18)"), required: false },
      { key: "send_user_data", label: msg("Enhanced conversions (hashed email and phone)"), required: false, options: USER_DATA_OPTIONS,
        help: msg("Turn on enhanced conversions for this conversion action in Google Ads first.") },
    ],
    credentials: [
      { key: "developer_token", label: msg("Developer token"), required: true },
      { key: "client_id", label: msg("OAuth client ID"), required: true },
      { key: "client_secret", label: msg("OAuth client secret"), required: true },
      { key: "refresh_token", label: msg("OAuth refresh token"), required: true },
    ],
    clickIdParam: "gclid",
  },
};

/**
 * Settings that depend on each other, checked when a postback is saved:
 * TikTok and Snap need the app id for app events and the pixel id for website
 * events (both for "by platform"). Returns the problem, or null.
 */
export function configProblem(network: Network, config: Record<string, string | undefined>): string | null {
  const ids: Partial<Record<Network, { app: string; web: string; appMsg: string; webMsg: string }>> = {
    tiktok: { app: "tiktok_app_id", web: "tiktok_pixel_code", appMsg: msg("TikTok App ID is required for app events."), webMsg: msg("TikTok Pixel code is required for website events.") },
    snapchat: { app: "snap_app_id", web: "snap_pixel_id", appMsg: msg("Snap App ID is required for app events."), webMsg: msg("Snap Pixel ID is required for website events.") },
  };
  const n = ids[network];
  if (!n) return null;
  const source = config.action_source ?? "app";
  if (source !== "website" && !config[n.app]) return n.appMsg;
  if (source !== "app" && !config[n.web]) return n.webMsg;
  return null;
}

export interface PostbackRequest {
  url: string;
  method: "GET" | "POST";
  headers: Record<string, string>;
  body?: string;
}

export type BuildResult = { ok: true; request: PostbackRequest } | { ok: false; error: string };

type Cfg = Record<string, string | undefined>;

/** LeanApp event names sent as the networks' "view content" website event (e.g. page_viewed, product_viewed, view_content). */
const VIEW_EVENT = /(^|_)(viewed|view_content)$/;

const isRevenue = (p: PostbackPayload) => p.revenue !== null && p.revenue !== undefined && p.revenue !== "" && Number(p.revenue) > 0;

/** The network's standard event name for our event (overridable per postback with config.event_map). */
export function networkEventName(network: Network, p: PostbackPayload, eventMap?: Record<string, string>, source: "app" | "website" = "app"): string {
  const ev = String(p.event ?? "");
  if (eventMap?.[ev]) return eventMap[ev];
  if (source === "website" && (network === "tiktok" || network === "snapchat")) {
    // Website standard events. Installs and app opens have none: they keep their app name and fail validation.
    const web = network === "tiktok" ? ["CompletePayment", "CompleteRegistration", "ViewContent"] : ["PURCHASE", "SIGN_UP", "VIEW_CONTENT"];
    if (isRevenue(p)) return web[0];
    if (/sign_?up|registration/.test(ev)) return web[1];
    if (VIEW_EVENT.test(ev)) return web[2];
  }
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

/** Send-time details of the event behind a delivery (read by delivery.ts from the stored event; never kept on the delivery). */
export interface WebContext {
  /** The event's own event_id: the id a browser Pixel must send as eventID so Meta deduplicates the two. */
  eventId?: string | null;
  eventSourceUrl?: string | null;
  userAgent?: string | null;
  fbp?: string | null;
  fbc?: string | null;
  /** TikTok's _ttp cookie (TikTok website events). */
  ttp?: string | null;
  /** Snap's _scid cookie, sent as sc_cookie1 (Snap website events). */
  scid?: string | null;
}

export function buildRequest(
  network: Network,
  opts: { urlTemplate?: string | null; method?: "GET" | "POST"; config: Cfg & { event_map?: unknown }; credentials: Cfg; payload: PostbackPayload; accessToken?: string;
    /** The install id, sent to Meta as user_data.anon_id (app events) when consent allows. */
    anonymousId?: string | null;
    web?: WebContext | null;
    /** Plain email / phone / user id, hashed here. Pass only when send_user_data and the user's consent allow it. */
    userData?: RawUserData | null;
    /** The user's attribution consent is explicitly granted (sent to Google as consent.adUserData). */
    consentGranted?: boolean },
): BuildResult {
  const p = opts.payload;
  const c = opts.config;
  const s = opts.credentials;
  const eventMap = c.event_map && typeof c.event_map === "object" ? (c.event_map as Record<string, string>) : undefined;
  const json = { "Content-Type": "application/json" };
  switch (network) {
    case "custom": {
      if (!opts.urlTemplate) return { ok: false, error: msg("No URL template.") };
      const url = expandMacros(opts.urlTemplate, p);
      const headers: Record<string, string> = s.authorization ? { Authorization: s.authorization } : {};
      if (opts.method === "POST") return { ok: true, request: { url, method: "POST", headers: { ...headers, ...json }, body: JSON.stringify(p) } };
      return { ok: true, request: { url, method: "GET", headers } };
    }
    case "tiktok": {
      const source = actionSourceOf(c.action_source, p.platform);
      if (source === "website") {
        if (!s.access_token || !c.tiktok_pixel_code) return { ok: false, error: msg("TikTok Pixel code and access token are required for website events.") };
      } else if (!s.access_token || !c.tiktok_app_id) return { ok: false, error: msg("TikTok App ID and access token are required.") };
      const m = money(p);
      const ttclid = p.network_click_id && p.network_click_param === "ttclid" ? { ttclid: p.network_click_id } : {};
      const event: Record<string, unknown> = {
        event: networkEventName("tiktok", p, eventMap, source),
        event_time: seconds(p),
        event_id: p.event_id,
        user: ttclid,
        ...(m ? { properties: { value: m.value, currency: m.currency } } : {}),
      };
      if (source === "website") {
        const web = opts.web ?? {};
        // Same event_id as the browser pixel's event_id, so TikTok counts the pair once.
        if (web.eventId) event.event_id = web.eventId;
        const ttp = pixelCookieId(web.ttp);
        event.user = {
          ...ttclid, ...(ttp ? { ttp } : {}), ...(opts.userData ? tiktokUserData(opts.userData) : {}),
          ...(web.userAgent ? { user_agent: web.userAgent } : {}),
        };
        if (web.eventSourceUrl) event.page = { url: web.eventSourceUrl };
      }
      const body: Record<string, unknown> = {
        event_source: source === "website" ? "web" : "app",
        event_source_id: source === "website" ? c.tiktok_pixel_code : c.tiktok_app_id,
        data: [event],
      };
      if (c.test_event_code) body.test_event_code = c.test_event_code;
      return { ok: true, request: { url: "https://business-api.tiktok.com/open_api/v1.3/event/track/", method: "POST", headers: { ...json, "Access-Token": s.access_token }, body: JSON.stringify(body) } };
    }
    case "snapchat": {
      const source = actionSourceOf(c.action_source, p.platform);
      if (source === "website") {
        if (!s.access_token || !c.snap_pixel_id) return { ok: false, error: msg("Snap Pixel ID and token are required for website events.") };
      } else if (!s.access_token || !c.snap_app_id) return { ok: false, error: msg("Snap App ID and token are required.") };
      const m = money(p);
      const click = p.network_click_id && p.network_click_param === "ScCid" ? { sc_click_id: p.network_click_id } : {};
      const event: Record<string, unknown> = {
        event_name: networkEventName("snapchat", p, eventMap, source),
        event_time: seconds(p),
        event_id: p.event_id,
        action_source: source === "website" ? "WEB" : "MOBILE_APP",
        user_data: click,
        ...(m ? { custom_data: { value: m.value, currency: m.currency } } : {}),
      };
      if (source === "website") {
        const web = opts.web ?? {};
        // Same id as the browser Snap Pixel's client_dedup_id, so Snap counts the pair once.
        if (web.eventId) event.event_id = web.eventId;
        if (web.eventSourceUrl) event.event_source_url = web.eventSourceUrl;
        const scid = pixelCookieId(web.scid);
        event.user_data = {
          ...(web.userAgent ? { client_user_agent: web.userAgent } : {}), ...click, ...(scid ? { sc_cookie1: scid } : {}),
          ...(opts.userData ? snapUserData(opts.userData) : {}),
        };
      }
      const body = { data: [event] };
      const id = source === "website" ? c.snap_pixel_id! : c.snap_app_id!;
      const url = `https://tr.snapchat.com/v3/${encodeURIComponent(id)}/events?access_token=${encodeURIComponent(s.access_token)}`;
      return { ok: true, request: { url, method: "POST", headers: json, body: JSON.stringify(body) } };
    }
    case "meta": {
      if (!s.access_token || !c.dataset_id) return { ok: false, error: msg("Dataset ID and access token are required.") };
      const m = money(p);
      const source = actionSourceOf(c.action_source, p.platform);
      const web = opts.web ?? {};
      const fromClick = p.network_click_id && p.network_click_param === "fbclid" ? `fb.1.${seconds(p) * 1000}.${p.network_click_id}` : undefined;
      // The _fbc cookie set by the Pixel (or the SDK) wins over one rebuilt from the click id.
      const fbc = metaBrowserId(web.fbc) ?? fromClick;
      const hashed = opts.userData ? metaUserData(opts.userData) : {};
      const event: Record<string, unknown> = {
        event_name: networkEventName("meta", p, eventMap),
        event_time: seconds(p),
        event_id: p.event_id,
        action_source: source,
      };
      if (source === "website") {
        // Same event_id as the browser Pixel's eventID, so Meta counts the pair once.
        if (web.eventId) event.event_id = web.eventId;
        if (web.eventSourceUrl) event.event_source_url = web.eventSourceUrl;
        const fbp = metaBrowserId(web.fbp);
        event.user_data = { ...(web.userAgent ? { client_user_agent: web.userAgent } : {}), ...(fbp ? { fbp } : {}), ...(fbc ? { fbc } : {}), ...hashed };
      } else {
        event.user_data = { ...(fbc ? { fbc } : {}), ...(opts.anonymousId ? { anon_id: opts.anonymousId } : {}), ...hashed };
        event.app_data = { advertiser_tracking_enabled: 0, application_tracking_enabled: 0, extinfo: [p.platform === "ios" ? "i2" : "a2", "", "", "", "", "", "", "", "", "", "", "", "", "", "", ""] };
      }
      if (m) event.custom_data = { value: m.value, currency: m.currency };
      const body: Record<string, unknown> = { data: [event] };
      if (c.test_event_code) body.test_event_code = c.test_event_code;
      const version = c.api_version || "v21.0";
      const url = `https://graph.facebook.com/${encodeURIComponent(version)}/${encodeURIComponent(c.dataset_id)}/events?access_token=${encodeURIComponent(s.access_token)}`;
      return { ok: true, request: { url, method: "POST", headers: json, body: JSON.stringify(body) } };
    }
    case "google": {
      if (!c.customer_id || !c.conversion_action_id || !s.developer_token) return { ok: false, error: msg("Customer ID, conversion action and developer token are required.") };
      const click = p.network_click_id && ["gclid", "gbraid", "wbraid"].includes(String(p.network_click_param)) ? String(p.network_click_param) : null;
      // gbraid / wbraid (iOS app campaigns) are not combined with user identifiers here: only gclid or no click id.
      const identifiers = opts.userData && (click === null || click === "gclid") ? googleUserIdentifiers(opts.userData) : [];
      if (!click && !identifiers.length) return { ok: false, error: msg("No Google click id (gclid / gbraid / wbraid) on this attribution.") };
      if (!opts.accessToken) return { ok: false, error: msg("No OAuth access token.") };
      const customer = c.customer_id.replace(/\D/g, "");
      const m = money(p);
      const when = new Date(seconds(p) * 1000).toISOString().replace("T", " ").replace(/\.\d+Z$/, "+00:00");
      const conversion: Record<string, unknown> = {
        ...(click ? { [click]: p.network_click_id } : {}),
        conversionAction: `customers/${customer}/conversionActions/${c.conversion_action_id.replace(/\D/g, "")}`,
        conversionDateTime: when,
        orderId: p.event_id,
        ...(m ? { conversionValue: m.value, currencyCode: m.currency } : {}),
      };
      if (identifiers.length) {
        conversion.userIdentifiers = identifiers;
        // Only an explicit grant is reported as GRANTED; otherwise consent is left unspecified, never assumed.
        if (opts.consentGranted) conversion.consent = { adUserData: "GRANTED" };
      }
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
