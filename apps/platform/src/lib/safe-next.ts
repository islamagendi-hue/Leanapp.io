/**
 * Post-login/sign-up return paths (`?next=`). Only same-origin relative paths
 * are allowed, so a crafted link can't bounce a fresh session to another site.
 * Browsers treat `\` like `/` and drop tabs and newlines inside URLs, so
 * `/\evil.example` or `/\t/evil.example` would otherwise leave the origin.
 */
const BASE = "https://leanapp.invalid";

export function safeNext(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 2048) return null;
  if (!value.startsWith("/") || value.startsWith("//")) return null;
  if (value.includes("\\") || /[\u0000-\u001f\u007f]/.test(value)) return null;
  let url: URL;
  try {
    url = new URL(value, BASE);
  } catch {
    return null;
  }
  if (url.origin !== BASE) return null;
  return `${url.pathname}${url.search}${url.hash}`;
}
