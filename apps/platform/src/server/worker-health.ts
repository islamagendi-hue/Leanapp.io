import "server-only";
import { withSystem } from "@/lib/db";
import { report } from "@/lib/monitoring";

/**
 * Worker heartbeat and ingestion error rate, from data the app already keeps
 * (no extra table): the oldest unprocessed event (platform.events), ingestion
 * responses (platform.api_request_logs), and, where the database has them,
 * pg_cron's run history and pg_net's last response. Aggregates across all
 * tenants only: no organization, environment or event data leaves here.
 * See docs/ops/monitoring.md.
 */

/** The worker is stale when the oldest unprocessed event waited longer than this. */
export const BACKLOG_STALE_SECONDS = 15 * 60;
/** pg_cron runs every 5 (production) or 15 (staging) minutes; older than this means it stopped. */
export const SCHEDULER_STALE_SECONDS = 20 * 60;
/** Ingestion 5xx window and thresholds: at least this many 5xx and at least this share of requests. */
export const INGEST_WINDOW_MINUTES = 15;
export const INGEST_5XX_MIN_COUNT = 5;
export const INGEST_5XX_MIN_RATE = 0.05;
const BACKLOG_COUNT_CAP = 10_000;

export interface WorkerSignals {
  oldestUnprocessedAgeSeconds: number | null;
  unprocessed: number;
  ingestRequests: number;
  ingest5xx: number;
  /** null when pg_cron isn't installed or readable (local development). */
  scheduler: { lastRunAgeSeconds: number | null; lastRunStatus: string | null; lastHttpStatus: number | null; lastHttpError: boolean } | null;
}

export type Problem = "backlog_stale" | "ingestion_5xx_rate" | "scheduler_stale" | "scheduler_http_error";

export interface WorkerHealth {
  status: "ok" | "degraded";
  problems: Problem[];
  backlog: { oldest_unprocessed_age_seconds: number | null; unprocessed: number; unprocessed_capped: boolean; stale_after_seconds: number };
  ingestion: { window_minutes: number; requests: number; server_errors: number };
  scheduler: { last_run_age_seconds: number | null; last_run_status: string | null; last_http_status: number | null } | null;
}

/** Pure: turns raw signals into problems (unit-tested). */
export function evaluate(s: WorkerSignals): WorkerHealth {
  const problems: Problem[] = [];
  if (s.oldestUnprocessedAgeSeconds !== null && s.oldestUnprocessedAgeSeconds > BACKLOG_STALE_SECONDS) problems.push("backlog_stale");
  if (s.ingest5xx >= INGEST_5XX_MIN_COUNT && s.ingestRequests > 0 && s.ingest5xx / s.ingestRequests >= INGEST_5XX_MIN_RATE) problems.push("ingestion_5xx_rate");
  if (s.scheduler) {
    if (s.scheduler.lastRunAgeSeconds === null || s.scheduler.lastRunAgeSeconds > SCHEDULER_STALE_SECONDS) problems.push("scheduler_stale");
    if (s.scheduler.lastHttpError || (s.scheduler.lastHttpStatus !== null && s.scheduler.lastHttpStatus !== 200)) problems.push("scheduler_http_error");
  }
  return {
    status: problems.length ? "degraded" : "ok",
    problems,
    backlog: {
      oldest_unprocessed_age_seconds: s.oldestUnprocessedAgeSeconds,
      unprocessed: Math.min(s.unprocessed, BACKLOG_COUNT_CAP),
      unprocessed_capped: s.unprocessed >= BACKLOG_COUNT_CAP,
      stale_after_seconds: BACKLOG_STALE_SECONDS,
    },
    ingestion: { window_minutes: INGEST_WINDOW_MINUTES, requests: s.ingestRequests, server_errors: s.ingest5xx },
    scheduler: s.scheduler
      ? { last_run_age_seconds: s.scheduler.lastRunAgeSeconds, last_run_status: s.scheduler.lastRunStatus, last_http_status: s.scheduler.lastHttpStatus }
      : null,
  };
}

/** pg_cron / pg_net exist only on the hosted database; each probe runs in its own transaction so a refusal can't abort the others. */
async function schedulerSignals(): Promise<WorkerSignals["scheduler"]> {
  const present = await withSystem((db) =>
    db.one<{ cron: boolean; net: boolean }>("select to_regclass('cron.job_run_details') is not null as cron, to_regclass('net._http_response') is not null as net"),
  ).catch(() => null);
  if (!present?.cron) return null;
  const run = await withSystem((db) =>
    db.one<{ age: number | null; status: string | null; jobs: number }>(
      `select (select count(*)::int from cron.job where jobname = 'leanapp-process-events') as jobs,
              extract(epoch from now() - d.start_time)::int as age, d.status
         from (select 1) one
         left join lateral (
           select r.start_time, r.status from cron.job_run_details r join cron.job j on j.jobid = r.jobid
            where j.jobname = 'leanapp-process-events' order by r.runid desc limit 1) d on true`,
    ),
  ).catch(() => null);
  if (!run || run.jobs === 0) return run ? { lastRunAgeSeconds: null, lastRunStatus: "job_missing", lastHttpStatus: null, lastHttpError: false } : null;
  // Every pg_net call in this database is the worker call (db/ops/schedule.sql); the response table keeps a few hours.
  const http = present.net
    ? await withSystem((db) =>
        db.one<{ status_code: number | null; failed: boolean }>(
          "select status_code, (status_code is null and error_msg is not null) as failed from net._http_response order by created desc limit 1",
        ),
      ).catch(() => null)
    : null;
  return { lastRunAgeSeconds: run.age, lastRunStatus: run.status, lastHttpStatus: http?.status_code ?? null, lastHttpError: http?.failed ?? false };
}

export async function collectSignals(): Promise<WorkerSignals> {
  const [backlog, ingest] = await Promise.all([
    withSystem(async (db) => {
      // Both use the partial index events_unprocessed_idx; the count stops at the cap.
      const oldest = await db.one<{ age: number }>(
        "select greatest(0, extract(epoch from now() - received_at))::int as age from platform.events where processed_at is null order by id limit 1",
      );
      const count = await db.one<{ n: number }>(`select count(*)::int as n from (select 1 from platform.events where processed_at is null limit ${BACKLOG_COUNT_CAP}) t`);
      return { age: oldest?.age ?? null, count: count?.n ?? 0 };
    }),
    withSystem((db) =>
      db.one<{ requests: number; errors: number }>(
        `select count(*)::int as requests, count(*) filter (where status_code >= 500)::int as errors
           from platform.api_request_logs
          where created_at > now() - make_interval(mins => $1) and route in ('/v1/events', '/v1/events/batch')`,
        [INGEST_WINDOW_MINUTES],
      ),
    ),
  ]);
  return {
    oldestUnprocessedAgeSeconds: backlog.age,
    unprocessed: backlog.count,
    ingestRequests: ingest?.requests ?? 0,
    ingest5xx: ingest?.errors ?? 0,
    scheduler: await schedulerSignals(),
  };
}

export async function checkWorkerHealth(): Promise<WorkerHealth> {
  return evaluate(await collectSignals());
}

const TITLES: Record<Problem, string> = {
  backlog_stale: "Event processing is behind: the oldest unprocessed event is older than the threshold",
  ingestion_5xx_rate: "Elevated ingestion 5xx rate on /v1/events",
  scheduler_stale: "Scheduled worker (pg_cron leanapp-process-events) has not run recently",
  scheduler_http_error: "Scheduled worker call did not return HTTP 200",
};

/** Sends one (throttled) alert per problem. Never throws. */
export async function alertOnProblems(h: WorkerHealth): Promise<void> {
  await Promise.all(
    h.problems.map((p) =>
      report({
        key: `worker-health:${p}`,
        severity: "error",
        title: TITLES[p],
        source: "worker-health",
        details:
          p === "ingestion_5xx_rate"
            ? { window_minutes: h.ingestion.window_minutes, requests: h.ingestion.requests, server_errors: h.ingestion.server_errors }
            : p === "backlog_stale"
              ? { oldest_unprocessed_age_seconds: h.backlog.oldest_unprocessed_age_seconds, unprocessed: h.backlog.unprocessed, threshold_seconds: h.backlog.stale_after_seconds }
              : { last_run_age_seconds: h.scheduler?.last_run_age_seconds ?? null, last_run_status: h.scheduler?.last_run_status ?? null, last_http_status: h.scheduler?.last_http_status ?? null },
      }),
    ),
  );
}
