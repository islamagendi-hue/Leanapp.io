# Billing

**Status: built, payments not connected.** Built: plans, prices, limits and entitlements as data; usage metering and enforcement; owner warnings and emails; a provider boundary with a Stripe adapter (Checkout, Customer Portal, signed webhooks with an event log, subscriptions, invoices, refunds, reconciliation); a configuration status with a real verification against Stripe; the Plan & billing page. Not connected: no Stripe account exists, so the status is `not_configured`, the page says "Payments aren't connected yet", upgrade buttons are disabled and every organization stays on its current plan (the evaluation plan by default). Nothing is charged, and nothing about payments is simulated in the product: every "verified" or "ready" state needs a real authorized call to Stripe or a real signed webhook.

Code: `apps/platform/src/modules/billing`:

| File | What it is |
| --- | --- |
| `limits.ts`, `plans.ts` | pure rules: limits, grace, notice thresholds; price variables, plan changes, downgrade checks, entitlements, overage |
| `enforcement.ts`, `notices.ts` | app / seat / event limits, feature entitlements, usage emails |
| `provider.ts` | the provider boundary (`BillingProvider`): customers, Checkout, Portal, subscription read, verification |
| `stripe.ts`, `stripe-adapter.ts` | the Stripe adapter: REST over `fetch`, signatures, redirect allowlist |
| `webhook.ts` | inbound Stripe events: verification, event log, idempotency, ordering, state transitions |
| `reconcile.ts` | re-reads unfinished subscriptions from the provider |
| `status.ts` | configuration status and verification |
| `service.ts` | the billing overview, Checkout and Portal for an organization |

Migrations `0013_billing.sql` and `0038_billing_foundation.sql`; page `/o/{org}/settings/billing` (the old `/settings/usage` redirects there); webhook `POST /api/webhooks/stripe`; operator endpoint `/api/internal/billing`.

## Plans and limits

Plans (`platform.plans`) and their features (`platform.plan_features`) are data: they change without a deploy. A null or absent limit is unlimited. Prices follow the public pricing (`modules/marketing/landing.ts`): Starter $399 a month (2M events, up to 3 apps), Growth from $599 a month (from 20M events, priced by usage), Enterprise priced on a call.

| | Evaluation (`free`) | Starter | Growth | Pro | Enterprise |
| --- | --- | --- | --- | --- | --- |
| How it's bought (`checkout`) | not sold (`none`) | Checkout (`self_serve`) | Checkout (`self_serve`) | sales | sales |
| On the public pricing / billing page | only while current | ✓ | ✓ | — (`is_public = false`) | ✓ (Contact sales) |
| Monthly price (`price_monthly_cents`, USD) | — | 39,900 | 59,900, a starting price (`price_is_minimum`) | — | — |
| Annual price (`price_annual_cents`) | — | not set: shown at checkout | not set | — | — |
| Usage-based (`usage_based`) | — | — | ✓ (overage prepared, not charged) | — | — |
| Trial (`trial_days`) | — | none | none | — | — |
| `limit.events_per_month` | 100,000 | 2M | 20M (included) | 100M | unlimited |
| `limit.apps` | 1 | 3 | 10 | unlimited | unlimited |
| `limit.seats` | 3 | 10 | 25 | unlimited | unlimited |
| `retention.days` | 30 | 180 | 365 | 730 | unlimited |

- The plan every organization starts on has the id `free` (unchanged, so nothing that refers to it breaks) and is shown as **Evaluation**: it's an allowance to set up and try LeanApp, not an offer, and it's never sold or described as free. Pro is sales-led and off the public pricing.
- **Annual prices and trials** are not on the public pricing, so none are set. When the owner decides them: `update platform.plans set price_annual_cents = … where id = 'starter'` (shown on the page and checked against Stripe), `trial_days = 14` (offered once per organization, on its first subscription). Until then an annual Stripe price, if configured, is sold at whatever Stripe says and the page says "Annual prices are shown at checkout".
- **Projects** in the product are apps: the apps limit is the project limit. Environments are bounded by apps (three per app).
- **Feature entitlements** are `plan_features` rows named `feature.<name>` (`true` / `false`). A feature is gated only when a plan explicitly sets it to `false`; absent means allowed, so no feature is taken from anyone today. Check with `featureEntitled(db, organizationId, name)` or `assertEntitled(…)` (403 `plan_limit_exceeded`). No feature is gated yet: the landing page's per-plan feature lists (cohorts, A/B tests, more integrations) are a commercial decision to make before adding rows.
- **Upgrade / downgrade rules**: plans are ordered by `sort_order`. Upgrades and downgrades of an existing subscription happen in the Customer Portal (Stripe prorates; configure it in step 2 below). Before a downgrade the page lists the hard limits current usage would exceed on the target plan (apps, members): nothing is deleted or removed, but nothing more can be added until usage is under the new limit. Monthly events never block a downgrade; the new allowance applies with the usual grace.

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

## Usage and usage-based billing

- Usage is metered once per stored event: ingestion inserts events with `on conflict (environment_id, event_id) do nothing` and meters only the rows actually inserted, and an `Idempotency-Key` replay returns the stored response without metering again. Retried requests and SDK resends are never counted twice (tested in `test/billing.int.test.ts`).
- For a usage-based plan (Growth) the page shows the events above the included allowance this month (`overageEvents`). **Nothing is reported to Stripe or charged for them.** Enforcement is unchanged: past the allowance a usage-based plan gets the same 10% grace and then refusal as any other plan. Turning on metered billing is a commercial decision (unit price per million events, whether to stop refusing on Growth) and then a Stripe metered price and a usage report job; the overage figure is what that job would send.

## Payments: Stripe

Stripe is called over its REST API with `fetch` (no SDK), only from the server. Card data never touches LeanApp: customers pay on Stripe Checkout and manage cards, plan changes, cancellation and invoices in the Stripe Customer Portal. Everything Stripe-specific sits behind `BillingProvider` (`provider.ts`); a second provider (e.g. Tap, HyperPay or Checkout.com for Mada and SAR invoicing) would implement the same interface and its own webhook handler.

### Configuration

Environment variables only (never in git, never logged; `.env.example` lists them):

| Variable | Value |
| --- | --- |
| `STRIPE_SECRET_KEY` | `sk_test_…` (preview, local) / `sk_live_…` (production), or a restricted `rk_test_…` / `rk_live_…` key (permissions below). **The prefix sets the mode.** |
| `STRIPE_WEBHOOK_SECRET` | `whsec_…` of the webhook endpoint created **in the same mode** |
| `STRIPE_PRICE_STARTER_MONTHLY`, `STRIPE_PRICE_STARTER_ANNUAL`, `STRIPE_PRICE_GROWTH_MONTHLY`, `STRIPE_PRICE_GROWTH_ANNUAL` | `price_…` ids, created in the same mode. Pattern: `STRIPE_PRICE_<PLAN ID>_<MONTHLY|ANNUAL>`. A missing one means that plan/interval can't be bought online. |
| `PLAN_USAGE_CACHE_MS` | optional, default `30000` |

- Test and live are never mixed: the mode comes from the key prefix; billing customers are stored per mode (`billing_customers`, so a test customer is never sent to live Stripe); webhook events from the other mode are recorded as `mode_mismatch` and not applied; prices are verified to be in the key's mode. Use test keys on Preview and locally, live keys only on Production. `src/server/config.ts` warns when a test key is used in production, when the key or secret is malformed or only half set, and when a `STRIPE_PRICE_*` value is malformed or reused.
- The legacy column `plans.stripe_price_id` (migration 0013) is still read as a monthly fallback when the env variable for that plan is unset. Prefer the env variables.
- Restricted key permissions: Customers (write), Checkout Sessions (write), Customer portal (write), Prices (read), Subscriptions (read). Optional: Webhook Endpoints (read) so verification can see the endpoint; Account (read).

### Configuration status

`billingStatus()` (`status.ts`) combines the environment, the last verification and the webhook log:

| State | Meaning | Checkout |
| --- | --- | --- |
| `not_configured` | no `STRIPE_*` variable set (today) | off |
| `missing_credentials` | something set, but the key or webhook secret is missing or malformed | off |
| `credentials_unverified` | both secrets look right; no verification has run in this mode | off |
| `verification_failed` | the last verification failed: bad key, or a price that's missing, inactive, not recurring, in the wrong interval, currency or mode, or whose amount differs from `price_*_cents` | off |
| `webhook_not_configured` | key and prices verified; Stripe has no enabled endpoint at `{PUBLIC_APP_URL}/api/webhooks/stripe` with every required event | off |
| `webhook_unverified` | key and prices verified; the key can't list endpoints and no signed event has arrived yet | off |
| `connected_verified` | key, prices and endpoint verified; no signed event received yet in this mode | on (prices that passed only) |
| `ready_test` / `ready_live` | all of the above, plus at least one correctly signed event received in this mode | on |

**Verification** runs only when both secrets are present. It makes read-only calls with the configured key: `GET /v1/account` (or, for a restricted key without account access, `GET /v1/customers?limit=1`), `GET /v1/prices/{id}` for every configured price, and `GET /v1/webhook_endpoints`. The result (states and ids, never keys) goes to `billing_provider_checks`. It runs when an owner opens Plan & billing and the last check in this mode is missing or older than 24 hours, or on demand:

```sh
# status (read-only; MONITORING_SECRET or CRON_SECRET)
curl -s -H "Authorization: Bearer $MONITORING_SECRET" https://app.leanapp.io/api/internal/billing
# verify now / reconcile subscriptions (CRON_SECRET)
curl -s -X POST -H "Authorization: Bearer $CRON_SECRET" -d '{"action":"verify"}' https://app.leanapp.io/api/internal/billing
curl -s -X POST -H "Authorization: Bearer $CRON_SECRET" -d '{"action":"reconcile"}' https://app.leanapp.io/api/internal/billing
```

Organization members never see keys, ids or check details: the page shows one of "Payments aren't connected yet", "Payments are being set up and haven't been verified yet", "Payments are in test mode" (test keys, checkout open) or nothing (live and ready).

### Flow

1. An owner (`billing.manage`) picks a plan and **Pay monthly** or **Pay annually** on the billing page. The server (`startCheckout`) checks the permission, that the plan is self-serve and public, that the organization has no unfinished subscription (otherwise: Manage billing), that checkout is enabled, and takes the **verified** price id for that plan and interval from configuration. The client sends only a plan id and an interval; amount, currency and price are never taken from it.
2. The organization's Stripe Customer in this mode is created on first use (idempotency key `leanapp-customer-{mode}-{org}`, so concurrent clicks share one) and stored in `billing_customers`. The Checkout Session is created in subscription mode with `client_reference_id` = organization id, `organization_id` / `plan_id` / `interval` metadata on the session and the subscription, success and cancel URLs built on the server from `PUBLIC_APP_URL`, the plan's trial when it has one and the organization never subscribed, and an idempotency key per organization, plan, interval and 10-minute window (a double click opens the same session). The browser is redirected only to `https://checkout.stripe.com` or `https://billing.stripe.com`; any other URL is refused.
3. Returning from Checkout changes nothing: the page says the plan changes once Stripe confirms. **Paid state comes only from signed webhooks (or reconciliation).**
4. Stripe sends webhooks to `POST /api/webhooks/stripe`. Each is verified over the raw body (`Stripe-Signature`: HMAC-SHA256 of `timestamp.body` with the endpoint secret, constant-time comparison against every `v1`, timestamp within 5 minutes), checked for mode, then its event id is inserted into `billing_events` and the event applied **in the same transaction**. A redelivery is acknowledged without being applied twice. A failure rolls the work back, records the event as `failed` with an error code (never the payload) and answers 500 so Stripe retries; a later successful retry takes the row over (`attempts` counts them). Unconfigured: `503 payments_not_connected`; bad signature: `400 invalid_signature`. Every event's `outcome` is one of `applied`, `ignored` (type not handled), `stale`, `unmatched` (no organization), `mode_mismatch`, `failed`.
5. Events:

| Event | Effect |
| --- | --- |
| `checkout.session.completed` | links the Stripe customer to the organization (per mode); audit. Grants nothing by itself. |
| `customer.subscription.created` / `updated` / `deleted` | upserts `subscriptions` (plan, price, interval, currency, status, period, trial, cancel at period end, ended at, mode) and sets the plan: `trialing`, `active`, `past_due` (Stripe retrying the card) → the subscription's plan; `incomplete`, `incomplete_expired`, `unpaid`, `paused`, `canceled` → back to the evaluation plan (only if the organization is still on that subscription's plan, so a hand-set enterprise plan isn't touched). |
| `invoice.paid` / `invoice.payment_succeeded` | upserts the invoice as paid (Stripe sends both for one payment; audited once) |
| `invoice.payment_failed` | upserts the invoice as open; never overwrites a recorded payment. Access follows the subscription's status (`past_due` keeps the plan while Stripe retries). |
| `charge.refunded` | records the refunded amount on the invoice (matched by invoice or payment intent). A refund alone doesn't change access; if the subscription is cancelled with it, `customer.subscription.deleted` does. |

   **Ordering:** subscription events older than the last one applied are `stale`; at the same second a `created` never overwrites a later kind; `canceled` and `incomplete_expired` are terminal (Stripe never revives them), so no late or replayed event can resurrect one. A subscription whose price matches no plan fails the webhook (Stripe retries for up to 3 days) until an operator sets the missing `STRIPE_PRICE_*`.
6. **Reconciliation** (`reconcile.ts`, `POST /api/internal/billing {"action":"reconcile"}`): reads every unfinished subscription in this mode from Stripe (`GET /v1/subscriptions/{id}`) and applies it through the same code as a webhook; a subscription Stripe no longer has is applied as cancelled. Run it after an outage of the webhook endpoint, or on a schedule (e.g. daily) once live. It is not in the 5-minute worker, to keep Stripe calls off that path.
7. Checkouts, portal visits, subscription changes, reconciled changes, plan changes, invoices and refunds are in the audit log (area "Billing").

### Plan & billing page

Current plan and its usage; the subscription with its status (Active, Trial with its end date, Payment failed retrying, Awaiting payment, Unpaid, Paused, Cancelled, Expired before payment), interval and period, cancel-at-period-end, and the last ended subscription; the plans with their public price ("from" for Growth), limits, trial when set, downgrade warnings, and a Pay monthly / Pay annually button per verified price; Contact sales (a mailto link) for sales-led plans; Manage billing (the Customer Portal) when the organization has a Stripe customer in this mode; invoices with status and refunds. When payments aren't ready every upgrade button is disabled with the reason.

### Permissions

| Role | Plan & billing page | Upgrade / Manage billing |
| --- | --- | --- |
| Owner | ✓ (and triggers re-verification when stale) | ✓ (`billing.manage`) |
| Admin | ✓ (`billing.read`) | — ("Only owners can change the plan") |
| Developer, analyst, marketer | — | — |

The banner about over-limit or refused events is shown to every member, since data stops arriving for all of them; the 80% warning only to people with `billing.read`.

## Owner activation guide

Nothing below has been done. Do it first in **test mode** on Preview (or locally), then repeat the Stripe parts in **live mode** for Production.

1. **Create the Stripe account.** Sign up at stripe.com for the legal entity that will invoice customers (business details, bank account, tax settings as Stripe asks). Keep the dashboard in **Test mode** (toggle top right) for steps 2–5.
2. **Create the products and prices.** Product catalog → Add product: "LeanApp Starter" with a recurring **monthly** price of **USD 399.00**; "LeanApp Growth" with a recurring monthly price of **USD 599.00** (the public "from" price). Add **annual** prices only once you've decided them (then also set `price_annual_cents`). Copy each price id (`price_…`). Then Settings → Billing → Customer portal: allow updating payment methods, viewing invoices, cancelling (at period end), and switching between the Starter and Growth prices; set the return URL to `https://app.leanapp.io`. Optionally Settings → Tax for Stripe Tax.
3. **Add the credentials.** Developers → API keys → reveal the **secret key** (`sk_test_…`) or create a restricted key with the permissions above. In Vercel → Project → Settings → Environment Variables, for the **Preview** environment only: `STRIPE_SECRET_KEY`, `STRIPE_PRICE_STARTER_MONTHLY`, `STRIPE_PRICE_GROWTH_MONTHLY` (and the `_ANNUAL` ones if created). Never paste keys into code, chat or tickets. The status now reads `missing_credentials` (webhook secret missing).
4. **Create the webhook endpoint and signing secret.** Developers → Webhooks → Add endpoint: URL `https://<preview host>/api/webhooks/stripe` (Production later: `https://app.leanapp.io/api/webhooks/stripe`), events: `checkout.session.completed`, `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`, `invoice.paid`, `invoice.payment_succeeded`, `invoice.payment_failed`, `charge.refunded`. Reveal its **signing secret** (`whsec_…`) and set `STRIPE_WEBHOOK_SECRET` for Preview. Redeploy the preview.
5. **Verify in test mode.** Run `POST /api/internal/billing {"action":"verify"}` (or open Plan & billing as an owner). Expect `connected_verified`; anything else names what's wrong (`GET /api/internal/billing` shows each price's problem and the endpoint state). Then, as an owner of a test organization, click Upgrade → Pay monthly, pay with card `4242 4242 4242 4242` (any future date, any CVC), and check: the plan changes within a minute, the subscription shows Active, the invoice appears, `billing_events` has `applied` rows, and the status reads `ready_test`. Also try `4000 0000 0000 0341` (payment fails → Payment failed, retrying), cancel in Manage billing (→ cancels at period end), and a refund from the dashboard (→ shown on the invoice). The automated tests only use a fake Stripe; this step is the first real verification.
6. **Go live.** Switch the dashboard to **Live mode** (requires the account to be activated) and repeat step 2 (products, prices, portal) and step 4 (endpoint at `https://app.leanapp.io/api/webhooks/stripe`, same events) in live mode — test objects and secrets don't carry over. Set `STRIPE_SECRET_KEY` (`sk_live_…`), `STRIPE_WEBHOOK_SECRET` and the live `STRIPE_PRICE_*` for the **Production** environment only, redeploy, run the verification, and expect `connected_verified`, then `ready_live` after the first real event. Optionally schedule the reconcile call daily.

## Simulated vs live

- Simulated (tests only, `test/billing.int.test.ts`, `src/modules/billing/*.test.ts`, `src/app/api/internal/billing/route.test.ts`): a fake Stripe API behind a mocked `fetch` — account, prices, webhook endpoints, customers, Checkout and Portal sessions, subscriptions — and webhook payloads signed with a test secret. No real keys, no network.
- Live-verifiable once keys exist: the verification calls above, Checkout, the Portal, webhooks and reconciliation. None of them has been run against Stripe.

## Not built yet

- **Connecting a real Stripe account** (owner): the activation guide above. Nothing has been created in any Stripe account.
- Annual prices and trials (commercial decisions; the code supports both).
- Charging usage-based overage (metered prices and a usage report job; see above) and whether Growth should stop refusing past its allowance once overage is billed.
- Gating features by plan (`feature.*` rows; mechanism built, no rows).
- MENA payment methods: Stripe (UAE entity) covers cards and Apple Pay; Mada and SAR invoicing may need Tap Payments, HyperPay or Checkout.com behind `BillingProvider`.
- MTU-based plans, annual contracts and SAR/AED invoicing for enterprise; dunning emails beyond Stripe's own; tax (Stripe Tax) settings.
