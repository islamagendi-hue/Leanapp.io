"use server";

import { revalidatePath } from "next/cache";
import { after } from "next/server";
import { addSuppression, removeSuppression } from "@/modules/privacy/consent";
import { requestDeletion, runDeletionJobs } from "@/modules/privacy/service";
import { getT } from "@/i18n/server";
import { msg } from "@/i18n/translate";
import { toActionError, type ActionState } from "@/server/action-result";
import { requireTenant } from "@/server/session";
import { log } from "@/lib/log";

export async function requestDeletionAction(orgSlug: string, appSlug: string, environmentId: string, _: ActionState, form: FormData): Promise<ActionState> {
  try {
    if (form.get("confirm") !== "delete") return { error: msg('Type "delete" to confirm.') };
    const ctx = await requireTenant(orgSlug);
    const { jobId } = await requestDeletion({ kind: "user", ctx }, environmentId, {
      userId: form.get("userId") ?? undefined,
      anonymousId: form.get("anonymousId") ?? undefined,
    });
    after(() => runDeletionJobs({ jobIds: [jobId] }).catch((e) => log.error("privacy.deletion_failed", { error: e })));
    revalidatePath(`/o/${orgSlug}/apps/${appSlug}/settings/privacy`);
    return { ok: true, message: msg("Deletion queued. It usually finishes within seconds; refresh to see the result below.") };
  } catch (err) {
    return toActionError(err);
  }
}

const formChannels = (form: FormData) => form.getAll("channel").map(String);

export async function addSuppressionAction(orgSlug: string, appSlug: string, environmentId: string, _: ActionState, form: FormData): Promise<ActionState> {
  try {
    const ctx = await requireTenant(orgSlug);
    const r = await addSuppression({ kind: "user", ctx }, environmentId, {
      userId: form.get("userId") ?? undefined,
      anonymousId: form.get("anonymousId") ?? undefined,
      channels: formChannels(form),
      reason: form.get("reason") ?? undefined,
    });
    revalidatePath(`/o/${orgSlug}/apps/${appSlug}/settings/privacy/suppressions`);
    const t = await getT();
    return { ok: true, message: t("{user} is suppressed for {channels}.", { user: r.userKey, channels: r.channels.join(", ") }) };
  } catch (err) {
    return toActionError(err);
  }
}

export async function removeSuppressionAction(orgSlug: string, appSlug: string, environmentId: string, userKey: string, channel: string, _: ActionState): Promise<ActionState> {
  try {
    const ctx = await requireTenant(orgSlug);
    const ids = userKey.startsWith("anon:") ? { anonymousId: userKey.slice(5) } : { userId: userKey };
    const r = await removeSuppression({ kind: "user", ctx }, environmentId, { ...ids, channels: [channel] });
    revalidatePath(`/o/${orgSlug}/apps/${appSlug}/settings/privacy/suppressions`);
    if (r.remaining.length) return { ok: true, message: msg("Removed. Still suppressed because the user denied consent.") };
    return { ok: true, message: msg("Removed.") };
  } catch (err) {
    return toActionError(err);
  }
}
