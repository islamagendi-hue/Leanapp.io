"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getT } from "@/i18n/server";
import { msg } from "@/i18n/translate";
import { activateAudience, archiveAudience, createAudience, previewAudience, updateAudience } from "@/modules/audiences/service";
import { translateMessage } from "@/modules/automation/messages";
import { activateAutomation, archiveAutomation, createAutomation, pauseAutomation, updateAutomation } from "@/modules/automation/service";
import { addEmailDomain, deleteEmailTemplate, refreshEmailDomain, removeEmailDomain, saveEmailTemplate } from "@/modules/messaging/email";
import { configureApns, configureFcm, configureResend, configureWhatsApp, removeIntegration, rotateWhatsAppVerifyToken } from "@/modules/messaging/integrations";
import { syncTemplates } from "@/modules/whatsapp/service";
import { createWebhook, deleteWebhook, retryDelivery, rotateWebhookSecret, sendTestWebhook, updateWebhook } from "@/modules/webhooks/service";
import { toActionError, type ActionState } from "@/server/action-result";
import { requireTenant } from "@/server/session";

const appBase = (org: string, app: string) => `/o/${org}/apps/${app}`;
const str = (form: FormData, k: string) => {
  const v = form.get(k);
  return typeof v === "string" ? v : undefined;
};

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

// ── Audiences ───────────────────────────────────────────────────────────────
export async function previewAudienceAction(orgSlug: string, environmentId: string, definitionJson: string): Promise<{ size?: number; sample?: string[]; description?: string; error?: string }> {
  try {
    return await previewAudience(await requireTenant(orgSlug), environmentId, definitionJson);
  } catch (err) {
    return { error: (await failed(err)).error };
  }
}

export async function saveAudienceAction(orgSlug: string, appSlug: string, environmentId: string, audienceId: string | null, _: ActionState, form: FormData): Promise<ActionState> {
  let id = audienceId;
  try {
    const ctx = await requireTenant(orgSlug);
    const input = { name: str(form, "name"), description: str(form, "description"), refreshMinutes: str(form, "refreshMinutes"), definition: str(form, "definition") };
    if (id) await updateAudience(ctx, id, input);
    else id = (await createAudience(ctx, environmentId, input)).id;
  } catch (err) {
    return failed(err);
  }
  revalidatePath(`${appBase(orgSlug, appSlug)}/engage/audiences`);
  if (!audienceId) redirect(`${appBase(orgSlug, appSlug)}/engage/audiences/${id}`);
  return { ok: true, message: msg("Saved. An active audience is recomputed on the next scheduled run.") };
}

export async function audienceLifecycleAction(orgSlug: string, appSlug: string, audienceId: string, op: "activate" | "archive", _: ActionState): Promise<ActionState> {
  try {
    const ctx = await requireTenant(orgSlug);
    let message = msg("Archived.");
    if (op === "activate") message = (await getT())("Active: {n} people right now.", { n: (await activateAudience(ctx, audienceId)).size.toLocaleString("en-US") });
    else await archiveAudience(ctx, audienceId);
    revalidatePath(`${appBase(orgSlug, appSlug)}/engage/audiences/${audienceId}`);
    return { ok: true, message };
  } catch (err) {
    return failed(err);
  }
}

// ── Automations ─────────────────────────────────────────────────────────────
export async function saveAutomationAction(orgSlug: string, appSlug: string, environmentId: string, automationId: string | null, _: ActionState, form: FormData): Promise<ActionState> {
  let id = automationId;
  let message = msg("Saved.");
  try {
    const ctx = await requireTenant(orgSlug);
    const input = { name: str(form, "name"), definition: str(form, "definition") };
    if (id) message = (await getT())("Saved as version {version}. Runs in progress keep the version they started with.", { version: (await updateAutomation(ctx, id, input)).version });
    else id = (await createAutomation(ctx, environmentId, input)).id;
  } catch (err) {
    return failed(err);
  }
  revalidatePath(`${appBase(orgSlug, appSlug)}/engage/automations`);
  if (!automationId) redirect(`${appBase(orgSlug, appSlug)}/engage/automations/${id}`);
  return { ok: true, message };
}

export async function automationLifecycleAction(orgSlug: string, appSlug: string, automationId: string, op: "activate" | "pause" | "archive", _: ActionState): Promise<ActionState> {
  try {
    const ctx = await requireTenant(orgSlug);
    let message: string;
    if (op === "activate") {
      await activateAutomation(ctx, automationId);
      message = msg("Active. New triggers start runs from now on.");
    } else if (op === "pause") {
      await pauseAutomation(ctx, automationId);
      message = msg("Paused. Runs in progress wait where they are.");
    } else {
      message = (await getT())("Archived. {n} runs in progress were cancelled.", { n: (await archiveAutomation(ctx, automationId)).cancelled });
    }
    revalidatePath(`${appBase(orgSlug, appSlug)}/engage/automations/${automationId}`);
    return { ok: true, message };
  } catch (err) {
    return failed(err);
  }
}

// ── Webhooks ────────────────────────────────────────────────────────────────
const hooksPath = (org: string, app: string) => `${appBase(org, app)}/settings/dev-ops/webhooks`;

export async function createWebhookAction(orgSlug: string, appSlug: string, environmentId: string, _: ActionState, form: FormData): Promise<ActionState> {
  try {
    const { secret } = await createWebhook(await requireTenant(orgSlug), environmentId, {
      url: str(form, "url"), description: str(form, "description"), eventTypes: form.getAll("eventTypes"),
    });
    revalidatePath(hooksPath(orgSlug, appSlug));
    return { ok: true, message: msg("Webhook created. Use this signing secret to verify the LeanApp-Signature header."), secret };
  } catch (err) {
    return failed(err);
  }
}

export async function webhookAction(orgSlug: string, appSlug: string, webhookId: string, op: "test" | "rotate" | "enable" | "disable" | "delete", _: ActionState): Promise<ActionState> {
  try {
    const ctx = await requireTenant(orgSlug);
    let result: ActionState = { ok: true };
    if (op === "test") {
      const r = await sendTestWebhook(ctx, webhookId);
      const t = await getT();
      const reason = r.error ?? `HTTP ${r.statusCode}`;
      result = r.status === "succeeded"
        ? { ok: true, message: t("Delivered: HTTP {status}.", { status: String(r.statusCode) }) }
        : { error: r.status === "pending" ? t("Not delivered: {reason}. It will be retried; see the delivery log.", { reason }) : t("Not delivered: {reason}.", { reason }) };
    } else if (op === "rotate") {
      result = { ok: true, message: msg("New signing secret. The old one stops working now."), secret: (await rotateWebhookSecret(ctx, webhookId)).secret };
    } else if (op === "delete") {
      await deleteWebhook(ctx, webhookId);
    } else {
      await updateWebhook(ctx, webhookId, { status: op === "enable" ? "active" : "disabled" });
      result = { ok: true, message: op === "enable" ? msg("Enabled.") : msg("Disabled.") };
    }
    revalidatePath(hooksPath(orgSlug, appSlug));
    if (op === "delete") redirect(hooksPath(orgSlug, appSlug));
    return result;
  } catch (err) {
    return failed(err);
  }
}

export async function retryDeliveryAction(orgSlug: string, appSlug: string, webhookId: string, deliveryId: string, _: ActionState): Promise<ActionState> {
  try {
    await retryDelivery(await requireTenant(orgSlug), deliveryId);
    revalidatePath(`${hooksPath(orgSlug, appSlug)}/${webhookId}`);
    return { ok: true, message: msg("Queued for the next delivery run (every 5 minutes).") };
  } catch (err) {
    return failed(err);
  }
}

// ── Integrations ────────────────────────────────────────────────────────────
const integrationsPath = (org: string, app: string) => `${appBase(org, app)}/settings/dev-ops/channels`;

export async function configureIntegrationAction(orgSlug: string, appSlug: string, environmentId: string, provider: "fcm" | "apns" | "resend" | "whatsapp", _: ActionState, form: FormData): Promise<ActionState> {
  try {
    const ctx = await requireTenant(orgSlug);
    if (provider === "whatsapp") {
      const { verifyToken } = await configureWhatsApp(ctx, environmentId, {
        phoneNumberId: str(form, "phoneNumberId"), wabaId: str(form, "wabaId"), accessToken: str(form, "accessToken"), appSecret: str(form, "appSecret"),
      });
      revalidatePath(integrationsPath(orgSlug, appSlug));
      return verifyToken
        ? { ok: true, message: msg("Saved. Enter this verify token with the webhook URL in your Meta app (WhatsApp → Configuration). It is shown only once."), secret: verifyToken }
        : { ok: true, message: msg("Saved. The webhook verify token is unchanged.") };
    }
    if (provider === "fcm") {
      const file = form.get("serviceAccount");
      const json = file instanceof File && file.size ? await file.text() : str(form, "serviceAccountJson");
      if (file instanceof File && file.size > 20_000) return { error: msg("That file is too large to be a service account key.") };
      await configureFcm(ctx, environmentId, { serviceAccountJson: json });
    } else if (provider === "apns") {
      const file = form.get("p8File");
      const p8 = file instanceof File && file.size ? await file.text() : str(form, "p8");
      await configureApns(ctx, environmentId, { keyId: str(form, "keyId"), teamId: str(form, "teamId"), bundleId: str(form, "bundleId"), apnsEnvironment: str(form, "apnsEnvironment"), p8 });
    } else {
      await configureResend(ctx, environmentId, { apiKey: str(form, "apiKey"), from: str(form, "from") });
    }
    revalidatePath(integrationsPath(orgSlug, appSlug));
    return { ok: true, message: msg("Saved. Credentials are stored encrypted and never shown again.") };
  } catch (err) {
    return failed(err);
  }
}

export async function removeIntegrationAction(orgSlug: string, appSlug: string, integrationId: string, _: ActionState): Promise<ActionState> {
  try {
    await removeIntegration(await requireTenant(orgSlug), integrationId);
    revalidatePath(integrationsPath(orgSlug, appSlug));
    return { ok: true, message: msg("Removed.") };
  } catch (err) {
    return failed(err);
  }
}

export async function whatsappAction(orgSlug: string, appSlug: string, environmentId: string, op: "sync" | "rotate", _: ActionState): Promise<ActionState> {
  try {
    const ctx = await requireTenant(orgSlug);
    let result: ActionState;
    if (op === "sync") {
      const r = await syncTemplates(ctx, environmentId);
      const t = await getT();
      result = { ok: true, message: r.templates === 1 ? t("Synced 1 template ({approved} approved).", { approved: r.approved }) : t("Synced {n} templates ({approved} approved).", { n: r.templates, approved: r.approved }) };
    } else {
      result = { ok: true, message: msg("New verify token. Update it in your Meta app before Meta re-verifies the webhook."), secret: await rotateWhatsAppVerifyToken(ctx, environmentId) };
    }
    revalidatePath(integrationsPath(orgSlug, appSlug));
    return result;
  } catch (err) {
    return failed(err);
  }
}

export async function emailDomainAction(orgSlug: string, appSlug: string, environmentId: string, op: "add" | "check" | "verify" | "remove", _: ActionState, form: FormData): Promise<ActionState> {
  try {
    const ctx = await requireTenant(orgSlug);
    const t = await getT();
    let message: string;
    if (op === "add") {
      const d = await addEmailDomain(ctx, environmentId, { name: str(form, "domain") });
      message = t("Added {domain} to your Resend account. Publish the DNS records below, then verify.", { domain: d.name });
    } else if (op === "remove") {
      await removeEmailDomain(ctx, environmentId);
      message = msg("Removed here. The domain stays in your Resend account.");
    } else {
      const d = await refreshEmailDomain(ctx, environmentId, { verify: op === "verify" });
      message = d.status === "verified" ? t("{domain} is verified.", { domain: d.name }) : t("Status: {status}. DNS changes can take a while; check again later.", { status: d.status.replace(/_/g, " ") });
    }
    revalidatePath(integrationsPath(orgSlug, appSlug));
    return { ok: true, message };
  } catch (err) {
    return failed(err);
  }
}

// ── Email templates ─────────────────────────────────────────────────────────
const templatesPath = (org: string, app: string) => `${appBase(org, app)}/engage/email-templates`;

export async function saveEmailTemplateAction(orgSlug: string, appSlug: string, environmentId: string, templateId: string | null, _: ActionState, form: FormData): Promise<ActionState> {
  try {
    await saveEmailTemplate(await requireTenant(orgSlug), environmentId, templateId, { name: str(form, "name"), subject: str(form, "subject"), body: str(form, "body") });
    revalidatePath(templatesPath(orgSlug, appSlug));
    return { ok: true, message: templateId ? msg("Saved. Automations using it send the new version from now on.") : msg("Template created.") };
  } catch (err) {
    return failed(err);
  }
}

export async function deleteEmailTemplateAction(orgSlug: string, appSlug: string, templateId: string, _: ActionState): Promise<ActionState> {
  try {
    await deleteEmailTemplate(await requireTenant(orgSlug), templateId);
    revalidatePath(templatesPath(orgSlug, appSlug));
    return { ok: true, message: msg("Deleted.") };
  } catch (err) {
    return failed(err);
  }
}
