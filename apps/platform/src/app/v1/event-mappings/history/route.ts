import { apiMappingHistory } from "@/modules/implementation/service";
import { managementApi } from "@/server/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /v1/event-mappings/history?limit=200 (secret key, management:read): every change to the app's mappings, newest first. */
export function GET(req: Request) {
  return managementApi(req, "/v1/event-mappings/history", "management:read", (key) => {
    const limit = Number(new URL(req.url).searchParams.get("limit") ?? 200);
    return apiMappingHistory(key, Number.isFinite(limit) ? limit : 200);
  });
}
