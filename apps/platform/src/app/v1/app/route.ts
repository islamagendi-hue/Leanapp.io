import { getKeyApp } from "@/modules/management/service";
import { managementApi } from "@/server/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /v1/app (secret key, management:read): the key's app and the key's environment. */
export function GET(req: Request) {
  return managementApi(req, "/v1/app", "management:read", (key) => getKeyApp(key));
}
