import { apiGrowthDefinition } from "@/modules/growth/service";
import { managementApi } from "@/server/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /v1/growth/definition (secret key, management:read): the growth definitions of the published tracking plan. */
export function GET(req: Request) {
  return managementApi(req, "/v1/growth/definition", "management:read", (key) => apiGrowthDefinition(key));
}
