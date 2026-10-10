import "server-only";
/** BillingProvider for Stripe (see provider.ts). Requests go through stripe.ts. */
import type { BillingProvider, PriceCheck, PriceExpectation, VerificationResult, WebhookEndpointCheck } from "./provider";
import { isAllowedProviderRedirect, PaymentProviderError, stripeRequest, type StripeConfig } from "./stripe";

const ok = (status: number) => status >= 200 && status < 300;

export function stripeAdapter(config: StripeConfig): BillingProvider {
  const call = async <T>(method: "GET" | "POST", path: string, params: Record<string, unknown> = {}, idempotencyKey?: string): Promise<T> => {
    const res = await stripeRequest<T>(config.secretKey, method, path, params, { idempotencyKey });
    if (!ok(res.status)) throw new PaymentProviderError();
    return res.body;
  };

  return {
    id: "stripe",
    mode: config.mode,

    async createCustomer({ organizationId, name, email }, idempotencyKey) {
      const c = await call<{ id?: unknown }>("POST", "/v1/customers", { name, email: email ?? undefined, metadata: { organization_id: organizationId } }, idempotencyKey);
      if (typeof c.id !== "string" || !c.id.startsWith("cus_")) throw new PaymentProviderError();
      return { id: c.id };
    },

    async createCheckoutSession(r) {
      const metadata = { organization_id: r.organizationId, plan_id: r.planId, interval: r.interval };
      const s = await call<{ id?: unknown; url?: unknown }>(
        "POST",
        "/v1/checkout/sessions",
        {
          mode: "subscription",
          customer: r.customerId,
          client_reference_id: r.organizationId,
          line_items: [{ price: r.priceId, quantity: 1 }],
          success_url: r.successUrl,
          cancel_url: r.cancelUrl,
          metadata,
          subscription_data: { metadata, trial_period_days: r.trialDays ?? undefined },
        },
        r.idempotencyKey,
      );
      // Never send the browser anywhere but Stripe's own Checkout host.
      if (typeof s.id !== "string" || !isAllowedProviderRedirect(s.url)) throw new PaymentProviderError();
      return { id: s.id, url: s.url };
    },

    async createPortalSession({ customerId, returnUrl }) {
      const s = await call<{ url?: unknown }>("POST", "/v1/billing_portal/sessions", { customer: customerId, return_url: returnUrl });
      if (!isAllowedProviderRedirect(s.url)) throw new PaymentProviderError();
      return { url: s.url };
    },

    async getSubscription(id) {
      if (!/^sub_[A-Za-z0-9]+$/.test(id)) return null;
      const res = await stripeRequest<Record<string, unknown>>(config.secretKey, "GET", `/v1/subscriptions/${id}`);
      if (res.status === 404) return null;
      if (!ok(res.status)) throw new PaymentProviderError();
      return res.body;
    },

    async verify({ prices, webhookUrl, requiredEvents }): Promise<VerificationResult> {
      const result: VerificationResult = { ok: false, mode: config.mode, account: { ok: false }, prices: [], webhook: { state: "unverifiable", url: webhookUrl } };
      try {
        result.account = await checkAccount(config.secretKey);
      } catch {
        result.account = { ok: false, problem: "unreachable" };
      }
      if (!result.account.ok) return result;
      for (const p of prices) result.prices.push(await checkPrice(config, p));
      result.webhook = await checkWebhook(config.secretKey, webhookUrl, requiredEvents);
      result.ok = result.account.ok && result.prices.length > 0 && result.prices.every((p) => p.ok);
      return result;
    },
  };
}

/** The key authenticates: /v1/account for a full secret key; a restricted key without account access is probed with a customers list. */
async function checkAccount(secretKey: string): Promise<VerificationResult["account"]> {
  const acct = await stripeRequest<{ id?: string; charges_enabled?: boolean }>(secretKey, "GET", "/v1/account");
  if (acct.status === 401) return { ok: false, problem: "key_invalid" };
  if (ok(acct.status)) return { ok: true, id: acct.body.id ?? null, chargesEnabled: acct.body.charges_enabled ?? null };
  const probe = await stripeRequest(secretKey, "GET", "/v1/customers", { limit: 1 });
  if (probe.status === 401) return { ok: false, problem: "key_invalid" };
  if (!ok(probe.status)) return { ok: false, problem: "key_forbidden" };
  return { ok: true, id: null, chargesEnabled: null };
}

async function checkPrice(config: StripeConfig, p: PriceExpectation): Promise<PriceCheck> {
  const base = { planId: p.planId, interval: p.interval, priceId: p.priceId };
  let res;
  try {
    res = await stripeRequest<{
      active?: boolean; livemode?: boolean; currency?: string; unit_amount?: number | null; type?: string;
      billing_scheme?: string; recurring?: { interval?: string; interval_count?: number; usage_type?: string } | null;
    }>(config.secretKey, "GET", `/v1/prices/${p.priceId}`);
  } catch {
    return { ...base, ok: false, problem: "unreadable" };
  }
  if (res.status === 404) return { ...base, ok: false, problem: "missing" };
  if (!ok(res.status)) return { ...base, ok: false, problem: "unreadable" };
  const price = res.body;
  const fail = (problem: string, extra: Partial<PriceCheck> = {}): PriceCheck => ({ ...base, ok: false, problem, ...extra });
  if (price.livemode !== (config.mode === "live")) return fail("wrong_mode");
  if (price.active !== true) return fail("inactive");
  if (price.type !== "recurring" || !price.recurring) return fail("not_recurring");
  if (price.recurring.interval !== p.interval || (price.recurring.interval_count ?? 1) !== 1) return fail("wrong_interval");
  if ((price.currency ?? "").toUpperCase() !== p.currency.toUpperCase()) return fail("wrong_currency");
  if (p.amountCents !== null && price.billing_scheme !== "tiered" && price.unit_amount !== p.amountCents) return fail("amount_differs", { amountCents: price.unit_amount ?? null });
  return { ...base, ok: true };
}

async function checkWebhook(secretKey: string, url: string, required: readonly string[]): Promise<WebhookEndpointCheck> {
  let res;
  try {
    res = await stripeRequest<{ data?: { url?: string; status?: string; enabled_events?: string[] }[] }>(secretKey, "GET", "/v1/webhook_endpoints", { limit: 100 });
  } catch {
    return { state: "unverifiable", url };
  }
  // A restricted key without webhook read access can't see endpoints: received signed events still prove it.
  if (!ok(res.status)) return { state: "unverifiable", url };
  const endpoints = (res.body.data ?? []).filter((e) => e.url === url);
  if (!endpoints.length) return { state: "missing", url };
  const enabled = endpoints.filter((e) => e.status === "enabled");
  if (!enabled.length) return { state: "disabled", url };
  const best = enabled
    .map((e) => ({ e, missing: e.enabled_events?.includes("*") ? [] : required.filter((x) => !e.enabled_events?.includes(x)) }))
    .sort((a, b) => a.missing.length - b.missing.length)[0];
  return best.missing.length ? { state: "missing_events", url, missingEvents: best.missing } : { state: "found", url };
}
