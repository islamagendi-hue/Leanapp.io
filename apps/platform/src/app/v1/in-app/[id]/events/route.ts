import { recordInAppAction } from "@/modules/messaging/in-app";
import { IN_APP_CORS, inAppError, inAppPrincipal, withCors } from "@/modules/messaging/http";
import { jsonBody } from "@/server/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function OPTIONS() {
  return new Response(null, { status: 204, headers: IN_APP_CORS });
}

/** POST /v1/in-app/{id}/events {action: "impression" | "click" | "dismiss", user_id?, anonymous_id?} with the public SDK key. */
export async function POST(req: Request, ctx: RouteContext<"/v1/in-app/[id]/events">) {
  try {
    const principal = await inAppPrincipal(req);
    const { id } = await ctx.params;
    const body = await jsonBody(req, 2048);
    const r = await recordInAppAction(principal, id, { action: body.action, userId: body.user_id ?? undefined, anonymousId: body.anonymous_id ?? undefined });
    return withCors(Response.json(r));
  } catch (err) {
    return inAppError(err);
  }
}
