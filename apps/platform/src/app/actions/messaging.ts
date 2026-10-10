"use server";

import { revalidatePath } from "next/cache";
import { getT } from "@/i18n/server";
import { msg } from "@/i18n/translate";
import { translateMessage } from "@/modules/automation/messages";
import { checkCampaign, sendCampaignTest, type CampaignCheck } from "@/modules/campaigns/service";
import type { CampaignForm } from "@/modules/campaigns/definition";
import { verifyConnection } from "@/modules/messaging/connections";
import { configureTwilio } from "@/modules/messaging/integrations";
import { deleteDraft, deleteSyncedTemplate, saveDraft, submitDraft, syncAllTemplates } from "@/modules/messaging/templates";
import { getOrganization } from "@/modules/organizations/service";
import { toActionError, type ActionState } from "@/server/action-result";
import { requireTenant } from "@/server/session";

/** Server actions for messaging providers, templates and the campaign composer's checks (docs/messaging.md). */

const appBase = (org: string, app: string) => `/o/${org}/apps/${app}`;
const channelsPath = (org: string, app: string) => `${appBase(org, app)}/settings/dev-ops/channels`;
const templatesPath = (org: string, app: string) => `${appBase(org, app)}/engage/templates`;
const str = (form: FormData, k: string) => {
  const v = form.get(k);
  return typeof v === "string" ? v : undefined;
};

async function failed(err: unknown): Promise<ActionState> {
  const state = toActionError(err);
  const t = await getT();
  return { ...state, error: state.error && translateMessage(t, state.error) };
}

// ── Providers ───────────────────────────────────────────────────────────────
export async function configureTwilioAction(org: string, app: string, environmentId: string, _: ActionState, form: FormData): Promise<ActionState> {
  try {
    await configureTwilio(await requireTenant(org), environmentId, {
      accountSid: str(form, "accountSid"), authToken: str(form, "authToken"), messagingServiceSid: str(form, "messagingServiceSid"),
      fromNumber: str(form, "fromNumber"), whatsappFrom: str(form, "whatsappFrom"),
    });
    revalidatePath(channelsPath(org, app));
    return { ok: true, message: msg("Saved. Credentials are stored encrypted and never shown again.") };
  } catch (err) {
    return failed(err);
  }
}

/** Calls the provider's real API with the stored credentials and reports exactly what it answered. */
export async function verifyConnectionAction(org: string, app: string, environmentId: string, provider: "whatsapp" | "twilio", _: ActionState): Promise<ActionState> {
  try {
    const r = await verifyConnection(await requireTenant(org), environmentId, provider);
    revalidatePath(channelsPath(org, app));
    return r.ok ? { ok: true, message: r.detail } : { error: r.detail };
  } catch (err) {
    return failed(err);
  }
}

// ── Templates ───────────────────────────────────────────────────────────────
export async function syncAllTemplatesAction(org: string, app: string, environmentId: string, _: ActionState): Promise<ActionState> {
  try {
    const results = await syncAllTemplates(await requireTenant(org), environmentId);
    const t = await getT();
    revalidatePath(templatesPath(org, app));
    const parts = results.map((r) => r.error
      ? t("{provider}: {error}", { provider: r.provider === "twilio" ? "Twilio" : "Meta", error: translateMessage(t, r.error) })
      : t("{provider}: {n} templates ({approved} approved)", { provider: r.provider === "twilio" ? "Twilio" : "Meta", n: r.templates ?? 0, approved: r.approved ?? 0 }));
    if (!results.length) return { error: msg("No connected provider offers WhatsApp templates (a Twilio integration needs a WhatsApp sender).") };
    return results.some((r) => r.error) ? { error: parts.join(" · ") } : { ok: true, message: parts.join(" · ") };
  } catch (err) {
    return failed(err);
  }
}

function draftInput(form: FormData) {
  return {
    name: str(form, "name"), language: str(form, "language"), category: str(form, "category"), headerText: str(form, "headerText"), body: str(form, "body"), footer: str(form, "footer"),
    examples: (str(form, "examples") ?? "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean),
  };
}

export async function saveTemplateDraftAction(org: string, app: string, environmentId: string, draftId: string | null, _: ActionState, form: FormData): Promise<ActionState> {
  try {
    await saveDraft(await requireTenant(org), environmentId, draftId, draftInput(form));
    revalidatePath(templatesPath(org, app));
    return { ok: true, message: draftId ? msg("Draft saved.") : msg("Draft created. It isn't on WhatsApp until you submit it.") };
  } catch (err) {
    return failed(err);
  }
}

export async function deleteTemplateDraftAction(org: string, app: string, draftId: string, _: ActionState): Promise<ActionState> {
  try {
    await deleteDraft(await requireTenant(org), draftId);
    revalidatePath(templatesPath(org, app));
    return { ok: true, message: msg("Deleted.") };
  } catch (err) {
    return failed(err);
  }
}

export async function submitTemplateDraftAction(org: string, app: string, environmentId: string, draftId: string, _: ActionState): Promise<ActionState> {
  try {
    const r = await submitDraft(await requireTenant(org), environmentId, draftId);
    revalidatePath(templatesPath(org, app));
    return { ok: true, message: (await getT())("Submitted to WhatsApp. Its status is {status}; approval can take from minutes to a day.", { status: r.status.toLowerCase() }) };
  } catch (err) {
    return failed(err);
  }
}

export async function deleteSyncedTemplateAction(org: string, app: string, environmentId: string, templateId: string, _: ActionState): Promise<ActionState> {
  try {
    await deleteSyncedTemplate(await requireTenant(org), environmentId, templateId);
    revalidatePath(templatesPath(org, app));
    return { ok: true, message: msg("Deleted on the provider.") };
  } catch (err) {
    return failed(err);
  }
}

// ── Campaign composer ───────────────────────────────────────────────────────
const COMPOSER_FIELDS = [
  "audienceId", "channel", "title", "body", "deepLink", "buttonText", "emailTemplateId", "subject", "whatsappTemplate", "whatsappParams", "whatsappHeaderParams", "whatsappProvider",
  "mediaAssetId", "phoneProperty", "schedule", "sendAt", "time", "weekday", "capMessages", "capHours", "quietHours",
] as const;

function composerForm(form: FormData): CampaignForm {
  const out: CampaignForm = {};
  for (const k of COMPOSER_FIELDS) {
    const v = form.get(k);
    if (typeof v === "string" && v.trim()) out[k] = v;
  }
  return out;
}

/** The composer's "Check" button: what would block or limit sending, translated. */
export async function checkCampaignAction(org: string, environmentId: string, form: FormData): Promise<CampaignCheck & { error?: string }> {
  try {
    const ctx = await requireTenant(org);
    const { timezone } = await getOrganization(ctx);
    const r = await checkCampaign(ctx, environmentId, composerForm(form), timezone);
    const t = await getT();
    return { ...r, issues: r.issues.map((i) => ({ ...i, message: translateMessage(t, i.message) })) };
  } catch (err) {
    return { issues: [], reach: null, error: (await failed(err)).error };
  }
}

/** The composer's test send (WhatsApp and SMS) to one person, through the campaign send path. */
export async function campaignTestAction(org: string, environmentId: string, _: ActionState, form: FormData): Promise<ActionState> {
  try {
    const ctx = await requireTenant(org);
    const { timezone } = await getOrganization(ctx);
    const r = await sendCampaignTest(ctx, environmentId, composerForm(form), form.get("testUserId"), timezone);
    const t = await getT();
    return r.ok ? { ok: true, message: translateMessage(t, r.message) } : { error: translateMessage(t, r.message) };
  } catch (err) {
    return failed(err);
  }
}
