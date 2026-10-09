import "server-only";
import { NotFoundError } from "@/lib/errors";
import { getAppBySlug } from "@/modules/apps/service";
import type { MediaAsset } from "@/modules/media/service";
import type { TenantContext } from "@/modules/tenancy/context";
import { apiTenant } from "./api";

/**
 * Tenant and app for the media routes, from the session and the URL's org and
 * app slugs (never from the request body). Writes must come from a page on this
 * origin (multipart uploads can't be forced to JSON, so the Origin is checked).
 */
export async function mediaRoute(req: Request, org: string, appSlug: string): Promise<{ ctx: TenantContext; appId: string }> {
  const ctx = await apiTenant(req, org, { form: true });
  try {
    const { app } = await getAppBySlug(ctx, appSlug);
    return { ctx, appId: app.id };
  } catch (e) {
    if (e instanceof NotFoundError) throw new NotFoundError("App");
    throw e;
  }
}

/** What the browser gets about an asset: no storage key, driver or public token beyond the public URL when it is on. */
export interface MediaAssetJson {
  id: string;
  name: string;
  folder: string | null;
  tags: string[];
  mime: string;
  kind: string;
  sizeBytes: number;
  width: number | null;
  height: number | null;
  publicUrl: string | null;
  fileUrl: string;
  usages: number;
  createdAt: string;
}

export const mediaFileUrl = (org: string, app: string, id: string) => `/o/${encodeURIComponent(org)}/apps/${encodeURIComponent(app)}/engage/media/${id}/file`;

export function mediaJson(org: string, app: string, a: MediaAsset): MediaAssetJson {
  return {
    id: a.id,
    name: a.name,
    folder: a.folder,
    tags: a.tags,
    mime: a.mime,
    kind: a.kind,
    sizeBytes: a.sizeBytes,
    width: a.width,
    height: a.height,
    publicUrl: a.publicUrl,
    fileUrl: mediaFileUrl(org, app, a.id),
    usages: a.usages,
    createdAt: a.createdAt.toISOString(),
  };
}
