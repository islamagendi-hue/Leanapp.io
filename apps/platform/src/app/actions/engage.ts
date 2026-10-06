"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { activateAudience, archiveAudience, createAudience, previewAudience, updateAudience } from "@/modules/audiences/service";
import { activateAutomation, archiveAutomation, createAutomation, pauseAutomation, updateAutomation } from "@/modules/automation/service";
import { configureApns, configureFcm, configureResend, removeIntegration } from "@/modules/messaging/integrations";
import { createWebhook, deleteWebhook, retryDelivery, rotateWebhookSecret, sendTestWebhook, updateWebhook } from "@/modules/webhooks/service";
import { toActionError, type ActionState } from "@/server/action-result";
import { requireTenant } from "@/server/session";

const appBase = (org: string, app: string) => `/o/${org}/apps/${app}`;
const str = (form: FormData, k: string) => {
  const v = form.get(k);
  return typeof v === "string" ? v : undefined;
};

// ── Audiences ───────────────────────────────────────────────────────────────
export async function previewAudienceAction(orgSlug: string, environmentId: string, definitionJson: string): Promise<{ size?: number; sample?: string[]; description?: string; error?: string }> {
  try {
    return await previewAudience(await requireTenant(orgSlug), environmentId, definitionJson);
  } catch (err) {
    return { error: toActionError(err).error };
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
    return toActionError(err);
  }
  revalidatePath(`${appBase(orgSlug, appSlug)}/engage/audiences`);
  if (!audienceId) redirect(`${appBase(orgSlug, appSlug)}/engage/audiences/${id}`);
  return { ok: true, message: "Saved. An active audience is recomputed on the next scheduled run." };
}

export async function audienceLifecycleAction(orgSlug: string, appSlug: string, audienceId: string, op: "activate" | "archive", _: ActionState): Promise<ActionState> {
  try {
    const ctx = await requireTenant(orgSlug);
    let message = "Archived.";
    if (op === "activate") message = `Active: ${(await activateAudience(ctx, audienceId)).size.toLocaleString("en-US")} people right now.`;
    else await archiveAudience(ctx, audienceId);
    revalidatePath(`${appBase(orgSlug, appSlug)}/engage/audiences/${audienceId}`);
    return { ok: true, message };
  } catch (err) {
    return toActionError(err);
  }
}

// ── Automations ─────────────────────────────────────────────────────────────
export async function saveAutomationAction(orgSlug: string, appSlug: string, environmentId: string, automationId: string | null, _: ActionState, form: FormData): Promise<ActionState> {
  let id = automationId;
  let message = "Saved.";
  try {
    const ctx = await requireTenant(orgSlug);
    const input = { name: str(form, "name"), definition: str(form, "definition") };
    if (id) message = `Saved as version ${(await updateAutomation(ctx, id, input)).version}. Runs in progress keep the version they started with.`;
    else id = (await createAutomation(ctx, environmentId, input)).id;
  } catch (err) {
    return toActionError(err);
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
      message = "Active. New triggers start runs from now on.";
    } else if (op === "pause") {
      await pauseAutomation(ctx, automationId);
      message = "Paused. Runs in progress wait where they are.";
    } else {
      message = `Archived. ${(await archiveAutomation(ctx, automationId)).cancelled} runs in progress were cancelled.`;
    }
    revalidatePath(`${appBase(orgSlug, appSlug)}/engage/automations/${automationId}`);
    return { ok: true, message };
  } catch (err) {
    return toActionError(err);
  }
}

// ── Webhooks ────────────────────────────────────────────────────────────────
const hooksPath = (org: string, app: string) => `${appBase(org, app)}/developers/webhooks`;

export async function createWebhookAction(orgSlug: string, appSlug: string, environmentId: string, _: ActionState, form: FormData): Promise<ActionState> {
  try {
    const { secret } = await createWebhook(await requireTenant(orgSlug), environmentId, {
      url: str(form, "url"), description: str(form, "description"), eventTypes: form.getAll("eventTypes"),
    });
    revalidatePath(hooksPath(orgSlug, appSlug));
    return { ok: true, message: "Webhook created. Use this signing secret to verify the LeanApp-Signature header.", secret };
  } catch (err) {
    return toActionError(err);
  }
}

export async function webhookAction(orgSlug: string, appSlug: string, webhookId: string, op: "test" | "rotate" | "enable" | "disable" | "delete", _: ActionState): Promise<ActionState> {
  try {
    const ctx = await requireTenant(orgSlug);
    let result: ActionState = { ok: true };
    if (op === "test") {
      const r = await sendTestWebhook(ctx, webhookId);
      result = r.status === "succeeded"
        ? { ok: true, message: `Delivered: HTTP ${r.statusCode}.` }
        : { error: `Not delivered: ${r.error ?? `HTTP ${r.statusCode}`}.${r.status === "pending" ? " It will be retried; see the delivery log." : ""}` };
    } else if (op === "rotate") {
      result = { ok: true, message: "New signing secret. The old one stops working now.", secret: (await rotateWebhookSecret(ctx, webhookId)).secret };
    } else if (op === "delete") {
      await deleteWebhook(ctx, webhookId);
    } else {
      await updateWebhook(ctx, webhookId, { status: op === "enable" ? "active" : "disabled" });
      result = { ok: true, message: op === "enable" ? "Enabled." : "Disabled." };
    }
    revalidatePath(hooksPath(orgSlug, appSlug));
    if (op === "delete") redirect(hooksPath(orgSlug, appSlug));
    return result;
  } catch (err) {
    return toActionError(err);
  }
}

export async function retryDeliveryAction(orgSlug: string, appSlug: string, webhookId: string, deliveryId: string, _: ActionState): Promise<ActionState> {
  try {
    await retryDelivery(await requireTenant(orgSlug), deliveryId);
    revalidatePath(`${hooksPath(orgSlug, appSlug)}/${webhookId}`);
    return { ok: true, message: "Queued for the next delivery run (every 5 minutes)." };
  } catch (err) {
    return toActionError(err);
  }
}

// ── Integrations ────────────────────────────────────────────────────────────
const integrationsPath = (org: string, app: string) => `${appBase(org, app)}/engage/integrations`;

export async function configureIntegrationAction(orgSlug: string, appSlug: string, environmentId: string, provider: "fcm" | "apns" | "resend", _: ActionState, form: FormData): Promise<ActionState> {
  try {
    const ctx = await requireTenant(orgSlug);
    if (provider === "fcm") {
      const file = form.get("serviceAccount");
      const json = file instanceof File && file.size ? await file.text() : str(form, "serviceAccountJson");
      if (file instanceof File && file.size > 20_000) return { error: "That file is too large to be a service account key." };
      await configureFcm(ctx, environmentId, { serviceAccountJson: json });
    } else if (provider === "apns") {
      const file = form.get("p8File");
      const p8 = file instanceof File && file.size ? await file.text() : str(form, "p8");
      await configureApns(ctx, environmentId, { keyId: str(form, "keyId"), teamId: str(form, "teamId"), bundleId: str(form, "bundleId"), apnsEnvironment: str(form, "apnsEnvironment"), p8 });
    } else {
      await configureResend(ctx, environmentId, { apiKey: str(form, "apiKey"), from: str(form, "from") });
    }
    revalidatePath(integrationsPath(orgSlug, appSlug));
    return { ok: true, message: "Saved. Credentials are stored encrypted and never shown again." };
  } catch (err) {
    return toActionError(err);
  }
}

export async function removeIntegrationAction(orgSlug: string, appSlug: string, integrationId: string, _: ActionState): Promise<ActionState> {
  try {
    await removeIntegration(await requireTenant(orgSlug), integrationId);
    revalidatePath(integrationsPath(orgSlug, appSlug));
    return { ok: true, message: "Removed." };
  } catch (err) {
    return toActionError(err);
  }
}
