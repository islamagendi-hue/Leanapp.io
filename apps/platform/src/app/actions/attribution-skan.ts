"use server";

import { revalidatePath } from "next/cache";
import { deleteConversionSchema, saveConversionSchema, updateSkanSettings } from "@/modules/attribution/skan-service";
import { toActionError, type ActionState } from "@/server/action-result";
import { loadApp } from "@/server/session";
import { getT } from "@/i18n/server";
import { msg } from "@/i18n/translate";

/** SKAdNetwork / AdAttributionKit actions. */
const text = (form: FormData, k: string) => (typeof form.get(k) === "string" ? (form.get(k) as string) : undefined);

export async function updateSkanSettingsAction(orgSlug: string, appSlug: string, _: ActionState, form: FormData): Promise<ActionState> {
  try {
    const { ctx, app } = await loadApp(orgSlug, appSlug);
    await updateSkanSettings(ctx, app.id, { appStoreId: text(form, "appStoreId"), networkIds: text(form, "networkIds") });
    revalidatePath(`/o/${orgSlug}/apps/${appSlug}/acquisition`, "layout");
    revalidatePath(`/o/${orgSlug}/apps/${appSlug}/settings/dev-ops/attribution`, "layout");
    return { ok: true, message: msg("Saved.") };
  } catch (err) {
    return toActionError(err);
  }
}

export async function saveSchemaAction(orgSlug: string, appSlug: string, _: ActionState, form: FormData): Promise<ActionState> {
  try {
    const { ctx, app } = await loadApp(orgSlug, appSlug);
    const saved = await saveConversionSchema(ctx, app.id, text(form, "schema") ?? "");
    revalidatePath(`/o/${orgSlug}/apps/${appSlug}/settings/dev-ops/attribution/skan`);
    const t = await getT();
    return { ok: true, message: t("Schema saved (revision {revision}). Apps pick it up on their next launch.", { revision: saved.revision }) };
  } catch (err) {
    const state = toActionError(err);
    // Schema problems read "rules.0: <message>"; translate the message and keep the JSON path as is.
    const m = state.error?.match(/^([\w.]+): (.+)$/);
    if (m) return { ...state, error: `${m[1]}: ${(await getT())(m[2])}` };
    return state;
  }
}

export async function deleteSchemaAction(orgSlug: string, appSlug: string, _: ActionState): Promise<ActionState> {
  try {
    const { ctx, app } = await loadApp(orgSlug, appSlug);
    await deleteConversionSchema(ctx, app.id);
    revalidatePath(`/o/${orgSlug}/apps/${appSlug}/settings/dev-ops/attribution/skan`);
    return { ok: true, message: msg("Schema removed. The SDK stops updating conversion values.") };
  } catch (err) {
    return toActionError(err);
  }
}
