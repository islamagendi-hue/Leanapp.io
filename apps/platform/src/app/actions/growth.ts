"use server";

import { revalidatePath } from "next/cache";
import { getT } from "@/i18n/server";
import { msg } from "@/i18n/translate";
import { localize } from "@/modules/dashboards/localize";
import { DEFINITION_MESSAGES, definitionInputFromFields } from "@/modules/growth/definition";
import { setGrowthModel, setMappingHistory } from "@/modules/growth/service";
import { setDraftGrowth } from "@/modules/implementation/editor";
import { revertMapping } from "@/modules/implementation/service";
import { toActionError, type ActionState } from "@/server/action-result";
import { requireTenant } from "@/server/session";

const base = (org: string, app: string) => `/o/${org}/apps/${app}`;

const MESSAGES = [...DEFINITION_MESSAGES, msg("Published tracking plan not found."), msg("You don't have permission to do that."), msg("Something went wrong. Please try again.")];

/** The form error for a failure, in the person's language. */
async function fail(err: unknown): Promise<ActionState> {
  const r = toActionError(err);
  const t = await getT();
  const tr = (m: string) => localize(m, t, MESSAGES);
  return {
    ...r,
    error: r.error && tr(r.error),
    fieldErrors: r.fieldErrors && Object.fromEntries(Object.entries(r.fieldErrors).map(([k, v]) => [k, tr(v)])),
  };
}

export async function setGrowthModelAction(orgSlug: string, appSlug: string, appId: string, on: boolean, _: ActionState): Promise<ActionState> {
  try {
    await setGrowthModel(await requireTenant(orgSlug), appId, on);
    revalidatePath(`${base(orgSlug, appSlug)}/growth`);
    const t = await getT();
    return { ok: true, message: on ? t("Growth model on. Growth state is being built from all past events.") : t("Growth model off.") };
  } catch (err) {
    return fail(err);
  }
}

export async function setMappingHistoryAction(orgSlug: string, appSlug: string, appId: string, on: boolean, _: ActionState): Promise<ActionState> {
  try {
    await setMappingHistory(await requireTenant(orgSlug), appId, on);
    revalidatePath(`${base(orgSlug, appSlug)}/settings/dev-ops/events`);
    const t = await getT();
    return { ok: true, message: on ? t("Mapping history on. All past events are being re-mapped.") : t("Mapping history off.") };
  } catch (err) {
    return fail(err);
  }
}

export async function revertMappingAction(orgSlug: string, appSlug: string, appId: string, mappingId: string, revision: number, _: ActionState): Promise<ActionState> {
  try {
    await revertMapping(await requireTenant(orgSlug), appId, mappingId, revision);
    revalidatePath(`${base(orgSlug, appSlug)}/settings/dev-ops/events`);
    return { ok: true, message: (await getT())(msg("Reverted to revision {n}."), { n: revision }) };
  } catch (err) {
    return fail(err);
  }
}

export async function saveGrowthDefinitionAction(orgSlug: string, appSlug: string, appId: string, _: ActionState, form: FormData): Promise<ActionState> {
  try {
    const ctx = await requireTenant(orgSlug);
    const r = await setDraftGrowth({ kind: "user", ctx }, appId, definitionInputFromFields((k) => form.get(k)?.toString()));
    revalidatePath(`${base(orgSlug, appSlug)}/growth/setup`);
    revalidatePath(`${base(orgSlug, appSlug)}/settings/dev-ops/implementation/plan`);
    const t = await getT();
    return {
      ok: true,
      message: r.draftCreated
        ? t("Saved in draft v{version} (new draft). Approve and publish it on the tracking plan page to apply it.", { version: r.version })
        : t("Saved in draft v{version}. Approve and publish it on the tracking plan page to apply it.", { version: r.version }),
    };
  } catch (err) {
    return fail(err);
  }
}
