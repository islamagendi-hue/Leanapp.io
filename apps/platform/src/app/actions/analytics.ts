"use server";

import { revalidatePath } from "next/cache";
import { deleteSavedReport, saveReport } from "@/modules/analytics/saved-reports";
import { toActionError, type ActionState } from "@/server/action-result";
import { requireTenant } from "@/server/session";

const base = (org: string, app: string) => `/o/${org}/apps/${app}/analytics`;

/** Saves the report a page shows; `query` is that page's search string. */
export async function saveReportAction(
  org: string, app: string, environmentId: string, kind: string, query: string, _: ActionState, form: FormData,
): Promise<ActionState> {
  try {
    const ctx = await requireTenant(org);
    await saveReport(ctx, environmentId, { name: form.get("name"), kind, query: new URLSearchParams(query) });
    revalidatePath(base(org, app));
    return { ok: true, message: "Saved. It's listed on the analytics overview." };
  } catch (err) {
    return toActionError(err);
  }
}

export async function deleteReportAction(org: string, app: string, environmentId: string, id: string): Promise<ActionState> {
  try {
    const ctx = await requireTenant(org);
    await deleteSavedReport(ctx, environmentId, id);
    revalidatePath(base(org, app));
    return { ok: true };
  } catch (err) {
    return toActionError(err);
  }
}
