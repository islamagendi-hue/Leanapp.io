"use server";

import { revalidatePath } from "next/cache";
import { deleteConversionSchema, saveConversionSchema, updateSkanSettings } from "@/modules/attribution/skan-service";
import { toActionError, type ActionState } from "@/server/action-result";
import { loadApp } from "@/server/session";

/** SKAdNetwork / AdAttributionKit actions. */
const text = (form: FormData, k: string) => (typeof form.get(k) === "string" ? (form.get(k) as string) : undefined);

export async function updateSkanSettingsAction(orgSlug: string, appSlug: string, _: ActionState, form: FormData): Promise<ActionState> {
  try {
    const { ctx, app } = await loadApp(orgSlug, appSlug);
    await updateSkanSettings(ctx, app.id, { appStoreId: text(form, "appStoreId"), networkIds: text(form, "networkIds") });
    revalidatePath(`/o/${orgSlug}/apps/${appSlug}/attribution`, "layout");
    return { ok: true, message: "Saved." };
  } catch (err) {
    return toActionError(err);
  }
}

export async function saveSchemaAction(orgSlug: string, appSlug: string, _: ActionState, form: FormData): Promise<ActionState> {
  try {
    const { ctx, app } = await loadApp(orgSlug, appSlug);
    const saved = await saveConversionSchema(ctx, app.id, text(form, "schema") ?? "");
    revalidatePath(`/o/${orgSlug}/apps/${appSlug}/attribution/skan`);
    return { ok: true, message: `Schema saved (revision ${saved.revision}). Apps pick it up on their next launch.` };
  } catch (err) {
    return toActionError(err);
  }
}

export async function deleteSchemaAction(orgSlug: string, appSlug: string, _: ActionState): Promise<ActionState> {
  try {
    const { ctx, app } = await loadApp(orgSlug, appSlug);
    await deleteConversionSchema(ctx, app.id);
    revalidatePath(`/o/${orgSlug}/apps/${appSlug}/attribution/skan`);
    return { ok: true, message: "Schema removed. The SDK stops updating conversion values." };
  } catch (err) {
    return toActionError(err);
  }
}
