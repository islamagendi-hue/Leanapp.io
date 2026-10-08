"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { QUESTIONS, type SectionKey } from "@/modules/implementation/questions";
import {
  approveVersion, createMapping, decideMapping, generateDraft, publishVersion, saveAnswers,
} from "@/modules/implementation/service";
import {
  addPlanEvent, removePlanEvent, removePlanEventProperty, removePlanUserProperty, setPlanEventProperty, setPlanUserProperty, updatePlanEvent,
  type EditResult,
} from "@/modules/implementation/editor";
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
    revalidatePath(`${base(orgSlug, appSlug)}/settings/dev-ops/implementation/questions`);
  } catch (err) {
    return toActionError(err);
  }
  if (done) redirect(`${base(orgSlug, appSlug)}/settings/dev-ops/implementation/questions?done=1`);
  redirect(`${base(orgSlug, appSlug)}/settings/dev-ops/implementation/questions`);
}

export async function generatePlanAction(orgSlug: string, appSlug: string, appId: string, _: ActionState): Promise<ActionState> {
  try {
    await generateDraft(await requireTenant(orgSlug), appId);
  } catch (err) {
    return toActionError(err);
  }
  redirect(`${base(orgSlug, appSlug)}/settings/dev-ops/implementation/plan`);
}

export async function approveAction(orgSlug: string, appSlug: string, appId: string, versionId: string, _: ActionState): Promise<ActionState> {
  try {
    await approveVersion(await requireTenant(orgSlug), appId, versionId);
    revalidatePath(`${base(orgSlug, appSlug)}/settings/dev-ops/implementation/plan`);
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
  redirect(`${base(orgSlug, appSlug)}/settings/dev-ops/sdk?env=development`);
}

export async function decideMappingAction(orgSlug: string, appSlug: string, appId: string, mappingId: string, accept: boolean, _: ActionState): Promise<ActionState> {
  try {
    await decideMapping(await requireTenant(orgSlug), appId, mappingId, accept);
    revalidatePath(`${base(orgSlug, appSlug)}/settings/dev-ops/events`);
    return { ok: true };
  } catch (err) {
    return toActionError(err);
  }
}

export async function createMappingAction(orgSlug: string, appSlug: string, appId: string, _: ActionState, form: FormData): Promise<ActionState> {
  try {
    await createMapping(await requireTenant(orgSlug), appId, String(form.get("from") ?? "").trim(), String(form.get("to") ?? "").trim());
    revalidatePath(`${base(orgSlug, appSlug)}/settings/dev-ops/events`);
    return { ok: true, message: "Mapping saved and recent events re-validated." };
  } catch (err) {
    return toActionError(err);
  }
}

// ── Hand edits (always land on the working draft; see modules/implementation/editor.ts) ──
export type PlanEditOp =
  | { kind: "add_event" }
  | { kind: "event_required"; event: string; required: boolean }
  | { kind: "remove_event"; event: string }
  | { kind: "set_property"; event: string }
  | { kind: "remove_property"; event: string; property: string }
  | { kind: "set_user_property" }
  | { kind: "remove_user_property"; name: string };

const str = (form: FormData, k: string) => {
  const v = form.get(k);
  return typeof v === "string" && v.trim() !== "" ? v.trim() : undefined;
};

function propertyFromForm(form: FormData) {
  const allowed = str(form, "allowed_values");
  return {
    name: str(form, "name") ?? "",
    type: str(form, "type"),
    required: form.get("required") === "on",
    description: str(form, "description") ?? "",
    allowed_values: allowed ? allowed.split(/[|,]/).map((x) => x.trim()).filter(Boolean) : null,
  };
}

export async function planEditAction(orgSlug: string, appSlug: string, appId: string, op: PlanEditOp, _: ActionState, form?: FormData): Promise<ActionState> {
  let result: EditResult;
  try {
    const actor = { kind: "user" as const, ctx: await requireTenant(orgSlug) };
    const f = form ?? new FormData();
    switch (op.kind) {
      case "add_event":
        result = await addPlanEvent(actor, appId, {
          event_name: str(f, "event_name") ?? "",
          display_name: str(f, "display_name"),
          description: str(f, "description"),
          trigger: str(f, "trigger"),
          category: str(f, "category"),
          source: str(f, "source"),
          priority: str(f, "priority"),
          required: f.get("required") === "on",
        });
        break;
      case "event_required":
        result = await updatePlanEvent(actor, appId, op.event, { required: op.required });
        break;
      case "remove_event":
        result = await removePlanEvent(actor, appId, op.event);
        break;
      case "set_property":
        result = await setPlanEventProperty(actor, appId, op.event, propertyFromForm(f));
        break;
      case "remove_property":
        result = await removePlanEventProperty(actor, appId, op.event, op.property);
        break;
      case "set_user_property":
        result = await setPlanUserProperty(actor, appId, { name: str(f, "name") ?? "", type: str(f, "type"), description: str(f, "description") ?? "", source: str(f, "source") });
        break;
      case "remove_user_property":
        result = await removePlanUserProperty(actor, appId, op.name);
        break;
    }
  } catch (err) {
    return toActionError(err);
  }
  revalidatePath(`${base(orgSlug, appSlug)}/settings/dev-ops/implementation/plan`);
  // A new draft was copied from the approved / published version: show it.
  if (result.draftCreated) redirect(`${base(orgSlug, appSlug)}/settings/dev-ops/implementation/plan?version=${result.versionId}`);
  return { ok: true, message: result.warnings.length ? `Saved to draft v${result.version}. ${result.warnings.join(" ")}` : `Saved to draft v${result.version}.` };
}
