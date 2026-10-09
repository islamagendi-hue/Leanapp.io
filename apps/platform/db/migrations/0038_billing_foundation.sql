-- Billing foundation: plan catalog fields, billing customers per provider mode,
-- richer subscription and invoice state, webhook event outcomes, provider
-- verification checks. Additive only. See docs/billing.md.
-- Nothing here creates anything in a Stripe account, and no Stripe ids are
-- stored as data: Stripe price ids come from STRIPE_PRICE_<PLAN>_<INTERVAL>.

-- ── Plan catalog ────────────────────────────────────────────────────────────
-- checkout: how a plan is bought. self_serve = Stripe Checkout when its price
-- is configured; sales = priced on a call (contact sales); none = not sold
-- (the evaluation plan every organization starts on).
alter table platform.plans
  add column checkout text not null default 'none' check (checkout in ('self_serve', 'sales', 'none')),
  add column price_annual_cents bigint check (price_annual_cents is null or price_annual_cents >= 0),
  -- The monthly price is a starting price ("from $599") that grows with usage.
  add column price_is_minimum boolean not null default false,
  -- Usage above the included allowance is meant to be billed (not charged yet: see docs/billing.md).
  add column usage_based boolean not null default false,
  -- Trial length offered at checkout; null = no trial.
  add column trial_days int check (trial_days is null or trial_days between 1 and 90);

-- The public pricing (marketing/landing.ts): Starter $399 a month (2M events,
-- up to 3 apps), Growth from $599 a month (from 20M events, priced by usage),
-- Enterprise priced on a call. Pro is not on the public pricing: sales-led.
update platform.plans set checkout = 'self_serve', price_monthly_cents = 39900, currency = 'USD' where id = 'starter';
update platform.plans set checkout = 'self_serve', price_monthly_cents = 59900, currency = 'USD',
  price_is_minimum = true, usage_based = true where id = 'growth';
update platform.plans set checkout = 'sales', is_public = false where id = 'pro';
update platform.plans set checkout = 'sales' where id = 'enterprise';
-- The plan organizations start on is an evaluation allowance, not an offer.
update platform.plans set name = 'Evaluation', checkout = 'none' where id = 'free' and name = 'Free';

-- ── Billing customers ───────────────────────────────────────────────────────
-- One provider customer per organization and mode: a Stripe test-mode customer
-- doesn't exist in live mode, so switching keys never reuses the wrong one.
create table platform.billing_customers (
  id                    uuid primary key default gen_random_uuid(),
  organization_id       uuid not null references platform.organizations(id) on delete cascade,
  provider              text not null default 'stripe',
  livemode              boolean not null,
  provider_customer_id  text not null,
  created_at            timestamptz not null default now(),
  unique (organization_id, provider, livemode),
  unique (provider, provider_customer_id)
);
alter table platform.billing_customers enable row level security;
create policy tenant_isolation on platform.billing_customers for all to platform_app
  using (organization_id = platform.current_org_id())
  with check (organization_id = platform.current_org_id());
grant select, insert on platform.billing_customers to platform_app;

-- Existing customer ids can only come from test keys (no live Stripe account exists yet).
insert into platform.billing_customers (organization_id, provider, livemode, provider_customer_id)
select id, 'stripe', false, billing_customer_id from platform.organizations where billing_customer_id is not null
on conflict do nothing;

-- ── Subscriptions ───────────────────────────────────────────────────────────
alter table platform.subscriptions
  add column provider_price_id text,
  add column billing_interval text check (billing_interval is null or billing_interval in ('month', 'year')),
  add column currency text,
  add column trial_start timestamptz,
  add column trial_end timestamptz,
  add column ended_at timestamptz,
  add column livemode boolean;

-- ── Invoices ────────────────────────────────────────────────────────────────
alter table platform.invoices
  add column amount_refunded_cents bigint not null default 0,
  add column refunded_at timestamptz,
  add column provider_payment_intent_id text,
  add column livemode boolean;
create index invoices_payment_intent_idx on platform.invoices (provider_payment_intent_id) where provider_payment_intent_id is not null;

-- ── Webhook events ──────────────────────────────────────────────────────────
-- outcome: applied, ignored (type not handled), stale (older than the state
-- already applied), unmatched (no organization), mode_mismatch (test event on
-- live keys or the reverse), failed (rolled back; the provider retries).
alter table platform.billing_events
  add column livemode boolean,
  add column object_id text,
  add column outcome text not null default 'applied'
    check (outcome in ('applied', 'ignored', 'stale', 'unmatched', 'mode_mismatch', 'failed')),
  add column error_code text,
  add column attempts int not null default 1,
  add column processed_at timestamptz;
create index billing_events_outcome_idx on platform.billing_events (outcome, received_at desc) where outcome in ('failed', 'unmatched');
create index billing_events_mode_idx on platform.billing_events (provider, livemode, received_at desc);

-- ── Provider verification ───────────────────────────────────────────────────
-- Results of authorized read-only calls to the provider with the configured
-- keys (account, prices, webhook endpoint). System-only: never granted to platform_app.
create table platform.billing_provider_checks (
  id          bigint generated always as identity primary key,
  provider    text not null default 'stripe',
  mode        text not null check (mode in ('test', 'live')),
  checked_at  timestamptz not null default now(),
  ok          boolean not null,
  -- {account, prices: [{plan, interval, ok, problem}], webhook: {...}} — ids and states only, never keys.
  details     jsonb not null default '{}'
);
create index billing_provider_checks_idx on platform.billing_provider_checks (provider, mode, checked_at desc);
