-- 0039: First-party attribution engine (docs/attribution.md "Attribution engine").
--
-- Additive only: new columns are nullable or defaulted, check constraints are
-- widened (never narrowed), and nothing existing is rewritten.
--
--   1. Web touches: a visit on the web that carries campaign evidence (UTM
--      parameters, a click id or an external referrer) is a touchpoint
--      (attribution_touchpoints.kind 'web') and an attribution event
--      (attribution_events.kind 'web_touch'), so web sign-ups and purchases are
--      credited without an app install.
--   2. Every attribution decision records its method, a confidence level and
--      the evidence it rests on (signals seen, window applied, limitations).
--   3. Last non-direct touch: a third credit view next to last and first touch.
--      Direct, organic and unattributed touches never take credit from a
--      known earlier source in it.
--   4. Lookback and conversion windows per channel (window_overrides), next to
--      the app-wide defaults.
--   5. Credit history: every credit a conversion is given (at processing, and
--      again when a delayed touch arrives later) is appended, never overwritten.

-- ── 1. Web touches ──────────────────────────────────────────────────────────
alter table platform.attribution_touchpoints drop constraint if exists attribution_touchpoints_kind_check;
alter table platform.attribution_touchpoints
  add constraint attribution_touchpoints_kind_check check (kind in ('click', 'context', 'web'));

alter table platform.attribution_events drop constraint if exists attribution_events_kind_check;
alter table platform.attribution_events
  add constraint attribution_events_kind_check check (kind in ('install', 'reinstall', 're_engagement', 'deep_link_open', 'web_touch'));

-- ── 2. Method, confidence and evidence of each decision ─────────────────────
alter table platform.attribution_events
  add column method          text,              -- leanapp_click | network_click_recorded | network_click_reported | play_install_referrer | utm_parameters | referrer | probabilistic_ip_os | store_organic | direct | organic_parameters | none
  add column confidence      text check (confidence in ('high', 'medium', 'low', 'none')),
  add column evidence        jsonb not null default '{}',  -- signals seen, window applied, limitations; never secrets or raw IPs
  add column referrer_host   text,              -- web touches: host of the referring page (no path or query)
  add column session_id      text,              -- web touches: the session that carried the touch
  add column touch_signature text;              -- web touches: hash of the campaign evidence, for de-duplication

-- ── 3. Last non-direct touch ────────────────────────────────────────────────
alter table platform.attribution_settings drop constraint if exists attribution_settings_reporting_model_check;
alter table platform.attribution_settings
  add constraint attribution_settings_reporting_model_check check (reporting_model in ('last_touch', 'first_touch', 'last_non_direct'));

alter table platform.attribution_conversions
  add column last_non_direct_attribution_event_id uuid references platform.attribution_events(id) on delete set null,
  add column last_non_direct_recorded boolean not null default false,
  add column credit_evidence jsonb not null default '{}';
create index attribution_conversions_lnd_event_idx on platform.attribution_conversions (last_non_direct_attribution_event_id)
  where last_non_direct_attribution_event_id is not null;

-- ── 4. Windows per channel ──────────────────────────────────────────────────
-- {"<channel key>": {"click_lookback_days": 1-90, "conversion_window_days": 1-730}}; validated by the app.
alter table platform.attribution_settings
  add column window_overrides jsonb not null default '{}' check (jsonb_typeof(window_overrides) = 'object');

-- ── 5. Credit history ───────────────────────────────────────────────────────
create table platform.attribution_conversion_credits (
  id                    uuid primary key default gen_random_uuid(),
  organization_id       uuid not null,
  app_id                uuid not null,
  environment_id        uuid not null,
  conversion_id         uuid not null references platform.attribution_conversions(id) on delete cascade,
  reason                text not null check (reason in ('initial', 'late_touch')),
  last_touch_event_id       uuid references platform.attribution_events(id) on delete set null,
  first_touch_event_id      uuid references platform.attribution_events(id) on delete set null,
  last_non_direct_event_id  uuid references platform.attribution_events(id) on delete set null,
  evidence              jsonb not null default '{}',
  decided_at            timestamptz not null default now(),
  foreign key (organization_id, app_id, environment_id) references platform.environments(organization_id, app_id, id) on delete cascade
);
create index attribution_conversion_credits_conversion_idx on platform.attribution_conversion_credits (conversion_id, decided_at);

alter table platform.attribution_conversion_credits enable row level security;
create policy tenant_isolation on platform.attribution_conversion_credits for all to platform_app
  using (organization_id = platform.current_org_id())
  with check (organization_id = platform.current_org_id());
grant select, insert, update, delete on platform.attribution_conversion_credits to platform_app;
