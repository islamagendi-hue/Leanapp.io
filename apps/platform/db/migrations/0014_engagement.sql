-- ════════════════════════════════════════════════════════════════════════════
-- Phase 4: audiences, automation engine, customer webhooks, push, in-app.
-- See docs/audiences.md, docs/automation.md, docs/webhooks.md.
--
-- Source of truth for definitions is the jsonb `definition` on audiences and
-- automations (validated in code). The normalized tables from 0001
-- (audience_conditions, automation_triggers, automation_actions) stay unused.
-- ════════════════════════════════════════════════════════════════════════════

-- ── Audiences ────────────────────────────────────────────────────────────────
alter table platform.audiences
  add column refresh_minutes   int not null default 15 check (refresh_minutes between 5 and 1440),
  add column last_compute_ms   int,
  add column last_compute_error text,
  add column activated_at      timestamptz,
  -- Set when the definition changes: the next computation records transitions
  -- as `initial`, so editing an audience doesn't fire "entered" automations for everyone.
  add column needs_baseline    boolean not null default true,
  add column updated_by        uuid references platform.users(id) on delete set null;
create index audiences_due_idx on platform.audiences (last_computed_at nulls first) where status = 'active';

create index audience_members_current_idx on platform.audience_members (audience_id) where exited_at is null;

-- Membership transitions, consumed by automations (cursor on id) and webhooks.
-- `initial` marks the first computation of an audience: people already in it
-- when it is activated don't trigger "entered" automations.
create table platform.audience_events (
  id               bigint generated always as identity primary key,
  organization_id  uuid not null,
  audience_id      uuid not null,
  user_key         text not null,
  kind             text not null check (kind in ('entered', 'exited')),
  initial          boolean not null default false,
  occurred_at      timestamptz not null default now(),
  foreign key (organization_id, audience_id) references platform.audiences(organization_id, id) on delete cascade
);
create index audience_events_audience_idx on platform.audience_events (audience_id, id);

-- Size after each computation (size history chart).
create table platform.audience_snapshots (
  organization_id  uuid not null,
  audience_id      uuid not null,
  computed_at      timestamptz not null default now(),
  member_count     bigint not null,
  entered          int not null,
  exited           int not null,
  primary key (audience_id, computed_at),
  foreign key (organization_id, audience_id) references platform.audiences(organization_id, id) on delete cascade
);

-- ── Automations ──────────────────────────────────────────────────────────────
alter table platform.automations
  add column trigger_cursor bigint,                  -- last events.id / audience_events.id consumed
  add column next_fire_at   timestamptz,             -- schedule trigger
  add column activated_at   timestamptz,
  add column updated_by     uuid references platform.users(id) on delete set null;

-- Every saved definition is a version; runs keep the version they started on.
create table platform.automation_versions (
  organization_id  uuid not null,
  automation_id    uuid not null,
  version          int not null,
  definition       jsonb not null,
  created_by       uuid references platform.users(id) on delete set null,
  created_at       timestamptz not null default now(),
  primary key (automation_id, version),
  foreign key (organization_id, automation_id) references platform.automations(organization_id, id) on delete cascade
);

alter table platform.automation_runs
  add column environment_id uuid,
  add column version        int not null default 1,
  add column trigger_key    text,                    -- idempotency: one run per (automation, user, trigger)
  add column trigger_data   jsonb not null default '{}',
  add column started_at     timestamptz not null default now(),
  add column finished_at    timestamptz,
  add column attempts       int not null default 0,
  add column last_error     text;
alter table platform.automation_runs add constraint automation_runs_org_id_key unique (organization_id, id);
create unique index automation_runs_trigger_key on platform.automation_runs (automation_id, user_key, trigger_key) where trigger_key is not null;
create index automation_runs_claim_idx on platform.automation_runs (next_run_at) where status in ('pending', 'waiting', 'running');
create index automation_runs_automation_idx on platform.automation_runs (automation_id, created_at desc);
create index automation_runs_user_idx on platform.automation_runs (automation_id, user_key, started_at desc);

-- ── Notifications (push, email) ──────────────────────────────────────────────
alter table platform.notifications drop constraint notifications_status_check;
alter table platform.notifications add constraint notifications_status_check
  check (status in ('queued', 'sent', 'delivered', 'failed', 'opened', 'skipped'));
alter table platform.notifications
  add column step           int,
  add column push_token_id  uuid references platform.push_tokens(id) on delete set null;
create index notifications_user_idx on platform.notifications (environment_id, user_key, created_at desc);
create unique index notifications_run_step_token_key on platform.notifications (automation_run_id, step, coalesce(push_token_id, '00000000-0000-0000-0000-000000000000'::uuid))
  where automation_run_id is not null;

-- ── In-app messages (polled by the SDK with its public key) ──────────────────
create table platform.in_app_messages (
  id                uuid primary key default gen_random_uuid(),
  organization_id   uuid not null,
  app_id            uuid not null,
  environment_id    uuid not null,
  user_key          text not null,
  automation_id     uuid,
  automation_run_id uuid,
  step              int,
  title             text not null,
  body              text not null,
  button_text       text,
  deep_link         text,
  data              jsonb not null default '{}',
  status            text not null default 'pending' check (status in ('pending', 'displayed', 'clicked', 'dismissed', 'expired')),
  created_at        timestamptz not null default now(),
  expires_at        timestamptz not null,
  displayed_at      timestamptz,
  clicked_at        timestamptz,
  dismissed_at      timestamptz,
  unique (automation_run_id, step),
  foreign key (organization_id, app_id, environment_id) references platform.environments(organization_id, app_id, id) on delete cascade,
  foreign key (organization_id, automation_run_id) references platform.automation_runs(organization_id, id) on delete cascade
);
create index in_app_messages_user_idx on platform.in_app_messages (environment_id, user_key, created_at desc);

-- ── Integrations (push credentials etc.) ─────────────────────────────────────
-- Customer-provided credentials are encrypted at rest (AES-256-GCM, key from
-- INTEGRATIONS_ENCRYPTION_KEY) in `secret_ciphertext`; `config` holds only
-- non-secret settings. `secret_ref` stays unused.
alter table platform.integrations
  add column secret_ciphertext text,
  add column last_error        text,
  add column last_used_at      timestamptz,
  add column created_by        uuid references platform.users(id) on delete set null;
alter table platform.integrations add constraint integrations_environment_fk
  foreign key (organization_id, app_id, environment_id) references platform.environments(organization_id, app_id, id) on delete cascade;
create unique index integrations_messaging_env_provider_key on platform.integrations (environment_id, provider)
  where environment_id is not null and provider in ('fcm', 'apns', 'resend');

-- ── Webhooks ─────────────────────────────────────────────────────────────────
-- To sign deliveries the secret itself is needed, so it is stored encrypted
-- (AES-256-GCM); the hash stays for display/verification. Shown once at creation.
alter table platform.webhooks
  add column description              text,
  add column signing_secret_ciphertext text,
  add column secret_prefix            text,
  add column created_by               uuid references platform.users(id) on delete set null,
  add column updated_at               timestamptz not null default now();
alter table platform.webhooks add constraint webhooks_event_types_known
  check (cardinality(event_types) > 0 and event_types <@ array['audience.entered', 'audience.exited', 'automation.webhook', 'webhook.test']::text[]);
create trigger webhooks_touch before update on platform.webhooks for each row execute function platform.touch_updated_at();

alter table platform.webhook_deliveries
  add column environment_id    uuid,
  add column automation_run_id uuid,
  add column last_attempt_at   timestamptz,
  add column last_duration_ms  int,
  add column last_response     text,
  add column succeeded_at      timestamptz;
create index webhook_deliveries_due_idx on platform.webhook_deliveries (next_attempt_at) where status = 'pending';
create index webhook_deliveries_webhook_idx on platform.webhook_deliveries (webhook_id, created_at desc);

-- ── Consent lookups ──────────────────────────────────────────────────────────
create index consent_records_user_idx on platform.consent_records (environment_id, user_key, purpose, recorded_at desc);

-- ── RLS for the new tenant tables ────────────────────────────────────────────
do $$
declare t text;
begin
  foreach t in array array['audience_events', 'audience_snapshots', 'automation_versions', 'in_app_messages']
  loop
    execute format('alter table platform.%I enable row level security', t);
    execute format('create policy tenant_isolation on platform.%I for all to platform_app
                    using (organization_id = platform.current_org_id())
                    with check (organization_id = platform.current_org_id())', t);
    execute format('grant select, insert, update, delete on platform.%I to platform_app', t);
  end loop;
end $$;
grant usage on all sequences in schema platform to platform_app;
