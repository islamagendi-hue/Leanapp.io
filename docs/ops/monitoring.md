# Monitoring and alerts

Status: **built in code, not yet connected to a provider.** No alert has been
sent from a deployment yet, and the production schedule has not been verified
against the production database (see [Scheduler verification](#scheduler-verification)).

LeanApp has no vendor SDK for monitoring. A small module,
`apps/platform/src/lib/monitoring.ts`, reports server errors and worker
problems to whichever destinations are configured, over plain HTTP. With no
destination set, every report is still one structured log line
(`"event":"monitoring.report"`) that a Vercel log drain or log search can alert on.

## Destinations (environment variables)

Set per environment in Vercel (Production and Preview separately). All are
optional and documented in `apps/platform/.env.example`.

| Variable | What it does |
| --- | --- |
| `ALERT_WEBHOOK_URL` | Incoming webhook for alerts. The JSON body has both `text` (Slack) and `content` (Discord), so either works. The URL is a credential: it is never logged. |
| `SENTRY_DSN` | Sends the same reports to a Sentry project through its envelope endpoint (`https://<host>/api/<project>/envelope/`). Only `https://` DSNs are accepted. Checked in unit tests with a mocked `fetch`; **not yet tried against a live Sentry project.** |
| `MONITORING_SECRET` | Read-only Bearer secret for `GET /api/internal/worker-status`, so an uptime monitor never needs `CRON_SECRET` (which can also start the worker). `CRON_SECRET` is accepted there too. |

## What is reported

| Source | When | Where in code |
| --- | --- | --- |
| `request:render` / `request:route` / `request:action` / `request:proxy` | Any unhandled server error in a page, route handler, server action or the proxy | `onRequestError` in `src/instrumentation.ts` |
| `api` | An unexpected (non-`AppError`) error turned into a 500 by `apiError()` (management and dashboard APIs) | `src/server/api.ts` |
| `http` | Each 5xx response from `POST /v1/events` and `POST /v1/events/batch`, reported at the route file after ingestion returns. Ingestion code is unchanged; the error itself is already logged by ingestion as `ingest.failed`. | `src/app/v1/events/route.ts`, `src/app/v1/events/batch/route.ts` |
| `worker:<step>` | A step of `/api/internal/process-events` throws (deletions, processing, reprocess, purge, retention, usage notices, attribution, engagement) or the demo refresh fails | `step()` in `src/app/api/internal/process-events/route.ts` |
| `worker` | The worker refuses to run because configuration is invalid (variable names only); events failed processing permanently in a run (warning, with counts) | same route |
| `worker-health` | Stale backlog, elevated ingestion 5xx rate, stopped scheduler, scheduler call not returning 200 (see below) | `src/server/worker-health.ts` |

The worker's steps are isolated by `step()`: a step that throws is reported
(`worker:<step>`), logged as `cron.step_failed`, and recorded in the response's
`errors` list as `{ "step": "<name>", "error_name": "<error class>" }` (the class
name only, never the message), and the remaining steps still run, each within
its usual time budget. When any step failed the route answers **HTTP 500** with
the full JSON summary (and logs `cron.completed_with_errors` instead of
`cron.completed`), so pg_net records a non-200 status, the heartbeat raises
`scheduler_http_error`, and the smoke test (`scripts/smoke.ts`) fails its worker check. A failed step
yields `null` in its response field (`processed`/`failed` are 0 when processing
failed). The demo refresh is the exception: it is reported as `worker:demo` and
shows `"demo": "failed"`, but does not make the run a 500.

Not reported: 4xx errors (`AppError` subclasses), Next's control-flow signals
(`notFound()`, `redirect()`), and errors swallowed and logged inside modules
(for example `processing.failed` in the ingestion `after()` hook).

### What a report contains, and what it never contains

A report carries: environment (`VERCEL_ENV`), commit (`VERCEL_GIT_COMMIT_SHA`,
12 characters), source, route **template** (for example
`GET /o/[org]/apps/[app]`, never the concrete URL), error name, scrubbed
message (300 characters at most), Next's error `digest`, a Postgres error code
when there is one, and a few counts chosen by the caller.

It never carries request headers, cookies, query strings, request or event
bodies, or user properties. Every string passes `scrub()`, which removes
credentials in URLs, query strings, Bearer/Basic tokens, LeanApp keys
(`la_sk_…`, `la_pk_…`), Stripe/Resend keys and webhook secrets, JWTs,
`password=`/`token=`-style pairs, emails, IPv4 addresses, phone numbers and
long opaque strings (including UUIDs). Unit tests in
`src/lib/monitoring.test.ts` and `src/instrumentation.test.ts` check this.

### Throttling

Per server instance, in memory:

- one report per dedupe key per 10 minutes (the key is source + route + error
  name + message, or a fixed key per worker problem); repeats are counted and
  the next report says how many were suppressed;
- at most 10 reports per 10 minutes in total, whatever the keys.

Serverless runs many instances, so a widespread failure can produce one alert
per warm instance per window. Webhook delivery times out after 3 seconds and
never throws; a failed delivery is logged as `monitoring.delivery_failed`
(destination type and status only).

## Worker heartbeat and stale-worker check

`src/server/worker-health.ts` reads data the app already has. No new table, no
queue, no migration.

| Signal | Query | Problem when |
| --- | --- | --- |
| Oldest unprocessed event age | `platform.events where processed_at is null order by id limit 1` (partial index `events_unprocessed_idx`) | older than **15 minutes** → `backlog_stale` |
| Unprocessed count | same index, counted up to 10,000 | reported only |
| Ingestion 5xx rate | `platform.api_request_logs`, routes `/v1/events` and `/v1/events/batch`, last **15 minutes** | **≥ 5** server errors **and ≥ 5 %** of requests → `ingestion_5xx_rate` |
| Last pg_cron run | `cron.job_run_details` for job `leanapp-process-events` (only where pg_cron exists) | no run in **20 minutes**, or the job is missing → `scheduler_stale` |
| Last pg_net response | `net._http_response`, latest row (every pg_net call in this database is the worker call) | not HTTP 200 → `scheduler_http_error` |

Where it runs:

1. **After every worker run** (`after()` in `/api/internal/process-events`):
   alerts on any problem. This catches a worker that runs but falls behind,
   and ingestion 5xx rates. It cannot catch a worker that never runs.
2. **`GET /api/internal/worker-status`** with `Authorization: Bearer <MONITORING_SECRET>`:
   returns the numbers above as JSON, **200 when healthy, 503 when degraded**
   (and sends the same throttled alerts). Point an external uptime monitor at
   it every 5 minutes: that is what detects a scheduler that stopped.
   Aggregates only; no organization, environment, event or configuration data.
   Without the secret it answers 401.

Limits, stated plainly:

- The 5xx **rate** counts only requests that reached `api_request_logs`:
  ingestion writes that row after authenticating the key. Requests that fail
  before that (for example the database is down during the key lookup) are not
  in the table; they are reported one by one by `onRequestError` or the route
  boundary, throttled, instead.
- With an empty `ALERT_WEBHOOK_URL` and `SENTRY_DSN`, nothing pages anyone:
  problems are only in the logs and the 503 of `worker-status`.
- The heartbeat in step 1 runs inside the worker. If pg_cron stops, only the
  external uptime check (step 2) notices.

## Scheduler (what the repository defines)

- `apps/platform/db/ops/schedule.sql` creates or updates the pg_cron job
  **`leanapp-process-events`** with the schedule passed as the psql variable
  `schedule`. The job runs `net.http_get` (pg_net) against
  `<app_url>/api/internal/process-events` with `Authorization: Bearer` read
  from Vault secret `leanapp_cron_secret` at run time (plus an optional
  `x-vercel-protection-bypass` from Vault secret `leanapp_protection_bypass`),
  timeout 60 s. It also creates **`leanapp-cron-history-cleanup`** (`17 3 * * *`)
  which deletes `cron.job_run_details` older than 7 days. It is idempotent.
- `.github/workflows/deploy.yml` applies it after the migrations on every
  deploy, with `schedule` = the GitHub environment **variable**
  `WORKER_SCHEDULE`. The 5-minute production cadence therefore depends on
  `WORKER_SCHEDULE` being set to `*/5 * * * *` in the `production` GitHub
  environment; the repository documents that value but cannot enforce it (the
  workflow only refuses an empty value).
- `apps/platform/vercel.json` adds a Vercel Cron at `0 3 * * *` (once a day) as
  a safety net only.
- The deploy smoke test (`scripts/smoke.ts`) checks the job exists, is active,
  and that the latest pg_net response was 200.

## Scheduler verification

Not verified for production from this repository. Evidence to collect, on the
**production** database (Supabase SQL editor, read-only queries):

```sql
-- 1. The job exists, is active, and has the production schedule.
select jobid, jobname, schedule, command, active from cron.job;
-- expect leanapp-process-events | */5 * * * * | active = t
-- (the command shows the URL and a Vault lookup, never the secret itself)

-- 2. It actually ran recently, every 5 minutes, and succeeded.
select d.runid, d.status, d.return_message, d.start_time, d.end_time
  from cron.job_run_details d join cron.job j using (jobid)
 where j.jobname = 'leanapp-process-events'
 order by d.start_time desc limit 12;
-- expect status = succeeded and start_time about 5 minutes apart, the latest within 5 minutes

-- 3. The HTTP calls returned 200 (pg_cron "succeeded" only means the request was queued).
select id, status_code, error_msg, created from net._http_response order by created desc limit 12;
```

Also: the GitHub `production` environment variable `WORKER_SCHEDULE` is
`*/5 * * * *`; the last Deploy run's "Install or update the scheduled worker"
step succeeded; Vercel logs show `cron.completed` about every 5 minutes; and
`GET /api/internal/worker-status` returns 200 with a `scheduler.last_run_age_seconds`
under 300.

## Owner actions

1. Create the alert destination: a Slack or Discord channel with an incoming
   webhook (one per environment, or one shared channel; the message names the
   environment). Set `ALERT_WEBHOOK_URL` in Vercel for Production and Preview.
2. Optional: create a Sentry project and set `SENTRY_DSN`; trigger a test error
   on staging and confirm the event arrives (the envelope format is unverified
   against a live project).
3. Generate `MONITORING_SECRET` (`openssl rand -base64 32`, different per
   environment), set it in Vercel, and configure an uptime monitor (any
   provider that can send a header) for
   `GET https://app.leanapp.io/api/internal/worker-status` with
   `Authorization: Bearer <MONITORING_SECRET>`, every 5 minutes, alerting on
   any non-200. Also monitor `GET https://api.leanapp.io/v1/health`.
4. Optional, provider-side: a log-based alert on `"event":"monitoring.report"`
   or `"event":"ingest.failed"` in a Vercel log drain, if you want rates across
   all instances rather than the per-instance throttle.
5. Run the [verification queries](#scheduler-verification) on production after
   the first production deploy and keep the output as evidence.
