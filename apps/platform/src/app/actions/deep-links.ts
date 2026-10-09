"use server";

import { revalidatePath } from "next/cache";
import { createLink } from "@/modules/attribution/service";
import { CHANNEL_PRESETS, linkUrl } from "@/modules/deeplinks/pure";
import { checkWellKnown, configLinkBase, getConfig, saveConfig } from "@/modules/deeplinks/service";
import { toActionError, type ActionState } from "@/server/action-result";
import { loadApp } from "@/server/session";
import { getT } from "@/i18n/server";
import { msg } from "@/i18n/translate";

const text = (form: FormData, k: string) => (typeof form.get(k) === "string" ? (form.get(k) as string) : undefined);

export async function saveDeepLinkConfigAction(orgSlug: string, appSlug: string, _: ActionState, form: FormData): Promise<ActionState> {
  try {
    const { ctx, app } = await loadApp(orgSlug, appSlug);
    await saveConfig(ctx, app.id, {
      environmentId: text(form, "environmentId"),
      linkPrefix: text(form, "linkPrefix"),
      customDomain: text(form, "customDomain"),
      iosTeamId: text(form, "iosTeamId"),
      iosBundleIds: text(form, "iosBundleIds"),
      iosAppStoreId: text(form, "iosAppStoreId"),
      uriScheme: text(form, "uriScheme"),
      androidPackage: text(form, "androidPackage"),
      androidSha256: text(form, "androidSha256"),
      androidPlayStoreId: text(form, "androidPlayStoreId"),
      deferredEnabled: text(form, "deferredEnabled"),
      interstitialEnabled: text(form, "interstitialEnabled"),
    });
    revalidatePath(`/o/${orgSlug}/apps/${appSlug}/settings/dev-ops/deep-links`);
    return { ok: true, message: msg("Saved. The association files are updated now; press Test to check them from outside.") };
  } catch (err) {
    return toActionError(err);
  }
}

export async function checkWellKnownAction(orgSlug: string, appSlug: string, environmentId: string, _: ActionState): Promise<ActionState> {
  try {
    const { ctx, app } = await loadApp(orgSlug, appSlug);
    const results = await checkWellKnown(ctx, app.id, environmentId);
    revalidatePath(`/o/${orgSlug}/apps/${appSlug}/settings/dev-ops/deep-links`);
    const failed = results.filter((r) => !r.ok && !r.warning);
    if (!results.length) return { error: msg("Nothing to test yet: add the iOS or Android settings first.") };
    const t = await getT();
    return failed.length ? { error: t("{n} check(s) failed: see the results below.", { n: failed.length }) } : { ok: true, message: msg("Both files are served correctly.") };
  } catch (err) {
    return toActionError(err);
  }
}

/** Creates a tracking link for a channel with the channel's source / medium preset. */
export async function createChannelLinkAction(orgSlug: string, appSlug: string, _: ActionState, form: FormData): Promise<ActionState> {
  try {
    const { ctx, app } = await loadApp(orgSlug, appSlug);
    const preset = CHANNEL_PRESETS.find((p) => p.id === text(form, "channel"));
    const environmentId = text(form, "environmentId") ?? "";
    const link = await createLink(ctx, app.id, {
      environmentId,
      name: text(form, "name"),
      source: text(form, "source") || preset?.source,
      medium: text(form, "medium") || preset?.medium,
      campaign: text(form, "campaign"),
      adGroup: text(form, "adGroup"),
      creative: text(form, "creative"),
      iosUrl: text(form, "iosUrl"),
      androidUrl: text(form, "androidUrl"),
      webUrl: text(form, "webUrl"),
      deepLinkPath: text(form, "deepLinkPath"),
    });
    const config = await getConfig(ctx, app.id, environmentId).catch(() => null);
    revalidatePath(`/o/${orgSlug}/apps/${appSlug}/acquisition/deep-links`);
    revalidatePath(`/o/${orgSlug}/apps/${appSlug}/acquisition/links`);
    const t = await getT();
    return { ok: true, message: t("Link created: {url}", { url: linkUrl(configLinkBase(config), link.code, config?.link_prefix ?? null) }) };
  } catch (err) {
    return toActionError(err);
  }
}
