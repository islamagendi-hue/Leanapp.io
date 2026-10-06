import { handleLinkRequest } from "@/modules/deeplinks/link-route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /l/{code}: LeanApp tracking link. Records the click (see
 * modules/attribution/service.ts handleClick) and redirects to the App Store,
 * Play Store (with the click id in `referrer`) or the web fallback; social
 * in-app browsers get the "Open in app" page (modules/deeplinks/link-route.ts).
 */
async function handle(req: Request, ctx: RouteContext<"/l/[code]">): Promise<Response> {
  const { code } = await ctx.params;
  return handleLinkRequest(req, code, null);
}

export const GET = handle;
export const HEAD = handle;
