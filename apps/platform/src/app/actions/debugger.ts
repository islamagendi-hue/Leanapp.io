"use server";

import { revalidatePath } from "next/cache";
import { after } from "next/server";
import { log } from "@/lib/log";
import { msg } from "@/i18n/translate";
import { retryFailedEvents } from "@/modules/debugger/service";
import { DEMO_LOCKED, isDemoUser } from "@/modules/marketing/demo";
import { processPendingEvents } from "@/modules/processing/processor";
import { toActionError, type ActionState } from "@/server/action-result";
import { requireTenant, requireUser } from "@/server/session";

/**
 * Puts failed events back in the processing queue: one event when `eventId`
 * is given, else every failed event of the environment in the debugger's
 * window (capped per press). Processing starts right after the response.
 */
export async function retryFailedEventsAction(orgSlug: string, appSlug: string, environmentId: string, eventId: string | null, _: ActionState): Promise<ActionState> {
  try {
    if (isDemoUser(await requireUser())) return { error: DEMO_LOCKED };
    const ctx = await requireTenant(orgSlug);
    const { retried } = await retryFailedEvents(ctx, environmentId, eventId ?? undefined);
    if (retried > 0) {
      after(() => processPendingEvents({ environmentId, limit: 1000 }).catch((e) => log.error("processing.failed", { environment_id: environmentId, error: e })));
    }
    revalidatePath(`/o/${orgSlug}/apps/${appSlug}/settings/dev-ops/debugger`);
    return {
      ok: true,
      message: retried > 0 ? msg("Queued for processing again. Refresh in a few seconds to see the result.") : msg("No failed events to retry."),
    };
  } catch (err) {
    return toActionError(err);
  }
}
