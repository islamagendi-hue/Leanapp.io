/** Plan limits, usage notices, billing configuration status, Stripe checkout, webhooks and reconciliation (Stripe is faked), entitlements. */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { withSystem } from "@/lib/db";
import { createApp } from "@/modules/apps/service";
import { listAuditLogs } from "@/modules/audit/service";
import { signUp } from "@/modules/auth/service";
import { assertEntitled, clearAllowanceCache, eventAllowance, featureEntitled } from "@/modules/billing/enforcement";
import { sendUsageNotices } from "@/modules/billing/notices";
import { billingOverview, openBillingPortal, startCheckout } from "@/modules/billing/service";
import { reconcileSubscriptions } from "@/modules/billing/reconcile";
import { billingStatus, verifyBillingProvider, webhookUrl } from "@/modules/billing/status";
import { stripeSignatureHeader } from "@/modules/billing/stripe";
import { handleStripeWebhook } from "@/modules/billing/webhook";
import { authenticateIngestionKey } from "@/modules/credentials/service";
import { outbox } from "@/modules/email/service";
import { ingest, PLAN_GRACE_HEADER } from "@/modules/ingestion/service";
import { acceptInvitation, inviteMember, revokeInvitation } from "@/modules/organizations/service";
import { usageSummary } from "@/modules/usage/service";
import { makeTenant } from "./helpers";

type T = Awaited<ReturnType<typeof makeTenant>>;
const WHSEC = "whsec_integration_test";

/** A private test plan with the given limits; the organization moves onto it. */
async function onPlan(orgId: string, id: string, limits: { events?: number | null; apps?: number | null; seats?: number | null }) {
  await withSystem(async (db) => {
    await db.query("insert into platform.plans (id, name, is_public, sort_order) values ($1, $1, false, 99) on conflict do nothing", [id]);
    for (const [k, f] of [["events", "limit.events_per_month"], ["apps", "limit.apps"], ["seats", "limit.seats"]] as const) {
      if (k in limits) {
        await db.query(
          "insert into platform.plan_features (plan_id, feature, value) values ($1, $2, $3) on conflict (plan_id, feature) do update set value = excluded.value",
          [id, f, JSON.stringify(limits[k] ?? null)],
        );
      }
    }
    await db.query("update platform.organizations set plan_id = $2 where id = $1", [orgId, id]);
  });
  clearAllowanceCache(orgId);
}

async function verifiedUser(label: string) {
  const email = `${label}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@example.com`;
  const { user } = await signUp({ name: label, email, password: "correct-horse-9" }, { ip: "10.9.0.1" });
  await withSystem((db) => db.query("update platform.users set email_verified_at = now() where id = $1", [user.id]));
  return { user, email };
}

const track = (n: number) => Array.from({ length: n }, () => ({ type: "track", event_name: "item_viewed", event_id: crypto.randomUUID(), anonymous_id: "a1" }));
const eventCount = async (orgId: string) =>
  Number((await withSystem((db) => db.one<{ n: string }>("select count(*) as n from platform.events where organization_id = $1", [orgId])))!.n);

describe("app and seat limits", () => {
  let t: T;
  beforeAll(async () => {
    t = await makeTenant("limits");
  });

  it("refuses a second app on the evaluation plan (1 app) and allows up to the plan's limit", async () => {
    await expect(createApp(t.ctx, { name: "Second", platforms: ["ios"] })).rejects.toMatchObject({ code: "plan_limit_exceeded", status: 403 });
    await onPlan(t.org.id, "test_apps3", { apps: 3 });
    await createApp(t.ctx, { name: "Second", platforms: ["ios"] });
    await createApp(t.ctx, { name: "Third", platforms: ["ios"] });
    await expect(createApp(t.ctx, { name: "Fourth", platforms: ["ios"] })).rejects.toThrow(/includes 3 apps/);
    await onPlan(t.org.id, "test_apps_unlimited", { apps: null });
    await createApp(t.ctx, { name: "Fourth", platforms: ["ios"] });
  });

  it("counts pending invitations as seats and blocks invitations over the limit", async () => {
    const s = await makeTenant("seats"); // evaluation plan: 3 seats, 1 taken by the owner
    await inviteMember(s.ctx, { email: "a@example.com", role: "developer" });
    const second = await inviteMember(s.ctx, { email: "b@example.com", role: "developer" });
    await expect(inviteMember(s.ctx, { email: "c@example.com", role: "developer" })).rejects.toMatchObject({ code: "plan_limit_exceeded" });
    expect((await usageSummary(s.ctx)).lines.find((l) => l.key === "seats")).toMatchObject({ used: 3, limit: 3, state: "over" });
    await revokeInvitation(s.ctx, second.invitationId);
    await inviteMember(s.ctx, { email: "c@example.com", role: "developer" });
  });

  it("refuses to accept an invitation when the plan has no free seat left", async () => {
    const s = await makeTenant("seats-accept");
    const a = await verifiedUser("joiner-a");
    const b = await verifiedUser("joiner-b");
    await onPlan(s.org.id, "test_seats3", { seats: 3 });
    const ia = await inviteMember(s.ctx, { email: a.email, role: "developer" });
    const ib = await inviteMember(s.ctx, { email: b.email, role: "analyst" });
    await acceptInvitation({ id: a.user.id }, ia.token);
    await onPlan(s.org.id, "test_seats2", { seats: 2 }); // downgraded while b's invitation was pending
    await expect(acceptInvitation({ id: b.user.id }, ib.token)).rejects.toMatchObject({ code: "plan_limit_exceeded" });
  });
});

describe("monthly event allowance", () => {
  let t: T;
  beforeAll(async () => {
    t = await makeTenant("events");
    await onPlan(t.org.id, "test_events10", { events: 10 }); // refuses from 11 (10 + 10% grace)
  });

  it("accepts up to the limit, then through the grace, then refuses with plan_limit_exceeded", async () => {
    const sdk = (await authenticateIngestionKey(t.sdkKey))!;
    const r1 = await ingest(sdk, { batch: track(9) }, { mode: "batch" });
    expect(r1.status).toBe(200);
    expect(r1.headers?.[PLAN_GRACE_HEADER]).toBeUndefined();
    expect((await eventAllowance(t.org.id)).state).toBe("warning");

    const r2 = await ingest(sdk, { batch: track(1) }, { mode: "batch" }); // 9 used before: under the limit
    expect(r2.status).toBe(200);
    expect((await eventAllowance(t.org.id)).state).toBe("over");

    const r3 = await ingest(sdk, { batch: track(1) }, { mode: "batch" }); // 10 used: grace
    expect(r3.status).toBe(200);
    expect(r3.headers?.[PLAN_GRACE_HEADER]).toBe("grace");
    expect(await eventCount(t.org.id)).toBe(11);

    const r4 = await ingest(sdk, { batch: track(3) }, { mode: "batch" }); // 11 used: past the grace
    expect(r4.status).toBe(429);
    expect(r4.body).toMatchObject({ error: "plan_limit_exceeded" });
    expect(Number(r4.headers?.["Retry-After"])).toBeGreaterThanOrEqual(60);
    expect(await eventCount(t.org.id)).toBe(11); // nothing stored

    const single = await ingest(sdk, track(1)[0], { mode: "single" });
    expect(single.status).toBe(429);

    // Never silent: refused events are metered and shown.
    const u = await usageSummary(t.ctx);
    expect(u.eventsRefused).toBe(4);
    expect(u.lines.find((l) => l.key === "events")).toMatchObject({ used: 11, limit: 10, hardCap: 11, state: "blocked" });
  });

  it("enforces from the database too, not only this process's cache", async () => {
    clearAllowanceCache();
    const sdk = (await authenticateIngestionKey(t.sdkKey))!;
    expect((await ingest(sdk, { batch: track(1) }, { mode: "batch" })).status).toBe(429);
  });

  it("still replays an earlier request by Idempotency-Key", async () => {
    const other = await makeTenant("events-replay");
    await onPlan(other.org.id, "test_events2", { events: 2 });
    const sdk = (await authenticateIngestionKey(other.sdkKey))!;
    const batch = track(3);
    const first = await ingest(sdk, { batch }, { mode: "batch", idempotencyKey: "k1" });
    expect(first.status).toBe(200);
    expect((await ingest(sdk, { batch: track(1) }, { mode: "batch" })).status).toBe(429);
    // The same events: a different batch under the same key is refused with 409 (ingestion-idempotency.int.test.ts).
    const again = await ingest(sdk, { batch }, { mode: "batch", idempotencyKey: "k1" });
    expect(again).toMatchObject({ status: 200, replayed: true });
  });

  it("resets with the month and lifts on upgrade", async () => {
    const nextMonth = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth() + 1, 2));
    expect((await eventAllowance(t.org.id, nextMonth)).state).toBe("ok");
    await onPlan(t.org.id, "test_events_unlimited", { events: null });
    const sdk = (await authenticateIngestionKey(t.sdkKey))!;
    expect((await ingest(sdk, { batch: track(2) }, { mode: "batch" })).status).toBe(200);
    await onPlan(t.org.id, "test_events10", { events: 10 });
  });

  it("doesn't count another organization's events", async () => {
    const other = await makeTenant("events-other");
    expect((await eventAllowance(other.org.id, new Date(), { fresh: true })).used).toBe(0);
  });
});

describe("usage notices", () => {
  it("emails owners once per threshold per month, and only the highest new one", async () => {
    const t = await makeTenant("notices");
    await onPlan(t.org.id, "test_notices10", { events: 10 });
    const sdk = (await authenticateIngestionKey(t.sdkKey))!;
    const ownerEmail = (await withSystem((db) => db.one<{ email: string }>("select email from platform.users where id = $1", [t.user.id])))!.email;
    const mine = () => outbox.filter((m) => m.to === ownerEmail && m.kind.startsWith("usage_notice_")).map((m) => m.kind);

    await ingest(sdk, { batch: track(8) }, { mode: "batch" });
    await sendUsageNotices();
    expect(mine()).toEqual(["usage_notice_80"]);
    await sendUsageNotices();
    expect(mine()).toEqual(["usage_notice_80"]);

    await ingest(sdk, { batch: track(4) }, { mode: "batch" }); // 12: past 100% and the grace at once
    await sendUsageNotices();
    expect(mine()).toEqual(["usage_notice_80", "usage_notice_110"]);
    const rows = await withSystem((db) => db.query<{ threshold: number }>("select threshold from platform.usage_notices where organization_id = $1 order by threshold", [t.org.id]));
    expect(rows.map((r) => r.threshold)).toEqual([80, 100, 110]);
    await sendUsageNotices();
    expect(mine()).toHaveLength(2);
  });
});

describe("billing without payments configured", () => {
  it("says payments aren't connected and refuses checkout and the portal", async () => {
    const t = await makeTenant("nopay");
    const b = await billingOverview(t.ctx);
    expect(b.paymentsConnected).toBe(false);
    expect(b.plans.every((p) => !p.purchasable)).toBe(true);
    expect(b.canManage).toBe(true);
    await expect(startCheckout(t.ctx, "starter")).rejects.toMatchObject({ code: "payments_not_connected", message: "Payments are not connected yet." });
    await expect(openBillingPortal(t.ctx)).rejects.toMatchObject({ code: "payments_not_connected" });
    expect((await handleStripeWebhook("{}", "t=1,v1=" + "a".repeat(64))).status).toBe(503);
  });
});

describe("billing configuration status", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("is not_configured without variables and never calls the provider", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    vi.stubEnv("STRIPE_SECRET_KEY", "");
    vi.stubEnv("STRIPE_WEBHOOK_SECRET", "");
    const s = await billingStatus({ autoVerify: true });
    expect(s).toMatchObject({ state: "not_configured", mode: null, checkoutEnabled: false });
    expect(s.prices.map((p) => [p.planId, p.interval, p.problem])).toEqual([
      ["starter", "month", "not_configured"], ["starter", "year", "not_configured"],
      ["growth", "month", "not_configured"], ["growth", "year", "not_configured"],
    ]);
    expect(await verifyBillingProvider()).toBeNull();
    expect((await reconcileSubscriptions()).configured).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("is missing_credentials when only part is set, and never shows a value", async () => {
    vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_onlythekey");
    vi.stubEnv("STRIPE_WEBHOOK_SECRET", "");
    const s = await billingStatus();
    expect(s.state).toBe("missing_credentials");
    expect(s.problems.map((p) => p.variable)).toContain("STRIPE_WEBHOOK_SECRET");
    expect(JSON.stringify(s)).not.toContain("sk_test_onlythekey");
  });

  it("an unconfigured provider doesn't change plan limits", async () => {
    const t = await makeTenant("nolockout");
    const sdk = (await authenticateIngestionKey(t.sdkKey))!;
    expect((await ingest(sdk, { batch: track(3) }, { mode: "batch" })).status).toBe(200);
    expect((await billingOverview(t.ctx)).usage.lines.find((l) => l.key === "events")).toMatchObject({ used: 3, limit: 100_000, state: "ok" });
  });
});

/**
 * A fake Stripe API for fetch: account, prices, webhook endpoints, customers,
 * Checkout and Portal sessions, subscriptions. Nothing leaves the process.
 */
function fakeStripe(opts: {
  prices?: Record<string, { interval: string; currency?: string; amount?: number | null; livemode?: boolean; active?: boolean }>;
  endpoints?: { url: string; status?: string; enabled_events?: string[] }[] | "forbidden";
  checkoutUrl?: string;
  subscriptions?: Record<string, Record<string, unknown> | null>;
  livemode?: boolean;
} = {}) {
  let customers = 0;
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  return vi.fn(async (input: string, init?: RequestInit) => {
    const url = new URL(input);
    const path = url.pathname;
    if (path === "/v1/account") return json({ id: "acct_test", charges_enabled: true });
    if (path.startsWith("/v1/prices/")) {
      const p = opts.prices?.[path.slice("/v1/prices/".length)];
      if (!p) return json({ error: { type: "invalid_request_error", code: "resource_missing" } }, 404);
      return json({ active: p.active ?? true, livemode: p.livemode ?? opts.livemode ?? false, currency: p.currency ?? "usd", unit_amount: p.amount ?? null, type: "recurring", billing_scheme: "per_unit", recurring: { interval: p.interval, interval_count: 1 } });
    }
    if (path === "/v1/webhook_endpoints") {
      if (opts.endpoints === "forbidden") return json({ error: { type: "invalid_request_error" } }, 403);
      return json({ data: opts.endpoints ?? [] });
    }
    if (path === "/v1/customers" && init?.method === "POST") return json({ id: `cus_${opts.livemode ? "live" : "fake"}${++customers}` });
    if (path === "/v1/checkout/sessions") return json({ id: "cs_fake", url: opts.checkoutUrl ?? "https://checkout.stripe.com/c/pay/cs_fake" });
    if (path === "/v1/billing_portal/sessions") return json({ url: "https://billing.stripe.com/p/session/fake" });
    if (path.startsWith("/v1/subscriptions/")) {
      const s = opts.subscriptions?.[path.slice("/v1/subscriptions/".length)];
      return s ? json(s) : json({ error: { type: "invalid_request_error", code: "resource_missing" } }, 404);
    }
    return json({ error: { type: "api_error" } }, 500);
  });
}

const PRICES = {
  price_startermonthly: { interval: "month", amount: 39_900 },
  price_starterannual: { interval: "year", amount: null },
  price_growthmonthly: { interval: "month", amount: 59_900 },
};

describe("with Stripe configured", () => {
  let a: T;
  let b: T;
  let fetchMock: ReturnType<typeof fakeStripe>;

  beforeAll(async () => {
    a = await makeTenant("stripe-a");
    b = await makeTenant("stripe-b");
  });

  const configure = (fake: Parameters<typeof fakeStripe>[0] = {}, mode: "test" | "live" = "test") => {
    vi.stubEnv("STRIPE_SECRET_KEY", `sk_${mode}_integration`);
    vi.stubEnv("STRIPE_WEBHOOK_SECRET", WHSEC);
    vi.stubEnv("STRIPE_PRICE_STARTER_MONTHLY", "price_startermonthly");
    vi.stubEnv("STRIPE_PRICE_STARTER_ANNUAL", "price_starterannual");
    vi.stubEnv("STRIPE_PRICE_GROWTH_MONTHLY", "price_growthmonthly");
    fetchMock = fakeStripe({ prices: PRICES, endpoints: [{ url: webhookUrl(), status: "enabled", enabled_events: ["*"] }], ...fake });
    vi.stubGlobal("fetch", fetchMock);
  };
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  let seq = 0;
  /** Delivers a signed event the way Stripe does. */
  async function deliver(type: string, object: Record<string, unknown>, opts: { id?: string; created?: number; livemode?: boolean } = {}) {
    const body = JSON.stringify({ id: opts.id ?? `evt_${++seq}_${Date.now()}`, type, created: opts.created ?? Math.floor(Date.now() / 1000) + seq, livemode: opts.livemode ?? false, data: { object } });
    return handleStripeWebhook(body, stripeSignatureHeader(body, WHSEC));
  }
  const orgPlan = async (id: string) => (await withSystem((db) => db.one<{ plan_id: string }>("select plan_id from platform.organizations where id = $1", [id])))!.plan_id;
  const sub = (orgId: string, status: string, extra: Record<string, unknown> = {}) => ({
    id: `sub_${orgId.slice(0, 8)}`, customer: `cus_${orgId.slice(0, 8)}`, status, currency: "usd", metadata: { organization_id: orgId },
    items: { data: [{ price: { id: "price_startermonthly", recurring: { interval: "month" } }, current_period_start: 1_790_000_000, current_period_end: 1_792_600_000 }] }, ...extra,
  });
  const callsTo = (path: string) => fetchMock.mock.calls.filter((c) => new URL(String(c[0])).pathname === path);

  it("keeps checkout closed until the credentials are verified", async () => {
    configure();
    // Admins don't trigger verification: credentials present, unverified, no checkout.
    const viewed = await billingOverview({ ...a.ctx, role: "admin" });
    expect(viewed.payments).toMatchObject({ state: "credentials_unverified", mode: "test", checkoutEnabled: false });
    expect(viewed.plans.every((p) => !p.purchasable)).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
    await expect(startCheckout(a.ctx, "starter")).rejects.toMatchObject({ code: "payments_not_connected" });
  });

  it("reports a failed verification (wrong currency) and keeps checkout closed", async () => {
    configure({ prices: { ...PRICES, price_growthmonthly: { interval: "month", amount: 59_900, currency: "eur" } } });
    const check = await verifyBillingProvider();
    expect(check!.ok).toBe(false);
    expect(check!.details.prices.find((p) => p.planId === "growth")).toMatchObject({ ok: false, problem: "wrong_currency" });
    const s = await billingStatus();
    expect(s.state).toBe("verification_failed");
    expect(s.checkoutEnabled).toBe(false);
    const stored = await withSystem((db) => db.one<{ details: unknown }>("select details from platform.billing_provider_checks order by id desc limit 1"));
    expect(JSON.stringify(stored)).not.toContain("sk_test_integration");
    expect(callsTo("/v1/account")[0][1]!.headers).toMatchObject({ Authorization: "Bearer sk_test_integration" });
  });

  it("distinguishes a missing webhook endpoint from one the key can't see", async () => {
    configure({ endpoints: [] });
    await verifyBillingProvider();
    expect((await billingStatus()).state).toBe("webhook_not_configured");
    configure({ endpoints: [{ url: webhookUrl(), status: "enabled", enabled_events: ["invoice.paid"] }] });
    const check = await verifyBillingProvider();
    expect(check!.details.webhook).toMatchObject({ state: "missing_events" });
    expect((await billingStatus()).state).toBe("webhook_not_configured");
    configure({ endpoints: "forbidden" });
    await verifyBillingProvider();
    expect((await billingStatus()).state).toBe("webhook_unverified");
  });

  it("verifies on an owner's visit and opens checkout for verified prices only", async () => {
    configure();
    await withSystem((db) => db.query("delete from platform.billing_provider_checks"));
    const view = await billingOverview(a.ctx);
    expect(view.payments).toMatchObject({ state: "connected_verified", mode: "test", checkoutEnabled: true });
    const starter = view.plans.find((p) => p.id === "starter")!;
    expect(starter).toMatchObject({ purchasable: true, priceMonthlyCents: 39_900, checkout: "self_serve", change: "upgrade" });
    expect(starter.prices).toEqual([{ interval: "month", amountCents: 39_900, available: true }, { interval: "year", amountCents: null, available: true }]);
    const growth = view.plans.find((p) => p.id === "growth")!;
    expect(growth).toMatchObject({ priceIsMinimum: true, usageBased: true });
    expect(growth.prices.map((p) => p.available)).toEqual([true, false]); // no annual price configured
    expect(view.plans.find((p) => p.id === "enterprise")).toMatchObject({ checkout: "sales", purchasable: false });
    expect(view.plans.some((p) => p.id === "pro")).toBe(false); // not on the public pricing
    await expect(startCheckout(a.ctx, "growth", "year")).rejects.toThrow(/can't be bought online/);
  });

  it("permissions: developers can't see billing, admins can't change it", async () => {
    configure();
    await expect(billingOverview({ ...a.ctx, role: "developer" })).rejects.toMatchObject({ code: "forbidden" });
    expect((await billingOverview({ ...a.ctx, role: "admin" })).canManage).toBe(false);
    fetchMock.mockClear();
    await expect(startCheckout({ ...a.ctx, role: "admin" }, "starter")).rejects.toMatchObject({ code: "forbidden" });
    await expect(openBillingPortal({ ...a.ctx, role: "admin" })).rejects.toMatchObject({ code: "forbidden" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("starts Checkout with the server-resolved price, an idempotency key and the customer created once", async () => {
    configure();
    const url = await startCheckout(a.ctx, "starter", "year");
    expect(url).toBe("https://checkout.stripe.com/c/pay/cs_fake");
    const [custUrl, custInit] = callsTo("/v1/customers")[0];
    expect(String(custUrl)).toBe("https://api.stripe.com/v1/customers");
    expect(custInit!.headers).toMatchObject({ "Idempotency-Key": `leanapp-customer-test-${a.org.id}` });
    const [, init] = callsTo("/v1/checkout/sessions")[0];
    const checkout = new URLSearchParams(String(init!.body));
    expect(checkout.get("mode")).toBe("subscription");
    expect(checkout.get("customer")).toBe("cus_fake1");
    expect(checkout.get("client_reference_id")).toBe(a.org.id);
    expect(checkout.get("line_items[0][price]")).toBe("price_starterannual");
    expect(checkout.get("line_items[0][quantity]")).toBe("1");
    expect([...checkout.keys()].some((k) => /amount|currency|unit_amount/.test(k))).toBe(false);
    expect(checkout.get("subscription_data[metadata][organization_id]")).toBe(a.org.id);
    expect(checkout.get("subscription_data[metadata][interval]")).toBe("year");
    expect(checkout.get("success_url")).toMatch(/\/settings\/billing\?checkout=success$/);
    expect((init!.headers as Record<string, string>)["Idempotency-Key"]).toMatch(new RegExp(`^leanapp-checkout-test-${a.org.id}-starter-year-\\d+$`));

    // The same click again reuses the customer and the idempotency key.
    const firstKey = (init!.headers as Record<string, string>)["Idempotency-Key"];
    fetchMock.mockClear();
    await startCheckout(a.ctx, "starter", "year");
    expect(fetchMock.mock.calls.map((c) => new URL(String(c[0])).pathname)).toEqual(["/v1/checkout/sessions"]);
    expect((callsTo("/v1/checkout/sessions")[0][1]!.headers as Record<string, string>)["Idempotency-Key"]).toBe(firstKey);

    // Nothing activates from the browser side: the plan is unchanged until a webhook says so.
    expect(await orgPlan(a.org.id)).toBe("free");
    await expect(startCheckout(a.ctx, "enterprise")).rejects.toThrow(/can't be bought online/);
    await expect(startCheckout(a.ctx, "starter", "weekly")).rejects.toMatchObject({ code: "validation_error" });
    await expect(startCheckout(a.ctx, "../../x")).rejects.toMatchObject({ code: "validation_error" });
    expect((await listAuditLogs(a.ctx, { area: "billing" })).rows[0].action).toBe("billing.checkout_started");
  });

  it("never redirects anywhere but Stripe's Checkout host", async () => {
    configure({ checkoutUrl: "https://evil.example/pay" });
    await expect(startCheckout(a.ctx, "starter")).rejects.toMatchObject({ code: "payment_provider_error", status: 502 });
  });

  it("keeps test-mode and live-mode customers apart", async () => {
    configure({ livemode: true, prices: Object.fromEntries(Object.entries(PRICES).map(([k, v]) => [k, { ...v, livemode: true }])) }, "live");
    await verifyBillingProvider();
    expect((await billingStatus()).mode).toBe("live");
    await startCheckout(a.ctx, "starter");
    const [, custInit] = callsTo("/v1/customers")[0];
    expect(custInit!.headers).toMatchObject({ "Idempotency-Key": `leanapp-customer-live-${a.org.id}` });
    const rows = await withSystem((db) => db.query<{ livemode: boolean }>("select livemode from platform.billing_customers where organization_id = $1 order by livemode", [a.org.id]));
    expect(rows.map((r) => r.livemode)).toEqual([false, true]);
  });

  it("reports provider errors without leaking Stripe's message", async () => {
    configure();
    await verifyBillingProvider();
    fetchMock.mockImplementation(async () => new Response(JSON.stringify({ error: { message: "No such price: 'price_startermonthly'" } }), { status: 400 }));
    const err = await startCheckout(a.ctx, "starter").catch((e) => e);
    expect(err).toMatchObject({ code: "payment_provider_error", status: 502 });
    expect(String(err.message)).not.toMatch(/No such price/);
  });

  it("verifies signatures: bad signature, stale timestamp, missing header", async () => {
    configure();
    const body = JSON.stringify({ id: "evt_sig", type: "invoice.paid", created: 1, data: { object: {} } });
    expect(await handleStripeWebhook(body, stripeSignatureHeader(body, "whsec_wrong"))).toMatchObject({ status: 400, body: { reason: "bad_signature" } });
    expect(await handleStripeWebhook(body, stripeSignatureHeader(body, WHSEC, Math.floor(Date.now() / 1000) - 600))).toMatchObject({ status: 400, body: { reason: "stale_timestamp" } });
    expect(await handleStripeWebhook(body, null)).toMatchObject({ status: 400, body: { reason: "missing_header" } });
    const n = await withSystem((db) => db.one<{ n: string }>("select count(*) as n from platform.billing_events where id = 'evt_sig'"));
    expect(Number(n!.n)).toBe(0);
  });

  it("ignores events from the other mode", async () => {
    configure();
    const c = await makeTenant("stripe-mode");
    const r = await deliver("customer.subscription.created", sub(c.org.id, "active"), { livemode: true, id: "evt_live_on_test" });
    expect(r).toMatchObject({ status: 200, body: { ignored: "mode_mismatch" } });
    expect(await orgPlan(c.org.id)).toBe("free");
    const row = await withSystem((db) => db.one<{ outcome: string }>("select outcome from platform.billing_events where id = 'evt_live_on_test'"));
    expect(row!.outcome).toBe("mode_mismatch");
  });

  it("links the customer on checkout completion and applies subscription state transitions", async () => {
    configure();
    const done = await deliver("checkout.session.completed", { id: "cs_x", mode: "subscription", client_reference_id: b.org.id, customer: `cus_${b.org.id.slice(0, 8)}`, subscription: "sub_x", metadata: { plan_id: "starter" } });
    expect(done.status).toBe(200);
    expect(await orgPlan(b.org.id)).toBe("free"); // checkout completion alone grants nothing
    const cust = await withSystem((db) => db.one<{ c: string }>("select provider_customer_id as c from platform.billing_customers where organization_id = $1 and not livemode", [b.org.id]));
    expect(cust!.c).toBe(`cus_${b.org.id.slice(0, 8)}`);

    // incomplete → no plan yet
    await deliver("customer.subscription.created", sub(b.org.id, "incomplete"));
    expect(await orgPlan(b.org.id)).toBe("free");
    expect((await billingOverview(b.ctx)).subscription).toMatchObject({ status: "incomplete" });
    // active → paid plan, and its limits apply immediately
    const t0 = Math.floor(Date.now() / 1000) + 1000;
    await deliver("customer.subscription.updated", sub(b.org.id, "active", { trial_end: null }), { created: t0 });
    expect(await orgPlan(b.org.id)).toBe("starter");
    await createApp(b.ctx, { name: "Paid Second App", platforms: ["web"] });
    // a "created" carrying an older state at the same second doesn't overwrite it
    await deliver("customer.subscription.created", sub(b.org.id, "incomplete"), { created: t0 });
    expect(await orgPlan(b.org.id)).toBe("starter");
    // past_due keeps the plan while Stripe retries
    await deliver("customer.subscription.updated", sub(b.org.id, "past_due"), { created: t0 + 10 });
    expect(await orgPlan(b.org.id)).toBe("starter");
    // an older event delivered late is ignored
    const late = await deliver("customer.subscription.updated", sub(b.org.id, "canceled"), { created: t0 + 5 });
    expect(late.body).toMatchObject({ outcome: "stale" });
    expect(await orgPlan(b.org.id)).toBe("starter");
    expect((await billingOverview(b.ctx)).subscription).toMatchObject({ status: "past_due", plan_id: "starter", billing_interval: "month" });
    // cancelled → back to the evaluation plan
    await deliver("customer.subscription.deleted", sub(b.org.id, "canceled"), { created: t0 + 20 });
    expect(await orgPlan(b.org.id)).toBe("free");
    // terminal: even a newer "active" can't resurrect a cancelled subscription
    await deliver("customer.subscription.updated", sub(b.org.id, "active"), { created: t0 + 30 });
    expect(await orgPlan(b.org.id)).toBe("free");
    const view = await billingOverview(b.ctx);
    expect(view.subscription).toBeNull();
    expect(view.endedSubscription).toMatchObject({ status: "cancelled", plan_id: "starter" });
    const actions = (await listAuditLogs(b.ctx, { area: "billing" })).rows.map((r) => r.action);
    expect(actions.filter((x) => x === "billing.plan_changed")).toHaveLength(2);
    // the other organization is untouched
    expect(await orgPlan(a.org.id)).toBe("free");
  });

  it("maps an annual price to its plan and interval", async () => {
    configure();
    const c = await makeTenant("stripe-annual");
    await deliver("customer.subscription.created", sub(c.org.id, "trialing", {
      trial_start: 1_790_000_000, trial_end: 1_791_000_000,
      items: { data: [{ price: { id: "price_starterannual", recurring: { interval: "year" } }, current_period_start: 1_790_000_000, current_period_end: 1_821_536_000 }] },
    }));
    expect(await orgPlan(c.org.id)).toBe("starter");
    const s = await withSystem((db) => db.one<{ billing_interval: string; provider_price_id: string; currency: string; trial_end: Date; livemode: boolean }>(
      "select billing_interval, provider_price_id, currency, trial_end, livemode from platform.subscriptions where organization_id = $1", [c.org.id]));
    expect(s).toMatchObject({ billing_interval: "year", provider_price_id: "price_starterannual", currency: "USD", livemode: false });
    expect(s!.trial_end.toISOString()).toBe(new Date(1_791_000_000_000).toISOString());
  });

  it("is idempotent by event id", async () => {
    configure();
    const c = await makeTenant("stripe-idem");
    const event = { id: "evt_replay_1", created: Math.floor(Date.now() / 1000) };
    const first = await deliver("customer.subscription.created", sub(c.org.id, "active"), event);
    const again = await deliver("customer.subscription.created", sub(c.org.id, "active"), event);
    expect(first).toMatchObject({ status: 200, body: { received: true } });
    expect(again).toMatchObject({ status: 200, body: { duplicate: true } });
    const audits = (await listAuditLogs(c.ctx, { area: "billing" })).rows.filter((r) => r.action === "billing.subscription_updated");
    expect(audits).toHaveLength(1);
  });

  it("records a failed event and applies it on Stripe's retry", async () => {
    configure();
    const c = await makeTenant("stripe-unknown-price");
    const object = { ...sub(c.org.id, "active"), items: { data: [{ price: { id: "price_unknownpro" } }] } };
    const event = { id: "evt_unknown_price", created: Math.floor(Date.now() / 1000) };
    await expect(deliver("customer.subscription.created", object, event)).rejects.toThrow(/STRIPE_PRICE_/);
    const failed = await withSystem((db) => db.one<{ outcome: string; error_code: string; attempts: number }>("select outcome, error_code, attempts from platform.billing_events where id = 'evt_unknown_price'"));
    expect(failed).toMatchObject({ outcome: "failed", error_code: "unknown_price", attempts: 1 });
    // The operator maps the price (legacy column here), Stripe retries.
    await withSystem((db) => db.query("update platform.plans set stripe_price_id = 'price_unknownpro' where id = 'pro'"));
    expect((await deliver("customer.subscription.created", object, event)).body).toEqual({ received: true });
    expect(await orgPlan(c.org.id)).toBe("pro");
    const applied = await withSystem((db) => db.one<{ outcome: string; attempts: number }>("select outcome, attempts from platform.billing_events where id = 'evt_unknown_price'"));
    expect(applied).toMatchObject({ outcome: "applied", attempts: 2 });
    await withSystem((db) => db.query("update platform.plans set stripe_price_id = null where id = 'pro'"));
  });

  it("records invoices; a late payment_failed never overrides a payment; refunds are recorded without changing access", async () => {
    configure();
    const customer = "cus_fake1"; // created by the test-mode checkout above
    const inv = (status: string) => ({
      id: "in_a1", customer, number: "LA-0001", status, currency: "usd", amount_paid: status === "paid" ? 39_900 : 0, amount_due: 39_900, payment_intent: "pi_a1",
      period_start: 1_790_000_000, period_end: 1_792_600_000, hosted_invoice_url: "https://invoice.stripe.com/i/abc", invoice_pdf: "https://evil.example/x.pdf",
      status_transitions: { paid_at: 1_790_000_100 },
    });
    await deliver("invoice.paid", inv("paid"));
    await deliver("invoice.payment_succeeded", inv("paid")); // Stripe sends both for one payment
    await deliver("invoice.payment_failed", inv("open"));
    await deliver("invoice.payment_failed", { ...inv("open"), id: "in_a2", number: "LA-0002", payment_intent: "pi_a2" });
    const { invoices } = await billingOverview(a.ctx);
    expect(invoices.map((i) => [i.number, i.status, Number(i.amount_cents), i.currency])).toEqual(
      expect.arrayContaining([["LA-0001", "paid", 39_900, "USD"], ["LA-0002", "open", 39_900, "USD"]]),
    );
    const paid = invoices.find((i) => i.number === "LA-0001")!;
    expect(paid.hosted_invoice_url).toBe("https://invoice.stripe.com/i/abc");
    expect(paid.invoice_pdf_url).toBeNull(); // only Stripe-hosted links are kept
    const audits = (await listAuditLogs(a.ctx, { area: "billing" })).rows.map((r) => r.action);
    expect(audits.filter((x) => x === "billing.invoice_paid")).toHaveLength(1);

    const planBefore = await orgPlan(a.org.id);
    await deliver("charge.refunded", { id: "ch_1", payment_intent: "pi_a1", amount_refunded: 10_000, refunded: false, currency: "usd" });
    const again = await billingOverview(a.ctx);
    expect(Number(again.invoices.find((i) => i.number === "LA-0001")!.amount_refunded_cents)).toBe(10_000);
    expect(await orgPlan(a.org.id)).toBe(planBefore);
    const unmatched = await deliver("charge.refunded", { id: "ch_2", payment_intent: "pi_nobody", amount_refunded: 5 });
    expect(unmatched.body).toMatchObject({ outcome: "unmatched" });
    // tenant isolation
    expect((await billingOverview(b.ctx)).invoices).toHaveLength(0);
  });

  it("is ready in test mode once a signed event has arrived", async () => {
    configure();
    await verifyBillingProvider();
    expect((await billingStatus()).state).toBe("ready_test");
  });

  it("opens the Customer Portal for an organization with a billing account in this mode", async () => {
    configure();
    expect(await openBillingPortal(a.ctx)).toBe("https://billing.stripe.com/p/session/fake");
    expect(new URLSearchParams(String(callsTo("/v1/billing_portal/sessions")[0][1]!.body)).get("customer")).toBe("cus_fake1");
    const fresh = await makeTenant("stripe-noacct");
    await expect(openBillingPortal(fresh.ctx)).rejects.toThrow(/no billing account/);
  });

  it("reconciles subscriptions from the provider's current state", async () => {
    const c = await makeTenant("stripe-reconcile");
    const d = await makeTenant("stripe-reconcile-gone");
    configure();
    const past = Math.floor(Date.now() / 1000) - 100;
    await deliver("customer.subscription.created", sub(c.org.id, "active"), { created: past });
    await deliver("customer.subscription.created", sub(d.org.id, "active"), { created: past });
    expect(await orgPlan(c.org.id)).toBe("starter");
    // Stripe says c is now canceled (the webhook never arrived) and d no longer exists.
    configure({ subscriptions: { [`sub_${c.org.id.slice(0, 8)}`]: sub(c.org.id, "canceled") } });
    const report = await reconcileSubscriptions({ limit: 1000 });
    expect(report.configured).toBe(true);
    expect(await orgPlan(c.org.id)).toBe("free");
    expect(await orgPlan(d.org.id)).toBe("free");
    expect((await listAuditLogs(c.ctx, { area: "billing" })).rows.map((r) => r.action)).toContain("billing.subscription_reconciled");
  });

  it("reconciling an unchanged subscription changes and audits nothing", async () => {
    const c = await makeTenant("stripe-reconcile-same");
    configure();
    await deliver("customer.subscription.created", sub(c.org.id, "active"), { created: Math.floor(Date.now() / 1000) - 100 });
    configure({ subscriptions: { [`sub_${c.org.id.slice(0, 8)}`]: sub(c.org.id, "active") } });
    await reconcileSubscriptions({ limit: 1000 });
    expect(await orgPlan(c.org.id)).toBe("starter");
    expect((await listAuditLogs(c.ctx, { area: "billing" })).rows.map((r) => r.action)).not.toContain("billing.subscription_reconciled");
  });
});

describe("entitlements and usage", () => {
  it("allows a feature unless the plan turns it off", async () => {
    const t = await makeTenant("entitle");
    expect(await withSystem((db) => featureEntitled(db, t.org.id, "experiments"))).toBe(true);
    await onPlan(t.org.id, "test_no_experiments", {});
    await withSystem((db) => db.query("insert into platform.plan_features (plan_id, feature, value) values ('test_no_experiments', 'feature.experiments', 'false')"));
    expect(await withSystem((db) => featureEntitled(db, t.org.id, "experiments"))).toBe(false);
    await expect(withSystem((db) => assertEntitled(db, t.org.id, "experiments"))).rejects.toMatchObject({ code: "plan_limit_exceeded" });
    expect(await withSystem((db) => featureEntitled(db, t.org.id, "funnels"))).toBe(true);
  });

  it("doesn't count retried events twice", async () => {
    const t = await makeTenant("usage-dedup");
    const sdk = (await authenticateIngestionKey(t.sdkKey))!;
    const batch = track(5);
    await ingest(sdk, { batch }, { mode: "batch" });
    await ingest(sdk, { batch }, { mode: "batch" }); // same event ids, no Idempotency-Key
    await ingest(sdk, { batch }, { mode: "batch", idempotencyKey: "retry-1" });
    await ingest(sdk, { batch }, { mode: "batch", idempotencyKey: "retry-1" });
    const used = (await usageSummary(t.ctx)).lines.find((l) => l.key === "events")!.used;
    expect(used).toBe(5);
    expect((await eventAllowance(t.org.id, new Date(), { fresh: true })).used).toBe(5);
  });

  it("projects usage-based overage without charging it", async () => {
    const t = await makeTenant("overage");
    await onPlan(t.org.id, "test_usage_based", { events: 10 });
    await withSystem((db) => db.query("update platform.plans set usage_based = true where id = 'test_usage_based'"));
    const sdk = (await authenticateIngestionKey(t.sdkKey))!;
    await ingest(sdk, { batch: track(10) }, { mode: "batch" });
    await ingest(sdk, { batch: track(1) }, { mode: "batch" }); // grace
    expect((await billingOverview(t.ctx)).overageEvents).toBe(1);
  });
});
