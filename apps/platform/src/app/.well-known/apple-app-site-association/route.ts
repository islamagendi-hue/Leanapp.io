import { serveAasa } from "@/modules/deeplinks/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Apple App Site Association for the link host this request came to: every iOS app
 * whose links use the host, each scoped to /l/{its prefix}/*. Served as JSON with a
 * 200 and no redirect, which is what iOS and Apple's CDN require.
 */
export function GET(req: Request) {
  return serveAasa(req);
}
