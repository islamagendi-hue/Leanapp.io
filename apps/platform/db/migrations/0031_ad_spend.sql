-- 0031: ad spend, entered by hand or by CSV (docs/attribution-architecture.md
-- `ad_spend_daily`, MVP). One row per environment, calendar day (app
-- timezone), source, campaign and currency; entering the same day again
-- replaces the amount. `source` uses the same labels as the attribution
-- `source` the Acquisition reports show (tiktok, meta, google…), so the
-- Revenue report broken down by channel can put spend next to revenue (matched
-- ignoring case). No campaign is stored as ''. Amounts stay in their own
-- currency: nothing is converted or added across currencies.
-- Automatic import from ad-network APIs is not built.
create table platform.ad_spend_daily (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null,
  environment_id   uuid not null,
  day              date not null,
  source           text not null check (char_length(source) between 1 and 100),
  campaign         text not null default '' check (char_length(campaign) <= 100),
  currency         text not null check (currency ~ '^[A-Z]{3}$'),
  amount           numeric(14, 2) not null check (amount >= 0),
  created_by       uuid references platform.users(id) on delete set null,
  updated_by       uuid references platform.users(id) on delete set null,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (environment_id, day, source, campaign, currency),
  foreign key (organization_id, environment_id) references platform.environments(organization_id, id) on delete cascade
);
create index ad_spend_daily_environment_day_idx on platform.ad_spend_daily (environment_id, day desc);

create trigger ad_spend_daily_touch before update on platform.ad_spend_daily for each row execute function platform.touch_updated_at();
alter table platform.ad_spend_daily enable row level security;
create policy tenant_isolation on platform.ad_spend_daily for all to platform_app
  using (organization_id = platform.current_org_id())
  with check (organization_id = platform.current_org_id());
grant select, insert, update, delete on platform.ad_spend_daily to platform_app;
