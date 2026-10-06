-- Deep linking (docs/deep-links.md): per-environment link domain configuration
-- for iOS Universal Links and Android App Links, and the record of deferred
-- deep link lookups (one per install). Tracking links themselves live in
-- attribution_links (0012); a click recorded when an installed app resolves a
-- link is an ordinary attribution_touchpoints row.

-- ── Permissions ─────────────────────────────────────────────────────────────
-- 0002 is generated from src/modules/rbac/permissions.ts and already applied,
-- so new permissions are added here (test/rbac.int.test.ts checks the matrix).
insert into platform.permissions (id, description) values
  ('deep_links.read', 'View deep link settings'),
  ('deep_links.manage', 'Configure deep link domains and app associations')
on conflict (id) do update set description = excluded.description;
insert into platform.role_permissions (role_id, permission_id) values
  ('owner', 'deep_links.read'), ('owner', 'deep_links.manage'),
  ('admin', 'deep_links.read'), ('admin', 'deep_links.manage'),
  ('developer', 'deep_links.read'), ('developer', 'deep_links.manage'),
  ('analyst', 'deep_links.read'),
  ('marketer', 'deep_links.read')
on conflict do nothing;

-- ── Link domain configuration: one per environment ─────────────────────────
-- Links of the environment are served at https://{custom_domain or the LeanApp
-- link host}/l/{link_prefix}/{code}. The prefix is globally unique so several
-- apps (and the dev / production builds of one app) can share a host: the
-- apple-app-site-association file scopes each app to its own prefix.
create table platform.deep_link_configs (
  id                     uuid primary key default gen_random_uuid(),
  organization_id        uuid not null,
  app_id                 uuid not null,
  environment_id         uuid not null unique,
  link_prefix            text not null unique check (link_prefix ~ '^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$'),
  custom_domain          text check (custom_domain ~ '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$'),
  ios_team_id            text check (ios_team_id ~ '^[A-Z0-9]{10}$'),
  ios_bundle_ids         text[] not null default '{}' check (cardinality(ios_bundle_ids) <= 10),
  ios_app_store_id       text check (ios_app_store_id ~ '^[0-9]{5,12}$'),
  uri_scheme             text check (uri_scheme ~ '^[a-z][a-z0-9+.-]{1,40}$'),
  android_package        text check (android_package ~ '^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$'),
  android_sha256         text[] not null default '{}' check (cardinality(android_sha256) <= 10),
  android_play_store_id  text check (android_play_store_id ~ '^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$'),
  deferred_enabled       boolean not null default true,
  interstitial_enabled   boolean not null default true,
  -- Result of the dashboard's "Test" button (what the well-known files look like from outside).
  last_check             jsonb,
  last_checked_at        timestamptz,
  created_by             uuid references platform.users(id) on delete set null,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  unique (organization_id, id),
  foreign key (organization_id, app_id, environment_id) references platform.environments(organization_id, app_id, id) on delete cascade
);
create index deep_link_configs_domain_idx on platform.deep_link_configs (custom_domain) where custom_domain is not null;
create trigger deep_link_configs_touch before update on platform.deep_link_configs for each row execute function platform.touch_updated_at();

-- ── Deferred deep links: one lookup per install ─────────────────────────────
-- The first open after install asks for the deep link of the click the install
-- came from. One row per install (anonymous_id) makes the answer once-only, and
-- a click can be handed to one install only.
create table platform.deep_link_deferred_matches (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null,
  app_id           uuid not null,
  environment_id   uuid not null,
  anonymous_id     text not null,
  touchpoint_id    uuid references platform.attribution_touchpoints(id) on delete set null,
  link_id          uuid references platform.attribution_links(id) on delete set null,
  match_type       text not null check (match_type in ('deterministic', 'probabilistic', 'none')),
  match_key        text,               -- install_referrer | click_id | ip_os
  created_at       timestamptz not null default now(),
  unique (environment_id, anonymous_id),
  foreign key (organization_id, app_id, environment_id) references platform.environments(organization_id, app_id, id) on delete cascade
);
create unique index deep_link_deferred_matches_touchpoint_key on platform.deep_link_deferred_matches (touchpoint_id) where touchpoint_id is not null;
create index deep_link_deferred_matches_env_time_idx on platform.deep_link_deferred_matches (environment_id, created_at desc);

-- ── RLS (same policy as every tenant table, see 0001) ───────────────────────
do $$
declare t text;
begin
  foreach t in array array['deep_link_configs', 'deep_link_deferred_matches']
  loop
    execute format('alter table platform.%I enable row level security', t);
    execute format('create policy tenant_isolation on platform.%I for all to platform_app
                    using (organization_id = platform.current_org_id())
                    with check (organization_id = platform.current_org_id())', t);
    execute format('grant select, insert, update, delete on platform.%I to platform_app', t);
  end loop;
end $$;
