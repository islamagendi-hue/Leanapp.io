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
 *                    person or click (Meta: no fbclid and no install id;
 *                    Snap: no ScCid click id)
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

/** Why a delivery must not be sent, or null when it may be. `attributionConsent`: latest decision (null = none recorded). */
export function eligibility(network: Network, payload: PostbackPayload, identity: Identity, attributionConsent: boolean | null): SkipReason | null {
  if (attributionConsent === false) return "consent_denied";
  if (network === "meta" && !(payload.network_click_param === "fbclid" && payload.network_click_id) && !identity.anonymousId) return "no_match_key";
  if (network === "snapchat" && !(payload.network_click_param === "ScCid" && payload.network_click_id)) return "no_match_key";
  return null;
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
      const app = e.app_data as { extinfo?: unknown; advertiser_tracking_enabled?: unknown } | undefined;
      if (e.action_source === "app" && (!app || !Array.isArray(app.extinfo) || app.advertiser_tracking_enabled === undefined)) return "app events need app_data with extinfo and advertiser_tracking_enabled";
      const ud = (e.user_data ?? {}) as Record<string, unknown>;
      if (!Object.keys(ud).length) return "user_data has no match key";
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
    const b = JSON.parse(req.body ?? "null") as { data?: { event_name?: string; event?: string; event_id?: string }[]; conversions?: { orderId?: string }[] } | null;
    if (b?.data) out.events = b.data.map((e) => ({ name: e.event_name ?? e.event, event_id: e.event_id }));
    if (b?.conversions) out.events = b.conversions.map((c) => ({ order_id: c.orderId }));
  } catch {
    // not JSON (custom GET postbacks): endpoint only
  }
  return out;
}
