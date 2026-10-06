-- SKAdNetwork / AdAttributionKit postbacks and conversion-value schemas
-- (docs/attribution.md). Nothing here changes existing rows.
-- (File name assigned as 0016_mmp_skan; MMP import was dropped from scope.)

-- SKAdNetwork routing and readiness (per app).
alter table platform.attribution_settings
  add column ios_app_store_id bigint check (ios_app_store_id > 0),
  add column skan_network_ids text[] not null default '{}';
-- Apple sends developer copies of SKAN / AdAttributionKit postbacks to one
-- well-known URL; they are routed by App Store id, so an id belongs to one app.
create unique index attribution_settings_app_store_id on platform.attribution_settings (ios_app_store_id) where ios_app_store_id is not null;

-- ── SKAdNetwork / AdAttributionKit postbacks (developer copies) ─────────────
create table platform.skan_postbacks (
  id                      uuid primary key default gen_random_uuid(),
  organization_id         uuid not null,
  app_id                  uuid not null,
  environment_id          uuid not null,
  framework               text not null check (framework in ('skadnetwork', 'adattributionkit')),
  version                 text,
  key_id                  text,                    -- AdAttributionKit JWS kid
  transaction_id          text not null,           -- SKAN transaction-id / AAK postback-identifier
  ad_network_id           text not null,
  source_identifier       text,                    -- SKAN 4 source-identifier (2–4 digits), else campaign-id
  app_store_id            bigint not null,
  source_app_id           bigint,
  source_domain           text,
  redownload              boolean,
  conversion_type         text,                    -- AAK: download | redownload | re-engagement
  fidelity_type           int,
  ad_interaction_type     text,
  did_win                 boolean,
  postback_sequence_index int not null default 0,
  fine_value              int check (fine_value between 0 and 63),
  coarse_value            text check (coarse_value in ('low', 'medium', 'high')),
  country_code            text,
  marketplace_id          text,
  payload                 jsonb not null,           -- the postback as received (no personal data)
  received_at             timestamptz not null default now(),
  unique (environment_id, framework, transaction_id),
  foreign key (organization_id, app_id, environment_id) references platform.environments(organization_id, app_id, id) on delete cascade
);
create index skan_postbacks_env_idx on platform.skan_postbacks (environment_id, received_at desc);

-- ── Conversion value schema (per app, served to the iOS SDK) ────────────────
create table platform.skan_conversion_schemas (
  organization_id uuid not null,
  app_id          uuid primary key,
  schema          jsonb not null,
  revision        int not null default 1,
  updated_by      uuid references platform.users(id) on delete set null,
  updated_at      timestamptz not null default now(),
  foreign key (organization_id, app_id) references platform.apps(organization_id, id) on delete cascade
);

-- ── RLS (same policy as every tenant table, see 0001) ───────────────────────
do $$
declare t text;
begin
  foreach t in array array['skan_postbacks', 'skan_conversion_schemas']
  loop
    execute format('alter table platform.%I enable row level security', t);
    execute format('create policy tenant_isolation on platform.%I for all to platform_app
                    using (organization_id = platform.current_org_id())
                    with check (organization_id = platform.current_org_id())', t);
    execute format('grant select, insert, update, delete on platform.%I to platform_app', t);
  end loop;
end $$;
