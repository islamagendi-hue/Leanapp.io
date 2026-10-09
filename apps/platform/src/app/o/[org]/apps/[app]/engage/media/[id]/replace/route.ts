import { msg } from "@/i18n/translate";
import { ValidationError } from "@/lib/errors";
import { maxUploadBytes } from "@/modules/media/policy";
import { replaceMedia } from "@/modules/media/service";
import { apiError } from "@/server/api";
import { mediaJson, mediaRoute } from "@/server/media";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * POST multipart/form-data with one `file`: replaces the asset's contents,
 * keeping its id and public link (media.manage, same origin). The new file must
 * be the same kind and fit every channel the asset is used on.
 */
export async function POST(req: Request, route: RouteContext<"/o/[org]/apps/[app]/engage/media/[id]/replace">) {
  try {
    const { org, app, id } = await route.params;
    const { ctx, appId } = await mediaRoute(req, org, app);
    const max = maxUploadBytes();
    if (Number(req.headers.get("content-length") ?? "0") > max + 64 * 1024) throw new ValidationError(msg("The file is larger than the upload limit."));
    let form: FormData;
    try {
      form = await req.formData();
    } catch {
      throw new ValidationError(msg("The upload could not be read. Try again."));
    }
    const file = form.get("file");
    if (!file || typeof file === "string") throw new ValidationError(msg("Choose at least one file."));
    if (file.size > max) throw new ValidationError(msg("The file is larger than the upload limit."));
    const asset = await replaceMedia(ctx, appId, id, { bytes: new Uint8Array(await file.arrayBuffer()), declaredType: file.type });
    return Response.json({ asset: mediaJson(org, app, asset) }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return apiError(err);
  }
}
