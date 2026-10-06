-- Attribution engine (docs/attribution.md): tracking links, click touchpoints,
-- install / re-engagement matching, conversions and ad-network postbacks.
-- Everything is scoped per environment so production attribution never mixes
-- with development traffic.

-- ── Settings ────────────────────────────────────────────────────────────────
alter table platform.attribution_settings
  add column probabilistic_enabled boolean not null default false,
  add column probabilistic_window_hours int not null default 24 check (probabilistic_window_hours between 1 and 168),
  add column conversion_window_days int not null default 90 check (conversion_window_days between 1 and 730),
  add column reengagement_enabled boolean not null default true;
alter table platform.attribution_settings
  add constraint attribution_settings_click_lookback check (click_lookback_days between 1 and 90),
  add constraint attribution_settings_view_lookback check (view_lookback_hours between 0 and 720);

-- ── Tracking links ──────────────────────────────────────────────────────────
create table platform.attribution_links (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null,
  app_id           uuid not null,
  environment_id   uuid not null,
  code             text not null unique check (code ~ '^[A-Za-z0-9_-]{6,32}$'),
  name             text not null check (length(name) between 1 and 120),
  source           text not null check (length(source) between 1 and 100),
  medium           text,
  campaign         text,
  ad_group         text,
  creative         text,
  ios_url          text,
  android_url      text,
  web_url          text,
  deep_link_path   text,
  status           text not null default 'active' check (status in ('active', 'paused')),
  created_by       uuid references platform.users(id) on delete set null,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (organization_id, id),
  check (ios_url is not null or android_url is not null or web_url is not null),
  foreign key (organization_id, app_id, environment_id) references platform.environments(organization_id, app_id, id) on delete cascade
);
create index attribution_links_env_idx on platform.attribution_links (environment_id, created_at desc);
create trigger attribution_links_touch before update on platform.attribution_links for each row execute function platform.touch_updated_at();

-- ── Touchpoints: clicks on links plus what installs carry in their context ─
alter table platform.attribution_touchpoints
  add column kind             text not null default 'context' check (kind in ('click', 'context')),
  add column link_id          uuid references platform.attribution_links(id) on delete set null,
  add column network_click_id text,            -- gclid / fbclid / ttclid / ScCid … appended by the ad network to the link
  add column network          text,            -- which ad network the network_click_id belongs to
  add column ip_hash          text,            -- keyed HMAC of the IP; cleared after 7 days. Never the raw IP.
  add column user_agent       text,            -- truncated; cleared with ip_hash
  add column os_name          text,            -- ios | android | other (from the user agent)
  add column os_major         text,
  add column country          text,            -- coarse geo from the edge (x-vercel-ip-country), when present
  add column matched_at       timestamptz;     -- first install / re-engagement attributed to this click
create index attribution_touchpoints_click_idx on platform.attribution_touchpoints (environment_id, click_id) where click_id is not null;
create index attribution_touchpoints_network_idx on platform.attribution_touchpoints (environment_id, network_click_id) where network_click_id is not null;
create index attribution_touchpoints_ip_idx on platform.attribution_touchpoints (environment_id, ip_hash, touchpoint_at) where ip_hash is not null;
create index attribution_touchpoints_link_idx on platform.attribution_touchpoints (link_id, touchpoint_at) where link_id is not null;
create index attribution_touchpoints_env_time_idx on platform.attribution_touchpoints (environment_id, touchpoint_at desc);

-- ── Attribution events: one row per install / reinstall / re-engagement ────
alter table platform.attribution_events
  add column match_type   text not null default 'organic' check (match_type in ('deterministic', 'probabilistic', 'organic')),
  add column match_key    text,               -- click_id | install_referrer | deep_link | gclid | … | utm_parameters | ip_ua
  add column event_row_id bigint,
  add column device_id    text,
  add column platform     text,
  add column link_id      uuid references platform.attribution_links(id) on delete set null,
  add column source       text,
  add column medium       text,
  add column campaign     text,
  add column network      text;
create unique index attribution_events_row_key on platform.attribution_events (environment_id, event_row_id) where event_row_id is not null;
create unique index attribution_events_install_key on platform.attribution_events (environment_id, anonymous_id) where kind in ('install', 'reinstall') and anonymous_id is not null;
create index attribution_events_anon_idx on platform.attribution_events (environment_id, anonymous_id, occurred_at desc);
create index attribution_events_user_idx on platform.attribution_events (environment_id, user_id, occurred_at desc) where user_id is not null;
create index attribution_events_device_idx on platform.attribution_events (environment_id, device_id) where device_id is not null;
create index attribution_events_env_time_idx on platform.attribution_events (environment_id, occurred_at desc);
create index attribution_events_touchpoint_idx on platform.attribution_events (touchpoint_id) where touchpoint_id is not null;

-- ── Conversions ─────────────────────────────────────────────────────────────
alter table platform.attribution_conversions add column created_at timestamptz not null default now();
create unique index attribution_conversions_row_key on platform.attribution_conversions (environment_id, event_row_id) where event_row_id is not null;
create index attribution_conversions_env_time_idx on platform.attribution_conversions (environment_id, occurred_at desc);
create index attribution_conversions_event_idx on platform.attribution_conversions (attribution_event_id) where attribution_event_id is not null;

-- ── Postbacks ───────────────────────────────────────────────────────────────
create table platform.attribution_postbacks (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null,
  app_id           uuid not null,
  environment_id   uuid not null,
  network          text not null check (network in ('custom', 'tiktok', 'snapchat', 'meta', 'google')),
  name             text not null check (length(name) between 1 and 120),
  -- 'install', 'reinstall', 're_engagement' and/or conversion event names
  events           text[] not null check (cardinality(events) between 1 and 50),
  -- Touchpoint sources this postback reports; empty = every attributed source.
  sources          text[] not null default '{}',
  include_organic  boolean not null default false,
  url_template     text,                       -- custom network only
  http_method      text not null default 'GET' check (http_method in ('GET', 'POST')),
  config           jsonb not null default '{}', -- non-secret settings (pixel / app / dataset ids)
  credentials_enc  text,                       -- AES-256-GCM, INTEGRATIONS_ENCRYPTION_KEY; never returned to the browser
  has_credentials  boolean generated always as (credentials_enc is not null) stored,
  status           text not null default 'active' check (status in ('active', 'paused')),
  created_by       uuid references platform.users(id) on delete set null,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (organization_id, id),
  check (network <> 'custom' or url_template is not null),
  foreign key (organization_id, app_id, environment_id) references platform.environments(organization_id, app_id, id) on delete cascade
);
create index attribution_postbacks_env_idx on platform.attribution_postbacks (environment_id) where status = 'active';
create trigger attribution_postbacks_touch before update on platform.attribution_postbacks for each row execute function platform.touch_updated_at();

create table platform.attribution_postback_deliveries (
  id                   uuid primary key default gen_random_uuid(),
  organization_id      uuid not null,
  environment_id       uuid not null,
  postback_id          uuid not null,
  attribution_event_id uuid references platform.attribution_events(id) on delete set null,
  conversion_id        uuid references platform.attribution_conversions(id) on delete set null,
  event_name           text not null,
  idempotency_key      text not null,
  payload              jsonb not null,         -- macro values: click_id, event, revenue, currency, timestamp, …
  status               text not null default 'pending' check (status in ('pending', 'succeeded', 'failed', 'giving_up')),
  attempts             int not null default 0,
  next_attempt_at      timestamptz not null default now(),
  last_status_code     int,
  last_error           text,
  delivered_at         timestamptz,
  created_at           timestamptz not null default now(),
  unique (postback_id, idempotency_key),
  foreign key (organization_id, postback_id) references platform.attribution_postbacks(organization_id, id) on delete cascade
);
create index attribution_postback_deliveries_due_idx on platform.attribution_postback_deliveries (next_attempt_at) where status = 'pending';
create index attribution_postback_deliveries_postback_idx on platform.attribution_postback_deliveries (postback_id, created_at desc);

-- ── RLS (same policy as every tenant table, see 0001) ───────────────────────
do $$
declare t text;
begin
  foreach t in array array['attribution_links', 'attribution_postbacks', 'attribution_postback_deliveries']
  loop
    execute format('alter table platform.%I enable row level security', t);
    execute format('create policy tenant_isolation on platform.%I for all to platform_app
                    using (organization_id = platform.current_org_id())
                    with check (organization_id = platform.current_org_id())', t);
    execute format('grant select, insert, update, delete on platform.%I to platform_app', t);
  end loop;
end $$;
-- The encrypted credentials never leave trusted server code (system scope).
revoke select on platform.attribution_postbacks from platform_app;
grant select (id, organization_id, app_id, environment_id, network, name, events, sources, include_organic, url_template,
              http_method, config, has_credentials, status, created_by, created_at, updated_at) on platform.attribution_postbacks to platform_app;
