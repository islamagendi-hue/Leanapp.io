"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { cohortInputFromForm } from "@/modules/analytics/cohort-form";
import { createCohort, deleteCohort, updateCohort } from "@/modules/analytics/cohorts";
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

export async function createCohortAction(org: string, app: string, environmentId: string, envType: string, _: ActionState, form: FormData): Promise<ActionState> {
  let id: string;
  try {
    const ctx = await requireTenant(org);
    id = (await createCohort(ctx, environmentId, cohortInputFromForm(form))).id;
  } catch (err) {
    return toActionError(err);
  }
  redirect(`${base(org, app)}/cohorts/${id}?env=${envType}`);
}

export async function updateCohortAction(org: string, app: string, environmentId: string, id: string, _: ActionState, form: FormData): Promise<ActionState> {
  try {
    const ctx = await requireTenant(org);
    await updateCohort(ctx, environmentId, id, cohortInputFromForm(form));
    revalidatePath(`${base(org, app)}/cohorts`);
    return { ok: true, message: "Cohort saved." };
  } catch (err) {
    return toActionError(err);
  }
}

export async function deleteCohortAction(org: string, app: string, environmentId: string, id: string, envType: string): Promise<ActionState> {
  try {
    const ctx = await requireTenant(org);
    await deleteCohort(ctx, environmentId, id);
  } catch (err) {
    return toActionError(err);
  }
  redirect(`${base(org, app)}/cohorts?env=${envType}`);
}
