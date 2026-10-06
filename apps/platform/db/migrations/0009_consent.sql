-- Consent capture and suppression lists (privacy phase 2).
--
-- consent_records (0001) is the append-only history of consent changes. Each
-- row now keeps the ids it arrived with and the event id it came from, so
-- retried SDK batches never record a change twice.
alter table platform.consent_records
  add column user_id      text,
  add column anonymous_id text,
  add column event_id     text,
  add column received_at  timestamptz not null default now();

alter table platform.consent_records
  add constraint consent_records_source_known check (source in ('sdk', 'api', 'dashboard'));

create unique index consent_records_event_idx on platform.consent_records (environment_id, event_id, purpose) where event_id is not null;
create index consent_records_env_key_idx on platform.consent_records (environment_id, user_key, purpose, recorded_at desc);
create index consent_records_env_anon_idx on platform.consent_records (environment_id, anonymous_id) where anonymous_id is not null;
create index consent_records_env_recorded_idx on platform.consent_records (environment_id, recorded_at);

-- Current consent per user key and purpose: the latest record wins (by the
-- time the change was made on the device). Ingestion reads it by primary key
-- for every batch, so it stays one row per (environment, key, purpose).
-- A change that carries both a user_id and an anonymous_id is written under
-- both keys ('<user_id>' and 'anon:<anonymous_id>').
create table platform.consent_state (
  organization_id  uuid not null,
  environment_id   uuid not null,
  user_key         text not null,
  purpose          text not null check (purpose in ('analytics', 'marketing', 'push', 'attribution')),
  granted          boolean not null,
  source           text not null check (source in ('sdk', 'api', 'dashboard')),
  updated_at       timestamptz not null,
  primary key (environment_id, user_key, purpose),
  foreign key (organization_id, environment_id) references platform.environments(organization_id, id) on delete cascade
);

-- Users who must not receive messages on a channel. 'marketing' covers every
-- marketing message whatever the medium; 'push' and 'email' block the medium
-- entirely. Rows from consent (source 'consent') follow the user's consent and
-- are removed when it is granted again; manual and API rows stay until removed.
create table platform.suppressions (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null,
  environment_id   uuid not null,
  user_key         text not null,
  channel          text not null check (channel in ('marketing', 'push', 'email')),
  source           text not null check (source in ('manual', 'api', 'consent')),
  reason           text check (char_length(reason) <= 500),
  created_by       uuid references platform.users(id) on delete set null,
  created_at       timestamptz not null default now(),
  unique (environment_id, user_key, channel, source),
  foreign key (organization_id, environment_id) references platform.environments(organization_id, id) on delete cascade
);
create index suppressions_env_created_idx on platform.suppressions (environment_id, created_at desc);

do $$
declare t text;
begin
  foreach t in array array['consent_state', 'suppressions']
  loop
    execute format('alter table platform.%I enable row level security', t);
    execute format('create policy tenant_isolation on platform.%I for all to platform_app
                    using (organization_id = platform.current_org_id())
                    with check (organization_id = platform.current_org_id())', t);
    execute format('grant select, insert, update, delete on platform.%I to platform_app', t);
  end loop;
end $$;

-- Events dropped at ingestion because the user denied analytics consent; part of rejected_count.
alter table platform.event_batches add column consent_denied_count int not null default 0;
