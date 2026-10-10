import "server-only";
import { msg } from "@/i18n/translate";
/**
 * The Stripe adapter: Stripe's REST API with fetch (no SDK). Everything
 * Stripe-specific on the way out lives here (and, for webhooks, in
 * webhook.ts); the rest of billing talks to the BillingProvider interface in
 * provider.ts. Card data never touches LeanApp: customers pay on Stripe
 * Checkout and manage payment methods in the Stripe Customer Portal.
 *
 * Configuration (env only, never in git, never logged):
 *   STRIPE_SECRET_KEY      sk_test_… / sk_live_… (or a restricted rk_test_… / rk_live_… key).
 *                          The prefix decides the mode: test and live are never mixed.
 *   STRIPE_WEBHOOK_SECRET  whsec_… of the webhook endpoint /api/webhooks/stripe in the same mode.
 *   STRIPE_PRICE_<PLAN>_<INTERVAL>  price ids per plan (plans.ts).
 * Payments count as connected only when both secrets are set and well-formed:
 * without the webhook a paid checkout could never activate the plan.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { AppError } from "@/lib/errors";
import { log } from "@/lib/log";

type Env = Record<string, string | undefined>;

export type ProviderMode = "test" | "live";

export interface StripeConfig {
  secretKey: string;
  webhookSecret: string;
  mode: ProviderMode;
}

/** test or live from the key's prefix; null for anything that isn't a Stripe secret or restricted key. */
export function keyMode(secretKey: string | undefined | null): ProviderMode | null {
  const m = /^(?:sk|rk)_(test|live)_[A-Za-z0-9]+$/.exec(secretKey?.trim() ?? "");
  return m ? (m[1] as ProviderMode) : null;
}

export function stripeConfig(env: Env = process.env): StripeConfig | null {
  const secretKey = env.STRIPE_SECRET_KEY?.trim();
  const webhookSecret = env.STRIPE_WEBHOOK_SECRET?.trim();
  const mode = keyMode(secretKey);
  if (!secretKey || !webhookSecret || !mode || !webhookSecret.startsWith("whsec_")) return null;
  return { secretKey, webhookSecret, mode };
}

export function paymentsConnected(env: Env = process.env): boolean {
  return stripeConfig(env) !== null;
}

export class PaymentsNotConnectedError extends AppError {
  constructor() {
    super("payments_not_connected", msg("Payments are not connected yet."), 503);
  }
}

export class PaymentProviderError extends AppError {
  constructor() {
    super("payment_provider_error", msg("The payment provider couldn't complete the request. Try again in a moment."), 502);
  }
}

// ── Requests ────────────────────────────────────────────────────────────────

/** Stripe's form encoding: nested objects and arrays as a[b][0][c]=v. */
export function formEncode(params: Record<string, unknown>): string {
  const out = new URLSearchParams();
  const walk = (prefix: string, v: unknown) => {
    if (v === undefined || v === null) return;
    if (Array.isArray(v)) v.forEach((x, i) => walk(`${prefix}[${i}]`, x));
    else if (typeof v === "object") for (const [k, x] of Object.entries(v)) walk(prefix ? `${prefix}[${k}]` : k, x);
    else out.append(prefix, String(v));
  };
  walk("", params);
  return out.toString();
}

type StripeError = { error?: { type?: string; code?: string } };

/**
 * One Stripe API call. Returns the HTTP status and body; a network failure
 * throws PaymentProviderError. The key goes only into the Authorization
 * header; logs carry the path, status and Stripe's error type/code, never the
 * key or Stripe's error message (which can echo parts of the request).
 */
export async function stripeRequest<T>(
  secretKey: string,
  method: "GET" | "POST",
  path: string,
  params: Record<string, unknown> = {},
  opts: { idempotencyKey?: string } = {},
): Promise<{ status: number; body: T & StripeError }> {
  const form = formEncode(params);
  const url = `https://api.stripe.com${path}${method === "GET" && form ? `?${form}` : ""}`;
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${secretKey}`,
        ...(method === "POST" ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
        ...(opts.idempotencyKey ? { "Idempotency-Key": opts.idempotencyKey } : {}),
      },
      body: method === "POST" ? form : undefined,
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    log.error("stripe.request_failed", { path: redactPath(path), error_name: err instanceof Error ? err.name : typeof err });
    throw new PaymentProviderError();
  }
  const body = (await res.json().catch(() => ({}))) as T & StripeError;
  if (!res.ok) log.warn("stripe.request_error", { path: redactPath(path), status: res.status, type: body.error?.type, code: body.error?.code });
  return { status: res.status, body };
}

/** A call that must succeed: provider errors become a generic PaymentProviderError for the user. */
export async function stripeApi<T>(
  method: "GET" | "POST",
  path: string,
  params: Record<string, unknown> = {},
  opts: { idempotencyKey?: string } = {},
): Promise<T> {
  const config = stripeConfig();
  if (!config) throw new PaymentsNotConnectedError();
  const res = await stripeRequest<T>(config.secretKey, method, path, params, opts);
  if (res.status < 200 || res.status >= 300) {
    log.error("stripe.request_failed", { path: redactPath(path), status: res.status, type: res.body.error?.type, code: res.body.error?.code });
    throw new PaymentProviderError();
  }
  return res.body;
}

/** Object ids in paths are fine to log; anything else is cut. */
const redactPath = (path: string) => path.replace(/[^A-Za-z0-9/_-]/g, "");

// ── Redirect allowlist ──────────────────────────────────────────────────────

/** Hosts a Checkout or Customer Portal session may send the browser to. */
const STRIPE_REDIRECT_HOSTS = new Set(["checkout.stripe.com", "billing.stripe.com"]);

/** True for an https URL on Stripe's Checkout or Portal host; anything else is never redirected to. */
export function isAllowedProviderRedirect(url: unknown): url is string {
  if (typeof url !== "string") return false;
  try {
    const u = new URL(url);
    return u.protocol === "https:" && STRIPE_REDIRECT_HOSTS.has(u.hostname) && !u.username && !u.password && !u.port;
  } catch {
    return false;
  }
}

// ── Webhook signatures ──────────────────────────────────────────────────────

/** Events the webhook endpoint must send (docs/billing.md); webhook.ts handles each. */
export const STRIPE_WEBHOOK_EVENTS = [
  "checkout.session.completed",
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
  "invoice.paid",
  "invoice.payment_succeeded",
  "invoice.payment_failed",
  "charge.refunded",
] as const;

/** Default tolerance between the signed timestamp and now, as Stripe's libraries use. */
export const SIGNATURE_TOLERANCE_SECONDS = 300;

export type SignatureCheck = { ok: true; timestamp: number } | { ok: false; reason: "missing_header" | "malformed_header" | "stale_timestamp" | "bad_signature" };

export function signPayload(payload: string, secret: string, timestamp: number): string {
  return createHmac("sha256", secret).update(`${timestamp}.${payload}`, "utf8").digest("hex");
}

/** A Stripe-Signature header value for tests and local tooling. */
export function stripeSignatureHeader(payload: string, secret: string, timestamp = Math.floor(Date.now() / 1000)): string {
  return `t=${timestamp},v1=${signPayload(payload, secret, timestamp)}`;
}

/**
 * Verifies `Stripe-Signature: t=…,v1=…[,v1=…]` over the raw request body:
 * HMAC-SHA256 of "t.payload" with the endpoint secret, compared in constant
 * time against every v1 (Stripe sends several while a secret is rolled), and a
 * timestamp within the tolerance to stop replays of old captures.
 */
export function verifyStripeSignature(
  payload: string,
  header: string | null | undefined,
  secret: string,
  opts: { now?: Date; toleranceSeconds?: number } = {},
): SignatureCheck {
  if (!header) return { ok: false, reason: "missing_header" };
  let timestamp: number | null = null;
  const signatures: string[] = [];
  for (const part of header.split(",")) {
    const i = part.indexOf("=");
    if (i < 1) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k === "t" && /^\d{1,12}$/.test(v)) timestamp = Number(v);
    else if (k === "v1" && /^[0-9a-f]{64}$/i.test(v)) signatures.push(v.toLowerCase());
  }
  if (timestamp === null || !signatures.length) return { ok: false, reason: "malformed_header" };
  const now = Math.floor((opts.now ?? new Date()).getTime() / 1000);
  if (Math.abs(now - timestamp) > (opts.toleranceSeconds ?? SIGNATURE_TOLERANCE_SECONDS)) return { ok: false, reason: "stale_timestamp" };
  const expected = Buffer.from(signPayload(payload, secret, timestamp), "hex");
  const match = signatures.some((s) => {
    const given = Buffer.from(s, "hex");
    return given.length === expected.length && timingSafeEqual(given, expected);
  });
  return match ? { ok: true, timestamp } : { ok: false, reason: "bad_signature" };
}
