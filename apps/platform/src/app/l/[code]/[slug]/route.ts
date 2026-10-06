import { handleLinkRequest } from "@/modules/deeplinks/link-route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /l/{prefix}/{code}: the same link under the environment's deep link prefix. This is
 * the URL iOS (apple-app-site-association) and Android (App Links) hand to the installed
 * app; without the app it behaves like /l/{code}. The first segment is the prefix
 * (the folder is named [code] because Next.js needs one name per level).
 */
async function handle(req: Request, ctx: RouteContext<"/l/[code]/[slug]">): Promise<Response> {
  const { code: prefix, slug: code } = await ctx.params;
  return handleLinkRequest(req, code, prefix);
}

export const GET = handle;
export const HEAD = handle;
