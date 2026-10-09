-- Provider connectors (docs/integrations.md, docs/meta-integration.md)
--
-- Additive only. Meta website events (Pixel + Conversions API) and Google
-- Enhanced Conversions need no schema change: they are settings in the
-- existing attribution_postbacks.config (action_source, send_user_data,
-- test_event_code), read at send time by modules/attribution/delivery.ts.
--
-- This migration adds Apple Search Ads attribution lookups (AdServices):
-- the iOS SDK sends AAAttribution.attributionToken() once, as
-- context.attribution.adservices_token; the scheduled worker posts the token
-- to Apple's AdServices API and stores Apple's answer here, as
-- provider-reported data. It does not change any attribution decision: the
-- attribution engine may read these rows as evidence.

-- ── Apple AdServices lookups ───────────────────────────────────────────────
create table platform.adservices_attributions (
  id                 uuid primary key default gen_random_uuid(),
  organization_id    uuid not null,
  app_id             uuid not null,
  environment_id     uuid not null,
  anonymous_id       text,
  user_id            text,
  event_row_id       bigint,                    -- the event that carried the token
  token_hash         text not null,             -- SHA-256 of the token (dedup)
  token              text,                      -- cleared once the lookup is final; Apple accepts it for 24 hours
  token_received_at  timestamptz not null,
  status             text not null default 'pending'
                     check (status in ('pending', 'attributed', 'not_attributed', 'failed', 'expired', 'skipped')),
  skip_reason        text,                      -- consent_denied
  attempts           int not null default 0,
  next_attempt_at    timestamptz not null default now(),
  last_status_code   int,
  last_error         text,
  looked_up_at       timestamptz,               -- last HTTP answer from Apple (any status)
  -- Apple's answer (attribution = true). Campaign data only; no personal data.
  apple_org_id       bigint,
  campaign_id        bigint,
  ad_group_id        bigint,
  keyword_id         bigint,
  ad_id              bigint,
  country_or_region  text,
  conversion_type    text,                      -- Download | Redownload
  claim_type         text,                      -- Click | Impression, when Apple sends it
  click_date         timestamptz,               -- only in the detailed response
  raw                jsonb,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  unique (environment_id, token_hash),
  foreign key (organization_id, app_id, environment_id) references platform.environments(organization_id, app_id, id) on delete cascade
);
create index adservices_attributions_due_idx on platform.adservices_attributions (next_attempt_at) where status = 'pending';
create index adservices_attributions_anon_idx on platform.adservices_attributions (environment_id, anonymous_id);
create index adservices_attributions_env_time_idx on platform.adservices_attributions (environment_id, created_at desc);
create trigger adservices_attributions_touch before update on platform.adservices_attributions for each row execute function platform.touch_updated_at();

alter table platform.adservices_attributions enable row level security;
create policy tenant_isolation on platform.adservices_attributions for all to platform_app
  using (organization_id = platform.current_org_id())
  with check (organization_id = platform.current_org_id());
grant select, insert, update, delete on platform.adservices_attributions to platform_app;
-- The raw token stays in trusted server code (system scope).
revoke select on platform.adservices_attributions from platform_app;
grant select (id, organization_id, app_id, environment_id, anonymous_id, user_id, event_row_id, token_hash, token_received_at, status, skip_reason,
              attempts, next_attempt_at, last_status_code, last_error, looked_up_at, apple_org_id, campaign_id, ad_group_id, keyword_id, ad_id,
              country_or_region, conversion_type, claim_type, click_date, raw, created_at, updated_at)
  on platform.adservices_attributions to platform_app;

-- Where the worker's scan of new events for AdServices tokens has reached.
-- System-only: never granted to platform_app. Starts at the newest event, so
-- deploying this never scans history (tokens expire after 24 hours anyway).
create table platform.adservices_scan_state (
  id             boolean primary key default true check (id),
  last_event_id  bigint not null default 0,
  updated_at     timestamptz not null default now()
);
insert into platform.adservices_scan_state (id, last_event_id) values (true, coalesce((select max(id) from platform.events), 0));
