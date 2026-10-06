import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "node:crypto";
import { AppError } from "./errors";

/**
 * Encryption at rest for secrets customers give us (ad-network tokens, push
 * and messaging credentials, email provider keys) and for webhook signing
 * secrets we must be able to use again.
 *
 * AES-256-GCM with the key from INTEGRATIONS_ENCRYPTION_KEY: 32 bytes, given
 * as base64 (`openssl rand -base64 32`) or 64 hex characters. One key for
 * every caller.
 *
 * Format: v1.<iv>.<tag>.<ciphertext>, base64url parts. `aad` (optional)
 * binds a value to its row (e.g. "webhook:<id>"), so a ciphertext copied
 * onto another row does not decrypt. Values written without `aad`
 * (attribution credentials) are read without it; GCM treats a missing AAD as
 * empty, so both kinds share the format.
 *
 * Fails safe: without a valid key nothing is encrypted or decrypted and
 * callers get SecretsUnavailableError, which the UI shows as "not configured".
 */
export class SecretsUnavailableError extends AppError {
  constructor() {
    super("secrets_unavailable", "Encrypted credentials are not available: the server has no valid INTEGRATIONS_ENCRYPTION_KEY configured.", 503);
  }
}

function parseKey(env: Record<string, string | undefined> = process.env): Buffer | null {
  const raw = env.INTEGRATIONS_ENCRYPTION_KEY?.trim();
  if (!raw) return null;
  const buf = /^[0-9a-f]{64}$/i.test(raw) ? Buffer.from(raw, "hex") : Buffer.from(raw, "base64");
  return buf.length === 32 ? buf : null;
}

function key(): Buffer {
  const k = parseKey();
  if (!k) throw new SecretsUnavailableError();
  return k;
}

export function encryptionAvailable(env?: Record<string, string | undefined>): boolean {
  return parseKey(env) !== null;
}

/** Problem with INTEGRATIONS_ENCRYPTION_KEY for the config check, or null when usable / unset. */
export function encryptionKeyProblem(env: Record<string, string | undefined>): string | null {
  if (!env.INTEGRATIONS_ENCRYPTION_KEY) return null;
  return parseKey(env) ? null : "must be 32 bytes, as base64 or 64 hex characters";
}

export function encryptSecret(plaintext: string, aad?: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  if (aad) cipher.setAAD(Buffer.from(aad));
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return ["v1", iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), ct.toString("base64url")].join(".");
}

export function decryptSecret(value: string, aad?: string): string {
  const k = key();
  const [v, iv, tag, ct] = value.split(".");
  if (v !== "v1" || !iv || !tag || ct === undefined) throw new Error("unrecognised secret format");
  const decipher = createDecipheriv("aes-256-gcm", k, Buffer.from(iv, "base64url"));
  if (aad) decipher.setAAD(Buffer.from(aad));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(ct, "base64url")), decipher.final()]).toString("utf8");
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
