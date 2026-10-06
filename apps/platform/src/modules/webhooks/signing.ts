/**
 * Webhook signing, retry schedule and outbound address rules. Pure, unit tested.
 *
 * Signature header (Stripe-style, so customers can reuse familiar code):
 *   LeanApp-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256(secret, "<t>.<raw body>")>
 * Receivers recompute the HMAC over the exact raw body, compare in constant
 * time, and reject timestamps older than a few minutes (replay protection).
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";

export const SIGNATURE_HEADER = "LeanApp-Signature";

export function signatureHeader(secret: string, body: string, timestamp: number): string {
  const mac = createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
  return `t=${timestamp},v1=${mac}`;
}

/** Reference verifier (also what docs/webhooks.md shows customers). */
export function verifySignature(secret: string, header: string | null, body: string, opts: { now?: number; toleranceSeconds?: number } = {}): boolean {
  if (!header) return false;
  const parts = Object.fromEntries(header.split(",").map((kv) => kv.trim().split("=", 2) as [string, string]));
  const t = Number(parts.t);
  if (!Number.isInteger(t) || !parts.v1) return false;
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - t) > (opts.toleranceSeconds ?? 300)) return false;
  const expected = Buffer.from(createHmac("sha256", secret).update(`${t}.${body}`).digest("hex"));
  const given = Buffer.from(parts.v1);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/** Attempts before a delivery is given up. */
export const MAX_ATTEMPTS = 10;
const BASE_SECONDS = 60;
const CAP_SECONDS = 6 * 3600;

/**
 * Seconds to wait after failed attempt number `attempt` (1-based): 1, 2, 4, …
 * minutes, capped at 6 hours, plus up to 10% jitter so retries of many
 * deliveries don't arrive in lockstep. ~8.5 hours from first to last attempt.
 */
export function backoffSeconds(attempt: number, random = Math.random): number {
  const base = Math.min(CAP_SECONDS, BASE_SECONDS * 2 ** Math.max(0, attempt - 1));
  return Math.round(base + base * 0.1 * random());
}

/** True for loopback, private, link-local, CGNAT, multicast and other non-public addresses. */
export function isPrivateAddress(address: string): boolean {
  const kind = isIP(address);
  if (kind === 4) {
    const [a, b] = address.split(".").map(Number);
    return (
      a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 0) ||
      (a === 198 && (b === 18 || b === 19))
    );
  }
  if (kind === 6) {
    const v = address.toLowerCase();
    const mapped = v.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateAddress(mapped[1]);
    return v === "::" || v === "::1" || /^f[cd]/.test(v) || /^fe[89ab]/.test(v) || /^ff/.test(v) || v.startsWith("64:ff9b:");
  }
  return true; // not an address: refuse
}
