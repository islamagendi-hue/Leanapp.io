/**
 * Post-deploy smoke test, run by .github/workflows/deploy.yml (never needs a laptop).
 *
 *   APP_URL=https://app.leanapp.io CRON_SECRET=... npm run smoke
 *
 * Checks, in order:
 *   1. GET /v1/health returns 200 (waits for the deployment of EXPECT_SHA when set).
 *   2. When SMOKE_SDK_KEY is set: a test event sent to /v1/events is processed
 *      (read back through DATABASE_URL).
 *   3. The scheduled worker endpoint answers an authorized call with 200.
 *   4. When DATABASE_URL is set: the pg_cron job exists and is active, and the
 *      last scheduled call (if one ran yet) got HTTP 200.
 *
 * Optional env: EXPECT_SHA, SMOKE_SDK_KEY (a development-environment key of an
 * internal "LeanApp smoke" app), DATABASE_URL, DATABASE_SSL, VERCEL_BYPASS
 * (protection bypass secret for a protected preview/staging deployment),
 * SMOKE_WAIT_SECONDS (default 600).
 */
import { randomUUID } from "node:crypto";
import pg from "pg";

const env = process.env;
const failures: string[] = [];
const notes: string[] = [];

function headers(extra: Record<string, string> = {}): Record<string, string> {
  return { ...(env.VERCEL_BYPASS ? { "x-vercel-protection-bypass": env.VERCEL_BYPASS } : {}), ...extra };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function health(base: string): Promise<void> {
  const deadline = Date.now() + Number(env.SMOKE_WAIT_SECONDS ?? 600) * 1000;
  let last = "";
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${base}/v1/health`, { headers: headers(), cache: "no-store" });
      const body = (await res.json().catch(() => ({}))) as { status?: string; version?: string | null; config?: { errors?: string[] } };
      last = `HTTP ${res.status} ${JSON.stringify(body)}`;
      const versionOk = !env.EXPECT_SHA || body.version === env.EXPECT_SHA;
      if (res.status === 200 && versionOk) {
        notes.push(`health ok (version ${body.version ?? "unknown"})`);
        return;
      }
      // A deployed config error will not fix itself by waiting.
      if (res.status === 503 && versionOk) break;
    } catch (err) {
      last = (err as Error).message;
    }
    await sleep(10_000);
  }
  failures.push(`health: ${last || "no answer"}`);
}

async function testEvent(base: string, db: pg.Client | null): Promise<void> {
  if (!env.SMOKE_SDK_KEY) {
    notes.push("test event skipped (SMOKE_SDK_KEY not set)");
    return;
  }
  const eventId = `smoke-${randomUUID()}`;
  const res = await fetch(`${base}/v1/events`, {
    method: "POST",
    headers: headers({ Authorization: `Bearer ${env.SMOKE_SDK_KEY}`, "Content-Type": "application/json" }),
    body: JSON.stringify({ type: "track", event_name: "smoke_test", event_id: eventId, anonymous_id: "smoke-runner", properties: { source: "deploy-smoke" } }),
  });
  if (res.status !== 200) {
    failures.push(`test event: HTTP ${res.status} ${await res.text()}`);
    return;
  }
  if (!db) {
    notes.push("test event accepted (not read back: DATABASE_URL not set)");
    return;
  }
  for (let i = 0; i < 12; i++) {
    const { rows } = await db.query<{ processed_at: Date | null; processing_error: string | null }>(
      "select processed_at, processing_error from platform.events where event_id = $1",
      [eventId],
    );
    if (rows[0]?.processing_error) {
      failures.push(`test event: processing error ${rows[0].processing_error}`);
      return;
    }
    if (rows[0]?.processed_at) {
      notes.push("test event processed");
      return;
    }
    await sleep(5_000);
  }
  failures.push("test event: stored but not processed within 60s");
}

async function worker(base: string): Promise<void> {
  if (!env.CRON_SECRET) {
    failures.push("worker: CRON_SECRET not set");
    return;
  }
  const res = await fetch(`${base}/api/internal/process-events`, { headers: headers({ Authorization: `Bearer ${env.CRON_SECRET}` }) });
  if (res.status === 200) notes.push("worker endpoint ok");
  else failures.push(`worker: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`);
}

async function scheduler(db: pg.Client): Promise<void> {
  const job = await db.query("select active, schedule from cron.job where jobname = 'leanapp-process-events'").catch(() => null);
  if (!job?.rows[0]) {
    failures.push("scheduler: pg_cron job leanapp-process-events missing");
    return;
  }
  if (!job.rows[0].active) failures.push("scheduler: pg_cron job is not active");
  // pg_net keeps responses for a few hours; every pg_net call in this database is the worker call.
  const last = await db
    .query<{ status_code: number | null; error_msg: string | null; created: Date }>(
      "select status_code, error_msg, created from net._http_response order by created desc limit 1",
    )
    .catch(() => null);
  const row = last?.rows[0];
  if (!row) notes.push(`scheduler: job active (${job.rows[0].schedule}), no run recorded yet`);
  else if (row.status_code === 200) notes.push(`scheduler: last run ${row.created.toISOString()} HTTP 200`);
  else failures.push(`scheduler: last run ${row.created.toISOString()} ${row.status_code ?? row.error_msg}`);
}

async function main() {
  const base = (env.APP_URL ?? "").replace(/\/$/, "");
  if (!base) {
    console.error("APP_URL is required");
    process.exit(1);
  }
  let db: pg.Client | null = null;
  if (env.DATABASE_URL) {
    db = new pg.Client({ connectionString: env.DATABASE_URL, ssl: env.DATABASE_SSL === "require" ? { rejectUnauthorized: false } : undefined });
    await db.connect();
  }
  try {
    await health(base);
    if (!failures.length) {
      await testEvent(base, db);
      await worker(base);
      if (db) await scheduler(db);
    }
  } finally {
    await db?.end();
  }
  for (const n of notes) console.log(`ok   ${n}`);
  for (const f of failures) console.log(`FAIL ${f}`);
  process.exit(failures.length ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
