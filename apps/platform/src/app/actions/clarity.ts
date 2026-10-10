"use server";

import { revalidatePath } from "next/cache";
import { getT } from "@/i18n/server";
import { msg } from "@/i18n/translate";
import { clarityImportNow, saveClarityConnection, setClarityImport } from "@/modules/integrations/clarity-service";
import { removeConnection } from "@/modules/integrations/service";
import { toActionError, type ActionState } from "@/server/action-result";
import { loadApp, pickEnvironment } from "@/server/session";

const text = (form: FormData, k: string) => (typeof form.get(k) === "string" ? (form.get(k) as string) : undefined);
const pagePath = (org: string, app: string) => `/o/${org}/apps/${app}/settings/integrations/microsoft_clarity`;

export async function saveClarityAction(org: string, app: string, _: ActionState, form: FormData): Promise<ActionState> {
  try {
    const { ctx, app: a, environments } = await loadApp(org, app);
    const env = await pickEnvironment(environments, text(form, "env"));
    const r = await saveClarityConnection(ctx, a.id, { environmentId: env.id, projectId: text(form, "projectId") ?? "", apiToken: text(form, "apiToken") ?? "" });
    revalidatePath(pagePath(org, app));
    const t = await getT();
    return r.missing.length
      ? { ok: true, message: t("Saved. Still missing: {fields}.", { fields: r.missing.map((m) => t(m)).join(", ") }) }
      : { ok: true, message: msg("Saved. Turn on the daily import to fetch Clarity's metrics.") };
  } catch (err) {
    return toActionError(err);
  }
}

export async function setClarityImportAction(org: string, app: string, connectionId: string, enabled: boolean, _: ActionState): Promise<ActionState> {
  try {
    const { ctx, app: a } = await loadApp(org, app);
    await setClarityImport(ctx, a.id, connectionId, enabled);
    revalidatePath(pagePath(org, app));
    return { ok: true, message: enabled ? msg("Daily import turned on. The first import runs on the worker's next pass.") : msg("Daily import turned off.") };
  } catch (err) {
    return toActionError(err);
  }
}

export async function clarityImportNowAction(org: string, app: string, connectionId: string, _: ActionState, form: FormData): Promise<ActionState> {
  try {
    const { ctx, app: a } = await loadApp(org, app);
    const r = await clarityImportNow(ctx, a.id, connectionId, Number(text(form, "days") ?? "1"));
    revalidatePath(pagePath(org, app));
    const t = await getT();
    if (r.budgetExhausted) return { error: msg("Not imported: today's Clarity requests are used up (10 per project per day, UTC). Try again tomorrow.") };
    if (!r.ok) return { error: t("Import failed: {error}", { error: r.error ?? "" }) };
    return { ok: true, message: t("Imported {rows} rows from Clarity using {requests} requests.", { rows: r.rows, requests: r.requests }) };
  } catch (err) {
    return toActionError(err);
  }
}

export async function removeClarityAction(org: string, app: string, connectionId: string, _: ActionState): Promise<ActionState> {
  try {
    const { ctx, app: a } = await loadApp(org, app);
    await removeConnection(ctx, a.id, connectionId);
    revalidatePath(pagePath(org, app));
    return { ok: true, message: msg("Connection removed.") };
  } catch (err) {
    return toActionError(err);
  }
}
