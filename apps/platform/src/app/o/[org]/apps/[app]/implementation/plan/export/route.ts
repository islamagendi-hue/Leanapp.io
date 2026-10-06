import { ValidationError } from "@/lib/errors";
import { getAppBySlug } from "@/modules/apps/service";
import { exportPlan } from "@/modules/implementation/editor";
import { apiError, apiTenant } from "@/server/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Dashboard download of one plan version: GET ?version=<id>&format=json|csv (session cookie). */
export async function GET(req: Request, ctx: RouteContext<"/o/[org]/apps/[app]/implementation/plan/export">) {
  try {
    const { org, app } = await ctx.params;
    const tenant = await apiTenant(req, org);
    const q = new URL(req.url).searchParams;
    const format = q.get("format") ?? "json";
    if (format !== "json" && format !== "csv") throw new ValidationError("format must be json or csv.");
    const { app: a } = await getAppBySlug(tenant, app);
    const file = await exportPlan(tenant, a.id, q.get("version") ?? "", format);
    return new Response(file.body, {
      headers: {
        "Content-Type": file.contentType,
        "Content-Disposition": `attachment; filename="${file.filename}"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (err) {
    return apiError(err);
  }
}
