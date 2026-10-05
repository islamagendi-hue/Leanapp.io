import { createApp, listApps } from "@/modules/apps/service";
import { apiError, apiTenant } from "@/server/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request, ctx: RouteContext<"/v1/organizations/[org]/apps">) {
  try {
    const tenant = await apiTenant(req, (await ctx.params).org);
    return Response.json({ apps: await listApps(tenant) });
  } catch (err) {
    return apiError(err);
  }
}

export async function POST(req: Request, ctx: RouteContext<"/v1/organizations/[org]/apps">) {
  try {
    const tenant = await apiTenant(req, (await ctx.params).org);
    const body = await req.json().catch(() => null);
    return Response.json(await createApp(tenant, body), { status: 201 });
  } catch (err) {
    return apiError(err);
  }
}
