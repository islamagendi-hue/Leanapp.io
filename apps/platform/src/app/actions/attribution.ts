"use server";

import { revalidatePath } from "next/cache";
import { createLink, createPostback, setLinkStatus, setPostbackStatus, updateSettings } from "@/modules/attribution/service";
import { toActionError, type ActionState } from "@/server/action-result";
import { publicBaseUrl } from "@/server/env";
import { loadApp } from "@/server/session";

const text = (form: FormData, k: string) => (typeof form.get(k) === "string" ? (form.get(k) as string) : undefined);

export async function createLinkAction(orgSlug: string, appSlug: string, _: ActionState, form: FormData): Promise<ActionState> {
  try {
    const { ctx, app } = await loadApp(orgSlug, appSlug);
    const link = await createLink(ctx, app.id, {
      environmentId: text(form, "environmentId"),
      name: text(form, "name"),
      source: text(form, "source"),
      medium: text(form, "medium"),
      campaign: text(form, "campaign"),
      adGroup: text(form, "adGroup"),
      creative: text(form, "creative"),
      iosUrl: text(form, "iosUrl"),
      androidUrl: text(form, "androidUrl"),
      webUrl: text(form, "webUrl"),
      deepLinkPath: text(form, "deepLinkPath"),
    });
    revalidatePath(`/o/${orgSlug}/apps/${appSlug}/acquisition/links`);
    return { ok: true, message: `Link created: ${publicBaseUrl()}/l/${link.code}` };
  } catch (err) {
    return toActionError(err);
  }
}

export async function setLinkStatusAction(orgSlug: string, appSlug: string, linkId: string, status: "active" | "paused", _: ActionState): Promise<ActionState> {
  try {
    const { ctx, app } = await loadApp(orgSlug, appSlug);
    await setLinkStatus(ctx, app.id, linkId, status);
    revalidatePath(`/o/${orgSlug}/apps/${appSlug}/acquisition/links`);
    return { ok: true };
  } catch (err) {
    return toActionError(err);
  }
}

export async function updateSettingsAction(orgSlug: string, appSlug: string, _: ActionState, form: FormData): Promise<ActionState> {
  try {
    const { ctx, app } = await loadApp(orgSlug, appSlug);
    await updateSettings(ctx, app.id, {
      clickLookbackDays: text(form, "clickLookbackDays"),
      probabilisticEnabled: text(form, "probabilisticEnabled"),
      probabilisticWindowHours: text(form, "probabilisticWindowHours"),
      conversionWindowDays: text(form, "conversionWindowDays"),
      reengagementEnabled: text(form, "reengagementEnabled"),
    });
    revalidatePath(`/o/${orgSlug}/apps/${appSlug}/settings/dev-ops/attribution`);
    return { ok: true, message: "Saved. New installs and conversions use these settings; past attributions are not recomputed." };
  } catch (err) {
    return toActionError(err);
  }
}

export async function createPostbackAction(orgSlug: string, appSlug: string, _: ActionState, form: FormData): Promise<ActionState> {
  try {
    const { ctx, app } = await loadApp(orgSlug, appSlug);
    const prefixed = (prefix: string) =>
      Object.fromEntries([...form.entries()].filter(([k, v]) => k.startsWith(prefix) && typeof v === "string").map(([k, v]) => [k.slice(prefix.length), v as string]));
    await createPostback(ctx, app.id, {
      environmentId: text(form, "environmentId"),
      network: text(form, "network"),
      name: text(form, "name"),
      events: text(form, "events"),
      sources: text(form, "sources"),
      includeOrganic: text(form, "includeOrganic"),
      urlTemplate: text(form, "urlTemplate"),
      httpMethod: text(form, "httpMethod") || "GET",
      config: prefixed("config."),
      credentials: prefixed("secret."),
    });
    revalidatePath(`/o/${orgSlug}/apps/${appSlug}/settings/dev-ops/attribution/postbacks`);
    return { ok: true, message: "Postback saved. Deliveries are sent by the scheduled worker (every 5 minutes)." };
  } catch (err) {
    return toActionError(err);
  }
}

export async function setPostbackStatusAction(orgSlug: string, appSlug: string, id: string, status: "active" | "paused" | "deleted", _: ActionState): Promise<ActionState> {
  try {
    const { ctx, app } = await loadApp(orgSlug, appSlug);
    await setPostbackStatus(ctx, app.id, id, status);
    revalidatePath(`/o/${orgSlug}/apps/${appSlug}/settings/dev-ops/attribution/postbacks`);
    return { ok: true };
  } catch (err) {
    return toActionError(err);
  }
}
