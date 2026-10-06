import { getKeyEnvironment } from "@/modules/management/service";
import { managementApi } from "@/server/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /v1/environment (secret key, management:read): the environment the key belongs to. */
export function GET(req: Request) {
  return managementApi(req, "/v1/environment", "management:read", (key) => getKeyEnvironment(key));
}
