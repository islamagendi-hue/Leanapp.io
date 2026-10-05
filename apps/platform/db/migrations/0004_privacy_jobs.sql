-- End-user data deletion runs as a job so a large deletion can't time out a
-- request, and a crashed run is picked up again by the scheduled worker.
alter table platform.data_deletion_jobs
  add column attempts   int not null default 0,
  add column started_at timestamptz,
  add column details    jsonb not null default '{}';   -- rows deleted per table

create index data_deletion_jobs_pending_idx on platform.data_deletion_jobs (created_at) where status in ('queued', 'running');
create index privacy_requests_env_created_idx on platform.privacy_requests (environment_id, created_at desc);

-- Lookups the deletion and export predicates need (identity_links is covered by its unique key).
create index sessions_env_user_idx on platform.sessions (environment_id, user_id) where user_id is not null;
create index sessions_env_anon_idx on platform.sessions (environment_id, anonymous_id) where anonymous_id is not null;
