"use server";

import { revalidatePath } from "next/cache";
import { after } from "next/server";
import { requestDeletion, runDeletionJobs } from "@/modules/privacy/service";
import { toActionError, type ActionState } from "@/server/action-result";
import { requireTenant } from "@/server/session";

export async function requestDeletionAction(orgSlug: string, appSlug: string, environmentId: string, _: ActionState, form: FormData): Promise<ActionState> {
  try {
    if (form.get("confirm") !== "delete") return { error: 'Type "delete" to confirm.' };
    const ctx = await requireTenant(orgSlug);
    const { jobId } = await requestDeletion({ kind: "user", ctx }, environmentId, {
      userId: form.get("userId") ?? undefined,
      anonymousId: form.get("anonymousId") ?? undefined,
    });
    after(() => runDeletionJobs({ jobIds: [jobId] }).catch((e) => console.error("[privacy]", e)));
    revalidatePath(`/o/${orgSlug}/apps/${appSlug}/privacy`);
    return { ok: true, message: "Deletion queued. It usually finishes within seconds; refresh to see the result below." };
  } catch (err) {
    return toActionError(err);
  }
}
