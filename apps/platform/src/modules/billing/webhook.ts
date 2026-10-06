import "server-only";
import { withSystem, type Db } from "@/lib/db";
import { log } from "@/lib/log";
import { audit } from "@/modules/audit/service";
import { clearAllowanceCache } from "./enforcement";
import { stripeConfig, verifyStripeSignature } from "./stripe";

/**
 * POST /api/webhooks/stripe. Verifies the signature over the raw body, then
 * records the event id and applies it in one transaction: a redelivered event
 * is acknowledged without being applied again, and a failure rolls back the
 * record too, so Stripe's retry applies it later.
 *
 * Handled: checkout.session.completed, customer.subscription.created /
 * updated / deleted, invoice.paid, invoice.payment_failed. Anything else is
 * recorded and ignored.
 *
 * The organization's plan (organizations.plan_id) follows its subscription:
 * trialing, active and past_due (Stripe is retrying the card) keep the paid
 * plan; any other state returns the organization to free. Subscription events
 * older than the last one applied are ignored, so out-of-order delivery can't
 * resurrect a cancelled subscription.
 */

export interface WebhookResult {
  status: number;
  body: Record<string, unknown>;
}

interface StripeEvent {
  id: string;
  type: string;
  created: number;
  data: { object: Record<string, unknown> };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ENTITLED = new Set(["trialing", "active", "past_due"]);
const STATUSES = new Set(["incomplete", "incomplete_expired", "trialing", "active", "past_due", "unpaid", "paused", "cancelled"]);

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
  if (typeof event?.id !== "string" || typeof event.type !== "string" || typeof event.created !== "number" || typeof event.data?.object !== "object" || !event.data.object) {
    return { status: 400, body: { error: "invalid_event" } };
  }

  return withSystem(async (db) => {
    const fresh = await db.one(
      `insert into platform.billing_events (id, type, created_at) values ($1, $2, to_timestamp($3))
       on conflict (id) do nothing returning id`,
      [event.id, event.type, event.created],
    );
    if (!fresh) return { status: 200, body: { received: true, duplicate: true } };
    const organizationId = await apply(db, event);
    if (organizationId) await db.query("update platform.billing_events set organization_id = $2 where id = $1", [event.id, organizationId]);
    return { status: 200, body: { received: true } };
  });
}

async function apply(db: Db, event: StripeEvent): Promise<string | null> {
  const obj = event.data.object;
  switch (event.type) {
    case "checkout.session.completed":
      return checkoutCompleted(db, obj);
    case "customer.subscription.created":
    case "customer.subscription.updated":
    case "customer.subscription.deleted":
      return subscriptionChanged(db, event, obj);
    case "invoice.paid":
    case "invoice.payment_failed":
      return invoiceChanged(db, event, obj);
    default:
      return null;
  }
}

const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
const idOf = (v: unknown): string | null => str(v) ?? str((v as { id?: unknown } | null)?.id);
const time = (v: unknown): Date | null => (typeof v === "number" && v > 0 ? new Date(v * 1000) : null);
const meta = (obj: Record<string, unknown>): Record<string, unknown> => (obj.metadata && typeof obj.metadata === "object" ? (obj.metadata as Record<string, unknown>) : {});

/** The organization an object belongs to: our metadata first, then the Stripe customer we stored. */
async function resolveOrganization(db: Db, candidates: unknown[], customerId: string | null): Promise<string | null> {
  for (const c of candidates) {
    if (typeof c === "string" && UUID.test(c)) {
      const row = await db.one<{ id: string }>("select id from platform.organizations where id = $1", [c]);
      if (row) return row.id;
    }
  }
  if (customerId) {
    const row = await db.one<{ id: string }>("select id from platform.organizations where billing_customer_id = $1", [customerId]);
    if (row) return row.id;
  }
  return null;
}

async function checkoutCompleted(db: Db, session: Record<string, unknown>): Promise<string | null> {
  const customer = idOf(session.customer);
  const organizationId = await resolveOrganization(db, [session.client_reference_id, meta(session).organization_id], customer);
  if (!organizationId) {
    log.warn("stripe.webhook_unmatched", { type: "checkout.session.completed" });
    return null;
  }
  if (customer) {
    await db.query("update platform.organizations set billing_customer_id = $2 where id = $1 and billing_customer_id is distinct from $2", [organizationId, customer]);
  }
  await audit(db, {
    organizationId, actorUserId: null, actorType: "system", action: "billing.checkout_completed", targetType: "checkout_session", targetId: str(session.id) ?? undefined,
    metadata: { plan_id: meta(session).plan_id ?? null, subscription: idOf(session.subscription) },
  });
  return organizationId;
}

function subscriptionStatus(eventType: string, raw: unknown): string {
  if (eventType === "customer.subscription.deleted") return "cancelled";
  const s = raw === "canceled" ? "cancelled" : String(raw);
  if (!STATUSES.has(s)) throw new Error(`Unknown Stripe subscription status: ${s}`);
  return s;
}

async function subscriptionChanged(db: Db, event: StripeEvent, sub: Record<string, unknown>): Promise<string | null> {
  const subscriptionId = str(sub.id);
  const customer = idOf(sub.customer);
  if (!subscriptionId) throw new Error("Subscription event without an id");
  const organizationId = await resolveOrganization(db, [meta(sub).organization_id], customer);
  if (!organizationId) {
    log.warn("stripe.webhook_unmatched", { type: event.type });
    return null;
  }
  const item = ((sub.items as { data?: Record<string, unknown>[] } | undefined)?.data ?? [])[0] ?? {};
  const priceId = idOf(item.price);
  const plan = priceId
    ? await db.one<{ id: string }>("select id from platform.plans where stripe_price_id = $1", [priceId])
    : null;
  if (!plan) {
    // Throwing makes Stripe retry for days, which gives an operator time to set plans.stripe_price_id.
    log.error("stripe.unknown_price", { price: priceId, subscription: subscriptionId });
    throw new Error(`No plan has stripe_price_id ${priceId}`);
  }
  const status = subscriptionStatus(event.type, sub.status);
  // Newer API versions moved the period onto the subscription item.
  const periodStart = time(sub.current_period_start) ?? time(item.current_period_start) ?? time(sub.start_date) ?? new Date(event.created * 1000);
  const periodEnd = time(sub.current_period_end) ?? time(item.current_period_end) ?? periodStart;
  const cancelledAt = time(sub.canceled_at) ?? (status === "cancelled" ? time(sub.ended_at) ?? new Date(event.created * 1000) : null);

  const row = await db.one<{ id: string }>(
    `insert into platform.subscriptions
       (organization_id, plan_id, status, provider, provider_subscription_id, provider_customer_id,
        current_period_start, current_period_end, cancel_at_period_end, cancelled_at, provider_event_at)
     values ($1, $2, $3, 'stripe', $4, $5, $6, $7, $8, $9, to_timestamp($10))
     on conflict (provider, provider_subscription_id) where provider_subscription_id is not null do update set
       plan_id = excluded.plan_id, status = excluded.status, provider_customer_id = excluded.provider_customer_id,
       current_period_start = excluded.current_period_start, current_period_end = excluded.current_period_end,
       cancel_at_period_end = excluded.cancel_at_period_end, cancelled_at = excluded.cancelled_at,
       provider_event_at = excluded.provider_event_at
     where platform.subscriptions.organization_id = excluded.organization_id
       and (platform.subscriptions.provider_event_at is null or platform.subscriptions.provider_event_at <= excluded.provider_event_at)
     returning id`,
    [organizationId, plan.id, status, subscriptionId, customer, periodStart, periodEnd, sub.cancel_at_period_end === true, cancelledAt, event.created],
  );
  if (!row) {
    log.info("stripe.webhook_stale", { type: event.type, subscription: subscriptionId });
    return organizationId;
  }
  if (customer) {
    await db.query("update platform.organizations set billing_customer_id = $2 where id = $1 and billing_customer_id is null", [organizationId, customer]);
  }
  await audit(db, {
    organizationId, actorUserId: null, actorType: "system", action: "billing.subscription_updated", targetType: "subscription", targetId: row.id,
    metadata: { plan_id: plan.id, status, cancel_at_period_end: sub.cancel_at_period_end === true },
  });
  await syncPlan(db, organizationId, plan.id, status);
  return organizationId;
}

/**
 * Sets the organization's plan from its subscriptions: the entitled one with
 * the latest period end, else free. A plan set by hand (e.g. enterprise on an
 * invoice contract) is left alone when an unrelated subscription ends.
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

async function invoiceChanged(db: Db, event: StripeEvent, inv: Record<string, unknown>): Promise<string | null> {
  const invoiceId = str(inv.id);
  if (!invoiceId) throw new Error("Invoice event without an id");
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
    return null;
  }
  const paid = event.type === "invoice.paid";
  const status = paid ? "paid" : ["draft", "open", "void", "uncollectible"].includes(String(inv.status)) ? String(inv.status) : "open";
  const line = ((inv.lines as { data?: { period?: { start?: unknown; end?: unknown } }[] } | undefined)?.data ?? [])[0]?.period;
  const periodStart = time(line?.start) ?? time(inv.period_start) ?? new Date(event.created * 1000);
  const periodEnd = time(line?.end) ?? time(inv.period_end) ?? periodStart;
  const amount = Number(paid ? inv.amount_paid : inv.amount_due) || 0;
  const currency = (str(inv.currency) ?? "usd").toUpperCase();
  const paidAt = paid ? time((inv.status_transitions as { paid_at?: unknown } | undefined)?.paid_at) ?? new Date(event.created * 1000) : null;

  const row = await db.one<{ id: string }>(
    `insert into platform.invoices
       (organization_id, subscription_id, provider_invoice_id, amount_cents, currency, status, period_start, period_end,
        number, hosted_invoice_url, invoice_pdf_url, paid_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     on conflict (provider_invoice_id) where provider_invoice_id is not null do update set
       subscription_id = coalesce(excluded.subscription_id, platform.invoices.subscription_id),
       amount_cents = case when platform.invoices.status = 'paid' then platform.invoices.amount_cents else excluded.amount_cents end,
       -- a late payment_failed never overwrites a recorded payment
       status = case when platform.invoices.status = 'paid' then 'paid' else excluded.status end,
       number = coalesce(excluded.number, platform.invoices.number),
       hosted_invoice_url = coalesce(excluded.hosted_invoice_url, platform.invoices.hosted_invoice_url),
       invoice_pdf_url = coalesce(excluded.invoice_pdf_url, platform.invoices.invoice_pdf_url),
       paid_at = coalesce(platform.invoices.paid_at, excluded.paid_at)
     where platform.invoices.organization_id = excluded.organization_id
     returning id`,
    [organizationId, ours?.id ?? null, invoiceId, amount, currency, status, periodStart, periodEnd,
     str(inv.number), httpsUrl(inv.hosted_invoice_url), httpsUrl(inv.invoice_pdf), paidAt],
  );
  if (row) {
    await audit(db, {
      organizationId, actorUserId: null, actorType: "system", action: paid ? "billing.invoice_paid" : "billing.payment_failed", targetType: "invoice", targetId: row.id,
      metadata: { amount_cents: amount, currency, number: str(inv.number) },
    });
  }
  return organizationId;
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
