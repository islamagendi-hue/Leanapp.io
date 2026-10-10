/**
 * Marketing-only mode (MARKETING_ONLY=1): the deployment serves just the public
 * pages, with no database. Sign up, sign in and the demo become an email to us,
 * and every other path goes back to the home page (proxy.ts).
 */
export function marketingOnly(env: Record<string, string | undefined> = process.env): boolean {
  return env.MARKETING_ONLY === "1";
}

const PAGES = new Set(["/", "/features", "/pricing", "/about", "/developers", "/lang", "/theme"]);

/** Whether a path is served in marketing-only mode. Static files never reach the proxy. */
export function servedInMarketingOnly(path: string): boolean {
  return PAGES.has(path) || path.startsWith("/_next/");
}
