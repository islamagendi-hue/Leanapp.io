"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getT } from "@/i18n/server";
import { msg } from "@/i18n/translate";
import { translateMessage } from "@/modules/automation/messages";
import type { CampaignForm } from "@/modules/campaigns/definition";
import { cancelCampaign, createCampaign, pauseCampaign, sendCampaign, updateCampaign } from "@/modules/campaigns/service";
import { sendTestMessage } from "@/modules/messaging/delivery";
import { getOrganization } from "@/modules/organizations/service";
import { toActionError, type ActionState } from "@/server/action-result";
import { requireTenant } from "@/server/session";

const base = (org: string, app: string) => `/o/${org}/apps/${app}/engage/campaigns`;
const FIELDS = [
  "audienceId", "channel", "title", "body", "deepLink", "buttonText", "emailTemplateId", "subject", "whatsappTemplate", "whatsappParams", "phoneProperty",
  "schedule", "sendAt", "time", "weekday", "capMessages", "capHours", "quietHours",
] as const;

function campaignForm(form: FormData): CampaignForm {
  const out: CampaignForm = {};
  for (const k of FIELDS) {
    const v = form.get(k);
    if (typeof v === "string" && v.trim()) out[k] = v;
  }
  return out;
}

/** The action error in the reader's language (messages with values included). */
async function failed(err: unknown): Promise<ActionState> {
  const state = toActionError(err);
  const t = await getT();
  return {
    ...state,
    error: state.error && translateMessage(t, state.error),
    fieldErrors: state.fieldErrors && Object.fromEntries(Object.entries(state.fieldErrors).map(([k, v]) => [k, translateMessage(t, v)])),
  };
}

/** Creates (campaignId null) or changes a campaign. Times are in the organization's timezone. */
export async function saveCampaignAction(org: string, app: string, environmentId: string, campaignId: string | null, _: ActionState, form: FormData): Promise<ActionState> {
  let id = campaignId;
  try {
    const ctx = await requireTenant(org);
    const { timezone } = await getOrganization(ctx);
    const input = { name: form.get("name"), form: campaignForm(form), timezone };
    if (id) await updateCampaign(ctx, id, input);
    else id = (await createCampaign(ctx, environmentId, input)).id;
  } catch (err) {
    return failed(err);
  }
  revalidatePath(base(org, app));
  if (!campaignId) redirect(`${base(org, app)}/${id}`);
  return { ok: true, message: msg("Saved.") };
}

const MESSAGES = {
  send: msg("The campaign is live. Its status below shows when messages go out."),
  pause: msg("Paused. Nothing more goes out until you resume."),
  cancel: msg("Cancelled."),
} as const;

export async function campaignLifecycleAction(org: string, app: string, id: string, op: "send" | "pause" | "cancel", _: ActionState): Promise<ActionState> {
  try {
    const ctx = await requireTenant(org);
    let message: string = MESSAGES[op];
    if (op === "send") await sendCampaign(ctx, id);
    else if (op === "pause") await pauseCampaign(ctx, id);
    else message = (await getT())("Cancelled. {n} messages still waiting were dropped.", { n: (await cancelCampaign(ctx, id)).cancelled });
    revalidatePath(`${base(org, app)}/${id}`);
    return { ok: true, message };
  } catch (err) {
    return failed(err);
  }
}

/** A test message to one person through the environment's provider (Engage → Channels & delivery). */
export async function testSendAction(org: string, environmentId: string, channel: string, _: ActionState, form: FormData): Promise<ActionState> {
  try {
    const ctx = await requireTenant(org);
    const params = form.get("whatsappParams");
    const r = await sendTestMessage(ctx, environmentId, {
      channel,
      userId: form.get("userId"),
      whatsappTemplate: form.get("whatsappTemplate") ?? undefined,
      whatsappParams: typeof params === "string" ? params.split("\n").map((l) => l.trim()).filter(Boolean) : [],
      phoneProperty: form.get("phoneProperty") ?? undefined,
    });
    const t = await getT();
    return r.ok ? { ok: true, message: translateMessage(t, r.message) } : { error: translateMessage(t, r.message) };
  } catch (err) {
    return failed(err);
  }
}
