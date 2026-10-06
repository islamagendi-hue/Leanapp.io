import { skanResponse } from "@/modules/attribution/skan-http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /.well-known/skadnetwork/report-attribution/: developer copies of
 * SKAdNetwork postbacks (Info.plist NSAdvertisingAttributionReportEndpoint).
 * Verified with Apple's public key and routed by App Store id.
 */
export function POST(req: Request) {
  return skanResponse(req, "skadnetwork");
}
