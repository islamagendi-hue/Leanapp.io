import { connectionHealth, liveEvents } from "@/modules/debugger/service";
import { apiError, apiTenant } from "@/server/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Event debugger feed: GET ?after=<id> returns newer events plus connection health. */
export async function GET(req: Request, ctx: RouteContext<"/v1/organizations/[org]/environments/[env]/events">) {
  try {
    const { org, env } = await ctx.params;
    const tenant = await apiTenant(req, org);
    const after = new URL(req.url).searchParams.get("after") ?? undefined;
    const [events, health] = [await liveEvents(tenant, env, { afterId: after, limit: 100 }), await connectionHealth(tenant, env)];
    return Response.json({ events, health }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return apiError(err);
  }
}
