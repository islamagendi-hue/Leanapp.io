import { pendingInAppMessages } from "@/modules/messaging/in-app";
import { IN_APP_CORS, inAppError, inAppPrincipal, withCors } from "@/modules/messaging/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function OPTIONS() {
  return new Response(null, { status: 204, headers: IN_APP_CORS });
}

/**
 * GET /v1/in-app?user_id=…&anonymous_id=… with the app's public SDK key.
 * Pending in-app messages for that user in the key's environment (see docs/sdk.md).
 */
export async function GET(req: Request) {
  try {
    const principal = await inAppPrincipal(req);
    const q = new URL(req.url).searchParams;
    const messages = await pendingInAppMessages(principal, { userId: q.get("user_id") ?? undefined, anonymousId: q.get("anonymous_id") ?? undefined });
    return withCors(Response.json({ messages }));
  } catch (err) {
    return inAppError(err);
  }
}
