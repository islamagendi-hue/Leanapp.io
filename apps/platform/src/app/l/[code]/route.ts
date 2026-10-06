import { log } from "@/lib/log";
import { handleClick } from "@/modules/attribution/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const HEADERS = { "Cache-Control": "no-store, private", "X-Robots-Tag": "noindex, nofollow", "Referrer-Policy": "no-referrer" };

/**
 * GET /l/{code}: LeanApp tracking link. Records the click (see
 * modules/attribution/service.ts handleClick) and redirects to the App Store,
 * Play Store (with the click id in `referrer`) or the web fallback.
 */
async function handle(req: Request, ctx: RouteContext<"/l/[code]">): Promise<Response> {
  const { code } = await ctx.params;
  const url = new URL(req.url);
  try {
    const out = await handleClick(code, {
      method: req.method,
      headers: req.headers,
      ip: req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || req.headers.get("x-real-ip") || null,
      query: url.searchParams,
    });
    if (out.status === 404) return new Response("Link not found.", { status: 404, headers: { ...HEADERS, "Content-Type": "text/plain; charset=utf-8" } });
    return new Response(null, { status: 302, headers: { ...HEADERS, Location: out.location } });
  } catch (err) {
    log.error("attribution.click_failed", { error: err });
    return new Response("Something went wrong. Please try the link again.", { status: 503, headers: { ...HEADERS, "Content-Type": "text/plain; charset=utf-8", "Retry-After": "5" } });
  }
}

export const GET = handle;
export const HEAD = handle;
