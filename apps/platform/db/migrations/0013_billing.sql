-- Billing: plan-limit enforcement, Stripe subscriptions and invoices.
-- See docs/billing.md. Nothing here creates anything in a Stripe account.

-- Stripe Price id per plan. Null = the plan can't be bought online (free,
-- enterprise, or a deployment without Stripe). Set it per deployment, e.g.
--   update platform.plans set stripe_price_id = 'price_123' where id = 'starter';
alter table platform.plans add column stripe_price_id text
  check (stripe_price_id is null or stripe_price_id ~ '^price_[A-Za-z0-9]+$');
create unique index plans_stripe_price_idx on platform.plans (stripe_price_id) where stripe_price_id is not null;

-- Stripe's subscription states, so every webhook maps to a stored state.
alter table platform.subscriptions drop constraint subscriptions_status_check;
alter table platform.subscriptions add constraint subscriptions_status_check
  check (status in ('incomplete', 'incomplete_expired', 'trialing', 'active', 'past_due', 'unpaid', 'paused', 'cancelled'));
alter table platform.subscriptions
  add column provider_customer_id text,
  add column cancel_at_period_end boolean not null default false,
  add column cancelled_at timestamptz,
  -- `created` of the newest provider event applied; older events arriving late are ignored.
  add column provider_event_at timestamptz;
create unique index subscriptions_provider_idx on platform.subscriptions (provider, provider_subscription_id)
  where provider_subscription_id is not null;
create index subscriptions_org_idx on platform.subscriptions (organization_id, created_at desc);

alter table platform.invoices
  add column number text,
  add column hosted_invoice_url text,
  add column invoice_pdf_url text,
  add column paid_at timestamptz,
  add column updated_at timestamptz not null default now();
create unique index invoices_provider_idx on platform.invoices (provider_invoice_id) where provider_invoice_id is not null;
create index invoices_org_idx on platform.invoices (organization_id, period_start desc);
create trigger invoices_touch before update on platform.invoices for each row execute function platform.touch_updated_at();

-- Webhook deliveries already applied, by provider event id (idempotency).
-- System-only: never granted to platform_app.
create table platform.billing_events (
  id               text primary key,                  -- Stripe event id (evt_...)
  provider         text not null default 'stripe',
  type             text not null,
  organization_id  uuid references platform.organizations(id) on delete set null,
  created_at       timestamptz not null,              -- the provider's event time
  received_at      timestamptz not null default now()
);
create index billing_events_received_idx on platform.billing_events (received_at);

-- Usage notices sent to owners: one row per organization, period, limit and
-- threshold, so each email goes out once per period.
create table platform.usage_notices (
  organization_id  uuid not null references platform.organizations(id) on delete cascade,
  period_start     date not null,
  limit_key        text not null,                     -- events
  threshold        int not null check (threshold in (80, 100, 110)),
  used             bigint not null,
  limit_value      bigint not null,
  recipients       int not null default 0,
  delivered        int not null default 0,
  created_at       timestamptz not null default now(),
  primary key (organization_id, period_start, limit_key, threshold)
);
alter table platform.usage_notices enable row level security;
create policy tenant_isolation on platform.usage_notices for all to platform_app
  using (organization_id = platform.current_org_id())
  with check (organization_id = platform.current_org_id());
grant select on platform.usage_notices to platform_app;

-- Events refused because the organization was past its monthly allowance (grace included).
insert into platform.usage_meters (id, unit, aggregation, description) values
  ('events_refused', 'event', 'sum', 'Events refused because the monthly plan allowance (with grace) was used up')
on conflict (id) do nothing;
