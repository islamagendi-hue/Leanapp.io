import { readMediaFile } from "@/modules/media/service";
import { apiError } from "@/server/api";
import { mediaRoute } from "@/server/media";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET: the file for a signed-in member with media.read in this app (previews
 * in the library and the picker). Private cache only; served inline with a
 * sandboxing CSP and nosniff so no file can run script on the dashboard origin.
 * `?download=1` saves it instead.
 */
export async function GET(req: Request, route: RouteContext<"/o/[org]/apps/[app]/engage/media/[id]/file">) {
  try {
    const { org, app, id } = await route.params;
    const { ctx, appId } = await mediaRoute(req, org, app);
    const file = await readMediaFile(ctx, appId, id);
    const etag = `"${file.checksum}"`;
    const headers: Record<string, string> = {
      "Content-Type": file.mime,
      "Cache-Control": "private, max-age=300",
      ETag: etag,
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; img-src 'self'; media-src 'self'; sandbox",
      "Cross-Origin-Resource-Policy": "same-origin",
      "Content-Disposition": `${new URL(req.url).searchParams.get("download") ? "attachment" : "inline"}; filename*=UTF-8''${encodeURIComponent(file.name)}`,
    };
    if (req.headers.get("if-none-match") === etag) return new Response(null, { status: 304, headers });
    return new Response(Buffer.from(file.bytes), { headers });
  } catch (err) {
    return apiError(err);
  }
}
