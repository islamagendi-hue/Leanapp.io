-- 0022: analytics foundation.
-- Reports and Activation read counted events (track and screen, processed) of one
-- environment by event time; this index matches that shape. Skips protocol calls.
create index if not exists events_env_ts_counted_idx on platform.events (environment_id, "timestamp")
  where type in ('track', 'screen');

-- Activation now uses the Retention report's rule (returned on calendar day N in the
-- app's timezone, not on or after it), so growth state is rebuilt for every app
-- that has the growth model on. Adds jobs only; an active job is left as it is.
insert into platform.app_reprocess_jobs (organization_id, app_id, environment_id, kind, reason)
select e.organization_id, e.app_id, e.id, 'growth_rebuild', 'retention rule unified with analytics'
  from platform.environments e
  join platform.apps a on a.id = e.app_id
 where (a.features->>'growth_model')::boolean is true
on conflict (environment_id, kind) where status in ('queued', 'running') do nothing;
