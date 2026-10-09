# Billing

**Status: built, payments not connected.** Built: plans and limits as data, usage metering, enforcement of every numeric plan limit, owner warnings and emails, the Stripe integration (Checkout, Customer Portal, signed webhooks, subscriptions and invoices) and the Plan & billing page. Not connected: no Stripe account is configured, so the page says "Payments are not connected yet", the upgrade buttons are disabled and every organization stays on its current plan (Free by default). Nothing is charged.

Code: `apps/platform/src/modules/billing` (`limits.ts` pure rules, `enforcement.ts`, `notices.ts`, `stripe.ts`, `webhook.ts`, `service.ts`), migration `0013_billing.sql`, page `/o/{org}/settings/billing` (the old `/settings/usage` redirects there), webhook `POST /api/webhooks/stripe`.

## Plans and limits

Plans (`platform.plans`) and their features (`platform.plan_features`) are data: they change without a deploy. A null or absent limit is unlimited. The seeded values are placeholders until pricing research is done.

| Feature | Free | Starter | Growth | Pro | Enterprise |
| --- | --- | --- | --- | --- | --- |
| `limit.events_per_month` | 100,000 | 2M | 20M | 100M | unlimited |
| `limit.apps` | 1 | 3 | 10 | unlimited | unlimited |
| `limit.seats` | 3 | 10 | 25 | unlimited | unlimited |
| `retention.days` | 30 | 180 | 365 | 730 | unlimited |

The organization's plan is `organizations.plan_id`. With Stripe connected it follows the organization's subscription (below); otherwise an operator sets it directly (`update platform.organizations set plan_id = 'growth' where slug = '…'`), which is also how sales-led enterprise contracts work.

## Enforcement

| Limit | Counted as | When it bites | What the user sees |
| --- | --- | --- | --- |
| Apps | active apps | creating an app | `plan_limit_exceeded` (403): "Your plan includes N apps…" |
| Seats | members **plus pending invitations** | sending an invitation; accepting one if the plan shrank meanwhile | `plan_limit_exceeded` (403) |
| Monthly events | events accepted by ingestion this calendar month (UTC), all environments | ingestion, after a 10% grace | `429 plan_limit_exceeded` + `Retry-After` |
| Retention | days | scheduled worker (report-only unless `EVENT_RETENTION=enforce`, see [database](database.md)) | — |

Environments are not a separate limit: every app has exactly three (development, staging, production), created with the app, so they are bounded by the apps limit. Monthly active users are shown but not limited (no plan defines an MTU limit yet).

**Monthly active users** (shown on Plan & billing for production environments) are the distinct people with at least one *counted* event in the calendar month (UTC). It is the same rule as the analytics "Active users" KPI (`COUNTED_EVENTS` and `PERSON` in `modules/analytics/sql.ts`):

- counted events are processed `track` events and screen views without a processing error; `identify`, `alias`, `push_token` and consent calls, and events still waiting for processing or that failed it, make nobody active;
- people are stitched like analytics: an install linked to exactly one user counts as that user, not as an extra anonymous person.

Billing months are UTC, while reports use the app's timezone, so a report over "this month" can differ from the billed figure by the activity in the hours between the two month boundaries. Monthly *events* (the allowance above) are different: they count every event ingestion accepted, protocol calls included.

Apps and seats are checked inside the transaction that adds one, under a per-organization advisory lock, so two concurrent requests can't both take the last slot.

### Monthly events: soft limit, then a grace, then refusal

- Under 80%: nothing.
- **80%**: warning on the Plan & billing page and a banner for people who can see billing; owners get one email.
- **100%**: events are still accepted (the grace). Ingestion responses carry `X-LeanApp-Plan-Limit: grace`; a banner tells everyone in the organization; owners get one email saying refusal starts at 110%.
- **110%** (limit + 10%, rounded down): ingestion refuses whole requests with `429 { "error": "plan_limit_exceeded" }` and `Retry-After` (seconds until the month resets, capped at one hour so an upgrade takes effect quickly). Nothing is dropped silently: the SDKs keep refused events queued on the device and retry; refused events are metered (`events_refused`) and shown on the billing page; the request log records the error code; owners get one email.
- The allowance resets on the 1st of the month (UTC), or as soon as the plan is upgraded.

A request is refused only when usage *before* it is at or past the cap, so the last accepted request can overshoot by its own size (at most 500 events). Idempotent replays of earlier requests are still answered.

**Speed:** ingestion doesn't query usage per event. `eventAllowance()` keeps each organization's limit and month-to-date count in an in-process cache refreshed every `PLAN_USAGE_CACHE_MS` (default 30 s) from `usage_records` (at most 31 daily rows), and adds the events each process accepts in between. Across many serverless instances the cap can be exceeded by up to one cache window of traffic, which the grace absorbs.

### Notices

The scheduled worker (`/api/internal/process-events`, every 5 minutes) calls `sendUsageNotices()`: for each organization at 80% or more of its events allowance it records the thresholds reached (80, 100, 110) in `usage_notices` (one row per organization, month and threshold) and emails all owners about the highest new one. Each threshold is emailed once per month; an organization that jumps past several at once gets one email. Emails go through the existing email service (Resend, or the log transport locally).

## Payments: Stripe

Stripe is called over its REST API with `fetch` (no SDK). Card data never touches LeanApp: customers pay on Stripe Checkout and manage cards, plan changes, cancellation and invoices in the Stripe Customer Portal.

**Configuration** (environment variables only; never in git):

| Variable | Value |
| --- | --- |
| `STRIPE_SECRET_KEY` | `sk_live_…` (production) / `sk_test_…` (preview), or a restricted `rk_…` key with write access to Customers, Checkout Sessions and Customer Portal sessions |
| `STRIPE_WEBHOOK_SECRET` | `whsec_…` of the webhook endpoint below |
| `PLAN_USAGE_CACHE_MS` | optional, default `30000` |

Payments count as connected only when **both** Stripe variables are set (without the webhook a paid checkout could never activate the plan). `src/server/config.ts` warns in production when they are missing, only half set, malformed, or a test key is used in production.

**Price per plan:** `plans.stripe_price_id` (null by default). Create one recurring monthly Price per sellable plan in the Stripe dashboard, then:

```sql
update platform.plans set stripe_price_id = 'price_…' where id = 'starter';
update platform.plans set stripe_price_id = 'price_…' where id = 'growth';
update platform.plans set stripe_price_id = 'price_…' where id = 'pro';
-- optional, shown on the plan cards:
update platform.plans set price_monthly_cents = 4900, currency = 'USD' where id = 'starter';
```

A plan without a price id shows a disabled upgrade button ("Not available for online checkout yet").

**Webhook:** in Stripe → Developers → Webhooks, add `https://app.leanapp.io/api/webhooks/stripe` with these events and copy its signing secret into `STRIPE_WEBHOOK_SECRET`:

`checkout.session.completed`, `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`, `invoice.paid`, `invoice.payment_failed`.

**Customer Portal:** enable it in Stripe → Settings → Billing → Customer portal (plan switching between the prices above, cancellation, payment-method updates, invoice history).

### Flow

1. An owner (`billing.manage`) clicks **Upgrade** on the billing page. The server creates the organization's Stripe Customer on first use (stored in `organizations.billing_customer_id`, created with an idempotency key so concurrent clicks share one) and a Checkout Session in subscription mode with the plan's price, `client_reference_id` = organization id, and `organization_id`/`plan_id` metadata on the session and the subscription. Organizations that already have a subscription are sent to **Manage billing** (the portal) instead.
2. Stripe sends webhooks. Each is verified (`Stripe-Signature`: HMAC-SHA256 of `timestamp.body` with the endpoint secret, constant-time comparison against every `v1`, timestamp within 5 minutes), then its event id is inserted into `billing_events` and the event applied **in the same transaction**: redeliveries are acknowledged without being applied twice, and a failure rolls back so Stripe retries. Unconfigured: `503 payments_not_connected`; bad signature: `400 invalid_signature`.
3. `customer.subscription.*` upserts `subscriptions` (by Stripe subscription id) and sets the organization's plan:
   - `trialing`, `active`, `past_due` (Stripe is retrying the card) → the subscription's plan;
   - `incomplete`, `incomplete_expired`, `unpaid`, `paused`, `canceled` / deleted → back to Free (only if the organization is still on that subscription's plan, so a hand-set enterprise plan isn't touched).
   Events older than the last one applied to a subscription are ignored, so out-of-order delivery can't resurrect a cancelled subscription. A subscription whose price matches no `plans.stripe_price_id` fails the webhook (500) so Stripe keeps retrying while an operator fixes the mapping.
4. `invoice.paid` / `invoice.payment_failed` upsert `invoices` (amount, currency, status, period, number, Stripe-hosted invoice and PDF links; links on other hosts are dropped). A late `payment_failed` never overwrites a recorded payment.
5. Checkouts, portal visits, subscription updates, plan changes and invoices are in the audit log (area "Billing").

### Permissions

| Role | Plan & billing page | Upgrade / Manage billing |
| --- | --- | --- |
| Owner | ✓ | ✓ (`billing.manage`) |
| Admin | ✓ (`billing.read`) | — ("Only owners can change the plan") |
| Developer, analyst, marketer | — | — |

The banner about over-limit or refused events is shown to every member, since data stops arriving for all of them; the 80% warning only to people with `billing.read`.

## Not built yet

- **Connecting a real Stripe account** (owner): a Stripe account for the business entity, the two environment variables, one Price per plan, the webhook endpoint and the Customer Portal configuration, as above. Nothing has been created in any Stripe account.
- Prices: `price_monthly_cents` and the Stripe prices wait for pricing research.
- MENA payment methods: Stripe (UAE entity) covers cards and Apple Pay; Mada and SAR invoicing may need Tap Payments, HyperPay or Checkout.com. Provider code is isolated in `stripe.ts` and `webhook.ts`.
- Usage-based billing (metered overage), MTU-based plans, annual contracts and SAR/AED invoicing for enterprise.
- Dunning emails beyond Stripe's own; tax (Stripe Tax) settings.

## Pricing model (to be validated)

- Free tier for development and small apps.
- Paid tiers by **monthly tracked users (MTU)** with an events allowance, because MTU tracks the value customers get better than raw event counts and is what MMPs and analytics tools in the region are compared on.
- Attribution and automation as add-ons or higher tiers.
- Annual contracts and invoicing in SAR/AED for enterprise.
