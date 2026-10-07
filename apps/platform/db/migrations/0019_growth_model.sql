-- 0019: growth model, Phase 1 (docs/growth-model.md). Additive only: nothing
-- existing changes behaviour unless an app turns the new features on.
--   1. apps.features: per-app switches, all off by default
--   2. event_mapping_history: every change to an event mapping, written by a trigger
--   3. app_reprocess_jobs: background re-map of all history and growth-state rebuilds
--   4. tracking_plan_versions.growth: growth definitions, versioned with the plan
--   5. growth_state: one row per person per environment
--   6. growth.read / growth.write permissions

-- ── 1. Feature switches ─────────────────────────────────────────────────────
-- {"growth_model": true, "mapping_history": true}; a missing key means off.
alter table platform.apps add column features jsonb not null default '{}' check (jsonb_typeof(features) = 'object');

-- ── 2. Event mapping history ────────────────────────────────────────────────
-- Append-only. One row per change of a mapping's target or status, numbered
-- per mapping. Written by the trigger below, so every code path that changes
-- event_mappings (suggestions, accept, reject, manual, revert) is recorded.
create table platform.event_mapping_history (
  id               bigint generated always as identity primary key,
  organization_id  uuid not null,
  app_id           uuid not null,
  mapping_id       uuid not null,
  revision         int not null,
  from_name        text not null,
  to_name          text not null,
  status           text not null,
  changed_by       uuid references platform.users(id) on delete set null,
  changed_at       timestamptz not null default now(),
  -- The revision this change restored (a revert), else null.
  reverted_to      int,
  unique (mapping_id, revision),
  foreign key (organization_id, app_id) references platform.apps(organization_id, id) on delete cascade
);
create index event_mapping_history_app_idx on platform.event_mapping_history (app_id, changed_at desc);

create function platform.record_event_mapping_change() returns trigger language plpgsql as $$
begin
  if tg_op = 'UPDATE' and new.to_name = old.to_name and new.status = old.status then
    return new;
  end if;
  insert into platform.event_mapping_history (organization_id, app_id, mapping_id, revision, from_name, to_name, status, changed_by, reverted_to)
  values (new.organization_id, new.app_id, new.id,
          coalesce((select max(revision) from platform.event_mapping_history where mapping_id = new.id), 0) + 1,
          new.from_name, new.to_name, new.status,
          case when new.status = 'suggested' then null else new.decided_by end,
          nullif(current_setting('platform.mapping_revert_to', true), '')::int);
  return new;
end $$;
create trigger event_mappings_history after insert or update on platform.event_mappings
  for each row execute function platform.record_event_mapping_change();

-- Existing mappings start with their current state as revision 1.
insert into platform.event_mapping_history (organization_id, app_id, mapping_id, revision, from_name, to_name, status, changed_by, changed_at)
select organization_id, app_id, id, 1, from_name, to_name, status, decided_by, coalesce(decided_at, created_at)
  from platform.event_mappings;

-- ── 3. Re-processing jobs ───────────────────────────────────────────────────
-- Run in chunks by the scheduled worker, under the environment's processing
-- lock. remap: rewrite events.canonical_name from the accepted mappings for
-- every event up to upto_event_id. growth_rebuild: recompute growth_state for
-- every person. One active job per environment and kind; a newer request
-- restarts it.
create table platform.app_reprocess_jobs (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null,
  app_id           uuid not null,
  environment_id   uuid not null,
  kind             text not null check (kind in ('remap', 'growth_rebuild')),
  status           text not null default 'queued' check (status in ('queued', 'running', 'done', 'failed')),
  reason           text not null,
  cursor           jsonb not null default '{}',
  upto_event_id    bigint,
  done_count       bigint not null default 0,
  total_estimate   bigint,
  attempts         int not null default 0,
  last_error       text,
  requested_by     uuid references platform.users(id) on delete set null,
  created_at       timestamptz not null default now(),
  started_at       timestamptz,
  finished_at      timestamptz,
  updated_at       timestamptz not null default now(),
  foreign key (organization_id, app_id, environment_id) references platform.environments(organization_id, app_id, id) on delete cascade
);
create unique index app_reprocess_jobs_active_key on platform.app_reprocess_jobs (environment_id, kind) where status in ('queued', 'running');
create index app_reprocess_jobs_pending_idx on platform.app_reprocess_jobs (created_at) where status in ('queued', 'running');
create index app_reprocess_jobs_app_idx on platform.app_reprocess_jobs (app_id, created_at desc);

-- Re-map and rebuild walk an environment's events in id order.
create index events_env_id_idx on platform.events (environment_id, id);

-- ── 4. Growth definitions, versioned with the tracking plan ─────────────────
-- Null = derived from activation_event / north_star_event and the plan's
-- revenue events (see src/modules/growth/definition.ts).
alter table platform.tracking_plan_versions add column growth jsonb check (growth is null or jsonb_typeof(growth) = 'object');

-- ── 5. Growth state per person ──────────────────────────────────────────────
-- person uses the analytics identity key: the user id, else the one user the
-- install is linked to, else 'anon:' || anonymous_id (shared devices are never merged).
create table platform.growth_state (
  organization_id       uuid not null,
  app_id                uuid not null,
  environment_id        uuid not null,
  person                text not null,
  user_id               text,
  anonymous_id          text,
  first_seen_at         timestamptz not null,
  last_active_at        timestamptz not null,
  activated_at          timestamptz,
  first_core_action_at  timestamptz,
  core_action_count     bigint not null default 0,
  first_revenue_at      timestamptz,
  revenue               jsonb not null default '{}',   -- {"SAR": 120.5, "USD": 9.99}
  purchases             bigint not null default 0,
  retained_d1_at        timestamptz,
  retained_d7_at        timestamptz,
  retained_d30_at       timestamptz,
  plan_version_id       uuid references platform.tracking_plan_versions(id) on delete set null,
  updated_at            timestamptz not null default now(),
  primary key (environment_id, person),
  foreign key (organization_id, app_id, environment_id) references platform.environments(organization_id, app_id, id) on delete cascade
);
create index growth_state_user_idx on platform.growth_state (environment_id, user_id) where user_id is not null;
create index growth_state_anon_idx on platform.growth_state (environment_id, anonymous_id) where anonymous_id is not null;

-- ── RLS ─────────────────────────────────────────────────────────────────────
do $$
declare t text;
begin
  foreach t in array array['event_mapping_history', 'app_reprocess_jobs', 'growth_state']
  loop
    execute format('alter table platform.%I enable row level security', t);
    execute format('create policy tenant_isolation on platform.%I for all to platform_app
                    using (organization_id = platform.current_org_id())
                    with check (organization_id = platform.current_org_id())', t);
    execute format('grant select, insert, update, delete on platform.%I to platform_app', t);
  end loop;
end $$;
-- History is append-only for the app role.
revoke update, delete on platform.event_mapping_history from platform_app;

-- ── 6. Permissions ──────────────────────────────────────────────────────────
insert into platform.permissions (id, description) values
  ('growth.read', 'View growth definitions and growth state'),
  ('growth.write', 'Edit growth definitions in the draft tracking plan')
on conflict (id) do update set description = excluded.description;
insert into platform.role_permissions (role_id, permission_id) values
  ('owner', 'growth.read'), ('owner', 'growth.write'),
  ('admin', 'growth.read'), ('admin', 'growth.write'),
  ('developer', 'growth.read'), ('developer', 'growth.write'),
  ('analyst', 'growth.read'),
  ('marketer', 'growth.read')
on conflict do nothing;
