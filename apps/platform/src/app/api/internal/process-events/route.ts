import { timingSafeEqual } from "node:crypto";
import { log } from "@/lib/log";
import { purgeRateLimitBuckets } from "@/lib/rate-limit";
import { sendUsageNotices } from "@/modules/billing/notices";
import { applyEventRetention, purgeOperationalData } from "@/modules/maintenance/retention";
import { runDeletionJobs } from "@/modules/privacy/service";
import { processPendingEvents } from "@/modules/processing/processor";
import { checkConfig } from "@/server/config";

export const runtime = "nodejs";
export const maxDuration = 60;

/** No new processing batch starts after this much wall time (of maxDuration). */
const PROCESSING_BUDGET_MS = 35_000;
/** Optional later steps start only before this much wall time. */
const LATE_STEPS_BUDGET_MS = 50_000;

function authorized(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  const given = req.headers.get("authorization")?.replace(/^Bearer /i, "") ?? "";
  if (!secret || given.length !== secret.length) return false;
  return timingSafeEqual(Buffer.from(given), Buffer.from(secret));
}

/**
 * Scheduled worker: retries privacy deletions, drains events the after() hook
 * missed (time-boxed; the rest waits for the next run), then housekeeping
 * (rate-limit windows, expired tokens and logs, and plan retention, which only
 * deletes events when EVENT_RETENTION=enforce), then plan usage notices.
 */
export async function GET(req: Request) {
  if (!authorized(req)) return new Response("Unauthorized", { status: 401 });
  const config = checkConfig();
  if (config.errors.length) {
    log.error("cron.refused", { errors: config.errors.map((e) => e.variable) });
    return Response.json({ error: "configuration_invalid", variables: config.errors.map((e) => e.variable) }, { status: 503 });
  }
  // Privacy deletions first (they have deadlines), then event processing under a
  // wall-clock budget so housekeeping always fits inside maxDuration.
  const started = Date.now();
  const deletions = await runDeletionJobs({ limit: 20 });
  const { processed, failed } = await processPendingEvents({ limit: 20_000, deadline: started + PROCESSING_BUDGET_MS });
  const purged = { rate_limit_buckets: await purgeRateLimitBuckets(), ...(await purgeOperationalData()) };
  const retention = await applyEventRetention();
  // Plan usage emails (80% / 100% / refusing), once per threshold per month.
  const usageNotices = Date.now() - started < LATE_STEPS_BUDGET_MS ? await sendUsageNotices({ limit: 100 }) : { notices: 0, emails: 0, skipped: true };
  const summary = { processed, failed, deletions, purged, retention: { mode: retention.mode, organizations: retention.organizations.length }, usage_notices: usageNotices };
  log.info("cron.completed", summary);
  return Response.json({ processed, failed, deletions, purged, retention, usage_notices: usageNotices });
}
