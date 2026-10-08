-- 0026: dashboards (PR 7).
-- A dashboard belongs to a project (app) and is viewed in whichever
-- environment is selected. Widgets either point at a saved report (its
-- configuration is used) or carry an inline configuration validated by the
-- same report schemas (src/modules/dashboards). Positions are on a 12-column
-- grid. Nothing is precomputed: widgets run their report when viewed, through
-- the report result cache.
create table platform.dashboards (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null,
  app_id           uuid not null,
  name             text not null check (char_length(name) between 1 and 80),
  description      text check (char_length(description) <= 500),
  -- workspace: everyone in the workspace who can see analytics; private: only its creator.
  visibility       text not null default 'workspace' check (visibility in ('workspace', 'private')),
  created_by       uuid references platform.users(id) on delete set null,
  updated_by       uuid references platform.users(id) on delete set null,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (organization_id, id),
  foreign key (organization_id, app_id) references platform.apps(organization_id, id) on delete cascade
);
create index dashboards_app_idx on platform.dashboards (app_id, lower(name));

create table platform.dashboard_widgets (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null,
  dashboard_id     uuid not null,
  type             text not null check (type in ('trend', 'funnel', 'retention', 'revenue', 'kpi', 'growth', 'audience_size')),
  title            text check (char_length(title) <= 80),
  -- Either a saved report (trend, funnel, retention, revenue) or an inline config.
  saved_report_id  uuid references platform.analytics_saved_reports(id) on delete set null,
  config           jsonb,
  x                int not null default 0 check (x between 0 and 11),
  y                int not null default 0 check (y between 0 and 500),
  w                int not null default 6 check (w between 1 and 12),
  h                int not null default 2 check (h between 1 and 8),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  check (x + w <= 12),
  foreign key (organization_id, dashboard_id) references platform.dashboards(organization_id, id) on delete cascade
);
create index dashboard_widgets_dashboard_idx on platform.dashboard_widgets (dashboard_id, y, x);

do $$
declare t text;
begin
  foreach t in array array['dashboards', 'dashboard_widgets']
  loop
    execute format('create trigger %I_touch before update on platform.%I for each row execute function platform.touch_updated_at()', t, t);
    execute format('alter table platform.%I enable row level security', t);
    execute format('create policy tenant_isolation on platform.%I for all to platform_app
                    using (organization_id = platform.current_org_id())
                    with check (organization_id = platform.current_org_id())', t);
    execute format('grant select, insert, update, delete on platform.%I to platform_app', t);
  end loop;
end $$;
