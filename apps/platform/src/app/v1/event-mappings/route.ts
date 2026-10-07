import { apiMappings } from "@/modules/implementation/service";
import { managementApi } from "@/server/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /v1/event-mappings (secret key, management:read): the app's event mappings (raw name → planned name) and their status. */
export function GET(req: Request) {
  return managementApi(req, "/v1/event-mappings", "management:read", (key) => apiMappings(key));
}
