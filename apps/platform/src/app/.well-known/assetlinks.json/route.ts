import { serveAssetLinks } from "@/modules/deeplinks/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Digital Asset Links for Android App Links: every Android app whose links use this host. */
export function GET(req: Request) {
  return serveAssetLinks(req);
}
