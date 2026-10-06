import { clientIp, preflight, sdkEndpoint } from "@/modules/deeplinks/http";
import { resolveLink } from "@/modules/deeplinks/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function OPTIONS() {
  return preflight();
}

/**
 * GET /v1/deep-links/resolve?url=…&anonymous_id=…&platform=… (public SDK key): the deep link,
 * campaign and click id of a LeanApp link an installed app was opened with.
 */
export function GET(req: Request) {
  const q = new URL(req.url).searchParams;
  return sdkEndpoint(req, "/v1/deep-links/resolve", (key) =>
    resolveLink(key, { url: q.get("url") ?? "", anonymous_id: q.get("anonymous_id") ?? undefined, platform: q.get("platform") ?? undefined }, {
      ip: clientIp(req),
      userAgent: req.headers.get("user-agent"),
    }),
  );
}
