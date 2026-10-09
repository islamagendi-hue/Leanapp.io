import { msg } from "@/i18n/translate";
import { RateLimitError, ValidationError } from "@/lib/errors";
import { consumeRateLimit } from "@/lib/rate-limit";
import { assertCan } from "@/modules/rbac/authorize";
import { maxUploadBytes, MAX_FILES_PER_UPLOAD } from "@/modules/media/policy";
import { uploadMedia } from "@/modules/media/service";
import { apiError } from "@/server/api";
import { mediaJson, mediaRoute, type MediaAssetJson } from "@/server/media";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const MULTIPART_OVERHEAD = 64 * 1024;

/**
 * POST multipart/form-data with one or more `file` fields (and optional
 * `folder`, `tags`), from the Media Library page (session cookie, same origin,
 * media.manage). Each file is checked and stored on its own; the response
 * lists a result per file so one bad file doesn't fail the others.
 */
export async function POST(req: Request, route: RouteContext<"/o/[org]/apps/[app]/engage/media/upload">) {
  try {
    const { org, app } = await route.params;
    const { ctx, appId } = await mediaRoute(req, org, app);
    assertCan(ctx.role, "media.manage");
    const max = maxUploadBytes();
    const length = Number(req.headers.get("content-length") ?? "0");
    if (length > max * MAX_FILES_PER_UPLOAD + MULTIPART_OVERHEAD) throw new ValidationError(msg("The upload is too large."));
    const wait = await consumeRateLimit(`media-upload:${ctx.organizationId}`, 120, 60);
    if (wait) throw new RateLimitError(wait);

    let form: FormData;
    try {
      form = await req.formData();
    } catch {
      throw new ValidationError(msg("The upload could not be read. Try again."));
    }
    const files = form.getAll("file").filter((f): f is File => typeof f === "object" && f !== null && "arrayBuffer" in f);
    if (files.length === 0) throw new ValidationError(msg("Choose at least one file."));
    if (files.length > MAX_FILES_PER_UPLOAD) throw new ValidationError(msg("Upload at most 10 files at a time."));
    const folder = typeof form.get("folder") === "string" ? (form.get("folder") as string) : null;
    const tags = typeof form.get("tags") === "string" ? (form.get("tags") as string) : "";

    const results: { name: string; ok: boolean; duplicate?: boolean; asset?: MediaAssetJson; error?: string }[] = [];
    for (const file of files) {
      try {
        if (file.size > max) throw new ValidationError(msg("The file is larger than the upload limit."));
        const bytes = new Uint8Array(await file.arrayBuffer());
        const { asset, duplicate } = await uploadMedia(ctx, appId, { bytes, declaredType: file.type, filename: file.name, folder, tags });
        results.push({ name: file.name, ok: true, duplicate, asset: mediaJson(org, app, asset) });
      } catch (e) {
        if (!(e instanceof ValidationError)) throw e;
        results.push({ name: file.name, ok: false, error: e.message });
      }
    }
    return Response.json({ results, maxBytes: max }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return apiError(err);
  }
}
