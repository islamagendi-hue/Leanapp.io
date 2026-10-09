/**
 * Worker heartbeat signals (src/server/worker-health.ts) against a real,
 * migrated schema: the oldest unprocessed event, the ingestion 5xx window from
 * api_request_logs, and pg_cron / pg_net history through small stubs with the
 * same columns (the CI Postgres image has neither extension).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withSystem } from "@/lib/db";
import { ingest } from "@/modules/ingestion/service";
import { authenticateIngestionKey } from "@/modules/credentials/service";
import { processPendingEvents } from "@/modules/processing/processor";
import { BACKLOG_STALE_SECONDS, checkWorkerHealth, collectSignals } from "@/server/worker-health";
import { makeTenant } from "./helpers";

type T = Awaited<ReturnType<typeof makeTenant>>;
let t: T;

// The stubs replace the cron / net schemas, so never run where the real extensions are installed.
let realExtensions = false;
const dropStubs = () => withSystem((db) => db.query("drop schema if exists cron cascade; drop schema if exists net cascade"));

beforeAll(async () => {
  t = await makeTenant("worker-health");
  realExtensions = !!(await withSystem((db) => db.one("select 1 from pg_extension where extname in ('pg_cron', 'pg_net') limit 1")));
  if (!realExtensions) await dropStubs();
});

afterAll(async () => {
  if (!realExtensions) await dropStubs();
});

describe("worker health signals", () => {
  it("reads an empty backlog and no scheduler on a plain database", async (ctx) => {
    if (realExtensions) ctx.skip();
    await processPendingEvents({ limit: 10_000 });
    const s = await collectSignals();
    expect(s.oldestUnprocessedAgeSeconds).toBeNull();
    expect(s.unprocessed).toBe(0);
    expect(s.scheduler).toBeNull();
  });

  it("flags an unprocessed event older than the threshold, and clears once processed", async () => {
    const sdk = (await authenticateIngestionKey(t.sdkKey))!;
    const res = await ingest(sdk, { type: "track", event_name: "stale_probe", event_id: crypto.randomUUID(), anonymous_id: "a1" }, { mode: "single" });
    expect(res.status).toBeLessThan(300);
    await withSystem((db) =>
      db.query("update platform.events set received_at = now() - make_interval(secs => $1) where event_name = 'stale_probe'", [BACKLOG_STALE_SECONDS + 60]),
    );
    const stale = await checkWorkerHealth();
    expect(stale.problems).toContain("backlog_stale");
    expect(stale.backlog.unprocessed).toBe(1);
    expect(stale.backlog.oldest_unprocessed_age_seconds).toBeGreaterThan(BACKLOG_STALE_SECONDS);

    await processPendingEvents({ limit: 10_000 });
    expect((await checkWorkerHealth()).problems).not.toContain("backlog_stale");
  });

  it("counts ingestion 5xx in the window from api_request_logs only", async () => {
    const insert = (route: string, status: number, ageMinutes = 1) =>
      withSystem((db) =>
        db.query(
          "insert into platform.api_request_logs (organization_id, environment_id, route, status_code, duration_ms, credential_kind, created_at) values ($1, $2, $3, $4, 5, 'sdk', now() - make_interval(mins => $5))",
          [t.org.id, t.dev.id, route, status, ageMinutes],
        ),
      );
    for (let i = 0; i < 20; i++) await insert("/v1/events", 200);
    for (let i = 0; i < 6; i++) await insert(i % 2 ? "/v1/events" : "/v1/events/batch", 500);
    await insert("/v1/events", 500, 60); // outside the window
    await insert("GET /v1/users", 500); // not ingestion
    const h = await checkWorkerHealth();
    expect(h.ingestion).toEqual({ window_minutes: 15, requests: 26, server_errors: 6 });
    expect(h.problems).toContain("ingestion_5xx_rate");
  });

  it("reads pg_cron and pg_net history where they exist", async (ctx) => {
    if (realExtensions) ctx.skip();
    await withSystem((db) =>
      db.query(`
        create schema cron; create schema net;
        create table cron.job (jobid bigserial primary key, jobname text unique, schedule text, command text, active boolean default true);
        create table cron.job_run_details (runid bigserial primary key, jobid bigint, status text, return_message text, start_time timestamptz, end_time timestamptz);
        create table net._http_response (id bigserial primary key, status_code int, content text, error_msg text, created timestamptz not null default now());
      `),
    );
    let s = await collectSignals();
    expect(s.scheduler).toMatchObject({ lastRunAgeSeconds: null, lastRunStatus: "job_missing" });

    await withSystem((db) =>
      db.query(`
        insert into cron.job (jobname, schedule, command) values ('leanapp-process-events', '*/5 * * * *', 'select 1');
        insert into cron.job_run_details (jobid, status, start_time, end_time)
          select jobid, 'succeeded', now() - interval '40 minutes', now() - interval '40 minutes' from cron.job;
        insert into cron.job_run_details (jobid, status, start_time, end_time)
          select jobid, 'succeeded', now() - interval '3 minutes', now() - interval '3 minutes' from cron.job;
        insert into net._http_response (status_code, created) values (200, now() - interval '3 minutes');
      `),
    );
    s = await collectSignals();
    expect(s.scheduler).toMatchObject({ lastRunStatus: "succeeded", lastHttpStatus: 200, lastHttpError: false });
    expect(s.scheduler!.lastRunAgeSeconds).toBeGreaterThanOrEqual(170);
    expect(s.scheduler!.lastRunAgeSeconds).toBeLessThan(400);
    let h = await checkWorkerHealth();
    expect(h.problems).not.toContain("scheduler_stale");
    expect(h.problems).not.toContain("scheduler_http_error");

    await withSystem((db) => db.query("insert into net._http_response (status_code, created) values (401, now())"));
    h = await checkWorkerHealth();
    expect(h.problems).toContain("scheduler_http_error");
  });
});
