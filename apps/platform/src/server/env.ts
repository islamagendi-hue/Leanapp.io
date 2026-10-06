import "server-only";

/**
 * Public hostnames. Production defaults follow the leanapp.io domain plan
 * (docs/infrastructure.md): dashboard on app.leanapp.io, ingestion and API on
 * api.leanapp.io (same deployment, two domains). Override per environment.
 */
const trim = (u: string) => u.replace(/\/$/, "");
const isProd = process.env.VERCEL_ENV === "production";

/** Base URL SDKs and servers send events to; shown in setup instructions and snippets. */
export function publicBaseUrl(): string {
  return trim(process.env.PUBLIC_API_URL || (isProd ? "https://api.leanapp.io" : process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : "http://localhost:3100"));
}

/** Dashboard URL used in links we hand out (invitations). */
export function publicAppUrl(): string {
  return trim(process.env.PUBLIC_APP_URL || (isProd ? "https://app.leanapp.io" : process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : "http://localhost:3100"));
}

/**
 * Host that serves tracking / deep links (`/l/…`) and the apple-app-site-association
 * and assetlinks.json files for them. Production default is the API host; a dedicated
 * host (e.g. https://l.leanapp.io) is recommended, see docs/deep-links.md.
 */
export function publicLinkUrl(): string {
  return trim(process.env.PUBLIC_LINK_URL || (isProd ? "https://api.leanapp.io" : publicBaseUrl()));
}
