"use server";

import { revalidatePath } from "next/cache";
import { createChannelRule, createCustomChannel, setChannelRuleStatus, setCustomChannelStatus } from "@/modules/channels/service";
import { toActionError, type ActionState } from "@/server/action-result";
import { loadApp } from "@/server/session";
import { msg } from "@/i18n/translate";

/**
 * Custom channels and channel rules (Settings → Dev Ops → Attribution). Each
 * action loads the app for the signed-in member; the service checks
 * attribution.manage inside the tenant transaction.
 */

const text = (form: FormData, k: string) => (typeof form.get(k) === "string" ? (form.get(k) as string) : undefined);
const paths = (org: string, app: string) => {
  revalidatePath(`/o/${org}/apps/${app}/settings/dev-ops/attribution`);
  revalidatePath(`/o/${org}/apps/${app}/acquisition`, "layout");
};

export async function createCustomChannelAction(orgSlug: string, appSlug: string, _: ActionState, form: FormData): Promise<ActionState> {
  try {
    const { ctx, app } = await loadApp(orgSlug, appSlug);
    await createCustomChannel(ctx, app.id, { label: text(form, "label"), key: text(form, "key"), group: text(form, "group"), description: text(form, "description") });
    paths(orgSlug, appSlug);
    return { ok: true, message: msg("Channel added. Add a rule to put touches on it.") };
  } catch (err) {
    return toActionError(err);
  }
}

export async function setCustomChannelStatusAction(orgSlug: string, appSlug: string, id: string, status: "active" | "archived", _: ActionState): Promise<ActionState> {
  try {
    const { ctx, app } = await loadApp(orgSlug, appSlug);
    await setCustomChannelStatus(ctx, app.id, id, status);
    paths(orgSlug, appSlug);
    return { ok: true };
  } catch (err) {
    return toActionError(err);
  }
}

export async function createChannelRuleAction(orgSlug: string, appSlug: string, _: ActionState, form: FormData): Promise<ActionState> {
  try {
    const { ctx, app } = await loadApp(orgSlug, appSlug);
    await createChannelRule(ctx, app.id, {
      channel: text(form, "channel"),
      priority: text(form, "priority") || undefined,
      source: text(form, "source"),
      medium: text(form, "medium"),
      campaignPrefix: text(form, "campaignPrefix"),
      referrerHost: text(form, "referrerHost"),
      clickIdParam: text(form, "clickIdParam"),
      hasReferralId: text(form, "hasReferralId"),
      note: text(form, "note"),
    });
    paths(orgSlug, appSlug);
    return { ok: true, message: msg("Rule saved. Reports use it from now on, for past data too.") };
  } catch (err) {
    return toActionError(err);
  }
}

export async function setChannelRuleStatusAction(orgSlug: string, appSlug: string, id: string, status: "active" | "paused" | "deleted", _: ActionState): Promise<ActionState> {
  try {
    const { ctx, app } = await loadApp(orgSlug, appSlug);
    await setChannelRuleStatus(ctx, app.id, id, status);
    paths(orgSlug, appSlug);
    return { ok: true };
  } catch (err) {
    return toActionError(err);
  }
}
