import { log } from "@/lib/log";
import { captureException } from "@/lib/monitoring";
import { bearerMatches } from "@/server/internal-auth";
import { alertOnProblems, checkWorkerHealth } from "@/server/worker-health";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 15;

/**
 * Worker heartbeat for an uptime monitor (docs/ops/monitoring.md): oldest
 * unprocessed event age, backlog size, ingestion 5xx count over the last 15
 * minutes, and the pg_cron job's last run where the database has pg_cron.
 * 200 when healthy, 503 when degraded (and a throttled alert is sent), so a
 * plain HTTP check can page on it. Bearer MONITORING_SECRET (read-only) or
 * CRON_SECRET. Aggregates only: no tenant, environment or event data.
 */
export async function GET(req: Request) {
  if (!bearerMatches(req, process.env.MONITORING_SECRET, process.env.CRON_SECRET)) return new Response("Unauthorized", { status: 401 });
  try {
    const health = await checkWorkerHealth();
    if (health.problems.length) {
      log.warn("worker_health.degraded", { problems: health.problems });
      await alertOnProblems(health);
    }
    return Response.json(health, { status: health.status === "ok" ? 200 : 503, headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    log.error("worker_health.failed", { error: e });
    await captureException(e, { source: "worker-health", route: "GET /api/internal/worker-status" });
    return Response.json({ status: "unknown", error: "check_failed" }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}
