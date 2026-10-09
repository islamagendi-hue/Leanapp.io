-- 0035: Integrations Center — connections, per-capability status, ad reporting
-- import and outbound conversion delivery logs (docs/integrations.md).
--
-- Concepts kept apart:
--   provider       described in code (modules/integrations/registry.ts), not a table
--   connection     one provider account linked to one environment, with its
--                  encrypted credentials (integration_connections)
--   capability     one thing a connection does (ad_reporting, spend_import…),
--                  each with its own config, status, last sync, freshness and
--                  last error (integration_capabilities)
-- There is no global "connected" flag: status lives on the capability.
--
-- Additive only: new tables, new nullable / defaulted columns, and a widened
-- check constraint on postback deliveries (adds 'skipped').

-- ── Connections ─────────────────────────────────────────────────────────────
create table platform.integration_connections (
  id                     uuid primary key default gen_random_uuid(),
  organization_id        uuid not null,
  app_id                 uuid not null,
  environment_id         uuid not null,
  provider               text not null check (provider ~ '^[a-z][a-z0-9_]{1,40}$'),
  -- How the credentials were obtained: pasted by the customer, or LeanApp's own OAuth app.
  auth_method            text not null default 'manual' check (auth_method in ('manual', 'oauth')),
  config                 jsonb not null default '{}',   -- non-secret settings only (account ids, API version…)
  credentials_enc        text,                          -- AES-256-GCM, INTEGRATIONS_ENCRYPTION_KEY, aad integration_connection:<id>
  has_credentials        boolean generated always as (credentials_enc is not null) stored,
  credentials_updated_at timestamptz,
  token_expires_at       timestamptz,                   -- when the provider said the access token expires, if it did
  -- Provider permissions (OAuth scopes) granted, as reported by the provider; empty when unknown.
  granted_scopes         text[] not null default '{}',
  -- Labels of required credentials / settings still missing (computed when saved; no values).
  missing_fields         text[] not null default '{}',
  status                 text not null default 'active' check (status in ('active', 'disabled')),
  created_by             uuid references platform.users(id) on delete set null,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  unique (environment_id, provider),
  unique (organization_id, id),
  foreign key (organization_id, app_id, environment_id) references platform.environments(organization_id, app_id, id) on delete cascade
);
create trigger integration_connections_touch before update on platform.integration_connections for each row execute function platform.touch_updated_at();

-- ── Capabilities ────────────────────────────────────────────────────────────
create table platform.integration_capabilities (
  id                    uuid primary key default gen_random_uuid(),
  organization_id       uuid not null,
  connection_id         uuid not null,
  capability            text not null check (capability ~ '^[a-z][a-z0-9_]{1,40}$'),
  enabled               boolean not null default false,
  config                jsonb not null default '{}',
  status                text not null default 'not_configured'
                        check (status in ('not_configured', 'credentials_missing', 'unverified', 'verified', 'error')),
  status_detail         text,
  verified_at           timestamptz,                -- last successful live call (verify or sync)
  last_sync_started_at  timestamptz,
  last_success_at       timestamptz,
  last_error_at         timestamptz,
  last_error            text,
  error_count           int not null default 0,     -- consecutive failures
  data_fresh_through    date,                       -- last day fully imported (inbound capabilities)
  next_sync_at          timestamptz,                -- null: not scheduled
  backfill_from         date,                       -- requested backfill start; cleared when done
  backfill_cursor       date,                       -- backfill has reached back to this day
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  unique (connection_id, capability),
  foreign key (organization_id, connection_id) references platform.integration_connections(organization_id, id) on delete cascade
);
create index integration_capabilities_due_idx on platform.integration_capabilities (next_sync_at) where enabled and next_sync_at is not null;
create trigger integration_capabilities_touch before update on platform.integration_capabilities for each row execute function platform.touch_updated_at();

-- ── Sync runs (inbound) ─────────────────────────────────────────────────────
create table platform.integration_sync_runs (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null,
  connection_id    uuid not null,
  capability       text not null,
  kind             text not null check (kind in ('incremental', 'backfill', 'manual')),
  status           text not null default 'running' check (status in ('running', 'succeeded', 'failed')),
  range_from       date,
  range_to         date,
  rows_imported    int not null default 0,
  spend_rows       int not null default 0,
  spend_skipped    int not null default 0,          -- days kept because a hand-entered amount exists
  requests         int not null default 0,
  error_kind       text,                            -- auth, rate_limited, transient, permanent, config
  error            text,
  started_at       timestamptz not null default now(),
  finished_at      timestamptz,
  foreign key (organization_id, connection_id) references platform.integration_connections(organization_id, id) on delete cascade
);
create index integration_sync_runs_conn_idx on platform.integration_sync_runs (connection_id, started_at desc);

-- ── Ad objects and daily performance (inbound reporting) ───────────────────
create table platform.ad_entities (
  id                 uuid primary key default gen_random_uuid(),
  organization_id    uuid not null,
  environment_id     uuid not null,
  connection_id      uuid not null,
  provider           text not null,
  level              text not null check (level in ('account', 'campaign', 'adset', 'ad')),
  external_id        text not null check (char_length(external_id) between 1 and 100),
  parent_external_id text,
  account_external_id text,
  name               text,
  currency           text,
  timezone           text,
  first_seen_at      timestamptz not null default now(),
  last_seen_at       timestamptz not null default now(),
  unique (connection_id, level, external_id),
  foreign key (organization_id, connection_id) references platform.integration_connections(organization_id, id) on delete cascade
);

create table platform.ad_performance_daily (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null,
  environment_id   uuid not null,
  connection_id    uuid not null,
  provider         text not null,
  day              date not null,
  account_id       text not null,
  campaign_id      text not null default '',
  campaign_name    text,
  adset_id         text not null default '',
  adset_name       text,
  ad_id            text not null default '',
  ad_name          text,
  currency         text not null check (currency ~ '^[A-Z]{3}$'),
  impressions      bigint not null default 0 check (impressions >= 0),
  clicks           bigint not null default 0 check (clicks >= 0),
  spend            numeric(16, 4) not null default 0 check (spend >= 0),
  conversions      numeric(16, 4),                  -- null when the provider reports none we map
  imported_at      timestamptz not null default now(),
  unique (connection_id, day, account_id, campaign_id, adset_id, ad_id),
  foreign key (organization_id, connection_id) references platform.integration_connections(organization_id, id) on delete cascade
);
create index ad_performance_daily_env_day_idx on platform.ad_performance_daily (environment_id, day desc);

-- ── OAuth state (CSRF) ──────────────────────────────────────────────────────
-- Only the SHA-256 of the state is stored; it is single-use, bound to the
-- user, organization and environment, and expires after 10 minutes.
create table platform.integration_oauth_states (
  state_hash       text primary key,
  organization_id  uuid not null,
  app_id           uuid not null,
  environment_id   uuid not null,
  user_id          uuid not null references platform.users(id) on delete cascade,
  provider         text not null,
  return_path      text not null,
  expires_at       timestamptz not null,
  consumed_at      timestamptz,
  created_at       timestamptz not null default now(),
  foreign key (organization_id, app_id, environment_id) references platform.environments(organization_id, app_id, id) on delete cascade
);
create index integration_oauth_states_expiry_idx on platform.integration_oauth_states (expires_at);

-- ── Spend: imported vs entered by hand ──────────────────────────────────────
alter table platform.ad_spend_daily add column origin text not null default 'manual' check (origin in ('manual', 'import'));
alter table platform.ad_spend_daily add column connection_id uuid references platform.integration_connections(id) on delete set null;

-- ── Outbound conversion delivery log ────────────────────────────────────────
alter table platform.attribution_postback_deliveries drop constraint attribution_postback_deliveries_status_check;
alter table platform.attribution_postback_deliveries add constraint attribution_postback_deliveries_status_check
  check (status in ('pending', 'succeeded', 'failed', 'giving_up', 'skipped'));
alter table platform.attribution_postback_deliveries add column skip_reason text;              -- consent_denied, no_match_key, invalid_payload
alter table platform.attribution_postback_deliveries add column provider_error_code text;
alter table platform.attribution_postback_deliveries add column provider_trace_id text;        -- e.g. Meta fbtrace_id
alter table platform.attribution_postback_deliveries add column request_summary jsonb;         -- endpoint (no query), event name and id; never tokens

-- ── RLS (same policy as every tenant table) ─────────────────────────────────
do $$
declare t text;
begin
  foreach t in array array['integration_connections', 'integration_capabilities', 'integration_sync_runs', 'ad_entities',
                           'ad_performance_daily', 'integration_oauth_states']
  loop
    execute format('alter table platform.%I enable row level security', t);
    execute format('create policy tenant_isolation on platform.%I for all to platform_app
                    using (organization_id = platform.current_org_id())
                    with check (organization_id = platform.current_org_id())', t);
    execute format('grant select, insert, update, delete on platform.%I to platform_app', t);
  end loop;
end $$;
-- Encrypted credentials never leave trusted server code (system scope).
revoke select on platform.integration_connections from platform_app;
grant select (id, organization_id, app_id, environment_id, provider, auth_method, config, has_credentials, credentials_updated_at,
              token_expires_at, granted_scopes, missing_fields, status, created_by, created_at, updated_at) on platform.integration_connections to platform_app;
