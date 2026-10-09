-- 0032: experiments (A/B tests).
-- An experiment belongs to one environment. The app asks which variant a
-- person gets (GET/POST /v1/experiments/assignments with the public SDK key)
-- and reports that it showed it with an `experiment_exposure` event; results
-- are computed from those events and the goal event (src/modules/experiments).
--
-- Assignment is not stored: it is a hash of `salt` and the person, so the
-- same person always gets the same variant while the experiment runs. That is
-- why variants, weights, traffic and the audience can only change in draft.
--
-- variants: [{ "key": "control", "name": "Control", "weight": 50 }, …], the
--   first is the control, 2 to 5 in all (validated in modules/experiments).
-- goal: { "event": "...", "filter": { name, op, value } | null, "window_days": 1..90 }.
-- secondary: null, { "kind": "event", "event": "..." } or { "kind": "revenue" }.
create table platform.experiments (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null,
  app_id           uuid not null,
  environment_id   uuid not null,
  key              text not null check (key ~ '^[a-z][a-z0-9_]{1,59}$'),
  name             text not null check (char_length(name) between 2 and 80),
  hypothesis       text check (char_length(hypothesis) <= 1000),
  status           text not null default 'draft' check (status in ('draft', 'running', 'stopped')),
  salt             text not null default replace(gen_random_uuid()::text, '-', ''),
  variants         jsonb not null check (jsonb_typeof(variants) = 'array' and jsonb_array_length(variants) between 2 and 5),
  traffic_percent  int not null default 100 check (traffic_percent between 1 and 100),
  audience_id      uuid,
  goal             jsonb not null check (jsonb_typeof(goal) = 'object'),
  secondary        jsonb check (secondary is null or jsonb_typeof(secondary) = 'object'),
  started_at       timestamptz,
  stopped_at       timestamptz,
  created_by       uuid references platform.users(id) on delete set null,
  updated_by       uuid references platform.users(id) on delete set null,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (organization_id, id),
  unique (environment_id, key),
  check ((status = 'draft') = (started_at is null)),
  check ((status = 'stopped') = (stopped_at is not null)),
  foreign key (organization_id, app_id, environment_id) references platform.environments(organization_id, app_id, id) on delete cascade,
  foreign key (organization_id, audience_id) references platform.audiences(organization_id, id)
);
-- The assignment endpoint reads the running experiments of one environment.
create index experiments_environment_status_idx on platform.experiments (environment_id, status);

create trigger experiments_touch before update on platform.experiments for each row execute function platform.touch_updated_at();
alter table platform.experiments enable row level security;
create policy tenant_isolation on platform.experiments for all to platform_app
  using (organization_id = platform.current_org_id())
  with check (organization_id = platform.current_org_id());
grant select, insert, update, delete on platform.experiments to platform_app;

-- Results read exposures through events_env_name_ts_idx (environment, event_name, timestamp),
-- so no new index on platform.events (building one would lock a large table).
