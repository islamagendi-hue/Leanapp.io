"use server";

import { revalidatePath } from "next/cache";
import { definitionInputFromFields } from "@/modules/growth/definition";
import { setGrowthModel, setMappingHistory } from "@/modules/growth/service";
import { setDraftGrowth } from "@/modules/implementation/editor";
import { revertMapping } from "@/modules/implementation/service";
import { toActionError, type ActionState } from "@/server/action-result";
import { requireTenant } from "@/server/session";

const base = (org: string, app: string) => `/o/${org}/apps/${app}`;

export async function setGrowthModelAction(orgSlug: string, appSlug: string, appId: string, on: boolean, _: ActionState): Promise<ActionState> {
  try {
    await setGrowthModel(await requireTenant(orgSlug), appId, on);
    revalidatePath(`${base(orgSlug, appSlug)}/growth`);
    return { ok: true, message: on ? "Growth model on. Growth state is being built from all past events." : "Growth model off." };
  } catch (err) {
    return toActionError(err);
  }
}

export async function setMappingHistoryAction(orgSlug: string, appSlug: string, appId: string, on: boolean, _: ActionState): Promise<ActionState> {
  try {
    await setMappingHistory(await requireTenant(orgSlug), appId, on);
    revalidatePath(`${base(orgSlug, appSlug)}/implementation/validation`);
    return { ok: true, message: on ? "Mapping history on. All past events are being re-mapped." : "Mapping history off." };
  } catch (err) {
    return toActionError(err);
  }
}

export async function revertMappingAction(orgSlug: string, appSlug: string, appId: string, mappingId: string, revision: number, _: ActionState): Promise<ActionState> {
  try {
    await revertMapping(await requireTenant(orgSlug), appId, mappingId, revision);
    revalidatePath(`${base(orgSlug, appSlug)}/implementation/validation`);
    return { ok: true, message: `Reverted to revision ${revision}.` };
  } catch (err) {
    return toActionError(err);
  }
}

export async function saveGrowthDefinitionAction(orgSlug: string, appSlug: string, appId: string, _: ActionState, form: FormData): Promise<ActionState> {
  try {
    const ctx = await requireTenant(orgSlug);
    const r = await setDraftGrowth({ kind: "user", ctx }, appId, definitionInputFromFields((k) => form.get(k)?.toString()));
    revalidatePath(`${base(orgSlug, appSlug)}/growth/setup`);
    revalidatePath(`${base(orgSlug, appSlug)}/implementation/plan`);
    return {
      ok: true,
      message: `Saved in draft v${r.version}${r.draftCreated ? " (new draft)" : ""}. Approve and publish it on the tracking plan page to apply it.`,
    };
  } catch (err) {
    return toActionError(err);
  }
}
