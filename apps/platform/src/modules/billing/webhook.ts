import "server-only";
import { withSystem, type Db } from "@/lib/db";
import { log } from "@/lib/log";
import { audit } from "@/modules/audit/service";
import { clearAllowanceCache } from "./enforcement";
import { priceLookup, isInterval, type BillingInterval } from "./plans";
import { stripeConfig, verifyStripeSignature, type ProviderMode } from "./stripe";

/**
 * POST /api/webhooks/stripe — the inbound half of the Stripe adapter.
 *
 * 1. Verifies the signature over the raw body (stripe.ts).
 * 2. Ignores events from the other mode (a test event on live keys or the
 *    reverse), recording them as `mode_mismatch`.
 * 3. Records the event id and applies it in one transaction: a redelivered
 *    event is acknowledged without being applied again; a failure rolls the
 *    work back, records the event as `failed` (with an error code, never the
 *    payload) and answers 500 so Stripe retries. A later successful retry
 *    takes the failed row over.
 *
 * Handled: checkout.session.completed, customer.subscription.created /
 * updated / deleted, invoice.paid / invoice.payment_succeeded,
 * invoice.payment_failed, charge.refunded. Anything else is recorded as
 * `ignored`.
 *
 * Paid state only ever comes from here (or reconcile.ts, which asks Stripe
 * directly), never from the browser returning from Checkout.
 *
 * Ordering: subscription events older than the last one applied to that
 * subscription are `stale`; at an equal timestamp a `created` event never
 * overwrites a later kind; a cancelled or expired subscription is terminal
 * (Stripe never revives one), so no late event can resurrect it.
 */

export interface WebhookResult {
  status: number;
  body: Record<string, unknown>;
}

interface StripeEvent {
  id: string;
  type: string;
  created: number;
  livemode?: boolean;
  data: { object: Record<string, unknown> };
}

type Outcome = "applied" | "ignored" | "stale" | "unmatched";
interface Applied {
  organizationId: string | null;
  outcome: Outcome;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Statuses that keep the paid plan: past_due while Stripe retries the card. */
export const ENTITLED = new Set(["trialing", "active", "past_due"]);
const STATUSES = new Set(["incomplete", "incomplete_expired", "trialing", "active", "past_due", "unpaid", "paused", "cancelled"]);
/** Stripe never reactivates these. */
export const TERMINAL = ["cancelled", "incomplete_expired"];

class WebhookApplyError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "WebhookApplyError";
  }
}

export async function handleStripeWebhook(rawBody: string, signatureHeader: string | null, now = new Date()): Promise<WebhookResult> {
  const config = stripeConfig();
  if (!config) return { status: 503, body: { error: "payments_not_connected", message: "Payments are not connected yet." } };
  const check = verifyStripeSignature(rawBody, signatureHeader, config.webhookSecret, { now });
  if (!check.ok) {
    log.warn("stripe.webhook_rejected", { reason: check.reason });
    return { status: 400, body: { error: "invalid_signature", reason: check.reason } };
  }
  let event: StripeEvent;
  try {
    event = JSON.parse(rawBody) as StripeEvent;
  } catch {
    return { status: 400, body: { error: "invalid_json" } };
  }
  if (typeof event?.id !== "string" || !/^evt_[A-Za-z0-9_]{1,200}$/.test(event.id) || typeof event.type !== "string" || typeof event.created !== "number" || typeof event.data?.object !== "object" || !event.data.object) {
    return { status: 400, body: { error: "invalid_event" } };
  }
  const livemode = typeof event.livemode === "boolean" ? event.livemode : config.mode === "live";
  const objectId = typeof event.data.object.id === "string" ? event.data.object.id.slice(0, 255) : null;

  if (livemode !== (config.mode === "live")) {
    // Signed with our secret but from the other mode: never applied.
    await withSystem((db) =>
      db.query(
        `insert into platform.billing_events (id, type, created_at, livemode, object_id, outcome, processed_at)
         values ($1, $2, to_timestamp($3), $4, $5, 'mode_mismatch', now()) on conflict (id) do nothing`,
        [event.id, event.type, event.created, livemode, objectId],
      ),
    );
    log.warn("stripe.webhook_mode_mismatch", { type: event.type, event_livemode: livemode, mode: config.mode });
    return { status: 200, body: { received: true, ignored: "mode_mismatch" } };
  }

  try {
    return await withSystem(async (db) => {
      const fresh = await db.one(
        `insert into platform.billing_events (id, type, created_at, livemode, object_id) values ($1, $2, to_timestamp($3), $4, $5)
         on conflict (id) do update set attempts = platform.billing_events.attempts + 1, outcome = 'applied', error_code = null
           where platform.billing_events.outcome = 'failed'
         returning id`,
        [event.id, event.type, event.created, livemode, objectId],
      );
      if (!fresh) return { status: 200, body: { received: true, duplicate: true } };
      const result = await applyEvent(db, event, config.mode);
      await db.query(
        "update platform.billing_events set organization_id = $2, outcome = $3, processed_at = now() where id = $1",
        [event.id, result.organizationId, result.outcome],
      );
      return { status: 200, body: { received: true, ...(result.outcome === "applied" ? {} : { outcome: result.outcome }) } };
    });
  } catch (err) {
    const code = err instanceof WebhookApplyError ? err.code : "apply_failed";
    await withSystem((db) =>
      db.query(
        `insert into platform.billing_events (id, type, created_at, livemode, object_id, outcome, error_code, processed_at)
         values ($1, $2, to_timestamp($3), $4, $5, 'failed', $6, now())
         on conflict (id) do update set outcome = 'failed', error_code = excluded.error_code, attempts = platform.billing_events.attempts + 1, processed_at = now()
           where platform.billing_events.outcome = 'failed'`,
        [event.id, event.type, event.created, livemode, objectId, code],
      ),
    ).catch((e) => log.error("stripe.webhook_failure_not_recorded", { error_name: e instanceof Error ? e.name : typeof e }));
    throw err;
  }
}

async function applyEvent(db: Db, event: StripeEvent, mode: ProviderMode): Promise<Applied> {
  const obj = event.data.object;
  switch (event.type) {
    case "checkout.session.completed":
      return checkoutCompleted(db, obj, mode);
    case "customer.subscription.created":
    case "customer.subscription.updated":
    case "customer.subscription.deleted":
      return applySubscription(db, { type: event.type, created: event.created }, obj, mode);
    case "invoice.paid":
    case "invoice.payment_succeeded":
    case "invoice.payment_failed":
      return invoiceChanged(db, event, obj, mode);
    case "charge.refunded":
      return chargeRefunded(db, obj);
    default:
      return { organizationId: null, outcome: "ignored" };
  }
}

const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
const idOf = (v: unknown): string | null => str(v) ?? str((v as { id?: unknown } | null)?.id);
const time = (v: unknown): Date | null => (typeof v === "number" && v > 0 ? new Date(v * 1000) : null);
const meta = (obj: Record<string, unknown>): Record<string, unknown> => (obj.metadata && typeof obj.metadata === "object" ? (obj.metadata as Record<string, unknown>) : {});

/** The organization an object belongs to: our metadata first, then the provider customer we stored. */
async function resolveOrganization(db: Db, candidates: unknown[], customerId: string | null): Promise<string | null> {
  for (const c of candidates) {
    if (typeof c === "string" && UUID.test(c)) {
      const row = await db.one<{ id: string }>("select id from platform.organizations where id = $1", [c]);
      if (row) return row.id;
    }
  }
  if (customerId) {
    const row = await db.one<{ id: string }>(
      `select organization_id as id from platform.billing_customers where provider = 'stripe' and provider_customer_id = $1
       union all select id from platform.organizations where billing_customer_id = $1 limit 1`,
      [customerId],
    );
    if (row) return row.id;
  }
  return null;
}

/** Remembers the organization's customer in this mode (first one wins; Stripe customers aren't shared). */
async function linkCustomer(db: Db, organizationId: string, customerId: string, mode: ProviderMode) {
  await db.query(
    `insert into platform.billing_customers (organization_id, provider, livemode, provider_customer_id) values ($1, 'stripe', $2, $3)
     on conflict do nothing`,
    [organizationId, mode === "live", customerId],
  );
  await db.query("update platform.organizations set billing_customer_id = $2 where id = $1 and billing_customer_id is null", [organizationId, customerId]);
}

async function checkoutCompleted(db: Db, session: Record<string, unknown>, mode: ProviderMode): Promise<Applied> {
  const customer = idOf(session.customer);
  const organizationId = await resolveOrganization(db, [session.client_reference_id, meta(session).organization_id], customer);
  if (!organizationId) {
    log.warn("stripe.webhook_unmatched", { type: "checkout.session.completed" });
    return { organizationId: null, outcome: "unmatched" };
  }
  if (customer) await linkCustomer(db, organizationId, customer, mode);
  // Completing Checkout doesn't grant the plan: the subscription events do.
  await audit(db, {
    organizationId, actorUserId: null, actorType: "system", action: "billing.checkout_completed", targetType: "checkout_session", targetId: str(session.id) ?? undefined,
    metadata: { plan_id: meta(session).plan_id ?? null, interval: meta(session).interval ?? null, subscription: idOf(session.subscription) },
  });
  return { organizationId, outcome: "applied" };
}

function subscriptionStatus(eventType: string, raw: unknown): string {
  if (eventType === "customer.subscription.deleted") return "cancelled";
  const s = raw === "canceled" ? "cancelled" : String(raw);
  if (!STATUSES.has(s)) throw new WebhookApplyError("unknown_status", `Unknown Stripe subscription status: ${s}`);
  return s;
}

/**
 * Applies a subscription object as of `at.created` (an event, or a
 * reconciliation snapshot). Exported for reconcile.ts.
 */
export async function applySubscription(
  db: Db,
  at: { type: string; created: number },
  sub: Record<string, unknown>,
  mode: ProviderMode,
): Promise<Applied> {
  const subscriptionId = str(sub.id);
  const customer = idOf(sub.customer);
  if (!subscriptionId) throw new WebhookApplyError("invalid_object", "Subscription event without an id");
  const organizationId = await resolveOrganization(db, [meta(sub).organization_id], customer);
  if (!organizationId) {
    log.warn("stripe.webhook_unmatched", { type: at.type });
    return { organizationId: null, outcome: "unmatched" };
  }
  const item = ((sub.items as { data?: Record<string, unknown>[] } | undefined)?.data ?? [])[0] ?? {};
  const price = (item.price ?? {}) as { id?: unknown; currency?: unknown; recurring?: { interval?: unknown } | null };
  const priceId = idOf(item.price);
  const plans = await db.query<{ id: string; stripe_price_id: string | null }>("select id, stripe_price_id from platform.plans");
  const ref = priceId ? priceLookup(process.env, plans).get(priceId) : undefined;
  if (!ref) {
    // Throwing makes Stripe retry for days, which gives an operator time to set STRIPE_PRICE_<PLAN>_<INTERVAL>.
    log.error("stripe.unknown_price", { price: priceId, subscription: subscriptionId });
    throw new WebhookApplyError("unknown_price", `No plan has price ${priceId} (STRIPE_PRICE_<PLAN>_<INTERVAL> or plans.stripe_price_id)`);
  }
  const interval: BillingInterval = isInterval(price.recurring?.interval) ? price.recurring.interval : ref.interval;
  const currency = (str(sub.currency) ?? str(price.currency))?.toUpperCase() ?? null;
  const status = subscriptionStatus(at.type, sub.status);
  // Newer API versions moved the period onto the subscription item.
  const periodStart = time(sub.current_period_start) ?? time(item.current_period_start) ?? time(sub.start_date) ?? new Date(at.created * 1000);
  const periodEnd = time(sub.current_period_end) ?? time(item.current_period_end) ?? periodStart;
  const cancelledAt = time(sub.canceled_at) ?? (status === "cancelled" ? time(sub.ended_at) ?? new Date(at.created * 1000) : null);
  const endedAt = time(sub.ended_at) ?? (TERMINAL.includes(status) ? new Date(at.created * 1000) : null);

  const before = await db.one<{ plan_id: string; status: string; cancel_at_period_end: boolean; current_period_end: Date }>(
    "select plan_id, status, cancel_at_period_end, current_period_end from platform.subscriptions where provider = 'stripe' and provider_subscription_id = $1 for update",
    [subscriptionId],
  );
  const row = await db.one<{ id: string }>(
    `insert into platform.subscriptions
       (organization_id, plan_id, status, provider, provider_subscription_id, provider_customer_id,
        current_period_start, current_period_end, cancel_at_period_end, cancelled_at, provider_event_at,
        provider_price_id, billing_interval, currency, trial_start, trial_end, ended_at, livemode)
     values ($1, $2, $3, 'stripe', $4, $5, $6, $7, $8, $9, to_timestamp($10), $11, $12, $13, $14, $15, $16, $17)
     on conflict (provider, provider_subscription_id) where provider_subscription_id is not null do update set
       plan_id = excluded.plan_id, status = excluded.status, provider_customer_id = excluded.provider_customer_id,
       current_period_start = excluded.current_period_start, current_period_end = excluded.current_period_end,
       cancel_at_period_end = excluded.cancel_at_period_end, cancelled_at = excluded.cancelled_at,
       provider_event_at = excluded.provider_event_at, provider_price_id = excluded.provider_price_id,
       billing_interval = excluded.billing_interval, currency = excluded.currency, trial_start = excluded.trial_start,
       trial_end = excluded.trial_end, ended_at = excluded.ended_at, livemode = excluded.livemode
     where platform.subscriptions.organization_id = excluded.organization_id
       and (platform.subscriptions.provider_event_at is null
            or platform.subscriptions.provider_event_at < excluded.provider_event_at
            or (platform.subscriptions.provider_event_at = excluded.provider_event_at and not $18))
       and (platform.subscriptions.status <> all($19) or platform.subscriptions.status = excluded.status)
     returning id`,
    [organizationId, ref.planId, status, subscriptionId, customer, periodStart, periodEnd, sub.cancel_at_period_end === true, cancelledAt, at.created,
     priceId, interval, currency, time(sub.trial_start), time(sub.trial_end), endedAt, mode === "live",
     at.type === "customer.subscription.created", TERMINAL],
  );
  if (!row) {
    log.info("stripe.webhook_stale", { type: at.type, subscription: subscriptionId });
    return { organizationId, outcome: "stale" };
  }
  if (customer) await linkCustomer(db, organizationId, customer, mode);
  const unchanged = before && before.plan_id === ref.planId && before.status === status && before.cancel_at_period_end === (sub.cancel_at_period_end === true)
    && new Date(before.current_period_end).getTime() === periodEnd.getTime();
  // A reconciliation that finds what we already had changes nothing and isn't audited.
  if (at.type === "reconcile" && unchanged) return { organizationId, outcome: "ignored" };
  await audit(db, {
    organizationId, actorUserId: null, actorType: "system",
    action: at.type === "reconcile" ? "billing.subscription_reconciled" : "billing.subscription_updated", targetType: "subscription", targetId: row.id,
    metadata: { plan_id: ref.planId, status, interval, cancel_at_period_end: sub.cancel_at_period_end === true },
  });
  await syncPlan(db, organizationId, ref.planId, status);
  return { organizationId, outcome: "applied" };
}

/**
 * Sets the organization's plan from its subscriptions: the entitled one with
 * the latest period end, else the evaluation plan. A plan set by hand (e.g.
 * enterprise on an invoice contract) is left alone when an unrelated
 * subscription ends.
 */
async function syncPlan(db: Db, organizationId: string, changedPlanId: string, changedStatus: string) {
  const org = await db.one<{ plan_id: string }>("select plan_id from platform.organizations where id = $1 for update", [organizationId]);
  const entitled = await db.one<{ plan_id: string }>(
    `select plan_id from platform.subscriptions
      where organization_id = $1 and provider = 'stripe' and status = any($2)
      order by current_period_end desc limit 1`,
    [organizationId, [...ENTITLED]],
  );
  let next = org!.plan_id;
  if (entitled) next = entitled.plan_id;
  else if (!ENTITLED.has(changedStatus) && org!.plan_id === changedPlanId) next = "free";
  if (next === org!.plan_id) return;
  await db.query("update platform.organizations set plan_id = $2 where id = $1", [organizationId, next]);
  await audit(db, {
    organizationId, actorUserId: null, actorType: "system", action: "billing.plan_changed", targetType: "organization", targetId: organizationId,
    metadata: { from: org!.plan_id, to: next, subscription_status: changedStatus },
  });
  clearAllowanceCache(organizationId);
}

async function invoiceChanged(db: Db, event: StripeEvent, inv: Record<string, unknown>, mode: ProviderMode): Promise<Applied> {
  const invoiceId = str(inv.id);
  if (!invoiceId) throw new WebhookApplyError("invalid_object", "Invoice event without an id");
  const customer = idOf(inv.customer);
  const parent = inv.parent as { subscription_details?: { subscription?: unknown; metadata?: Record<string, unknown> } } | undefined;
  const providerSubscription = idOf(inv.subscription) ?? idOf(parent?.subscription_details?.subscription);
  const ours = providerSubscription
    ? await db.one<{ id: string; organization_id: string }>(
        "select id, organization_id from platform.subscriptions where provider = 'stripe' and provider_subscription_id = $1",
        [providerSubscription],
      )
    : null;
  const organizationId = ours?.organization_id
    ?? (await resolveOrganization(db, [meta(inv).organization_id, parent?.subscription_details?.metadata?.organization_id], customer));
  if (!organizationId) {
    log.warn("stripe.webhook_unmatched", { type: event.type });
    return { organizationId: null, outcome: "unmatched" };
  }
  const paid = event.type === "invoice.paid" || event.type === "invoice.payment_succeeded";
  const status = paid ? "paid" : ["draft", "open", "void", "uncollectible"].includes(String(inv.status)) ? String(inv.status) : "open";
  const line = ((inv.lines as { data?: { period?: { start?: unknown; end?: unknown } }[] } | undefined)?.data ?? [])[0]?.period;
  const periodStart = time(line?.start) ?? time(inv.period_start) ?? new Date(event.created * 1000);
  const periodEnd = time(line?.end) ?? time(inv.period_end) ?? periodStart;
  const amount = Number(paid ? inv.amount_paid : inv.amount_due) || 0;
  const currency = (str(inv.currency) ?? "usd").toUpperCase();
  const paidAt = paid ? time((inv.status_transitions as { paid_at?: unknown } | undefined)?.paid_at) ?? new Date(event.created * 1000) : null;

  const before = await db.one<{ status: string }>("select status from platform.invoices where provider_invoice_id = $1 for update", [invoiceId]);
  const row = await db.one<{ id: string; status: string }>(
    `insert into platform.invoices
       (organization_id, subscription_id, provider_invoice_id, amount_cents, currency, status, period_start, period_end,
        number, hosted_invoice_url, invoice_pdf_url, paid_at, provider_payment_intent_id, livemode)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
     on conflict (provider_invoice_id) where provider_invoice_id is not null do update set
       subscription_id = coalesce(excluded.subscription_id, platform.invoices.subscription_id),
       amount_cents = case when platform.invoices.status = 'paid' then platform.invoices.amount_cents else excluded.amount_cents end,
       -- a late payment_failed never overwrites a recorded payment
       status = case when platform.invoices.status = 'paid' then 'paid' else excluded.status end,
       number = coalesce(excluded.number, platform.invoices.number),
       hosted_invoice_url = coalesce(excluded.hosted_invoice_url, platform.invoices.hosted_invoice_url),
       invoice_pdf_url = coalesce(excluded.invoice_pdf_url, platform.invoices.invoice_pdf_url),
       paid_at = coalesce(platform.invoices.paid_at, excluded.paid_at),
       provider_payment_intent_id = coalesce(excluded.provider_payment_intent_id, platform.invoices.provider_payment_intent_id),
       livemode = excluded.livemode
     where platform.invoices.organization_id = excluded.organization_id
     returning id, status`,
    [organizationId, ours?.id ?? null, invoiceId, amount, currency, status, periodStart, periodEnd,
     str(inv.number), httpsUrl(inv.hosted_invoice_url), httpsUrl(inv.invoice_pdf), paidAt, str(inv.payment_intent), mode === "live"],
  );
  // invoice.paid and invoice.payment_succeeded both arrive for one payment: audit the change once.
  if (row && before?.status !== row.status) {
    await audit(db, {
      organizationId, actorUserId: null, actorType: "system", action: row.status === "paid" ? "billing.invoice_paid" : "billing.payment_failed", targetType: "invoice", targetId: row.id,
      metadata: { amount_cents: amount, currency, number: str(inv.number) },
    });
  }
  return { organizationId, outcome: row ? "applied" : "unmatched" };
}

/**
 * A refund is recorded on its invoice (amount refunded, when). It doesn't
 * change access by itself: if the subscription is cancelled with the refund,
 * Stripe sends customer.subscription.deleted, which does.
 */
async function chargeRefunded(db: Db, charge: Record<string, unknown>): Promise<Applied> {
  const invoiceId = idOf(charge.invoice);
  const paymentIntent = idOf(charge.payment_intent);
  const refunded = Number(charge.amount_refunded) || 0;
  if (!invoiceId && !paymentIntent) return { organizationId: null, outcome: "unmatched" };
  const row = await db.one<{ id: string; organization_id: string; prev: string }>(
    `with target as (
       select id, amount_refunded_cents as prev from platform.invoices
        where (provider_invoice_id = $1 or provider_payment_intent_id = $2) limit 1 for update)
     update platform.invoices i set amount_refunded_cents = greatest(i.amount_refunded_cents, $3), refunded_at = coalesce(i.refunded_at, now())
       from target where i.id = target.id
     returning i.id, i.organization_id, target.prev`,
    [invoiceId, paymentIntent, refunded],
  );
  if (!row) {
    log.warn("stripe.webhook_unmatched", { type: "charge.refunded" });
    return { organizationId: null, outcome: "unmatched" };
  }
  if (refunded > Number(row.prev)) {
    await audit(db, {
      organizationId: row.organization_id, actorUserId: null, actorType: "system", action: "billing.refund_recorded", targetType: "invoice", targetId: row.id,
      metadata: { amount_refunded_cents: refunded, currency: (str(charge.currency) ?? "").toUpperCase() || null, full: charge.refunded === true },
    });
  }
  return { organizationId: row.organization_id, outcome: "applied" };
}

/** Links we render must be https Stripe-hosted pages. */
function httpsUrl(v: unknown): string | null {
  const s = str(v);
  if (!s) return null;
  try {
    const u = new URL(s);
    return u.protocol === "https:" && (u.hostname === "stripe.com" || u.hostname.endsWith(".stripe.com")) ? s : null;
  } catch {
    return null;
  }
}
