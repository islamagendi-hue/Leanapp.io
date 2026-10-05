-- ════════════════════════════════════════════════════════════════════════════
-- Growth platform: foundation schema (control plane + interim data plane).
--
-- Everything lives in the `platform` schema so it can share a Postgres instance
-- with the marketing site (whose tables live in `public`) without collisions,
-- and is never exposed through Supabase's PostgREST (which serves `public`).
--
-- Tenant isolation (see docs/multi-tenancy.md, ADR-009):
--   * Every tenant-owned table carries `organization_id`.
--   * RLS is enabled on every tenant-owned table. Policies compare against
--     `platform.current_org_id()`, which reads a transaction-local setting the
--     server sets from the authenticated session, never from client input.
--   * Request-path queries run as the non-owner role `platform_app`
--     (SET LOCAL ROLE), so RLS applies. Only trusted system jobs (auth lookups,
--     ingestion key lookup, event processing) run as the owning role.
--   * Child tables use composite foreign keys (organization_id, parent_id) so a
--     row can never point at a parent in another organization.
-- ════════════════════════════════════════════════════════════════════════════

create extension if not exists pgcrypto;
create schema if not exists platform;

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'platform_app') then
    create role platform_app nologin noinherit nobypassrls;
  end if;
end $$;
-- The connecting (owner) role must be able to switch into platform_app.
do $$ begin execute format('grant platform_app to %I', current_user); end $$;
grant usage on schema platform to platform_app;

create or replace function platform.current_org_id() returns uuid
language sql stable as $$
  select nullif(current_setting('app.org_id', true), '')::uuid
$$;

create or replace function platform.current_user_id() returns uuid
language sql stable as $$
  select nullif(current_setting('app.user_id', true), '')::uuid
$$;

create or replace function platform.touch_updated_at() returns trigger
language plpgsql as $$
begin new.updated_at = now(); return new; end $$;

-- ════════════════════════════════════════════════════════════════════════════
-- BILLING CATALOG (global, editable data: no pricing in code)
-- ════════════════════════════════════════════════════════════════════════════
create table platform.plans (
  id            text primary key,                 -- free, starter, growth, pro, enterprise
  name          text not null,
  description   text,
  is_public     boolean not null default true,
  sort_order    int not null default 0,
  price_monthly_cents bigint,                     -- null = not priced yet / contact sales
  currency      text not null default 'USD',
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create table platform.plan_features (
  plan_id     text not null references platform.plans(id) on delete cascade,
  feature     text not null,                       -- e.g. limit.events_per_month, retention.days
  value       jsonb not null,                      -- number | boolean | string; null = unlimited
  primary key (plan_id, feature)
);

-- Plans and limits are placeholders until market research sets pricing
-- (docs/billing.md). They are data, so they change without a deploy.
insert into platform.plans (id, name, sort_order) values
  ('free', 'Free', 0), ('starter', 'Starter', 1), ('growth', 'Growth', 2),
  ('pro', 'Pro', 3), ('enterprise', 'Enterprise', 4);
insert into platform.plan_features (plan_id, feature, value) values
  ('free', 'retention.days', '30'),      ('free', 'limit.apps', '1'),      ('free', 'limit.seats', '3'),
  ('free', 'limit.events_per_month', '100000'),
  ('starter', 'retention.days', '180'),  ('starter', 'limit.apps', '3'),   ('starter', 'limit.seats', '10'),
  ('starter', 'limit.events_per_month', '2000000'),
  ('growth', 'retention.days', '365'),   ('growth', 'limit.apps', '10'),   ('growth', 'limit.seats', '25'),
  ('growth', 'limit.events_per_month', '20000000'),
  ('pro', 'retention.days', '730'),      ('pro', 'limit.apps', 'null'),    ('pro', 'limit.seats', 'null'),
  ('pro', 'limit.events_per_month', '100000000'),
  ('enterprise', 'retention.days', 'null'), ('enterprise', 'limit.apps', 'null'), ('enterprise', 'limit.seats', 'null'),
  ('enterprise', 'limit.events_per_month', 'null');

-- ════════════════════════════════════════════════════════════════════════════
-- IDENTITY & ACCESS (control plane)
-- ════════════════════════════════════════════════════════════════════════════
create table platform.users (
  id                 uuid primary key default gen_random_uuid(),
  email              text not null,
  name               text not null,
  password_hash      text,                         -- null for OAuth-only accounts
  email_verified_at  timestamptz,
  mfa_enabled        boolean not null default false,
  mfa_secret_enc     text,                         -- reserved: encrypted TOTP secret (MFA-ready)
  is_platform_admin  boolean not null default false,
  locale             text not null default 'en',
  status             text not null default 'active' check (status in ('active', 'disabled')),
  last_login_at      timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);
create unique index users_email_key on platform.users (lower(email));

-- OAuth-ready: one row per external identity provider account.
create table platform.user_identities (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null references platform.users(id) on delete cascade,
  provider         text not null,                  -- google, apple, github, ...
  provider_user_id text not null,
  created_at       timestamptz not null default now(),
  unique (provider, provider_user_id)
);

create table platform.auth_sessions (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references platform.users(id) on delete cascade,
  token_hash    text not null unique,              -- sha256 of the cookie token; the token itself is never stored
  created_at    timestamptz not null default now(),
  last_seen_at  timestamptz not null default now(),
  expires_at    timestamptz not null,
  revoked_at    timestamptz,
  user_agent    text,
  mfa_verified  boolean not null default false
);
create index auth_sessions_user_idx on platform.auth_sessions (user_id);

create table platform.organizations (
  id                   uuid primary key default gen_random_uuid(),
  name                 text not null,
  slug                 text not null unique check (slug ~ '^[a-z0-9][a-z0-9-]{1,46}[a-z0-9]$'),
  logo_url             text,
  country              text,                        -- ISO 3166-1 alpha-2
  timezone             text not null default 'UTC',
  default_currency     text not null default 'USD' check (default_currency ~ '^[A-Z]{3}$'),
  industry             text,
  status               text not null default 'active' check (status in ('active', 'suspended', 'deleted')),
  plan_id              text not null default 'free' references platform.plans(id),
  billing_customer_id  text,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

create table platform.roles (
  id           text primary key,                    -- owner, admin, developer, analyst, marketer
  name         text not null,
  description  text not null,
  rank         int not null                          -- higher = more privileged; used for "cannot grant above yourself"
);
create table platform.permissions (
  id           text primary key,                    -- e.g. apps.manage
  description  text not null
);
create table platform.role_permissions (
  role_id       text not null references platform.roles(id) on delete cascade,
  permission_id text not null references platform.permissions(id) on delete cascade,
  primary key (role_id, permission_id)
);
-- Seeded by 0002_rbac_seed.sql, which is generated from src/modules/rbac/permissions.ts
-- (a unit test fails if the two drift).

create table platform.organization_members (
  organization_id uuid not null references platform.organizations(id) on delete cascade,
  user_id         uuid not null references platform.users(id) on delete cascade,
  role_id         text not null references platform.roles(id),
  invited_by      uuid references platform.users(id) on delete set null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  primary key (organization_id, user_id)
);
create index organization_members_user_idx on platform.organization_members (user_id);

create table platform.organization_invitations (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references platform.organizations(id) on delete cascade,
  email           text not null,
  role_id         text not null references platform.roles(id),
  token_hash      text not null unique,
  invited_by      uuid references platform.users(id) on delete set null,
  expires_at      timestamptz not null,
  accepted_at     timestamptz,
  revoked_at      timestamptz,
  created_at      timestamptz not null default now()
);
create index organization_invitations_org_idx on platform.organization_invitations (organization_id);

-- ════════════════════════════════════════════════════════════════════════════
-- APPS, ENVIRONMENTS, CREDENTIALS
-- ════════════════════════════════════════════════════════════════════════════
create table platform.apps (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references platform.organizations(id) on delete cascade,
  name             text not null,
  slug             text not null check (slug ~ '^[a-z0-9][a-z0-9-]{0,46}[a-z0-9]$'),
  description      text,
  icon_url         text,
  category         text,
  timezone         text not null default 'UTC',
  default_currency text not null default 'USD' check (default_currency ~ '^[A-Z]{3}$'),
  status           text not null default 'active' check (status in ('active', 'archived')),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (organization_id, slug),
  unique (organization_id, id)
);

create table platform.app_platforms (
  organization_id uuid not null,
  app_id          uuid not null,
  platform        text not null check (platform in ('android', 'ios', 'react_native', 'flutter', 'web', 'backend')),
  bundle_id       text,                             -- applicationId / bundle identifier
  created_at      timestamptz not null default now(),
  primary key (app_id, platform),
  foreign key (organization_id, app_id) references platform.apps(organization_id, id) on delete cascade
);

create table platform.environments (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null,
  app_id           uuid not null,
  name             text not null,
  type             text not null check (type in ('development', 'staging', 'production')),
  status           text not null default 'active' check (status in ('active', 'disabled')),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (app_id, type),
  unique (organization_id, id),
  unique (organization_id, app_id, id),
  foreign key (organization_id, app_id) references platform.apps(organization_id, id) on delete cascade
);

-- Client-safe keys embedded in mobile apps. Can only write events.
-- The key is client-safe, so it is stored in clear for display; lookups use the hash.
create table platform.sdk_keys (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null,
  app_id           uuid not null,
  environment_id   uuid not null,
  key              text not null unique,            -- pk_<env>_<random>
  key_hash         text not null unique,
  label            text,
  status           text not null default 'active' check (status in ('active', 'revoked')),
  expires_at       timestamptz,
  last_used_at     timestamptz,
  created_by       uuid references platform.users(id) on delete set null,
  created_at       timestamptz not null default now(),
  revoked_at       timestamptz,
  foreign key (organization_id, app_id, environment_id) references platform.environments(organization_id, app_id, id) on delete cascade
);
create index sdk_keys_env_idx on platform.sdk_keys (environment_id);

-- Server-side secret keys. Only the hash is stored; the key is shown once.
create table platform.api_keys (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null,
  app_id           uuid not null,
  environment_id   uuid not null,
  key_prefix       text not null,                   -- first characters, for display ("sk_live_AbCd…")
  key_hash         text not null unique,
  label            text,
  scopes           text[] not null default array['events:write'],
  status           text not null default 'active' check (status in ('active', 'revoked')),
  expires_at       timestamptz,
  last_used_at     timestamptz,
  created_by       uuid references platform.users(id) on delete set null,
  created_at       timestamptz not null default now(),
  revoked_at       timestamptz,
  foreign key (organization_id, app_id, environment_id) references platform.environments(organization_id, app_id, id) on delete cascade
);
create index api_keys_env_idx on platform.api_keys (environment_id);

-- ════════════════════════════════════════════════════════════════════════════
-- DATA PLANE (interim Postgres store; ClickHouse target, see ADR-002)
-- ════════════════════════════════════════════════════════════════════════════
create table platform.event_batches (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null,
  app_id           uuid not null,
  environment_id   uuid not null,
  idempotency_key  text,
  credential_kind  text not null check (credential_kind in ('sdk', 'api')),
  received_count   int not null,
  accepted_count   int not null,
  duplicate_count  int not null,
  rejected_count   int not null,
  response         jsonb not null,                  -- replayed verbatim for a retried Idempotency-Key
  received_at      timestamptz not null default now(),
  foreign key (organization_id, app_id, environment_id) references platform.environments(organization_id, app_id, id) on delete cascade
);
create unique index event_batches_idem_key on platform.event_batches (environment_id, idempotency_key) where idempotency_key is not null;

create table platform.events (
  id               bigint generated always as identity primary key,
  organization_id  uuid not null,
  app_id           uuid not null,
  environment_id   uuid not null,
  event_id         text not null,                   -- client-generated UUID; dedup key
  type             text not null check (type in ('track', 'screen', 'identify', 'alias', 'push_token')),
  event_name       text not null,                   -- as sent
  canonical_name   text,                            -- after event mapping (null = same as event_name)
  "timestamp"      timestamptz not null,            -- client time (clamped)
  received_at      timestamptz not null default now(),
  anonymous_id     text,
  user_id          text,
  session_id       text,
  platform         text,
  app_version      text,
  os_version       text,
  sdk_name         text,
  sdk_version      text,
  source           text not null check (source in ('mobile_sdk', 'backend', 'automatic')),
  schema_version   int not null default 1,
  properties       jsonb not null default '{}',
  user_properties  jsonb,                           -- identify traits / setUserProperties
  context          jsonb not null default '{}',     -- device, locale, timezone, attribution, ...
  batch_id         uuid,
  processed_at     timestamptz,
  processing_error text,
  unique (environment_id, event_id),
  foreign key (organization_id, app_id, environment_id) references platform.environments(organization_id, app_id, id) on delete cascade
);
create index events_env_received_idx on platform.events (environment_id, received_at desc);
create index events_env_name_ts_idx on platform.events (environment_id, event_name, "timestamp" desc);
create index events_unprocessed_idx on platform.events (id) where processed_at is null;
create index events_env_user_idx on platform.events (environment_id, user_id) where user_id is not null;
create index events_env_anon_idx on platform.events (environment_id, anonymous_id);

-- End users of a customer's app (not dashboard users).
create table platform.app_users (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null,
  app_id           uuid not null,
  environment_id   uuid not null,
  external_id      text not null,                   -- the customer's user_id
  properties       jsonb not null default '{}',
  first_seen_at    timestamptz not null,
  last_seen_at     timestamptz not null,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (environment_id, external_id),
  foreign key (organization_id, app_id, environment_id) references platform.environments(organization_id, app_id, id) on delete cascade
);

create table platform.anonymous_users (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null,
  app_id           uuid not null,
  environment_id   uuid not null,
  anonymous_id     text not null,
  device_id        text,
  platform         text,
  first_seen_at    timestamptz not null,
  last_seen_at     timestamptz not null,
  first_context    jsonb not null default '{}',     -- first-touch context incl. attribution
  unique (environment_id, anonymous_id),
  foreign key (organization_id, app_id, environment_id) references platform.environments(organization_id, app_id, id) on delete cascade
);

-- Identity graph edges: anonymous_id ⇄ user_id (and device_id when provided).
create table platform.identity_links (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null,
  app_id           uuid not null,
  environment_id   uuid not null,
  anonymous_id     text not null,
  user_id          text not null,
  device_id        text,
  first_linked_at  timestamptz not null,
  last_seen_at     timestamptz not null,
  unique (environment_id, anonymous_id, user_id),
  foreign key (organization_id, app_id, environment_id) references platform.environments(organization_id, app_id, id) on delete cascade
);
create index identity_links_user_idx on platform.identity_links (environment_id, user_id);

create table platform.sessions (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null,
  app_id           uuid not null,
  environment_id   uuid not null,
  session_id       text not null,
  anonymous_id     text,
  user_id          text,
  started_at       timestamptz not null,
  ended_at         timestamptz not null,
  duration_seconds int generated always as (greatest(0, extract(epoch from (ended_at - started_at))::int)) stored,
  event_count      int not null default 0,
  screen_count     int not null default 0,
  platform         text,
  app_version      text,
  entry_source     text,
  entry_campaign   text,
  unique (environment_id, session_id),
  foreign key (organization_id, app_id, environment_id) references platform.environments(organization_id, app_id, id) on delete cascade
);
create index sessions_env_started_idx on platform.sessions (environment_id, started_at desc);

create table platform.push_tokens (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null,
  app_id           uuid not null,
  environment_id   uuid not null,
  token            text not null,
  provider         text not null check (provider in ('fcm', 'apns')),
  anonymous_id     text,
  user_id          text,
  platform         text,
  permission_state text not null default 'unknown' check (permission_state in ('granted', 'denied', 'provisional', 'unknown')),
  status           text not null default 'active' check (status in ('active', 'invalid', 'opted_out')),
  created_at       timestamptz not null default now(),
  last_seen_at     timestamptz not null default now(),
  invalidated_at   timestamptz,
  unique (environment_id, token),
  foreign key (organization_id, app_id, environment_id) references platform.environments(organization_id, app_id, id) on delete cascade
);

-- ════════════════════════════════════════════════════════════════════════════
-- IMPLEMENTATION INTELLIGENCE
-- ════════════════════════════════════════════════════════════════════════════
create table platform.tracking_projects (          -- "Implementation Project": one per app
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null,
  app_id           uuid not null unique,
  status           text not null default 'questionnaire'
                     check (status in ('questionnaire', 'plan_draft', 'plan_approved', 'implementing', 'live')),
  progress         int not null default 0 check (progress between 0 and 100),
  business_model   text,                            -- classified model
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (organization_id, id),
  foreign key (organization_id, app_id) references platform.apps(organization_id, id) on delete cascade
);

-- Questions actually presented to this project (the adaptive path), with the
-- question text snapshotted so later catalog edits don't rewrite history.
create table platform.tracking_questions (
  id                  uuid primary key default gen_random_uuid(),
  organization_id     uuid not null,
  tracking_project_id uuid not null,
  question_key        text not null,
  catalog_version     int not null,
  section             text not null,
  prompt              text not null,
  shown_at            timestamptz not null default now(),
  unique (tracking_project_id, question_key),
  foreign key (organization_id, tracking_project_id) references platform.tracking_projects(organization_id, id) on delete cascade
);

create table platform.tracking_answers (
  id                  uuid primary key default gen_random_uuid(),
  organization_id     uuid not null,
  tracking_project_id uuid not null,
  question_key        text not null,
  value               jsonb not null,
  answered_by         uuid references platform.users(id) on delete set null,
  answered_at         timestamptz not null default now(),
  unique (tracking_project_id, question_key),
  foreign key (organization_id, tracking_project_id) references platform.tracking_projects(organization_id, id) on delete cascade
);

create table platform.tracking_plans (
  id                  uuid primary key default gen_random_uuid(),
  organization_id     uuid not null,
  tracking_project_id uuid not null unique,
  app_id              uuid not null,
  published_version_id uuid,                        -- set when a version is published
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  unique (organization_id, id),
  foreign key (organization_id, tracking_project_id) references platform.tracking_projects(organization_id, id) on delete cascade
);

create table platform.tracking_plan_versions (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null,
  tracking_plan_id uuid not null,
  version          int not null,
  status           text not null default 'draft' check (status in ('draft', 'approved', 'published', 'archived')),
  generator        text not null,                   -- e.g. rules@1
  business_model   text,
  activation_event text,
  north_star_event text,
  summary          jsonb not null default '{}',     -- classification, reasons, warnings
  answers_snapshot jsonb not null default '{}',
  created_by       uuid references platform.users(id) on delete set null,
  created_at       timestamptz not null default now(),
  approved_by      uuid references platform.users(id) on delete set null,
  approved_at      timestamptz,
  published_by     uuid references platform.users(id) on delete set null,
  published_at     timestamptz,
  archived_at      timestamptz,
  unique (tracking_plan_id, version),
  unique (organization_id, id),
  foreign key (organization_id, tracking_plan_id) references platform.tracking_plans(organization_id, id) on delete cascade
);
alter table platform.tracking_plans
  add constraint tracking_plans_published_fk foreign key (organization_id, published_version_id)
  references platform.tracking_plan_versions(organization_id, id) deferrable initially deferred;

create table platform.tracking_events (
  id                    uuid primary key default gen_random_uuid(),
  organization_id       uuid not null,
  plan_version_id       uuid not null,
  event_name            text not null check (event_name ~ '^[a-z][a-z0-9_]{1,63}$'),
  display_name          text not null,
  description           text not null,
  category              text not null,
  "trigger"             text not null,
  source                text not null check (source in ('mobile_sdk', 'backend', 'both', 'automatic')),
  priority              text not null check (priority in ('critical', 'high', 'medium', 'low')),
  required              boolean not null default false,
  activation_relevance  boolean not null default false,
  conversion_relevance  boolean not null default false,
  revenue_relevance     boolean not null default false,
  attribution_relevance boolean not null default false,
  automation_relevance  boolean not null default false,
  platforms             text[] not null default '{}',
  reason                text not null,               -- why the engine recommends it
  schema_version        int not null default 1,
  sort_order            int not null default 0,
  unique (plan_version_id, event_name),
  unique (organization_id, id),
  foreign key (organization_id, plan_version_id) references platform.tracking_plan_versions(organization_id, id) on delete cascade
);

create table platform.tracking_event_properties (
  id                uuid primary key default gen_random_uuid(),
  organization_id   uuid not null,
  tracking_event_id uuid not null,
  name              text not null check (name ~ '^[a-z][a-z0-9_]{0,63}$'),
  type              text not null check (type in ('string', 'number', 'integer', 'boolean', 'array', 'object', 'currency', 'datetime')),
  required          boolean not null default false,
  description       text not null,
  example           jsonb,
  allowed_values    jsonb,                           -- optional enum
  unique (tracking_event_id, name),
  foreign key (organization_id, tracking_event_id) references platform.tracking_events(organization_id, id) on delete cascade
);

create table platform.tracking_user_properties (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null,
  plan_version_id  uuid not null,
  name             text not null check (name ~ '^[a-z][a-z0-9_]{0,63}$'),
  type             text not null check (type in ('string', 'number', 'integer', 'boolean', 'array', 'datetime')),
  description      text not null,
  source           text not null check (source in ('mobile_sdk', 'backend', 'both', 'automatic', 'computed')),
  reason           text not null,
  unique (plan_version_id, name),
  foreign key (organization_id, plan_version_id) references platform.tracking_plan_versions(organization_id, id) on delete cascade
);

create table platform.tracking_attribution_rules (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null,
  plan_version_id  uuid not null,
  channel          text not null,                    -- meta, google, tiktok, snapchat, influencer, referral, qr, deep_link, organic
  parameters       text[] not null,                  -- source, medium, campaign, click_id, ...
  click_id_param   text,                             -- fbclid, gclid, ttclid, ScCid
  notes            text not null,
  unique (plan_version_id, channel),
  foreign key (organization_id, plan_version_id) references platform.tracking_plan_versions(organization_id, id) on delete cascade
);

-- Live implementation lifecycle per environment and planned event.
create table platform.tracking_implementation_status (
  id                 uuid primary key default gen_random_uuid(),
  organization_id    uuid not null,
  app_id             uuid not null,
  environment_id     uuid not null,
  event_name         text not null,
  status             text not null default 'planned'
                       check (status in ('planned', 'recommended', 'approved', 'implementation_started', 'received', 'validated', 'deprecated')),
  first_received_at  timestamptz,
  last_received_at   timestamptz,
  received_count     bigint not null default 0,
  valid_count        bigint not null default 0,
  invalid_count      bigint not null default 0,
  last_sources       text[] not null default '{}',   -- sources seen (mobile_sdk/backend)
  updated_at         timestamptz not null default now(),
  unique (environment_id, event_name),
  foreign key (organization_id, app_id, environment_id) references platform.environments(organization_id, app_id, id) on delete cascade
);

create table platform.tracking_validation_results (
  id               bigint generated always as identity primary key,
  organization_id  uuid not null,
  environment_id   uuid not null,
  event_row_id     bigint,                          -- platform.events.id
  event_name       text not null,
  plan_version_id  uuid,
  valid            boolean not null,
  errors           jsonb not null default '[]',
  created_at       timestamptz not null default now(),
  foreign key (organization_id, environment_id) references platform.environments(organization_id, id) on delete cascade
);
create index tracking_validation_results_env_idx on platform.tracking_validation_results (environment_id, created_at desc);

-- Received-name → planned-name mappings (e.g. purchase → purchase_completed).
create table platform.event_mappings (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null,
  app_id           uuid not null,
  from_name        text not null,
  to_name          text not null,
  status           text not null default 'suggested' check (status in ('suggested', 'accepted', 'rejected')),
  similarity       real,
  decided_by       uuid references platform.users(id) on delete set null,
  decided_at       timestamptz,
  created_at       timestamptz not null default now(),
  unique (app_id, from_name),
  foreign key (organization_id, app_id) references platform.apps(organization_id, id) on delete cascade
);

-- Global, platform-curated templates (read-only for tenants).
create table platform.implementation_templates (
  id           text primary key,                    -- ecommerce, food_delivery, ...
  name         text not null,
  version      int not null,
  definition   jsonb not null,
  updated_at   timestamptz not null default now()
);

-- What depends on a tracked event (funnels, audiences, automations, reports).
create table platform.implementation_dependencies (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null,
  app_id           uuid not null,
  event_name       text not null,
  dependent_type   text not null check (dependent_type in ('funnel', 'audience', 'automation', 'attribution_report', 'dashboard', 'revenue_report')),
  dependent_id     uuid not null,
  created_at       timestamptz not null default now(),
  unique (app_id, event_name, dependent_type, dependent_id),
  foreign key (organization_id, app_id) references platform.apps(organization_id, id) on delete cascade
);

-- ════════════════════════════════════════════════════════════════════════════
-- ATTRIBUTION (schema only in phase 1: see docs/attribution.md)
-- ════════════════════════════════════════════════════════════════════════════
create table platform.attribution_settings (
  organization_id  uuid not null,
  app_id           uuid primary key,
  authoritative_source text not null default 'native'
                     check (authoritative_source in ('native', 'branch', 'adjust', 'appsflyer', 'custom', 'unknown')),
  click_lookback_days int not null default 7,
  view_lookback_hours int not null default 24,
  updated_at       timestamptz not null default now(),
  foreign key (organization_id, app_id) references platform.apps(organization_id, id) on delete cascade
);

create table platform.campaigns (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null,
  app_id           uuid not null,
  source           text not null,
  medium           text,
  name             text not null,
  external_id      text,
  created_at       timestamptz not null default now(),
  unique (app_id, source, name),
  foreign key (organization_id, app_id) references platform.apps(organization_id, id) on delete cascade
);

create table platform.attribution_touchpoints (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null,
  app_id           uuid not null,
  environment_id   uuid not null,
  anonymous_id     text,
  user_id          text,
  provider         text not null default 'native',
  source           text, medium text, campaign text, campaign_id text,
  ad_group text, ad_group_id text, creative text, creative_id text,
  click_id         text,
  referrer         text,
  landing_page     text,
  touchpoint_at    timestamptz not null,
  raw              jsonb not null default '{}',
  created_at       timestamptz not null default now(),
  foreign key (organization_id, app_id, environment_id) references platform.environments(organization_id, app_id, id) on delete cascade
);
create index attribution_touchpoints_anon_idx on platform.attribution_touchpoints (environment_id, anonymous_id);

create table platform.attribution_events (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null,
  app_id           uuid not null,
  environment_id   uuid not null,
  kind             text not null check (kind in ('install', 'reinstall', 're_engagement', 'deep_link_open')),
  anonymous_id     text,
  user_id          text,
  touchpoint_id    uuid references platform.attribution_touchpoints(id) on delete set null,
  provider         text not null default 'native',
  model            text not null default 'last_touch',
  occurred_at      timestamptz not null,
  created_at       timestamptz not null default now(),
  foreign key (organization_id, app_id, environment_id) references platform.environments(organization_id, app_id, id) on delete cascade
);

create table platform.attribution_conversions (
  id                   uuid primary key default gen_random_uuid(),
  organization_id      uuid not null,
  app_id               uuid not null,
  environment_id       uuid not null,
  attribution_event_id uuid references platform.attribution_events(id) on delete set null,
  event_row_id         bigint,
  event_name           text not null,
  revenue              numeric,
  currency             text,
  occurred_at          timestamptz not null,
  foreign key (organization_id, app_id, environment_id) references platform.environments(organization_id, app_id, id) on delete cascade
);

-- ════════════════════════════════════════════════════════════════════════════
-- AUDIENCES & AUTOMATION (schema only in phase 1)
-- ════════════════════════════════════════════════════════════════════════════
create table platform.audiences (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null,
  app_id           uuid not null,
  environment_id   uuid not null,
  name             text not null,
  description      text,
  definition       jsonb not null,                   -- boolean condition tree (AND/OR/NOT)
  status           text not null default 'draft' check (status in ('draft', 'active', 'archived')),
  member_count     bigint not null default 0,
  last_computed_at timestamptz,
  created_by       uuid references platform.users(id) on delete set null,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (organization_id, id),
  foreign key (organization_id, app_id, environment_id) references platform.environments(organization_id, app_id, id) on delete cascade
);

create table platform.audience_conditions (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null,
  audience_id      uuid not null,
  parent_id        uuid references platform.audience_conditions(id) on delete cascade,
  operator         text not null check (operator in ('and', 'or', 'not', 'leaf')),
  kind             text check (kind in ('event', 'event_property', 'user_property', 'attribution', 'revenue', 'time', 'frequency')),
  spec             jsonb not null default '{}',
  position         int not null default 0,
  foreign key (organization_id, audience_id) references platform.audiences(organization_id, id) on delete cascade
);

create table platform.audience_members (
  organization_id  uuid not null,
  audience_id      uuid not null,
  user_key         text not null,                    -- user_id or anon:<anonymous_id>
  entered_at       timestamptz not null default now(),
  exited_at        timestamptz,
  primary key (audience_id, user_key),
  foreign key (organization_id, audience_id) references platform.audiences(organization_id, id) on delete cascade
);

create table platform.automations (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null,
  app_id           uuid not null,
  environment_id   uuid not null,
  name             text not null,
  status           text not null default 'draft' check (status in ('draft', 'active', 'paused', 'archived')),
  definition       jsonb not null default '{}',
  version          int not null default 1,
  created_by       uuid references platform.users(id) on delete set null,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (organization_id, id),
  foreign key (organization_id, app_id, environment_id) references platform.environments(organization_id, app_id, id) on delete cascade
);

create table platform.automation_triggers (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null,
  automation_id    uuid not null,
  kind             text not null check (kind in ('event', 'audience_entered', 'audience_exited', 'schedule')),
  spec             jsonb not null,
  foreign key (organization_id, automation_id) references platform.automations(organization_id, id) on delete cascade
);

create table platform.automation_actions (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null,
  automation_id    uuid not null,
  position         int not null,
  kind             text not null check (kind in ('push', 'webhook', 'email', 'sms', 'whatsapp', 'add_to_audience', 'remove_from_audience', 'update_user_property', 'delay', 'branch', 'send_event')),
  provider         text,
  spec             jsonb not null,
  foreign key (organization_id, automation_id) references platform.automations(organization_id, id) on delete cascade
);

create table platform.automation_runs (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null,
  automation_id    uuid not null,
  user_key         text not null,
  status           text not null check (status in ('pending', 'waiting', 'running', 'completed', 'failed', 'cancelled')),
  current_step     int not null default 0,
  next_run_at      timestamptz,
  trigger_event_id bigint,
  log              jsonb not null default '[]',
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  foreign key (organization_id, automation_id) references platform.automations(organization_id, id) on delete cascade
);
create index automation_runs_due_idx on platform.automation_runs (next_run_at) where status in ('pending', 'waiting');

create table platform.notifications (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null,
  environment_id   uuid not null,
  channel          text not null check (channel in ('push', 'email', 'sms', 'whatsapp')),
  provider         text not null,
  user_key         text not null,
  automation_run_id uuid references platform.automation_runs(id) on delete set null,
  status           text not null check (status in ('queued', 'sent', 'delivered', 'failed', 'opened')),
  payload          jsonb not null,
  error            text,
  created_at       timestamptz not null default now(),
  sent_at          timestamptz,
  foreign key (organization_id, environment_id) references platform.environments(organization_id, id) on delete cascade
);

-- ════════════════════════════════════════════════════════════════════════════
-- INTEGRATIONS & WEBHOOKS
-- ════════════════════════════════════════════════════════════════════════════
create table platform.integrations (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references platform.organizations(id) on delete cascade,
  app_id           uuid,
  environment_id   uuid,
  provider         text not null,                    -- fcm, apns, appsflyer, adjust, branch, resend, twilio, ...
  config           jsonb not null default '{}',      -- non-secret settings only
  secret_ref       text,                             -- reference into the secret manager; never the secret
  status           text not null default 'active' check (status in ('active', 'disabled', 'error')),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create table platform.webhooks (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null,
  app_id           uuid not null,
  environment_id   uuid not null,
  url              text not null,
  event_types      text[] not null,
  signing_secret_hash text not null,
  status           text not null default 'active' check (status in ('active', 'disabled')),
  created_at       timestamptz not null default now(),
  unique (organization_id, id),
  foreign key (organization_id, app_id, environment_id) references platform.environments(organization_id, app_id, id) on delete cascade
);

create table platform.webhook_deliveries (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null,
  webhook_id       uuid not null,
  event_type       text not null,
  idempotency_key  text not null,
  payload          jsonb not null,
  status           text not null check (status in ('pending', 'succeeded', 'failed', 'giving_up')),
  attempts         int not null default 0,
  next_attempt_at  timestamptz,
  last_status_code int,
  last_error       text,
  created_at       timestamptz not null default now(),
  unique (webhook_id, idempotency_key),
  foreign key (organization_id, webhook_id) references platform.webhooks(organization_id, id) on delete cascade
);

-- ════════════════════════════════════════════════════════════════════════════
-- COMMERCIAL: subscriptions, usage, invoices
-- ════════════════════════════════════════════════════════════════════════════
create table platform.subscriptions (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references platform.organizations(id) on delete cascade,
  plan_id          text not null references platform.plans(id),
  status           text not null check (status in ('trialing', 'active', 'past_due', 'cancelled')),
  provider         text,                             -- stripe, ... (not integrated yet)
  provider_subscription_id text,
  current_period_start timestamptz not null,
  current_period_end   timestamptz not null,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create table platform.usage_meters (
  id           text primary key,                    -- events, monthly_active_users, ...
  unit         text not null,
  aggregation  text not null check (aggregation in ('sum', 'max', 'distinct')),
  description  text not null
);
insert into platform.usage_meters (id, unit, aggregation, description) values
  ('events', 'event', 'sum', 'Events accepted by ingestion'),
  ('monthly_active_users', 'user', 'distinct', 'Distinct identified or anonymous users with an event in the month'),
  ('automation_runs', 'run', 'sum', 'Automation runs started'),
  ('push_messages', 'message', 'sum', 'Push notifications sent'),
  ('api_requests', 'request', 'sum', 'Authenticated API requests'),
  ('storage', 'byte', 'max', 'Stored bytes'),
  ('seats', 'seat', 'max', 'Organization members');

-- Daily rollup per organization and meter (UsageService.record upserts here).
create table platform.usage_records (
  organization_id  uuid not null references platform.organizations(id) on delete cascade,
  meter_id         text not null references platform.usage_meters(id),
  day              date not null,
  quantity         bigint not null default 0,
  updated_at       timestamptz not null default now(),
  primary key (organization_id, meter_id, day)
);

create table platform.invoices (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references platform.organizations(id) on delete cascade,
  subscription_id  uuid references platform.subscriptions(id) on delete set null,
  provider_invoice_id text,
  amount_cents     bigint not null,
  currency         text not null,
  status           text not null check (status in ('draft', 'open', 'paid', 'void', 'uncollectible')),
  period_start     timestamptz not null,
  period_end       timestamptz not null,
  created_at       timestamptz not null default now()
);

-- ════════════════════════════════════════════════════════════════════════════
-- AUDIT, REQUEST LOGS, PRIVACY
-- ════════════════════════════════════════════════════════════════════════════
create table platform.audit_logs (
  id               bigint generated always as identity primary key,
  organization_id  uuid references platform.organizations(id) on delete cascade, -- null = platform-level (e.g. login)
  actor_user_id    uuid references platform.users(id) on delete set null,
  actor_type       text not null default 'user' check (actor_type in ('user', 'system', 'api_key', 'platform_admin')),
  action           text not null,                    -- e.g. api_key.created
  target_type      text,
  target_id        text,
  metadata         jsonb not null default '{}',
  created_at       timestamptz not null default now()
);
create index audit_logs_org_idx on platform.audit_logs (organization_id, created_at desc);

create table platform.api_request_logs (
  id               bigint generated always as identity primary key,
  organization_id  uuid,
  environment_id   uuid,
  route            text not null,
  status_code      int not null,
  duration_ms      int not null,
  credential_kind  text,
  error_code       text,
  created_at       timestamptz not null default now()
);
create index api_request_logs_env_idx on platform.api_request_logs (environment_id, created_at desc);

create table platform.rate_limit_buckets (
  key          text not null,
  window_start timestamptz not null,
  count        int not null,
  primary key (key, window_start)
);

create table platform.privacy_requests (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null,
  environment_id   uuid not null,
  kind             text not null check (kind in ('export', 'deletion', 'tracking_opt_out', 'marketing_opt_out')),
  subject_user_id  text,
  subject_anonymous_id text,
  status           text not null default 'received' check (status in ('received', 'processing', 'completed', 'rejected')),
  requested_by     uuid references platform.users(id) on delete set null,
  created_at       timestamptz not null default now(),
  completed_at     timestamptz,
  foreign key (organization_id, environment_id) references platform.environments(organization_id, id) on delete cascade
);

create table platform.consent_records (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null,
  environment_id   uuid not null,
  user_key         text not null,
  purpose          text not null check (purpose in ('analytics', 'marketing', 'push', 'attribution')),
  granted          boolean not null,
  source           text not null,
  recorded_at      timestamptz not null default now(),
  foreign key (organization_id, environment_id) references platform.environments(organization_id, id) on delete cascade
);

create table platform.data_deletion_jobs (
  id                 uuid primary key default gen_random_uuid(),
  organization_id    uuid not null,
  environment_id     uuid not null,
  privacy_request_id uuid references platform.privacy_requests(id) on delete set null,
  status             text not null default 'queued' check (status in ('queued', 'running', 'completed', 'failed')),
  rows_deleted       bigint not null default 0,
  error              text,
  created_at         timestamptz not null default now(),
  finished_at        timestamptz,
  foreign key (organization_id, environment_id) references platform.environments(organization_id, id) on delete cascade
);

-- ════════════════════════════════════════════════════════════════════════════
-- updated_at triggers
-- ════════════════════════════════════════════════════════════════════════════
do $$
declare t text;
begin
  foreach t in array array['users','organizations','organization_members','apps','environments','tracking_projects',
                           'tracking_plans','app_users','audiences','automations','automation_runs','integrations','subscriptions','plans']
  loop
    execute format('create trigger %I_touch before update on platform.%I for each row execute function platform.touch_updated_at()', t, t);
  end loop;
end $$;

-- ════════════════════════════════════════════════════════════════════════════
-- ROW LEVEL SECURITY
-- ════════════════════════════════════════════════════════════════════════════
-- Tenant tables: full CRUD for platform_app, scoped to the current organization.
do $$
declare t text;
begin
  foreach t in array array[
    'organization_members','organization_invitations','apps','app_platforms','environments','sdk_keys','api_keys',
    'event_batches','events','app_users','anonymous_users','identity_links','sessions','push_tokens',
    'tracking_projects','tracking_questions','tracking_answers','tracking_plans','tracking_plan_versions','tracking_events',
    'tracking_event_properties','tracking_user_properties','tracking_attribution_rules','tracking_implementation_status',
    'tracking_validation_results','event_mappings','implementation_dependencies',
    'attribution_settings','campaigns','attribution_touchpoints','attribution_events','attribution_conversions',
    'audiences','audience_conditions','audience_members','automations','automation_triggers','automation_actions',
    'automation_runs','notifications','integrations','webhooks','webhook_deliveries','subscriptions','usage_records',
    'invoices','privacy_requests','consent_records','data_deletion_jobs']
  loop
    execute format('alter table platform.%I enable row level security', t);
    execute format('create policy tenant_isolation on platform.%I for all to platform_app
                    using (organization_id = platform.current_org_id())
                    with check (organization_id = platform.current_org_id())', t);
    execute format('grant select, insert, update, delete on platform.%I to platform_app', t);
  end loop;
end $$;

-- Organizations: a tenant sees and edits only itself.
alter table platform.organizations enable row level security;
create policy tenant_isolation on platform.organizations for all to platform_app
  using (id = platform.current_org_id()) with check (id = platform.current_org_id());
grant select, update on platform.organizations to platform_app;

-- Users: yourself, plus members of the current organization (for member lists).
alter table platform.users enable row level security;
create policy users_visible on platform.users for select to platform_app using (
  id = platform.current_user_id()
  or exists (select 1 from platform.organization_members m
             where m.user_id = users.id and m.organization_id = platform.current_org_id())
);
create policy users_self_update on platform.users for update to platform_app
  using (id = platform.current_user_id()) with check (id = platform.current_user_id());
grant select (id, email, name, email_verified_at, mfa_enabled, locale, status, created_at) on platform.users to platform_app;
grant update (name, locale) on platform.users to platform_app;

-- Audit log: tenants read their own and append; never update or delete.
alter table platform.audit_logs enable row level security;
create policy audit_read on platform.audit_logs for select to platform_app using (organization_id = platform.current_org_id());
create policy audit_append on platform.audit_logs for insert to platform_app with check (organization_id = platform.current_org_id());
grant select, insert on platform.audit_logs to platform_app;

alter table platform.api_request_logs enable row level security;
create policy tenant_read on platform.api_request_logs for select to platform_app using (organization_id = platform.current_org_id());
grant select on platform.api_request_logs to platform_app;

-- Global reference data: read-only for tenants.
grant select on platform.plans, platform.plan_features, platform.roles, platform.permissions,
                platform.role_permissions, platform.usage_meters, platform.implementation_templates to platform_app;

-- Identity sequences for tables platform_app may insert into.
grant usage on all sequences in schema platform to platform_app;

-- Never granted to platform_app: auth_sessions, user_identities, rate_limit_buckets
-- (system-only, accessed by the owning role in trusted server code).
