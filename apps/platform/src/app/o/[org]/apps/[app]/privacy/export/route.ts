import { exportSubjectData } from "@/modules/privacy/service";
import { apiError, apiTenant } from "@/server/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Dashboard download of a subject's data: a form POST of environment, user_id and anonymous_id
 * (session cookie, same origin only). POST because each export is recorded as a privacy request.
 */
export async function POST(req: Request, ctx: RouteContext<"/o/[org]/apps/[app]/privacy/export">) {
  try {
    const { org } = await ctx.params;
    const tenant = await apiTenant(req, org, { form: true });
    const form = await req.formData();
    const field = (k: string) => {
      const v = form.get(k);
      return typeof v === "string" ? v : undefined;
    };
    const data = await exportSubjectData({ kind: "user", ctx: tenant }, field("environment") ?? "", {
      userId: field("user_id"),
      anonymousId: field("anonymous_id"),
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
