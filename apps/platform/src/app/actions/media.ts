"use server";

import { revalidatePath } from "next/cache";
import { getT } from "@/i18n/server";
import { msg } from "@/i18n/translate";
import { NotFoundError } from "@/lib/errors";
import { getAppBySlug } from "@/modules/apps/service";
import { translateMessage } from "@/modules/automation/messages";
import { deleteMedia, setMediaPublic, updateMedia } from "@/modules/media/service";
import { toActionError, type ActionState } from "@/server/action-result";
import { requireTenant } from "@/server/session";

const libraryPath = (org: string, app: string) => `/o/${org}/apps/${app}/engage/media`;
const str = (form: FormData, k: string) => {
  const v = form.get(k);
  return typeof v === "string" ? v : undefined;
};

async function failed(err: unknown): Promise<ActionState> {
  const state = toActionError(err);
  const t = await getT();
  return { ...state, error: state.error && translateMessage(t, state.error) };
}

/** Tenant and app id from the URL slugs (never from the form). */
async function scope(org: string, appSlug: string) {
  const ctx = await requireTenant(org);
  try {
    const { app } = await getAppBySlug(ctx, appSlug);
    return { ctx, appId: app.id };
  } catch (e) {
    if (e instanceof NotFoundError) throw new NotFoundError("App");
    throw e;
  }
}

export async function updateMediaAction(org: string, appSlug: string, id: string, _: ActionState, form: FormData): Promise<ActionState> {
  try {
    const { ctx, appId } = await scope(org, appSlug);
    await updateMedia(ctx, appId, id, { name: str(form, "name"), folder: str(form, "folder") ?? null, tags: str(form, "tags") ?? "" });
  } catch (err) {
    return failed(err);
  }
  revalidatePath(libraryPath(org, appSlug));
  return { ok: true, message: msg("Saved.") };
}

export async function setMediaPublicAction(org: string, appSlug: string, id: string, on: boolean, _: ActionState): Promise<ActionState> {
  try {
    const { ctx, appId } = await scope(org, appSlug);
    await setMediaPublic(ctx, appId, id, on);
  } catch (err) {
    return failed(err);
  }
  revalidatePath(libraryPath(org, appSlug));
  return { ok: true, message: on ? msg("Public link on.") : msg("Public link off.") };
}

export async function deleteMediaAction(org: string, appSlug: string, id: string, _: ActionState): Promise<ActionState> {
  try {
    const { ctx, appId } = await scope(org, appSlug);
    await deleteMedia(ctx, appId, id);
  } catch (err) {
    return failed(err);
  }
  revalidatePath(libraryPath(org, appSlug));
  return { ok: true, message: msg("Deleted.") };
}
