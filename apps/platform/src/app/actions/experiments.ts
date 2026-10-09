"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getT } from "@/i18n/server";
import { msg } from "@/i18n/translate";
import { translateMessage } from "@/modules/automation/messages";
import type { ExperimentForm } from "@/modules/experiments/definition";
import { createExperiment, startExperiment, stopExperiment, updateExperiment } from "@/modules/experiments/service";
import { toActionError, type ActionState } from "@/server/action-result";
import { requireTenant } from "@/server/session";

const base = (org: string, app: string) => `/o/${org}/apps/${app}/engage/experiments`;

function experimentForm(form: FormData): ExperimentForm {
  const out: ExperimentForm = {};
  for (const [k, v] of form.entries()) if (typeof v === "string" && !k.startsWith("$")) out[k] = v;
  return out;
}

async function failed(err: unknown): Promise<ActionState> {
  const state = toActionError(err);
  const t = await getT();
  return { ...state, error: state.error && translateMessage(t, state.error) };
}

/** Creates (experimentId null) or changes a draft experiment. */
export async function saveExperimentAction(org: string, app: string, environmentId: string, experimentId: string | null, _: ActionState, form: FormData): Promise<ActionState> {
  let id = experimentId;
  try {
    const ctx = await requireTenant(org);
    if (id) await updateExperiment(ctx, id, experimentForm(form));
    else id = (await createExperiment(ctx, environmentId, experimentForm(form))).id;
  } catch (err) {
    return failed(err);
  }
  revalidatePath(base(org, app));
  if (!experimentId) redirect(`${base(org, app)}/${id}`);
  return { ok: true, message: msg("Saved.") };
}

const MESSAGES = {
  start: msg("Running. The assignment API now returns this experiment's variants."),
  stop: msg("Stopped. The app gets no variant for it any more and shows its default."),
} as const;

export async function experimentLifecycleAction(org: string, app: string, id: string, op: "start" | "stop", _: ActionState): Promise<ActionState> {
  try {
    const ctx = await requireTenant(org);
    if (op === "start") await startExperiment(ctx, id);
    else await stopExperiment(ctx, id);
    revalidatePath(`${base(org, app)}/${id}`);
    return { ok: true, message: MESSAGES[op] };
  } catch (err) {
    return failed(err);
  }
}
