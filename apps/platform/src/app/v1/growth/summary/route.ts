import { apiGrowthSummary } from "@/modules/growth/service";
import { managementApi } from "@/server/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /v1/growth/summary (secret key, management:read): people, activation, core action, revenue and D1/D7/D30 retention of the key's environment. */
export function GET(req: Request) {
  return managementApi(req, "/v1/growth/summary", "management:read", (key) => apiGrowthSummary(key));
}
