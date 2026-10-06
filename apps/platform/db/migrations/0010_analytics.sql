-- Analytics beyond v1: saved cohorts, saved reports, end-user profile search,
-- and the analytics.write permission for saving cohorts and reports.
-- See docs/analytics.md.

-- ── Permission ──────────────────────────────────────────────────────────────
-- 0002 is generated from src/modules/rbac/permissions.ts and already applied,
-- so new permissions are added here (the source of truth has them too; an
-- integration test checks the database matches it).
insert into platform.permissions (id, description) values
  ('analytics.write', 'Save cohorts and analytics reports')
on conflict (id) do update set description = excluded.description;
insert into platform.role_permissions (role_id, permission_id) values
  ('owner', 'analytics.write'),
  ('admin', 'analytics.write'),
  ('analyst', 'analytics.write'),
  ('marketer', 'analytics.write')
on conflict do nothing;

-- ── Saved cohorts ───────────────────────────────────────────────────────────
-- A definition (who did event X N times in a range, with optional event and
-- user property filters). Members are computed on demand, never stored.
create table platform.analytics_cohorts (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null,
  app_id           uuid not null,
  environment_id   uuid not null,
  name             text not null check (char_length(name) between 1 and 100),
  description      text check (char_length(description) <= 500),
  definition       jsonb not null,
  created_by       uuid references platform.users(id) on delete set null,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (organization_id, id),
  foreign key (organization_id, app_id, environment_id) references platform.environments(organization_id, app_id, id) on delete cascade
);
create unique index analytics_cohorts_name_idx on platform.analytics_cohorts (environment_id, lower(name));

-- ── Saved reports ───────────────────────────────────────────────────────────
create table platform.analytics_saved_reports (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null,
  app_id           uuid not null,
  environment_id   uuid not null,
  name             text not null check (char_length(name) between 1 and 100),
  kind             text not null check (kind in ('trend', 'funnel', 'retention', 'revenue')),
  config           jsonb not null,
  created_by       uuid references platform.users(id) on delete set null,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (organization_id, id),
  foreign key (organization_id, app_id, environment_id) references platform.environments(organization_id, app_id, id) on delete cascade
);
create unique index analytics_saved_reports_name_idx on platform.analytics_saved_reports (environment_id, lower(name));

do $$
declare t text;
begin
  foreach t in array array['analytics_cohorts', 'analytics_saved_reports']
  loop
    execute format('create trigger %I_touch before update on platform.%I for each row execute function platform.touch_updated_at()', t, t);
    execute format('alter table platform.%I enable row level security', t);
    execute format('create policy tenant_isolation on platform.%I for all to platform_app
                    using (organization_id = platform.current_org_id())
                    with check (organization_id = platform.current_org_id())', t);
    execute format('grant select, insert, update, delete on platform.%I to platform_app', t);
  end loop;
end $$;

-- ── Profile search ──────────────────────────────────────────────────────────
-- Prefix search on user ids and anonymous ids, and "recently seen" lists.
create index app_users_env_external_prefix_idx on platform.app_users (environment_id, external_id text_pattern_ops);
create index app_users_env_last_seen_idx on platform.app_users (environment_id, last_seen_at desc);
create index anonymous_users_env_anon_prefix_idx on platform.anonymous_users (environment_id, anonymous_id text_pattern_ops);
