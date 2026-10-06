import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { AppError } from "./errors";

/**
 * Encryption at rest for secrets customers give us (push credentials, email
 * provider keys) and webhook signing secrets we must be able to use again.
 *
 * AES-256-GCM with a key derived (SHA-256) from INTEGRATIONS_ENCRYPTION_KEY,
 * which must be at least 32 characters (e.g. `openssl rand -base64 32`).
 * Each value is bound to its row by `aad` (e.g. "webhook:<id>"), so a
 * ciphertext copied onto another row does not decrypt.
 *
 * Format: v1.<iv>.<tag>.<ciphertext>, base64url parts.
 *
 * Fails safe: without the key nothing is encrypted or decrypted and callers
 * get SecretsUnavailableError, which the UI shows as "not configured".
 */
export class SecretsUnavailableError extends AppError {
  constructor() {
    super("secrets_unavailable", "Encrypted credentials are not available: the server has no INTEGRATIONS_ENCRYPTION_KEY configured.", 503);
  }
}

function key(): Buffer {
  const raw = process.env.INTEGRATIONS_ENCRYPTION_KEY ?? "";
  if (raw.length < 32) throw new SecretsUnavailableError();
  return createHash("sha256").update(raw).digest();
}

export function secretsAvailable(): boolean {
  return (process.env.INTEGRATIONS_ENCRYPTION_KEY ?? "").length >= 32;
}

export function encryptSecret(plaintext: string, aad: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  cipher.setAAD(Buffer.from(aad));
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return ["v1", iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), ct.toString("base64url")].join(".");
}

export function decryptSecret(value: string, aad: string): string {
  const [v, iv, tag, ct] = value.split(".");
  if (v !== "v1" || !iv || !tag || ct === undefined) throw new Error("secret-box: unknown format");
  const decipher = createDecipheriv("aes-256-gcm", key(), Buffer.from(iv, "base64url"));
  decipher.setAAD(Buffer.from(aad));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(ct, "base64url")), decipher.final()]).toString("utf8");
}
