import { skanResponse } from "@/modules/attribution/skan-http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /.well-known/appattribution/report-attribution/: developer copies of
 * AdAttributionKit postbacks (Info.plist AdAttributionKit → AttributionCopyEndpoint).
 * The JWS is verified with Apple's key for its kid and routed by App Store id.
 */
export function POST(req: Request) {
  return skanResponse(req, "adattributionkit");
}
