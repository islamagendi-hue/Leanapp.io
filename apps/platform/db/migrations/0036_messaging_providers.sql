-- 0036: provider-agnostic messaging. Twilio (SMS, MMS, WhatsApp) as a second
-- adapter next to Meta's WhatsApp Cloud API; template catalog per provider
-- with local drafts; inbound messages and the WhatsApp 24-hour customer
-- service window; SMS suppressions. Additive: no rows are removed or
-- rewritten. See docs/messaging.md.

-- ── Integrations: Twilio joins the per-environment messaging providers ─────
drop index platform.integrations_messaging_env_provider_key;
create unique index integrations_messaging_env_provider_key on platform.integrations (environment_id, provider)
  where environment_id is not null and provider in ('fcm', 'apns', 'resend', 'whatsapp', 'twilio');

-- ── Suppressions: SMS gets its own list ─────────────────────────────────────
alter table platform.suppressions drop constraint suppressions_channel_check;
alter table platform.suppressions add constraint suppressions_channel_check
  check (channel in ('marketing', 'push', 'email', 'whatsapp', 'sms'));

-- ── Synced provider templates: which provider, and what the provider says ──
-- `provider` is the adapter id ('whatsapp_cloud' for Meta, 'twilio' for
-- Twilio Content templates). Existing rows came from Meta. The unique key
-- widens from (environment, name, language) to include the provider, so the
-- same WhatsApp template seen through Meta and Twilio can both be listed.
alter table platform.whatsapp_templates
  add column provider         text not null default 'whatsapp_cloud' check (provider in ('whatsapp_cloud', 'twilio')),
  add column rejected_reason  text,
  add column parameter_format text check (parameter_format in ('POSITIONAL', 'NAMED')),
  add column header_format    text,
  add column variables        jsonb not null default '[]',
  add column quality_score    text;
alter table platform.whatsapp_templates drop constraint whatsapp_templates_environment_id_name_language_key;
create unique index whatsapp_templates_provider_key on platform.whatsapp_templates (environment_id, provider, name, language);

-- ── Local template drafts (not on any provider until submitted) ─────────────
create table platform.message_template_drafts (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null,
  app_id           uuid not null,
  environment_id   uuid not null,
  provider         text not null check (provider in ('whatsapp_cloud')),
  name             text not null check (name ~ '^[a-z0-9_]+$' and char_length(name) <= 512),
  language         text not null check (char_length(language) between 2 and 20),
  category         text not null check (category in ('MARKETING', 'UTILITY', 'AUTHENTICATION')),
  header_text      text check (char_length(header_text) <= 60),
  body             text not null check (char_length(body) between 1 and 1024),
  footer           text check (char_length(footer) <= 60),
  -- One example value per body variable, which Meta requires for review.
  examples         jsonb not null default '[]',
  status           text not null default 'draft' check (status in ('draft', 'submitted', 'failed')),
  external_id      text,
  last_error       text,
  submitted_at     timestamptz,
  created_by       uuid references platform.users(id) on delete set null,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (environment_id, provider, name, language),
  foreign key (organization_id, app_id, environment_id) references platform.environments(organization_id, app_id, id) on delete cascade
);

-- ── Inbound messages (replies) from WhatsApp and SMS ────────────────────────
-- The sender's number is never stored: `sender_hash` is sha256 of environment
-- and number, matched to the person through notifications.recipient_hash.
-- `body` keeps the text (at most 4096 characters) for flow triggers and
-- keyword conditions; rows are purged after 90 days and on deletion requests.
create table platform.inbound_messages (
  id                  bigserial primary key,
  organization_id     uuid not null,
  environment_id      uuid not null,
  integration_id      uuid references platform.integrations(id) on delete set null,
  provider            text not null check (provider in ('whatsapp_cloud', 'twilio')),
  channel             text not null check (channel in ('whatsapp', 'sms')),
  provider_message_id text,
  sender_hash         text not null,
  user_key            text,
  message_type        text not null default 'text',
  body                text check (char_length(body) <= 4096),
  opt_out             boolean not null default false,
  received_at         timestamptz not null default now(),
  foreign key (organization_id, environment_id) references platform.environments(organization_id, id) on delete cascade
);
create unique index inbound_messages_provider_msg_key on platform.inbound_messages (environment_id, provider, provider_message_id) where provider_message_id is not null;
create index inbound_messages_user_idx on platform.inbound_messages (environment_id, user_key, received_at desc) where user_key is not null;
create index inbound_messages_env_idx on platform.inbound_messages (environment_id, id);

-- ── Customer service windows (WhatsApp: 24 hours from the last inbound) ────
create table platform.messaging_sessions (
  organization_id  uuid not null,
  environment_id   uuid not null,
  channel          text not null check (channel in ('whatsapp', 'sms')),
  sender_hash      text not null,
  user_key         text,
  last_inbound_at  timestamptz not null,
  primary key (environment_id, channel, sender_hash),
  foreign key (organization_id, environment_id) references platform.environments(organization_id, id) on delete cascade
);
create index messaging_sessions_user_idx on platform.messaging_sessions (environment_id, channel, user_key) where user_key is not null;

-- ── Usage meter for SMS ─────────────────────────────────────────────────────
insert into platform.usage_meters (id, unit, aggregation, description) values
  ('sms_messages', 'message', 'sum', 'SMS and MMS messages sent')
on conflict (id) do nothing;

-- ── RLS ─────────────────────────────────────────────────────────────────────
do $$
declare t text;
begin
  foreach t in array array['message_template_drafts', 'inbound_messages', 'messaging_sessions']
  loop
    execute format('alter table platform.%I enable row level security', t);
    execute format('create policy tenant_isolation on platform.%I for all to platform_app
                    using (organization_id = platform.current_org_id())
                    with check (organization_id = platform.current_org_id())', t);
    execute format('grant select, insert, update, delete on platform.%I to platform_app', t);
  end loop;
end $$;
grant usage on sequence platform.inbound_messages_id_seq to platform_app;
