import { eventTrendReport } from "@/modules/management/service";
import { managementApi } from "@/server/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

/** GET /v1/analytics/trend?event=…&days=…&breakdown=… (secret key, analytics:read): daily counts and people for one event. */
export function GET(req: Request) {
  return managementApi(req, "/v1/analytics/trend", "analytics:read", (key) => {
    const q = new URL(req.url).searchParams;
    return eventTrendReport(key, { event: q.get("event") ?? "", days: q.get("days") ?? 30, breakdown: q.get("breakdown") ?? undefined });
  });
}
