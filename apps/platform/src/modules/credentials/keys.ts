import { randomToken, sha256 } from "@/lib/crypto";

export type EnvironmentType = "development" | "staging" | "production";
const ENV_TAG: Record<EnvironmentType, string> = { development: "dev", staging: "stg", production: "live" };

/** Public, client-safe key embedded in mobile apps. Write-only access to ingestion. */
export function generateSdkKey(env: EnvironmentType) {
  const key = `la_pk_${ENV_TAG[env]}_${randomToken(18)}`;
  return { key, hash: sha256(key) };
}

/** Server-side secret key. Shown once; only the hash and a display prefix are stored. */
export function generateApiKey(env: EnvironmentType) {
  const key = `la_sk_${ENV_TAG[env]}_${randomToken(32)}`;
  return { key, hash: sha256(key), prefix: key.slice(0, 16) };
}

export function keyKind(raw: string): "sdk" | "api" | null {
  if (/^la_pk_(dev|stg|live)_[A-Za-z0-9_-]{20,}$/.test(raw)) return "sdk";
  if (/^la_sk_(dev|stg|live)_[A-Za-z0-9_-]{40,}$/.test(raw)) return "api";
  return null;
}
