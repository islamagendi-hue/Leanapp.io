import { getDeletion } from "@/modules/privacy/service";
import { apiError, apiSecretKey } from "@/server/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /v1/privacy/deletions/{id}: status of a deletion request made with a key of the same environment. */
export async function GET(req: Request, ctx: RouteContext<"/v1/privacy/deletions/[id]">) {
  try {
    const key = await apiSecretKey(req);
    const { id } = await ctx.params;
    const d = await getDeletion({ kind: "api_key", organizationId: key.organizationId, environmentId: key.environmentId, keyId: key.keyId }, key.environmentId, id);
    return Response.json(
      {
        id: d.id,
        status: d.status,
        subject: d.subject,
        created_at: d.created_at,
        completed_at: d.completed_at,
        rows_deleted: d.job?.rows_deleted ?? 0,
        details: d.job?.details ?? {},
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    return apiError(err);
  }
}
