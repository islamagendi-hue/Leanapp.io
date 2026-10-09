import "server-only";
import { msg } from "@/i18n/translate";
import { ConflictError, ValidationError } from "@/lib/errors";
import { audit } from "@/modules/audit/service";
import { can } from "@/modules/rbac/authorize";
import { tenantTx, type TenantContext } from "@/modules/tenancy/context";
import { usageSummary, type UsageSummary } from "@/modules/usage/service";
import { publicAppUrl } from "@/server/env";
import { asLimit } from "./limits";
import { downgradeBlockers, INTERVALS, isInterval, overageEvents, planChange, type BillingInterval, type CheckoutMode, type DowngradeBlocker, type PlanChange } from "./plans";
import { billingProvider, type BillingProvider } from "./provider";
import { billingStatus, checkoutPrice, type BillingConfigState } from "./status";
import { PaymentProviderError, PaymentsNotConnectedError } from "./stripe";
import { TERMINAL } from "./webhook";

export interface PlanPriceOption {
  interval: BillingInterval;
  /** List price in cents when known (the monthly one is on the public pricing); null = shown at checkout. */
  amountCents: number | null;
  /** Checkout can start for this interval now (provider ready, price configured and verified). */
  available: boolean;
}

export interface PlanOption {
  id: string;
  name: string;
  description: string | null;
  priceMonthlyCents: number | null;
  /** The monthly price is a starting price that grows with usage. */
  priceIsMinimum: boolean;
  usageBased: boolean;
  currency: string;
  checkout: CheckoutMode;
  trialDays: number | null;
  /** True when at least one interval can be bought now. */
  purchasable: boolean;
  prices: PlanPriceOption[];
  current: boolean;
  change: PlanChange;
  /** Hard limits current usage would exceed on this plan (shown before a downgrade). */
  blockers: DowngradeBlocker[];
  limits: { events: number | null; apps: number | null; seats: number | null; retentionDays: number | null };
}

export interface SubscriptionView {
  id: string;
  plan_id: string;
  status: string;
  billing_interval: BillingInterval | null;
  current_period_start: Date;
  current_period_end: Date;
  cancel_at_period_end: boolean;
  trial_end: Date | null;
  ended_at: Date | null;
}

export interface InvoiceView {
  id: string;
  number: string | null;
  amount_cents: string;
  amount_refunded_cents: string;
  currency: string;
  status: string;
  period_start: Date;
  period_end: Date;
  paid_at: Date | null;
  hosted_invoice_url: string | null;
  invoice_pdf_url: string | null;
}

/** What an organization's members may know about the payment setup: no keys, ids or check details. */
export interface PaymentsView {
  state: BillingConfigState;
  mode: "test" | "live" | null;
  checkoutEnabled: boolean;
}

export interface BillingOverview {
  usage: UsageSummary;
  /** Kept for callers that only need a yes/no: checkout can be offered. */
  paymentsConnected: boolean;
  payments: PaymentsView;
  /** The viewer may start checkout and open the portal (billing.manage). */
  canManage: boolean;
  hasBillingAccount: boolean;
  /** The subscription that currently decides the plan, if any (any non-terminal state). */
  subscription: SubscriptionView | null;
  /** The most recent subscription that ended, when there's no current one. */
  endedSubscription: SubscriptionView | null;
  invoices: InvoiceView[];
  plans: PlanOption[];
  /** Usage-based plans: events above the included allowance this month. Prepared for metered billing; not charged. */
  overageEvents: number;
}

const SUBSCRIPTION_COLUMNS = "id, plan_id, status, billing_interval, current_period_start, current_period_end, cancel_at_period_end, trial_end, ended_at";

interface PlanRow {
  id: string;
  name: string;
  description: string | null;
  sort_order: number;
  price_monthly_cents: string | null;
  price_annual_cents: string | null;
  price_is_minimum: boolean;
  usage_based: boolean;
  checkout: CheckoutMode;
  trial_days: number | null;
  currency: string;
  features: Record<string, unknown> | null;
}

export async function billingOverview(ctx: TenantContext, now = new Date()): Promise<BillingOverview> {
  const usage = await usageSummary(ctx, now);
  const canManage = can(ctx.role, "billing.manage");
  // Owners' visits re-verify stale credentials (only when keys exist); everyone else reads the stored result.
  const status = await billingStatus({ autoVerify: canManage });
  const livemode = status.mode === "live";
  return tenantTx(ctx, "billing.read", async (db) => {
    const customer = status.mode
      ? await db.one("select 1 from platform.billing_customers where provider = 'stripe' and livemode = $1", [livemode])
      : null;
    const subscription = await db.one<SubscriptionView>(
      `select ${SUBSCRIPTION_COLUMNS} from platform.subscriptions where status <> all($1) order by current_period_end desc limit 1`,
      [TERMINAL],
    );
    const endedSubscription = subscription
      ? null
      : await db.one<SubscriptionView>(`select ${SUBSCRIPTION_COLUMNS} from platform.subscriptions where status = any($1) order by coalesce(ended_at, updated_at) desc limit 1`, [TERMINAL]);
    const invoices = await db.query<InvoiceView>(
      `select id, number, amount_cents, amount_refunded_cents, currency, status, period_start, period_end, paid_at, hosted_invoice_url, invoice_pdf_url
         from platform.invoices order by period_start desc, created_at desc limit 24`,
    );
    const plans = await db.query<PlanRow>(
      `select p.id, p.name, p.description, p.sort_order, p.price_monthly_cents, p.price_annual_cents, p.price_is_minimum, p.usage_based,
              p.checkout, p.trial_days, p.currency,
              (select jsonb_object_agg(f.feature, f.value) from platform.plan_features f where f.plan_id = p.id) as features
         from platform.plans p where p.is_public or p.id = $1 order by p.sort_order`,
      [usage.plan.id],
    );
    const current = plans.find((p) => p.id === usage.plan.id) ?? { id: usage.plan.id, sort_order: 0 };
    const used = (k: string) => usage.lines.find((l) => l.key === k)?.used ?? 0;
    const eventsLine = usage.lines.find((l) => l.key === "events");
    const options = plans.map((p): PlanOption => {
      const limits = {
        events: asLimit(p.features?.["limit.events_per_month"]),
        apps: asLimit(p.features?.["limit.apps"]),
        seats: asLimit(p.features?.["limit.seats"]),
        retentionDays: asLimit(p.features?.["retention.days"]),
      };
      const sellable = p.checkout === "self_serve";
      const prices = sellable
        ? INTERVALS.map((interval) => ({
            interval,
            amountCents: interval === "month" ? numOrNull(p.price_monthly_cents) : numOrNull(p.price_annual_cents),
            available: checkoutPrice(status, p.id, interval) !== null,
          }))
        : [];
      const change = planChange({ id: current.id, sortOrder: current.sort_order }, { id: p.id, sortOrder: p.sort_order });
      return {
        id: p.id,
        name: p.name,
        description: p.description,
        priceMonthlyCents: numOrNull(p.price_monthly_cents),
        priceIsMinimum: p.price_is_minimum,
        usageBased: p.usage_based,
        currency: p.currency,
        checkout: p.checkout,
        trialDays: p.trial_days,
        purchasable: prices.some((x) => x.available),
        prices,
        current: p.id === usage.plan.id,
        change,
        blockers: change === "downgrade" ? downgradeBlockers({ apps: used("apps"), seats: used("seats") }, limits) : [],
        limits,
      };
    });
    const currentOption = options.find((o) => o.current);
    return {
      usage,
      paymentsConnected: status.checkoutEnabled,
      payments: { state: status.state, mode: status.mode, checkoutEnabled: status.checkoutEnabled },
      canManage,
      hasBillingAccount: Boolean(customer),
      subscription,
      endedSubscription,
      invoices,
      plans: options,
      overageEvents: overageEvents(eventsLine?.used ?? 0, eventsLine?.limit ?? null, currentOption?.usageBased ?? false),
    };
  });
}

const numOrNull = (v: string | null) => (v === null ? null : Number(v));
const billingPage = (ctx: TenantContext) => `${publicAppUrl()}/o/${encodeURIComponent(ctx.organizationSlug)}/settings/billing`;

/** Checkout requests within this window with the same plan and interval share one Checkout Session (double clicks, retries). */
const CHECKOUT_IDEMPOTENCY_WINDOW_MS = 10 * 60_000;

/** The organization's provider customer in the provider's mode, created on first use. */
async function ensureCustomer(ctx: TenantContext, provider: BillingProvider, org: { name: string; email: string | null }): Promise<string> {
  const livemode = provider.mode === "live";
  const existing = await tenantTx(ctx, "billing.manage", (db) =>
    db.one<{ provider_customer_id: string }>("select provider_customer_id from platform.billing_customers where provider = 'stripe' and livemode = $1", [livemode]),
  );
  if (existing) return existing.provider_customer_id;
  // Two concurrent first checkouts get the same customer back from the provider.
  const created = await provider.createCustomer({ organizationId: ctx.organizationId, name: org.name, email: org.email }, `leanapp-customer-${provider.mode}-${ctx.organizationId}`);
  return tenantTx(ctx, "billing.manage", async (db) => {
    await db.query(
      `insert into platform.billing_customers (organization_id, provider, livemode, provider_customer_id) values ($1, 'stripe', $2, $3)
       on conflict do nothing`,
      [ctx.organizationId, livemode, created.id],
    );
    await db.query("update platform.organizations set billing_customer_id = coalesce(billing_customer_id, $2) where id = $1", [ctx.organizationId, created.id]);
    const row = await db.one<{ provider_customer_id: string }>(
      "select provider_customer_id from platform.billing_customers where provider = 'stripe' and livemode = $1",
      [livemode],
    );
    // The provider returned a customer already linked to another organization: never share one.
    if (!row) throw new PaymentProviderError();
    return row.provider_customer_id;
  });
}

/**
 * Starts Checkout for a self-serve plan and interval and returns the
 * provider's Checkout URL. The plan, its price and currency are resolved here
 * from configuration and verified state; the client only names a plan and an
 * interval. Paying doesn't change the plan: the provider's webhook does.
 * Changing an existing subscription goes through the Customer Portal.
 */
export async function startCheckout(ctx: TenantContext, planId: unknown, intervalInput: unknown = "month", now = new Date()): Promise<string> {
  if (typeof planId !== "string" || !/^[a-z0-9_-]{1,40}$/.test(planId)) throw new ValidationError(msg("Choose a plan."));
  if (!isInterval(intervalInput)) throw new ValidationError(msg("Choose monthly or annual billing."));
  const interval = intervalInput;
  const pre = await tenantTx(ctx, "billing.manage", async (db) => {
    const plan = await db.one<{ id: string; checkout: CheckoutMode; trial_days: number | null }>(
      "select id, checkout, trial_days from platform.plans where id = $1 and is_public",
      [planId],
    );
    const live = await db.one("select 1 from platform.subscriptions where provider = 'stripe' and status <> all($1) limit 1", [TERMINAL]);
    const before = await db.one("select 1 from platform.subscriptions limit 1");
    const org = await db.one<{ name: string }>("select name from platform.organizations where id = $1", [ctx.organizationId]);
    const me = await db.one<{ email: string }>("select email from platform.users where id = $1", [ctx.userId]);
    return { plan, live: Boolean(live), hadSubscription: Boolean(before), orgName: org!.name, email: me?.email ?? null };
  });
  const provider = billingProvider();
  if (!provider) throw new PaymentsNotConnectedError();
  if (!pre.plan || pre.plan.checkout !== "self_serve") throw new ValidationError(msg("This plan can't be bought online yet. Contact sales@leanapp.io."));
  if (pre.live) throw new ConflictError(msg("This organization already has a subscription. Use Manage billing to change plans."));
  const status = await billingStatus();
  if (!status.checkoutEnabled) throw new PaymentsNotConnectedError();
  const priceId = checkoutPrice(status, pre.plan.id, interval);
  if (!priceId) throw new ValidationError(msg("This plan can't be bought online yet. Contact sales@leanapp.io."));

  const customerId = await ensureCustomer(ctx, provider, { name: pre.orgName, email: pre.email });
  const bucket = Math.floor(now.getTime() / CHECKOUT_IDEMPOTENCY_WINDOW_MS);
  const session = await provider.createCheckoutSession({
    organizationId: ctx.organizationId,
    customerId,
    planId: pre.plan.id,
    interval,
    priceId,
    successUrl: `${billingPage(ctx)}?checkout=success`,
    cancelUrl: `${billingPage(ctx)}?checkout=cancelled`,
    // A trial is offered once per organization.
    trialDays: pre.hadSubscription ? null : pre.plan.trial_days,
    idempotencyKey: `leanapp-checkout-${provider.mode}-${ctx.organizationId}-${pre.plan.id}-${interval}-${bucket}`,
  });
  await tenantTx(ctx, "billing.manage", (db) =>
    audit(db, { organizationId: ctx.organizationId, actorUserId: ctx.userId, action: "billing.checkout_started", targetType: "plan", targetId: pre.plan!.id, metadata: { interval, mode: provider.mode } }),
  );
  return session.url;
}

/** A Customer Portal session (payment methods, plan changes, cancellation, invoices). */
export async function openBillingPortal(ctx: TenantContext): Promise<string> {
  const provider = billingProvider();
  const customerId = await tenantTx(ctx, "billing.manage", async (db) => {
    if (!provider) throw new PaymentsNotConnectedError();
    const row = await db.one<{ provider_customer_id: string }>(
      "select provider_customer_id from platform.billing_customers where provider = 'stripe' and livemode = $1",
      [provider.mode === "live"],
    );
    if (!row) throw new ConflictError(msg("There's no billing account yet. Upgrade to a paid plan first."));
    return row.provider_customer_id;
  });
  const session = await provider!.createPortalSession({ customerId, returnUrl: billingPage(ctx) });
  await tenantTx(ctx, "billing.manage", (db) =>
    audit(db, { organizationId: ctx.organizationId, actorUserId: ctx.userId, action: "billing.portal_opened", targetType: "organization", targetId: ctx.organizationId }),
  );
  return session.url;
}
