import { jsonBody } from "@/server/api";
import { clientIp, preflight, sdkEndpoint } from "@/modules/deeplinks/http";
import { deferredDeepLink } from "@/modules/deeplinks/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function OPTIONS() {
  return preflight();
}

/** POST /v1/deep-links/deferred (public SDK key): the deep link of the click this install came from, once per install. */
export function POST(req: Request) {
  return sdkEndpoint(req, "/v1/deep-links/deferred", async (key) => deferredDeepLink(key, await jsonBody(req, 8_192), { ip: clientIp(req) }));
}
