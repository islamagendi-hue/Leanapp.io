import { timingSafeEqual } from "node:crypto";
import { purgeRateLimitBuckets } from "@/lib/rate-limit";
import { applyEventRetention, purgeOperationalData } from "@/modules/maintenance/retention";
import { runDeletionJobs } from "@/modules/privacy/service";
import { processPendingEvents } from "@/modules/processing/processor";

export const runtime = "nodejs";
export const maxDuration = 60;

function authorized(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  const given = req.headers.get("authorization")?.replace(/^Bearer /i, "") ?? "";
  if (!secret || given.length !== secret.length) return false;
  return timingSafeEqual(Buffer.from(given), Buffer.from(secret));
}

/**
 * Scheduled worker: drains events the after() hook missed, retries privacy
 * deletions, then housekeeping (rate-limit windows, expired tokens and logs,
 * and plan retention, which only deletes events when EVENT_RETENTION=enforce).
 */
export async function GET(req: Request) {
  if (!authorized(req)) return new Response("Unauthorized", { status: 401 });
  let processed = 0;
  let failed = 0;
  for (let i = 0; i < 10; i++) {
    const r = await processPendingEvents({ limit: 1000 });
    processed += r.processed;
    failed += r.failed;
    if (r.processed + r.failed < 1000) break;
  }
  const deletions = await runDeletionJobs({ limit: 20 });
  const purged = { rate_limit_buckets: await purgeRateLimitBuckets(), ...(await purgeOperationalData()) };
  const retention = await applyEventRetention();
  return Response.json({ processed, failed, deletions, purged, retention });
}
