import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { ValidationError } from "@/lib/errors";

/**
 * Postback URLs are customer-supplied and fetched from our servers, so they
 * must not reach our own network (SSRF). Deployed (VERCEL_ENV set), only
 * https to public addresses is allowed and every resolved address is checked
 * right before sending. Local development and tests may use http://localhost.
 */
const deployed = (env: Record<string, string | undefined>) => env.VERCEL_ENV === "production" || env.VERCEL_ENV === "preview";

export function assertPostbackUrlShape(url: string, env: Record<string, string | undefined> = process.env): URL {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new ValidationError("The postback URL is not a valid URL.");
  }
  if (u.username || u.password) throw new ValidationError("Put credentials in the Authorization field, not in the URL.");
  if (u.protocol !== "https:" && !(u.protocol === "http:" && !deployed(env))) throw new ValidationError("The postback URL must use https://.");
  if (deployed(env) && (isPrivateAddress(u.hostname.replace(/^\[|\]$/g, "")) || /^(localhost|.*\.local|.*\.internal)$/i.test(u.hostname))) {
    throw new ValidationError("The postback URL must point at a public host.");
  }
  return u;
}

export function isPrivateAddress(host: string): boolean {
  const v = isIP(host);
  if (v === 4) {
    const [a, b] = host.split(".").map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) || (a === 198 && (b === 18 || b === 19)) || a >= 224;
  }
  if (v === 6) {
    const h = host.toLowerCase();
    if (h === "::" || h === "::1") return true;
    if (h.startsWith("::ffff:")) return isPrivateAddress(h.slice(7));
    return /^(fc|fd|fe8|fe9|fea|feb|ff)/.test(h);
  }
  return false;
}

/** Throws when the URL may not be fetched now (resolves DNS when deployed). */
export async function assertSafeDestination(url: string, env: Record<string, string | undefined> = process.env): Promise<void> {
  const u = assertPostbackUrlShape(url, env);
  if (!deployed(env)) return;
  const host = u.hostname.replace(/^\[|\]$/g, "");
  const addrs = isIP(host) ? [{ address: host }] : await lookup(host, { all: true });
  if (!addrs.length || addrs.some((a) => isPrivateAddress(a.address))) throw new ValidationError("The postback host resolves to a private address.");
}
