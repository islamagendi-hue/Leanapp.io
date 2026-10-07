-- Scheduled worker for a hosted LeanApp database (Supabase: pg_cron + pg_net + Vault).
--
-- Calls the app's /api/internal/process-events endpoint on a schedule, with
-- CRON_SECRET as a Bearer token read from Vault at call time (never stored in
-- the job text). Idempotent: running it again updates the secret, URL and
-- schedule in place. It is run by .github/workflows/deploy.yml after the
-- migrations, never by hand from a laptop.
--
-- psql variables (all required except bypass):
--   app_url    e.g. https://app.leanapp.io (no trailing slash)
--   secret     the deployment's CRON_SECRET
--   schedule   cron expression: '*/5 * * * *' production, '*/15 * * * *' staging
--   bypass     Vercel "Protection Bypass for Automation" secret, for a protected
--              preview (staging) deployment; '' when the URL is public
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -v app_url=... -v secret=... \
--        -v schedule='*/5 * * * *' -v bypass= -f db/ops/schedule.sql

\set ON_ERROR_STOP 1

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- Secrets live in Vault (encrypted at rest); the job decrypts them when it runs.
select vault.update_secret(id, :'secret') from vault.secrets where name = 'leanapp_cron_secret';
select vault.create_secret(:'secret', 'leanapp_cron_secret', 'CRON_SECRET for /api/internal/process-events')
 where not exists (select 1 from vault.secrets where name = 'leanapp_cron_secret');
select vault.update_secret(id, :'bypass') from vault.secrets where name = 'leanapp_protection_bypass';
select vault.create_secret(:'bypass', 'leanapp_protection_bypass', 'Vercel protection bypass for automation (may be empty)')
 where not exists (select 1 from vault.secrets where name = 'leanapp_protection_bypass');

-- cron.schedule with a job name replaces an existing job of that name.
-- The request is asynchronous (pg_net); the endpoint itself is time-boxed to 60s.
select cron.schedule(
  'leanapp-process-events',
  :'schedule',
  format(
    $job$select net.http_get(
      url := %L,
      headers := jsonb_strip_nulls(jsonb_build_object(
        'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'leanapp_cron_secret'),
        'x-vercel-protection-bypass', nullif((select decrypted_secret from vault.decrypted_secrets where name = 'leanapp_protection_bypass'), '')
      )),
      timeout_milliseconds := 60000
    )$job$,
    rtrim(:'app_url', '/') || '/api/internal/process-events'
  )
);

-- Keep pg_cron's own run history from growing without bound (one week kept).
select cron.schedule(
  'leanapp-cron-history-cleanup',
  '17 3 * * *',
  $job$delete from cron.job_run_details where end_time < now() - interval '7 days'$job$
);

select jobname, schedule, active from cron.job where jobname like 'leanapp-%' order by jobname;
