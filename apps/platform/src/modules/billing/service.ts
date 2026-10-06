import "server-only";
import { ConflictError, ValidationError } from "@/lib/errors";
import { audit } from "@/modules/audit/service";
import { can } from "@/modules/rbac/authorize";
import { tenantTx, type TenantContext } from "@/modules/tenancy/context";
import { usageSummary, type UsageSummary } from "@/modules/usage/service";
import { publicAppUrl } from "@/server/env";
import { asLimit } from "./limits";
import { paymentsConnected, PaymentsNotConnectedError, stripeApi } from "./stripe";

export interface PlanOption {
  id: string;
  name: string;
  description: string | null;
  priceMonthlyCents: number | null;
  currency: string;
  /** True when the plan has a Stripe price and payments are connected. */
  purchasable: boolean;
  current: boolean;
  limits: { events: number | null; apps: number | null; seats: number | null; retentionDays: number | null };
}

export interface SubscriptionView {
  id: string;
  plan_id: string;
  status: string;
  current_period_start: Date;
  current_period_end: Date;
  cancel_at_period_end: boolean;
}

export interface InvoiceView {
  id: string;
  number: string | null;
  amount_cents: string;
  currency: string;
  status: string;
  period_start: Date;
  period_end: Date;
  paid_at: Date | null;
  hosted_invoice_url: string | null;
  invoice_pdf_url: string | null;
}

export interface BillingOverview {
  usage: UsageSummary;
  paymentsConnected: boolean;
  /** The viewer may start checkout and open the portal (billing.manage). */
  canManage: boolean;
  hasBillingAccount: boolean;
  subscription: SubscriptionView | null;
  invoices: InvoiceView[];
  plans: PlanOption[];
}

const LIVE = ["trialing", "active", "past_due", "unpaid", "paused", "incomplete"];

export async function billingOverview(ctx: TenantContext, now = new Date()): Promise<BillingOverview> {
  const usage = await usageSummary(ctx, now);
  const connected = paymentsConnected();
  return tenantTx(ctx, "billing.read", async (db) => {
    const org = await db.one<{ billing_customer_id: string | null }>("select billing_customer_id from platform.organizations where id = $1", [ctx.organizationId]);
    const subscription = await db.one<SubscriptionView>(
      `select id, plan_id, status, current_period_start, current_period_end, cancel_at_period_end
         from platform.subscriptions where status = any($1) order by current_period_end desc limit 1`,
      [LIVE],
    );
    const invoices = await db.query<InvoiceView>(
      `select id, number, amount_cents, currency, status, period_start, period_end, paid_at, hosted_invoice_url, invoice_pdf_url
         from platform.invoices order by period_start desc, created_at desc limit 24`,
    );
    const plans = await db.query<{ id: string; name: string; description: string | null; price_monthly_cents: string | null; currency: string; stripe_price_id: string | null; features: Record<string, unknown> | null }>(
      `select p.id, p.name, p.description, p.price_monthly_cents, p.currency, p.stripe_price_id,
              (select jsonb_object_agg(f.feature, f.value) from platform.plan_features f where f.plan_id = p.id) as features
         from platform.plans p where p.is_public or p.id = $1 order by p.sort_order`,
      [usage.plan.id],
    );
    return {
      usage,
      paymentsConnected: connected,
      canManage: can(ctx.role, "billing.manage"),
      hasBillingAccount: Boolean(org?.billing_customer_id),
      subscription,
      invoices,
      plans: plans.map((p) => ({
        id: p.id,
        name: p.name,
        description: p.description,
        priceMonthlyCents: p.price_monthly_cents === null ? null : Number(p.price_monthly_cents),
        currency: p.currency,
        purchasable: connected && Boolean(p.stripe_price_id),
        current: p.id === usage.plan.id,
        limits: {
          events: asLimit(p.features?.["limit.events_per_month"]),
          apps: asLimit(p.features?.["limit.apps"]),
          seats: asLimit(p.features?.["limit.seats"]),
          retentionDays: asLimit(p.features?.["retention.days"]),
        },
      })),
    };
  });
}

const billingPage = (ctx: TenantContext) => `${publicAppUrl()}/o/${ctx.organizationSlug}/settings/billing`;

/**
 * Starts Stripe Checkout for a paid plan and returns its URL. Creates the
 * organization's Stripe customer on first use. Changing an existing
 * subscription goes through the Customer Portal instead.
 */
export async function startCheckout(ctx: TenantContext, planId: unknown): Promise<string> {
  if (typeof planId !== "string" || !/^[a-z0-9_-]{1,40}$/.test(planId)) throw new ValidationError("Choose a plan.");
  const pre = await tenantTx(ctx, "billing.manage", async (db) => {
    if (!paymentsConnected()) throw new PaymentsNotConnectedError();
    const plan = await db.one<{ id: string; name: string; stripe_price_id: string | null }>(
      "select id, name, stripe_price_id from platform.plans where id = $1 and is_public",
      [planId],
    );
    if (!plan?.stripe_price_id) throw new ValidationError("This plan can't be bought online yet. Contact sales@leanapp.io.");
    const live = await db.one("select 1 from platform.subscriptions where provider = 'stripe' and status = any($1) limit 1", [LIVE]);
    if (live) throw new ConflictError("This organization already has a subscription. Use Manage billing to change plans.");
    const org = await db.one<{ billing_customer_id: string | null; name: string }>(
      "select billing_customer_id, name from platform.organizations where id = $1",
      [ctx.organizationId],
    );
    const me = await db.one<{ email: string }>("select email from platform.users where id = $1", [ctx.userId]);
    return { plan, customerId: org!.billing_customer_id, orgName: org!.name, email: me?.email };
  });

  let customerId = pre.customerId;
  if (!customerId) {
    const customer = await stripeApi<{ id: string }>(
      "POST",
      "/v1/customers",
      { name: pre.orgName, email: pre.email, metadata: { organization_id: ctx.organizationId } },
      // Two concurrent first checkouts get the same customer back.
      { idempotencyKey: `leanapp-customer-${ctx.organizationId}` },
    );
    customerId = await tenantTx(ctx, "billing.manage", async (db) => {
      const row = await db.one<{ billing_customer_id: string }>(
        "update platform.organizations set billing_customer_id = coalesce(billing_customer_id, $2) where id = $1 returning billing_customer_id",
        [ctx.organizationId, customer.id],
      );
      return row!.billing_customer_id;
    });
  }

  const metadata = { organization_id: ctx.organizationId, plan_id: pre.plan.id };
  const session = await stripeApi<{ id: string; url: string }>("POST", "/v1/checkout/sessions", {
    mode: "subscription",
    customer: customerId,
    client_reference_id: ctx.organizationId,
    line_items: [{ price: pre.plan.stripe_price_id, quantity: 1 }],
    success_url: `${billingPage(ctx)}?checkout=success`,
    cancel_url: `${billingPage(ctx)}?checkout=cancelled`,
    metadata,
    subscription_data: { metadata },
  });
  await tenantTx(ctx, "billing.manage", (db) =>
    audit(db, { organizationId: ctx.organizationId, actorUserId: ctx.userId, action: "billing.checkout_started", targetType: "plan", targetId: pre.plan.id }),
  );
  return session.url;
}

/** A Stripe Customer Portal session (payment methods, plan changes, cancellation, invoices). */
export async function openBillingPortal(ctx: TenantContext): Promise<string> {
  const customerId = await tenantTx(ctx, "billing.manage", async (db) => {
    if (!paymentsConnected()) throw new PaymentsNotConnectedError();
    const org = await db.one<{ billing_customer_id: string | null }>("select billing_customer_id from platform.organizations where id = $1", [ctx.organizationId]);
    if (!org?.billing_customer_id) throw new ConflictError("There's no billing account yet. Upgrade to a paid plan first.");
    return org.billing_customer_id;
  });
  const session = await stripeApi<{ url: string }>("POST", "/v1/billing_portal/sessions", { customer: customerId, return_url: billingPage(ctx) });
  await tenantTx(ctx, "billing.manage", (db) =>
    audit(db, { organizationId: ctx.organizationId, actorUserId: ctx.userId, action: "billing.portal_opened", targetType: "organization", targetId: ctx.organizationId }),
  );
  return session.url;
}
