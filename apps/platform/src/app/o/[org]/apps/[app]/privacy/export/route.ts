import { exportSubjectData } from "@/modules/privacy/service";
import { apiError, apiTenant } from "@/server/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Dashboard download of a subject's data: GET ?environment=<id>&user_id=&anonymous_id= (session cookie). */
export async function GET(req: Request, ctx: RouteContext<"/o/[org]/apps/[app]/privacy/export">) {
  try {
    const { org } = await ctx.params;
    const tenant = await apiTenant(req, org);
    const q = new URL(req.url).searchParams;
    const data = await exportSubjectData({ kind: "user", ctx: tenant }, q.get("environment") ?? "", {
      userId: q.get("user_id") ?? undefined,
      anonymousId: q.get("anonymous_id") ?? undefined,
    });
    return new Response(JSON.stringify(data, null, 2), {
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Disposition": `attachment; filename="leanapp-export-${data.request_id}.json"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (err) {
    return apiError(err);
  }
}
