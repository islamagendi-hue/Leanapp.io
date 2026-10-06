import "server-only";
/**
 * Stripe over its REST API with fetch (no SDK). Card data never touches
 * LeanApp: customers pay on Stripe Checkout and manage payment methods in the
 * Stripe Customer Portal.
 *
 * Configuration (env only, never in git):
 *   STRIPE_SECRET_KEY      sk_live_… / sk_test_… (or a restricted rk_… key)
 *   STRIPE_WEBHOOK_SECRET  whsec_… of the webhook endpoint /api/webhooks/stripe
 * Payments count as connected only when both are set: without the webhook a
 * paid checkout could never activate the plan.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { AppError } from "@/lib/errors";
import { log } from "@/lib/log";

type Env = Record<string, string | undefined>;

export interface StripeConfig {
  secretKey: string;
  webhookSecret: string;
}

export function stripeConfig(env: Env = process.env): StripeConfig | null {
  const secretKey = env.STRIPE_SECRET_KEY?.trim();
  const webhookSecret = env.STRIPE_WEBHOOK_SECRET?.trim();
  return secretKey && webhookSecret ? { secretKey, webhookSecret } : null;
}

export function paymentsConnected(env: Env = process.env): boolean {
  return stripeConfig(env) !== null;
}

export class PaymentsNotConnectedError extends AppError {
  constructor() {
    super("payments_not_connected", "Payments are not connected yet.", 503);
  }
}

export class PaymentProviderError extends AppError {
  constructor() {
    super("payment_provider_error", "The payment provider couldn't complete the request. Try again in a moment.", 502);
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

export async function stripeApi<T>(
  method: "GET" | "POST",
  path: string,
  params: Record<string, unknown> = {},
  opts: { idempotencyKey?: string } = {},
): Promise<T> {
  const config = stripeConfig();
  if (!config) throw new PaymentsNotConnectedError();
  const body = formEncode(params);
  const url = `https://api.stripe.com${path}${method === "GET" && body ? `?${body}` : ""}`;
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${config.secretKey}`,
        ...(method === "POST" ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
        ...(opts.idempotencyKey ? { "Idempotency-Key": opts.idempotencyKey } : {}),
      },
      body: method === "POST" ? body : undefined,
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    log.error("stripe.request_failed", { path, error: err instanceof Error ? err.message : String(err) });
    throw new PaymentProviderError();
  }
  const json = (await res.json().catch(() => ({}))) as T & { error?: { type?: string; code?: string; message?: string } };
  if (!res.ok) {
    // Stripe's error messages describe our request, not the customer: log them, show a generic one.
    log.error("stripe.request_failed", { path, status: res.status, type: json.error?.type, code: json.error?.code, message: json.error?.message });
    throw new PaymentProviderError();
  }
  return json;
}

// ── Webhook signatures ──────────────────────────────────────────────────────

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
