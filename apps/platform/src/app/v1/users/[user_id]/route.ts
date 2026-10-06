import { lookupUser } from "@/modules/management/service";
import { managementApi } from "@/server/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /v1/users/{user_id} (secret key, users:read): an end user of the key's environment, by your user_id (URL-encoded). */
export async function GET(req: Request, ctx: RouteContext<"/v1/users/[user_id]">) {
  const { user_id } = await ctx.params;
  return managementApi(req, "/v1/users/{user_id}", "users:read", (key) => lookupUser(key, user_id));
}
