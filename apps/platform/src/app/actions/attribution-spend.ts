"use server";

import { revalidatePath } from "next/cache";
import { deleteSpend, importSpendCsv, saveSpend } from "@/modules/attribution/spend";
import { toActionError, type ActionState } from "@/server/action-result";
import { loadApp, pickEnvironment } from "@/server/session";
import { getT } from "@/i18n/server";
import { msg } from "@/i18n/translate";

const text = (form: FormData, k: string) => (typeof form.get(k) === "string" ? (form.get(k) as string) : undefined);
const MAX_FILE_BYTES = 1_000_000;

async function scopeOf(orgSlug: string, appSlug: string, form: FormData) {
  const { ctx, app, environments } = await loadApp(orgSlug, appSlug);
  const env = await pickEnvironment(environments, text(form, "env"));
  return { ctx, scope: { appId: app.id, environmentId: env.id, timezone: app.timezone } };
}

const spendPath = (orgSlug: string, appSlug: string) => `/o/${orgSlug}/apps/${appSlug}/acquisition/spend`;

export async function saveSpendAction(orgSlug: string, appSlug: string, _: ActionState, form: FormData): Promise<ActionState> {
  try {
    const { ctx, scope } = await scopeOf(orgSlug, appSlug, form);
    await saveSpend(ctx, scope, { date: text(form, "date"), source: text(form, "source"), campaign: text(form, "campaign"), currency: text(form, "currency"), amount: text(form, "amount") });
    revalidatePath(spendPath(orgSlug, appSlug));
    return { ok: true, message: msg("Spend saved.") };
  } catch (err) {
    return toActionError(err);
  }
}

export async function importSpendAction(orgSlug: string, appSlug: string, _: ActionState, form: FormData): Promise<ActionState> {
  try {
    const t = await getT();
    const file = form.get("file");
    let csv = text(form, "csv") ?? "";
    if (file instanceof File && file.size > 0) {
      if (file.size > MAX_FILE_BYTES) return { error: msg("The CSV is too large: import at most 1 MB at a time.") };
      csv = await file.text();
    }
    const { ctx, scope } = await scopeOf(orgSlug, appSlug, form);
    const r = await importSpendCsv(ctx, scope, csv);
    if (r.errors.length) {
      const shown = r.errors.slice(0, 20);
      // The form lists field errors (and hides `error` when there are some), so the summary goes first among them.
      const fieldErrors: Record<string, string> = { form: t("Nothing was imported. Fix these lines and try again.") };
      for (const e of shown) fieldErrors[`line-${e.line}`] = t("Line {line}: {error}", { line: e.line, error: t(e.error) });
      if (r.errors.length > shown.length) fieldErrors.more = t("…and {n} more lines with errors.", { n: r.errors.length - shown.length });
      return { error: msg("Nothing was imported. Fix these lines and try again."), fieldErrors };
    }
    revalidatePath(spendPath(orgSlug, appSlug));
    return { ok: true, message: t("Imported {n} spend entries.", { n: r.imported }) };
  } catch (err) {
    return toActionError(err);
  }
}

export async function deleteSpendAction(orgSlug: string, appSlug: string, id: string, _: ActionState): Promise<ActionState> {
  try {
    const { ctx, app } = await loadApp(orgSlug, appSlug);
    await deleteSpend(ctx, app.id, id);
    revalidatePath(spendPath(orgSlug, appSlug));
    return { ok: true };
  } catch (err) {
    return toActionError(err);
  }
}
