import { timingSafeEqual } from "node:crypto";
import { after } from "next/server";
import { log } from "@/lib/log";
import { captureException, report } from "@/lib/monitoring";
import { purgeRateLimitBuckets } from "@/lib/rate-limit";
import { sendUsageNotices } from "@/modules/billing/notices";
import { applyEventRetention, purgeOperationalData } from "@/modules/maintenance/retention";
import { purgeDeletedMedia } from "@/modules/media/service";
import { runAttributionJobs } from "@/modules/attribution/delivery";
import { runAdSyncJobs } from "@/modules/integrations/sync";
import { runEngagement } from "@/modules/automation/worker";
import { demoEnabled, ensureDemo } from "@/modules/marketing/demo";
import { runDeletionJobs } from "@/modules/privacy/service";
import { runReprocessJobs } from "@/modules/reprocess/jobs";
import { processPendingEvents } from "@/modules/processing/processor";
import { checkConfig } from "@/server/config";
import { alertOnProblems, checkWorkerHealth } from "@/server/worker-health";

export const runtime = "nodejs";
export const maxDuration = 60;

/** No new processing batch starts after this much wall time (of maxDuration). */
const PROCESSING_BUDGET_MS = 35_000;
/** Re-map and growth rebuild chunks stop starting after this much wall time. */
const REPROCESS_BUDGET_MS = 42_000;
/** Optional later steps start only before this much wall time. */
const LATE_STEPS_BUDGET_MS = 50_000;
/** Postback delivery stops starting new requests after this much wall time. */
const ATTRIBUTION_BUDGET_MS = 48_000;
/** Ad-reporting imports start only before this much wall time, and stop starting requests at the attribution budget. */
const AD_SYNC_START_MS = 40_000;
/** Engagement work (audiences, automations, webhooks) stops starting new items after this much wall time. */
const ENGAGEMENT_BUDGET_MS = 52_000;

function authorized(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  const given = req.headers.get("authorization")?.replace(/^Bearer /i, "") ?? "";
  if (!secret || given.length !== secret.length) return false;
  return timingSafeEqual(Buffer.from(given), Buffer.from(secret));
}

const ROUTE = "GET /api/internal/process-events";

interface StepError {
  step: string;
  /** The error's class name only (e.g. "Error", "DatabaseError"); never its message, which may carry data. */
  error_name: string;
}

/**
 * Runs one worker step in isolation: a throwing step is reported
 * (docs/ops/monitoring.md), recorded in `errors`, and yields `null`, so the
 * remaining steps still run. The route answers 500 when any step failed.
 */
async function step<T>(errors: StepError[], name: string, fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn();
  } catch (e) {
    log.error("cron.step_failed", { step: name, error: e });
    await captureException(e, { source: `worker:${name}`, route: ROUTE, title: `Worker step "${name}" failed`, details: { step: name } });
    errors.push({ step: name, error_name: e instanceof Error ? e.name || "Error" : typeof e });
    return null;
  }
}

/**
 * Scheduled worker: retries privacy deletions, drains events the after() hook
 * missed (time-boxed; the rest waits for the next run), re-map and growth
 * rebuild chunks (app_reprocess_jobs), then housekeeping
 * (rate-limit windows, expired tokens and logs, and plan retention, which only
 * deletes events when EVENT_RETENTION=enforce), then plan usage notices,
 * attribution postbacks, and engagement: audience recomputation, automation
 * triggers and steps, webhook deliveries, and (when DEMO_ENABLED=1) the public
 * demo's sample data. Each later step starts only while its time budget lasts.
 *
 * Steps are isolated: one that throws is reported and listed in `errors`
 * (step and error class name), the others still run, and the response is 500
 * so pg_cron/pg_net, the heartbeat and the smoke test see the failure.
 */
export async function GET(req: Request) {
  if (!authorized(req)) return new Response("Unauthorized", { status: 401 });
  const config = checkConfig();
  if (config.errors.length) {
    log.error("cron.refused", { errors: config.errors.map((e) => e.variable) });
    await report({ key: "worker:config_invalid", severity: "error", title: "Worker refused to run: configuration invalid", source: "worker", route: ROUTE, details: { variables: config.errors.map((e) => e.variable).join(",") } });
    return Response.json({ error: "configuration_invalid", variables: config.errors.map((e) => e.variable) }, { status: 503 });
  }
  // Privacy deletions first (they have deadlines), then event processing under a
  // wall-clock budget so housekeeping always fits inside maxDuration.
  const started = Date.now();
  const errors: StepError[] = [];
  const deletions = await step(errors, "deletions", () => runDeletionJobs({ limit: 20 }));
  const processing = await step(errors, "processing", () => processPendingEvents({ limit: 20_000, deadline: started + PROCESSING_BUDGET_MS }));
  const processed = processing?.processed ?? 0;
  const failed = processing?.failed ?? 0;
  // Background re-map of past events and growth-state rebuilds, in small chunks while time is left.
  const reprocess = Date.now() < started + REPROCESS_BUDGET_MS ? await step(errors, "reprocess", () => runReprocessJobs({ deadline: started + REPROCESS_BUDGET_MS })) : null;
  const purged = {
    rate_limit_buckets: await step(errors, "purge_rate_limits", () => purgeRateLimitBuckets()),
    ...(await step(errors, "purge_operational", () => purgeOperationalData())),
    // Stored files of media deleted over a week ago that nothing references.
    media: await step(errors, "purge_media", () => purgeDeletedMedia({ limit: 100 })),
  };
  const retention = await step(errors, "retention", () => applyEventRetention());
  // Plan usage emails (80% / 100% / refusing), once per threshold per month.
  const usageNotices = Date.now() - started < LATE_STEPS_BUDGET_MS ? await step(errors, "usage_notices", () => sendUsageNotices({ limit: 100 })) : { notices: 0, emails: 0, skipped: true };
  // Attribution postbacks and click fingerprint cleanup, only while time is left.
  const attribution = Date.now() < started + ATTRIBUTION_BUDGET_MS ? await step(errors, "attribution", () => runAttributionJobs({ deadline: started + ATTRIBUTION_BUDGET_MS })) : null;
  // Ad reporting and cost import from connected ad accounts (Integrations Center), only while time is left.
  const adSync = Date.now() < started + AD_SYNC_START_MS
    ? await step(errors, "ad_sync", () => runAdSyncJobs({ deadline: started + ATTRIBUTION_BUDGET_MS, limit: 5, http: { timeoutMs: 8_000 } }))
    : null;
  // Engagement: audiences, automation triggers and steps, webhook deliveries, only while time is left.
  const engagement = Date.now() < started + ENGAGEMENT_BUDGET_MS ? await step(errors, "engagement", () => runEngagement({ deadline: started + ENGAGEMENT_BUDGET_MS })) : { skipped: "time budget" };
  // The public demo's sample data, re-sent a few times a day so its reports stay current.
  // Not a failing step: a demo refresh failure is reported but does not turn the run into a 500.
  let demo: string | null = null;
  if (demoEnabled() && Date.now() < started + LATE_STEPS_BUDGET_MS) {
    demo = await ensureDemo({ staleHours: 6, deadline: started + LATE_STEPS_BUDGET_MS + 5_000 }).then(
      () => "ok",
      async (e) => {
        log.error("demo.refresh_failed", { error: e });
        await captureException(e, { source: "worker:demo", route: ROUTE, title: 'Worker step "demo" failed', details: { step: "demo" } });
        return "failed";
      },
    );
  }
  const summary = {
    processed,
    failed,
    deletions,
    reprocess,
    purged,
    retention: retention ? { mode: retention.mode, organizations: retention.organizations.length } : null,
    usage_notices: usageNotices,
    attribution,
    ad_sync: adSync,
    engagement,
    demo,
    errors,
  };
  if (errors.length) log.error("cron.completed_with_errors", summary);
  else log.info("cron.completed", summary);
  // Heartbeat checks after the response: stale backlog, ingestion 5xx rate, pg_cron history. Alerts are throttled.
  after(async () => {
    if (failed > 0) {
      await report({ key: "worker:events_failed", severity: "warning", title: "Events failed processing permanently in a worker run", source: "worker", route: ROUTE, details: { failed, processed } });
    }
    await checkWorkerHealth()
      .then(alertOnProblems)
      .catch((e) => log.error("worker_health.failed", { error: e }));
  });
  return Response.json(
    { processed, failed, deletions, reprocess, purged, retention, usage_notices: usageNotices, attribution, engagement, demo, errors },
    { status: errors.length ? 500 : 200 },
  );
}
