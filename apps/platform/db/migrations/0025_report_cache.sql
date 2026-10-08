-- 0025: short-lived report result cache (PR 6).
-- Postgres stays the source of truth: a row is a finished report result for
-- one environment, reused for a few minutes (src/modules/analytics/cache.ts)
-- and then recomputed. The key is a hash of everything the result depends on:
-- environment, report kind, configuration, range, filters, comparison,
-- timezone and the version of the audience filter.
create table platform.report_cache (
  organization_id  uuid not null,
  environment_id   uuid not null,
  key              text not null check (key ~ '^[0-9a-f]{64}$'),
  kind             text not null check (char_length(kind) <= 40),
  result           jsonb not null,
  created_at       timestamptz not null default now(),
  expires_at       timestamptz not null,
  primary key (environment_id, key),
  foreign key (organization_id, environment_id) references platform.environments(organization_id, id) on delete cascade
);
create index report_cache_expires_idx on platform.report_cache (expires_at);

alter table platform.report_cache enable row level security;
create policy tenant_isolation on platform.report_cache for all to platform_app
  using (organization_id = platform.current_org_id())
  with check (organization_id = platform.current_org_id());
grant select, insert, update, delete on platform.report_cache to platform_app;
