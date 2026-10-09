import { readPublicMedia } from "@/modules/media/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /m/<token>.<ext>: the durable public link of a media library file whose
 * public access is on (providers such as WhatsApp, FCM/APNs service extensions
 * and email clients fetch it themselves). The token is an unguessable 192-bit
 * value; the extension is cosmetic. 404 once the file is deleted or its
 * public access is turned off. No cookies are read.
 */
export async function GET(req: Request, route: RouteContext<"/m/[file]">) {
  const { file } = await route.params;
  const token = file.replace(/\.[a-z0-9]{2,4}$/i, "");
  const found = await readPublicMedia(token).catch(() => null);
  if (!found) return new Response("Not found", { status: 404, headers: { "Cache-Control": "no-store", "Content-Type": "text/plain" } });
  const etag = `"${found.checksum}"`;
  const headers: Record<string, string> = {
    "Content-Type": found.mime,
    // Short enough that a replaced or unpublished file stops being served soon.
    "Cache-Control": "public, max-age=300",
    ETag: etag,
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "default-src 'none'; sandbox",
    "Cross-Origin-Resource-Policy": "cross-origin",
    "Access-Control-Allow-Origin": "*",
  };
  if (req.headers.get("if-none-match") === etag) return new Response(null, { status: 304, headers });
  return new Response(Buffer.from(found.bytes), { headers });
}
