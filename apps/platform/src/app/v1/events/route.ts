import { reportServerErrorResponse } from "@/lib/monitoring";
import { handleIngest, preflight } from "@/modules/ingestion/http";
import { reportInBackground } from "@/server/report-in-background";

export const runtime = "nodejs";

export function OPTIONS() {
  return preflight();
}

export async function POST(req: Request) {
  const res = await handleIngest(req, "single");
  // Monitoring only (docs/ops/monitoring.md): each 5xx is reported, throttled; the response is unchanged.
  if (res.status >= 500) reportInBackground(() => reportServerErrorResponse("POST /v1/events", res.status));
  return res;
}
