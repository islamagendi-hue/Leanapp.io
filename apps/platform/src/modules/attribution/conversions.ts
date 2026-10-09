import { createHash } from "node:crypto";
import type { Network, PostbackRequest } from "./networks";
import type { PostbackPayload } from "./pure";

/**
 * Outbound conversions (Meta Conversions API, Snap Conversions API, and the
 * other networks' postbacks): the checks that run right before a delivery is
 * sent, and how provider errors are read back. Pure; unit-tested in
 * conversions.test.ts. Delivery itself is in ./delivery.ts.
 *
 * Eligibility (skipped, never sent):
 *   consent_denied   the user or install denied the `attribution` purpose
 *                    (checked at send time, so a later denial still stops it)
 *   no_match_key     the network would have nothing to match the event to a
 *                    person or click (Meta app events: no fbclid and no install
 *                    id; Meta website events: no fbclid, _fbp / _fbc or hashed
 *                    user data; Snap: no ScCid click id; Google: no click id
 *                    and no Enhanced Conversions user identifiers)
 *   invalid_payload  the request body fails the network's documented rules
 * Deduplication: every request carries the delivery's stable event_id
 * (Meta / Snap / TikTok deduplicate on it; Google on orderId), and a delivery
 * is queued at most once per postback (unique idempotency key).
 */
export type SkipReason = "consent_denied" | "no_match_key" | "invalid_payload";

export interface Identity {
  anonymousId: string | null;
  userId: string | null;
}

/**
 * What else a delivery has to match on, besides the attribution's click id.
 * Filled at send time from the event that triggered it (delivery.ts).
 *   actionSource   Meta: "app" (Conversions API for app events) or "website"
 *                  (Pixel + Conversions API); other networks ignore it
 *   browserIds     the event carried Meta's _fbp / _fbc browser ids
 *   userData       hashed email / phone / user id will be sent (allowed by the
 *                  postback's send_user_data setting and the user's consent)
 */
export interface MatchContext {
  actionSource?: ActionSource;
  browserIds?: boolean;
  userData?: boolean;
}

const hasClick = (p: PostbackPayload, params: string[]) => Boolean(p.network_click_id) && params.includes(String(p.network_click_param));

/** Why a delivery must not be sent, or null when it may be. `attributionConsent`: latest decision (null = none recorded). */
export function eligibility(network: Network, payload: PostbackPayload, identity: Identity, attributionConsent: boolean | null, match: MatchContext = {}): SkipReason | null {
  if (attributionConsent === false) return "consent_denied";
  if (network === "meta") {
    // Website events match on the browser ids or hashed user data; the install id (anon_id) only exists for app events.
    if (match.actionSource === "website") return hasClick(payload, ["fbclid"]) || match.browserIds || match.userData ? null : "no_match_key";
    if (!hasClick(payload, ["fbclid"]) && !identity.anonymousId) return "no_match_key";
  }
  if (network === "snapchat" && !hasClick(payload, ["ScCid"])) return "no_match_key";
  // Google: a click id, or Enhanced Conversions user identifiers (enhanced conversions for leads).
  if (network === "google" && !hasClick(payload, ["gclid", "gbraid", "wbraid"]) && !match.userData) return "no_match_key";
  return null;
}

// ── Meta action source ──────────────────────────────────────────────────────
export type ActionSource = "app" | "website";
/** Postback setting: "app" (default), "website", or "auto" (website for events from the web SDK, app otherwise). */
export function metaActionSource(setting: string | undefined, platform: unknown): ActionSource {
  if (setting === "website") return "website";
  if (setting === "auto") return platform === "web" ? "website" : "app";
  return "app";
}

// ── Hashed user data (Meta advanced matching, Google Enhanced Conversions) ──
/**
 * Postback setting `send_user_data`:
 *   off            (default) no email, phone or user id leaves LeanApp
 *   with_consent   only for users whose latest `attribution` consent is granted
 *   unless_denied  unless the user denied `attribution` consent
 * Values are normalised and SHA-256 hashed before they are put in a request;
 * the plain values are never stored with the delivery or logged.
 */
export type UserDataMode = "off" | "with_consent" | "unless_denied";
export function userDataMode(setting: string | undefined): UserDataMode {
  return setting === "with_consent" || setting === "unless_denied" ? setting : "off";
}
export function userDataAllowed(mode: UserDataMode, attributionConsent: boolean | null): boolean {
  if (mode === "with_consent") return attributionConsent === true;
  if (mode === "unless_denied") return attributionConsent !== false;
  return false;
}

/** Plain values from the user's profile (identify traits `email` and `phone`) and their user_id. */
export interface RawUserData {
  email?: unknown;
  phone?: unknown;
  externalId?: unknown;
}

export const sha256Hex = (v: string) => createHash("sha256").update(v, "utf8").digest("hex");
const EMAIL = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;

/** Trimmed, lowercased email; null when it isn't one. Google also drops dots before @gmail.com / @googlemail.com. */
export function normalizeEmail(value: unknown, flavour: "meta" | "google"): string | null {
  if (typeof value !== "string") return null;
  const v = value.trim().toLowerCase();
  if (!EMAIL.test(v) || v.length > 254) return null;
  if (flavour === "google") {
    const [local, domain] = v.split("@");
    if (domain === "gmail.com" || domain === "googlemail.com") return `${local.replace(/\./g, "")}@${domain}`;
  }
  return v;
}

/**
 * Phone in international form. Meta wants digits only with the country code;
 * Google wants E.164 with the leading "+". Numbers without a country code
 * (no "+" or "00") are dropped rather than guessed.
 */
export function normalizePhone(value: unknown, flavour: "meta" | "google"): string | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const raw = String(value).trim().replace(/[\s().-]/g, "");
  const intl = raw.startsWith("00") ? `+${raw.slice(2)}` : raw;
  if (!/^\+[1-9]\d{6,14}$/.test(intl)) return null;
  return flavour === "google" ? intl : intl.slice(1);
}

/** Meta user_data fields (em, ph, external_id), hashed. Empty when nothing usable. */
export function metaUserData(raw: RawUserData): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  const em = normalizeEmail(raw.email, "meta");
  const ph = normalizePhone(raw.phone, "meta");
  const ext = typeof raw.externalId === "string" && raw.externalId.trim() ? raw.externalId.trim() : null;
  if (em) out.em = [sha256Hex(em)];
  if (ph) out.ph = [sha256Hex(ph)];
  if (ext) out.external_id = [sha256Hex(ext)];
  return out;
}

/** Google Ads userIdentifiers (hashedEmail / hashedPhoneNumber), at most 5. Empty when nothing usable. */
export function googleUserIdentifiers(raw: RawUserData): Record<string, string>[] {
  const out: Record<string, string>[] = [];
  const em = normalizeEmail(raw.email, "google");
  const ph = normalizePhone(raw.phone, "google");
  if (em) out.push({ userIdentifierSource: "FIRST_PARTY", hashedEmail: sha256Hex(em) });
  if (ph) out.push({ userIdentifierSource: "FIRST_PARTY", hashedPhoneNumber: sha256Hex(ph) });
  return out.slice(0, 5);
}

/** A page URL Meta can take as event_source_url: absolute http(s), without the fragment. */
export function eventSourceUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 2000) return null;
  try {
    const u = new URL(value);
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    u.hash = "";
    return u.toString();
  } catch {
    return null;
  }
}

/** Meta's _fbp / _fbc cookie values look like fb.<subdomain index>.<ms>.<id>; anything else is dropped. */
export function metaBrowserId(value: unknown): string | null {
  return typeof value === "string" && /^fb\.\d\.\d{10,16}\.[A-Za-z0-9_.-]{1,500}$/.test(value.trim()) ? value.trim() : null;
}

/** Meta accepts events up to 7 days old; Snap and TikTok are given the same bound here. */
const MAX_AGE_SECONDS = 7 * 24 * 3600;
const FUTURE_SKEW_SECONDS = 600;

/** Checks a built Meta / Snap / TikTok request body. Returns the first problem, or null. */
export function validateConversionBody(network: Network, body: string | undefined, nowSeconds = Math.floor(Date.now() / 1000)): string | null {
  if (network !== "meta" && network !== "snapchat" && network !== "tiktok") return null;
  let parsed: { data?: Record<string, unknown>[] };
  try {
    parsed = JSON.parse(body ?? "");
  } catch {
    return "body is not JSON";
  }
  const events = parsed.data;
  if (!Array.isArray(events) || events.length === 0) return "no events in data[]";
  if (events.length > 1000) return "more than 1000 events in one request";
  for (const e of events) {
    const name = network === "tiktok" ? e.event : e.event_name;
    if (typeof name !== "string" || !name.trim() || name.length > 100) return "event name missing or too long";
    const id = e.event_id;
    if (typeof id !== "string" || !id || id.length > 200) return "event_id missing (needed for deduplication)";
    const time = e.event_time;
    if (typeof time !== "number" || !Number.isInteger(time)) return "event_time must be Unix seconds";
    if (time > nowSeconds + FUTURE_SKEW_SECONDS) return "event_time is in the future";
    if (time < nowSeconds - MAX_AGE_SECONDS) return "event_time is older than 7 days";
    const money = (network === "tiktok" ? e.properties : e.custom_data) as { value?: unknown; currency?: unknown } | undefined;
    if (money && money.value !== undefined) {
      if (typeof money.value !== "number" || !Number.isFinite(money.value) || money.value < 0) return "value must be a number of 0 or more";
      if (typeof money.currency !== "string" || !/^[A-Z]{3}$/.test(money.currency)) return "currency must be a 3-letter ISO code";
    }
    if (network === "meta") {
      const ud = (e.user_data ?? {}) as Record<string, unknown>;
      if (e.action_source === "website") {
        if (typeof e.event_source_url !== "string" || !/^https?:\/\//.test(e.event_source_url)) return "website events need event_source_url (the page URL)";
        if (typeof ud.client_user_agent !== "string" || !ud.client_user_agent) return "website events need client_user_agent";
        if (e.app_data !== undefined) return "website events can't carry app_data";
        if (name === "MobileAppInstall" || name === "fb_mobile_activate_app") return "app installs and opens can't be sent as website events";
        if (!["em", "ph", "external_id", "fbp", "fbc", "client_ip_address"].some((k) => ud[k] !== undefined)) return "user_data has no match key";
      } else {
        const app = e.app_data as { extinfo?: unknown; advertiser_tracking_enabled?: unknown } | undefined;
        if (e.action_source === "app" && (!app || !Array.isArray(app.extinfo) || app.advertiser_tracking_enabled === undefined)) return "app events need app_data with extinfo and advertiser_tracking_enabled";
        if (!Object.keys(ud).length) return "user_data has no match key";
      }
      for (const k of ["em", "ph", "external_id"]) {
        const v = ud[k];
        if (v !== undefined && !(Array.isArray(v) && v.every((h) => typeof h === "string" && /^[0-9a-f]{64}$/.test(h)))) return `user_data.${k} must be SHA-256 hashes`;
      }
    }
  }
  return null;
}

export interface ProviderErrorInfo {
  code: string | null;
  traceId: string | null;
  message: string | null;
  /** The provider says to try again later even though the HTTP status wouldn't (e.g. Meta code 17 with HTTP 400). */
  retryable: boolean;
}

/** Reads the provider's error body (Meta, Snap, TikTok, Google formats). Never includes the request. */
export function parseProviderError(network: Network, status: number, text: string): ProviderErrorInfo {
  let body: Record<string, unknown> | null = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = null;
  }
  const none: ProviderErrorInfo = { code: null, traceId: null, message: text ? text.slice(0, 200) : null, retryable: false };
  if (!body || typeof body !== "object") return none;
  if (network === "meta") {
    const e = body.error as { message?: string; code?: number; error_subcode?: number; fbtrace_id?: string } | undefined;
    if (!e) return none;
    const code = e.code;
    return {
      code: code !== undefined ? `${code}${e.error_subcode ? `/${e.error_subcode}` : ""}` : null,
      traceId: e.fbtrace_id ?? null,
      message: e.message?.slice(0, 200) ?? null,
      retryable: code === 1 || code === 2 || code === 4 || code === 17 || code === 32 || code === 613,
    };
  }
  if (network === "tiktok") {
    const code = body.code as number | undefined;
    return { code: code !== undefined ? String(code) : null, traceId: (body.request_id as string) ?? null, message: (body.message as string)?.slice(0, 200) ?? null, retryable: code === 40100 };
  }
  if (network === "snapchat") {
    return {
      code: (body.error_code as string) ?? (body.status as string) ?? null,
      traceId: (body.request_id as string) ?? null,
      message: ((body.reason as string) ?? (body.debug_message as string) ?? (body.message as string))?.slice(0, 200) ?? null,
      retryable: false,
    };
  }
  if (network === "google") {
    const e = body.error as { status?: string; message?: string } | undefined;
    return { code: e?.status ?? null, traceId: null, message: e?.message?.slice(0, 200) ?? null, retryable: e?.status === "RESOURCE_EXHAUSTED" || e?.status === "UNAVAILABLE" };
  }
  return { ...none, retryable: status === 429 };
}

/**
 * Non-secret record of what was sent, for the delivery log: the endpoint
 * without its query (Meta and Snap take the token in the query), and the
 * event names and ids in the body.
 */
export function requestSummary(req: PostbackRequest): Record<string, unknown> {
  let endpoint = "";
  try {
    const u = new URL(req.url);
    endpoint = `${u.host}${u.pathname}`;
  } catch {
    endpoint = "";
  }
  const out: Record<string, unknown> = { method: req.method, endpoint };
  try {
    const b = JSON.parse(req.body ?? "null") as {
      data?: { event_name?: string; event?: string; event_id?: string; action_source?: string; user_data?: Record<string, unknown> }[];
      conversions?: { orderId?: string; userIdentifiers?: unknown[] }[];
      test_event_code?: string;
    } | null;
    // Which kinds of match keys went out (names only, never values).
    if (b?.data) {
      out.events = b.data.map((e) => ({
        name: e.event_name ?? e.event, event_id: e.event_id,
        ...(e.action_source ? { action_source: e.action_source } : {}),
        ...(e.user_data && typeof e.user_data === "object" ? { match_keys: Object.keys(e.user_data).sort() } : {}),
      }));
    }
    if (b?.conversions) out.events = b.conversions.map((c) => ({ order_id: c.orderId, ...(Array.isArray(c.userIdentifiers) ? { user_identifiers: c.userIdentifiers.length } : {}) }));
    if (b?.test_event_code) out.test_event = true;
  } catch {
    // not JSON (custom GET postbacks): endpoint only
  }
  return out;
}
