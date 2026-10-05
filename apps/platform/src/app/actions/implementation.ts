"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { QUESTIONS, type SectionKey } from "@/modules/implementation/questions";
import {
  approveVersion, createMapping, decideMapping, editDraftEvent, generateDraft, publishVersion, saveAnswers,
} from "@/modules/implementation/service";
import { toActionError, type ActionState } from "@/server/action-result";
import { requireTenant } from "@/server/session";

const base = (org: string, app: string) => `/o/${org}/apps/${app}`;

export async function saveSectionAction(orgSlug: string, appSlug: string, appId: string, section: SectionKey, _: ActionState, form: FormData): Promise<ActionState> {
  let done = false;
  try {
    const ctx = await requireTenant(orgSlug);
    const raw: Record<string, unknown> = {};
    for (const q of QUESTIONS.filter((x) => x.section === section)) {
      if (!form.has(`${q.key}__shown`)) continue;
      if (q.type === "multi") raw[q.key] = form.getAll(q.key);
      else {
        const v = form.get(q.key);
        const other = form.get(`${q.key}__other`);
        raw[q.key] = v === "__other" ? other : v;
      }
    }
    const r = await saveAnswers(ctx, appId, section, raw);
    if (!r.ok) return { error: "Please answer the highlighted questions.", fieldErrors: r.errors };
    done = r.next === null;
    revalidatePath(`${base(orgSlug, appSlug)}/implementation/questions`);
  } catch (err) {
    return toActionError(err);
  }
  if (done) redirect(`${base(orgSlug, appSlug)}/implementation/questions?done=1`);
  redirect(`${base(orgSlug, appSlug)}/implementation/questions`);
}

export async function generatePlanAction(orgSlug: string, appSlug: string, appId: string, _: ActionState): Promise<ActionState> {
  try {
    await generateDraft(await requireTenant(orgSlug), appId);
  } catch (err) {
    return toActionError(err);
  }
  redirect(`${base(orgSlug, appSlug)}/implementation/plan`);
}

export async function editEventAction(orgSlug: string, appSlug: string, appId: string, versionId: string, eventName: string, op: "remove" | "require" | "optional", _: ActionState): Promise<ActionState> {
  try {
    await editDraftEvent(await requireTenant(orgSlug), appId, versionId, eventName, op === "remove" ? { remove: true } : { required: op === "require" });
    revalidatePath(`${base(orgSlug, appSlug)}/implementation/plan`);
    return { ok: true };
  } catch (err) {
    return toActionError(err);
  }
}

export async function approveAction(orgSlug: string, appSlug: string, appId: string, versionId: string, _: ActionState): Promise<ActionState> {
  try {
    await approveVersion(await requireTenant(orgSlug), appId, versionId);
    revalidatePath(`${base(orgSlug, appSlug)}/implementation/plan`);
    return { ok: true, message: "Approved. Publish it to start validating incoming events against it." };
  } catch (err) {
    return toActionError(err);
  }
}

export async function publishAction(orgSlug: string, appSlug: string, appId: string, versionId: string, _: ActionState): Promise<ActionState> {
  try {
    await publishVersion(await requireTenant(orgSlug), appId, versionId);
  } catch (err) {
    return toActionError(err);
  }
  redirect(`${base(orgSlug, appSlug)}/developers/sdk`);
}

export async function decideMappingAction(orgSlug: string, appSlug: string, appId: string, mappingId: string, accept: boolean, _: ActionState): Promise<ActionState> {
  try {
    await decideMapping(await requireTenant(orgSlug), appId, mappingId, accept);
    revalidatePath(`${base(orgSlug, appSlug)}/implementation/validation`);
    return { ok: true };
  } catch (err) {
    return toActionError(err);
  }
}

export async function createMappingAction(orgSlug: string, appSlug: string, appId: string, _: ActionState, form: FormData): Promise<ActionState> {
  try {
    await createMapping(await requireTenant(orgSlug), appId, String(form.get("from") ?? "").trim(), String(form.get("to") ?? "").trim());
    revalidatePath(`${base(orgSlug, appSlug)}/implementation/validation`);
    return { ok: true, message: "Mapping saved and recent events re-validated." };
  } catch (err) {
    return toActionError(err);
  }
}
