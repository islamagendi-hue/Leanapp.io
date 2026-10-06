import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "node:crypto";

/**
 * Encryption at rest for secrets customers give us (ad-network tokens).
 * AES-256-GCM with the key from INTEGRATIONS_ENCRYPTION_KEY (32 bytes as
 * base64 or 64 hex characters). Without a valid key nothing is encrypted or
 * decrypted: callers refuse to store credentials instead of storing them in
 * the clear. Format: v1.<iv>.<tag>.<ciphertext>, base64url parts.
 */
function key(env: Record<string, string | undefined> = process.env): Buffer | null {
  const raw = env.INTEGRATIONS_ENCRYPTION_KEY?.trim();
  if (!raw) return null;
  const buf = /^[0-9a-f]{64}$/i.test(raw) ? Buffer.from(raw, "hex") : Buffer.from(raw, "base64");
  return buf.length === 32 ? buf : null;
}

export function encryptionAvailable(env?: Record<string, string | undefined>): boolean {
  return key(env) !== null;
}

/** Problem with INTEGRATIONS_ENCRYPTION_KEY for the config check, or null when usable / unset. */
export function encryptionKeyProblem(env: Record<string, string | undefined>): string | null {
  if (!env.INTEGRATIONS_ENCRYPTION_KEY) return null;
  return key(env) ? null : "must be 32 bytes, as base64 or 64 hex characters";
}

export function encryptSecret(plain: string): string {
  const k = key();
  if (!k) throw new Error("INTEGRATIONS_ENCRYPTION_KEY is not configured");
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", k, iv);
  const ct = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return ["v1", iv.toString("base64url"), c.getAuthTag().toString("base64url"), ct.toString("base64url")].join(".");
}

export function decryptSecret(box: string): string {
  const k = key();
  if (!k) throw new Error("INTEGRATIONS_ENCRYPTION_KEY is not configured");
  const [v, iv, tag, ct] = box.split(".");
  if (v !== "v1" || !iv || !tag || ct === undefined) throw new Error("unrecognised secret format");
  const d = createDecipheriv("aes-256-gcm", k, Buffer.from(iv, "base64url"));
  d.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([d.update(Buffer.from(ct, "base64url")), d.final()]).toString("utf8");
}

/**
 * Keyed hash of an end user's IP address for attribution matching. The raw
 * IP is never stored. Keyed with ATTRIBUTION_IP_HASH_SECRET so the small IPv4
 * space can't be brute-forced from the hash; local development falls back to
 * a fixed key. Deployed without the secret, returns null (no IP matching).
 */
export function hashIp(appId: string, ip: string | null | undefined, env: Record<string, string | undefined> = process.env): string | null {
  if (!ip || ip === "unknown") return null;
  const deployed = env.VERCEL_ENV === "production" || env.VERCEL_ENV === "preview";
  const secret = env.ATTRIBUTION_IP_HASH_SECRET || (deployed ? "" : "leanapp-local-development-only");
  if (!secret) return null;
  const normalized = ip.trim().toLowerCase().replace(/^::ffff:/, "");
  return createHmac("sha256", secret).update(`${appId}|${normalized}`).digest("base64url").slice(0, 32);
}

