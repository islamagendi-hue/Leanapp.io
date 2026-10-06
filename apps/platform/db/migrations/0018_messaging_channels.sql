-- 0018: messaging channels for automations: WhatsApp (Meta Cloud API) and
-- email campaigns on the customer's Resend account (sending domain,
-- templates, one-click unsubscribe). See docs/messaging.md.

-- ── Notifications: provider ids, receipts, opt-out matching ─────────────────
-- provider_message_id: FCM name / Resend id / WhatsApp wamid, for delivery
-- status callbacks. recipient_hash: sha256 of environment + phone, to map an
-- inbound WhatsApp STOP to the person without storing the number.
-- unsubscribe_token_hash: sha256 of the one-click unsubscribe token in an email.
alter table platform.notifications drop constraint notifications_status_check;
alter table platform.notifications add constraint notifications_status_check
  check (status in ('queued', 'sent', 'delivered', 'read', 'failed', 'opened', 'skipped'));
alter table platform.notifications
  add column provider_message_id    text,
  add column recipient_hash         text,
  add column unsubscribe_token_hash text,
  add column delivered_at           timestamptz,
  add column read_at                timestamptz;
create index notifications_provider_msg_idx on platform.notifications (environment_id, provider_message_id) where provider_message_id is not null;
create index notifications_recipient_idx on platform.notifications (environment_id, recipient_hash, created_at desc) where recipient_hash is not null;
create unique index notifications_unsubscribe_key on platform.notifications (unsubscribe_token_hash) where unsubscribe_token_hash is not null;

-- ── Integrations: live verification, WhatsApp webhook verify token ─────────
alter table platform.integrations
  -- First successful send to the provider's real API (not a local mock).
  add column live_verified_at  timestamptz,
  -- sha256 of a token we issue (WhatsApp webhook verify token); shown once.
  add column verify_token_hash text;
drop index platform.integrations_messaging_env_provider_key;
create unique index integrations_messaging_env_provider_key on platform.integrations (environment_id, provider)
  where environment_id is not null and provider in ('fcm', 'apns', 'resend', 'whatsapp');

-- ── WhatsApp message templates (synced from the WhatsApp Business account) ──
create table platform.whatsapp_templates (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null,
  app_id           uuid not null,
  environment_id   uuid not null,
  integration_id   uuid not null references platform.integrations(id) on delete cascade,
  external_id      text,
  name             text not null,
  language         text not null,
  category         text,
  status           text not null,
  components       jsonb not null default '[]',
  body_params      int not null default 0,
  header_params    int not null default 0,
  synced_at        timestamptz not null default now(),
  unique (environment_id, name, language),
  foreign key (organization_id, app_id, environment_id) references platform.environments(organization_id, app_id, id) on delete cascade
);

-- ── Email: templates and the customer's sending domain ──────────────────────
create table platform.email_templates (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null,
  app_id           uuid not null,
  environment_id   uuid not null,
  name             text not null check (char_length(name) between 2 and 80),
  subject          text not null check (char_length(subject) between 1 and 200),
  body             text not null check (char_length(body) between 1 and 20000),
  created_by       uuid references platform.users(id) on delete set null,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (environment_id, name),
  foreign key (organization_id, app_id, environment_id) references platform.environments(organization_id, app_id, id) on delete cascade
);

create table platform.email_domains (
  id                 uuid primary key default gen_random_uuid(),
  organization_id    uuid not null,
  app_id             uuid not null,
  environment_id     uuid not null unique,
  integration_id     uuid not null references platform.integrations(id) on delete cascade,
  name               text not null,
  provider_domain_id text not null,
  status             text not null,
  records            jsonb not null default '[]',
  last_checked_at    timestamptz not null default now(),
  created_at         timestamptz not null default now(),
  foreign key (organization_id, app_id, environment_id) references platform.environments(organization_id, app_id, id) on delete cascade
);

-- ── Usage meters for the new channels ───────────────────────────────────────
insert into platform.usage_meters (id, unit, aggregation, description) values
  ('whatsapp_messages', 'message', 'sum', 'WhatsApp template messages sent'),
  ('email_messages', 'message', 'sum', 'Automation emails sent')
on conflict (id) do nothing;

-- ── RLS ─────────────────────────────────────────────────────────────────────
do $$
declare t text;
begin
  foreach t in array array['whatsapp_templates', 'email_templates', 'email_domains']
  loop
    execute format('alter table platform.%I enable row level security', t);
    execute format('create policy tenant_isolation on platform.%I for all to platform_app
                    using (organization_id = platform.current_org_id())
                    with check (organization_id = platform.current_org_id())', t);
    execute format('grant select, insert, update, delete on platform.%I to platform_app', t);
  end loop;
end $$;
