import { eventsReport } from "@/modules/management/service";
import { managementApi } from "@/server/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

/** GET /v1/analytics/events?days=7|30|90 (secret key, analytics:read): events with counts and people, most frequent first. */
export function GET(req: Request) {
  return managementApi(req, "/v1/analytics/events", "analytics:read", (key) => eventsReport(key, new URL(req.url).searchParams.get("days") ?? 30));
}
