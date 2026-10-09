-- 0034: growth channels (docs/channels.md). Additive only.
--   1. channel_definitions: customer-defined channels per app (built-in channels live in code,
--      src/modules/channels/registry.ts, and are never stored)
--   2. channel_rules: per-app rules that put touches (source, medium, campaign prefix, referrer
--      host, click id, referral id) on a channel, before the built-in rules
--   3. attribution_settings.reporting_model: the default credit model the reports open with
--   4. attribution_conversions.first_attribution_event_id: first-touch credit next to the
--      existing last-touch attribution_event_id, written by event processing from now on

-- ── 1. Custom channels ──────────────────────────────────────────────────────
create table platform.channel_definitions (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null,
  app_id           uuid not null,
  key              text not null check (key ~ '^custom_[a-z0-9_]{1,40}$'),
  label            text not null check (char_length(label) between 1 and 80),
  channel_group    text not null check (channel_group in ('paid', 'organic', 'owned', 'referral', 'custom')),
  description      text not null default '' check (char_length(description) <= 300),
  status           text not null default 'active' check (status in ('active', 'archived')),
  created_by       uuid references platform.users(id) on delete set null,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (app_id, key),
  unique (organization_id, id),
  foreign key (organization_id, app_id) references platform.apps(organization_id, id) on delete cascade
);
create trigger channel_definitions_touch before update on platform.channel_definitions for each row execute function platform.touch_updated_at();

-- ── 2. Channel rules ────────────────────────────────────────────────────────
-- conditions: {"source": [..], "medium": [..], "campaignPrefix": "..", "referrerHost": "..",
--              "clickIdParam": "..", "hasReferralId": true}; every condition given must hold.
-- channel_key is a built-in key or a custom_ key of the same app (checked by the service; a rule
-- pointing at an archived or missing channel is skipped at report time).
create table platform.channel_rules (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null,
  app_id           uuid not null,
  channel_key      text not null check (channel_key ~ '^[a-z][a-z0-9_]{1,47}$'),
  priority         int not null default 100 check (priority between 1 and 1000),
  conditions       jsonb not null check (jsonb_typeof(conditions) = 'object' and conditions <> '{}'::jsonb),
  note             text not null default '' check (char_length(note) <= 200),
  status           text not null default 'active' check (status in ('active', 'paused')),
  created_by       uuid references platform.users(id) on delete set null,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (organization_id, id),
  foreign key (organization_id, app_id) references platform.apps(organization_id, id) on delete cascade
);
create index channel_rules_app_idx on platform.channel_rules (app_id, priority) where status = 'active';
create trigger channel_rules_touch before update on platform.channel_rules for each row execute function platform.touch_updated_at();

do $$
declare t text;
begin
  foreach t in array array['channel_definitions', 'channel_rules']
  loop
    execute format('alter table platform.%I enable row level security', t);
    execute format('create policy tenant_isolation on platform.%I for all to platform_app
                    using (organization_id = platform.current_org_id())
                    with check (organization_id = platform.current_org_id())', t);
    execute format('grant select, insert, update, delete on platform.%I to platform_app', t);
  end loop;
end $$;

-- ── 3. Default reporting model ──────────────────────────────────────────────
alter table platform.attribution_settings
  add column reporting_model text not null default 'last_touch' check (reporting_model in ('last_touch', 'first_touch'));

-- ── 4. First-touch credit on conversions ────────────────────────────────────
-- The person's earliest install / reinstall / re-engagement within the conversion window. Null on
-- conversions processed before this migration (reports count them as "first touch not recorded").
alter table platform.attribution_conversions
  add column first_attribution_event_id uuid references platform.attribution_events(id) on delete set null,
  add column first_touch_recorded boolean not null default false;
create index attribution_conversions_first_event_idx on platform.attribution_conversions (first_attribution_event_id) where first_attribution_event_id is not null;
