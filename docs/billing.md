# Billing

**Status: partial.** Built: plans and plan features as data (`plans`, `plan_features`: retention days, app, seat and monthly event limits), usage metering (`usage_meters`, `usage_records` daily rollups of ingested events, written on every ingestion request), and a monthly active users query. Retention is applied by the scheduled worker (report-only until `EVENT_RETENTION=enforce`, see [database](database.md)). Not built: enforcement of the other limits, a payment provider, invoices, the billing UI. Every organization is on `free` and nothing is charged.

## Pricing model (to be validated)

- Free tier for development and small apps.
- Paid tiers by **monthly tracked users (MTU)** with an events allowance, because MTU tracks the value customers get better than raw event counts and is what MMPs and analytics tools in the region are compared on.
- Attribution and automation as add-ons or higher tiers.
- Annual contracts and invoicing in SAR/AED for enterprise.

The seeded limits are placeholders until pricing research is done.

## Provider

A payment provider must support SAR and AED, Mada cards, Apple Pay and invoices for B2B. Candidates: Stripe (available in the UAE), Checkout.com, Tap Payments, HyperPay. The choice needs the owner's business entity and is not made yet. Card data never touches LeanApp servers.

## Enforcement (planned)

Soft limits with in-app warnings at 80% and 100%; ingestion is never blocked silently. Exceeding the event allowance flags the organization and notifies owners; hard blocking only after a grace period and an explicit notice.
