/** Plan limits, usage notices, Stripe webhooks, checkout and the billing overview. */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { withSystem } from "@/lib/db";
import { createApp } from "@/modules/apps/service";
import { listAuditLogs } from "@/modules/audit/service";
import { signUp } from "@/modules/auth/service";
import { clearAllowanceCache, eventAllowance } from "@/modules/billing/enforcement";
import { sendUsageNotices } from "@/modules/billing/notices";
import { billingOverview, openBillingPortal, startCheckout } from "@/modules/billing/service";
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

  it("refuses a second app on Free (1 app) and allows up to the plan's limit", async () => {
    await expect(createApp(t.ctx, { name: "Second", platforms: ["ios"] })).rejects.toMatchObject({ code: "plan_limit_exceeded", status: 403 });
    await onPlan(t.org.id, "test_apps3", { apps: 3 });
    await createApp(t.ctx, { name: "Second", platforms: ["ios"] });
    await createApp(t.ctx, { name: "Third", platforms: ["ios"] });
    await expect(createApp(t.ctx, { name: "Fourth", platforms: ["ios"] })).rejects.toThrow(/includes 3 apps/);
    await onPlan(t.org.id, "test_apps_unlimited", { apps: null });
    await createApp(t.ctx, { name: "Fourth", platforms: ["ios"] });
  });

  it("counts pending invitations as seats and blocks invitations over the limit", async () => {
    const s = await makeTenant("seats"); // Free: 3 seats, 1 taken by the owner
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
    const first = await ingest(sdk, { batch: track(3) }, { mode: "batch", idempotencyKey: "k1" });
    expect(first.status).toBe(200);
    expect((await ingest(sdk, { batch: track(1) }, { mode: "batch" })).status).toBe(429);
    const again = await ingest(sdk, { batch: track(3) }, { mode: "batch", idempotencyKey: "k1" });
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

describe("with Stripe configured", () => {
  let a: T;
  let b: T;
  const fetchMock = vi.fn();

  beforeAll(async () => {
    a = await makeTenant("stripe-a");
    b = await makeTenant("stripe-b");
    await withSystem((db) => db.query("update platform.plans set stripe_price_id = 'price_starter' where id = 'starter'"));
    await withSystem((db) => db.query("update platform.plans set stripe_price_id = 'price_growth' where id = 'growth'"));
  });

  const configure = () => {
    vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_integration");
    vi.stubEnv("STRIPE_WEBHOOK_SECRET", WHSEC);
    vi.stubGlobal("fetch", fetchMock);
  };
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    fetchMock.mockReset();
  });

  let seq = 0;
  /** Delivers a signed event the way Stripe does. */
  async function deliver(type: string, object: Record<string, unknown>, opts: { id?: string; created?: number; sig?: string } = {}) {
    const body = JSON.stringify({ id: opts.id ?? `evt_${++seq}_${Date.now()}`, type, created: opts.created ?? Math.floor(Date.now() / 1000) + seq, data: { object } });
    return handleStripeWebhook(body, opts.sig ?? stripeSignatureHeader(body, WHSEC));
  }
  const orgPlan = async (id: string) => (await withSystem((db) => db.one<{ plan_id: string }>("select plan_id from platform.organizations where id = $1", [id])))!.plan_id;
  const sub = (orgId: string, status: string, extra: Record<string, unknown> = {}) => ({
    id: `sub_${orgId.slice(0, 8)}`, customer: `cus_${orgId.slice(0, 8)}`, status, metadata: { organization_id: orgId },
    items: { data: [{ price: { id: "price_starter" }, current_period_start: 1_790_000_000, current_period_end: 1_792_600_000 }] }, ...extra,
  });

  it("permissions: developers can't see billing, admins can't change it", async () => {
    configure();
    await expect(billingOverview({ ...a.ctx, role: "developer" })).rejects.toMatchObject({ code: "forbidden" });
    expect((await billingOverview({ ...a.ctx, role: "admin" })).canManage).toBe(false);
    await expect(startCheckout({ ...a.ctx, role: "admin" }, "starter")).rejects.toMatchObject({ code: "forbidden" });
    await expect(openBillingPortal({ ...a.ctx, role: "admin" })).rejects.toMatchObject({ code: "forbidden" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("starts Checkout for the owner, creating the Stripe customer once", async () => {
    configure();
    const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
    fetchMock.mockImplementation(async (url: string) =>
      url.endsWith("/v1/customers") ? ok({ id: "cus_new_a" }) : ok({ id: "cs_1", url: "https://checkout.stripe.com/c/pay/cs_1" }),
    );
    const b0 = await billingOverview(a.ctx);
    expect(b0.paymentsConnected).toBe(true);
    expect(b0.plans.find((p) => p.id === "starter")!.purchasable).toBe(true);
    expect(b0.plans.find((p) => p.id === "enterprise")!.purchasable).toBe(false);

    expect(await startCheckout(a.ctx, "starter")).toBe("https://checkout.stripe.com/c/pay/cs_1");
    const [custUrl, custInit] = fetchMock.mock.calls[0];
    expect(custUrl).toBe("https://api.stripe.com/v1/customers");
    expect(custInit.headers.Authorization).toBe("Bearer sk_test_integration");
    expect(custInit.headers["Idempotency-Key"]).toBe(`leanapp-customer-${a.org.id}`);
    const checkout = new URLSearchParams(fetchMock.mock.calls[1][1].body);
    expect(checkout.get("mode")).toBe("subscription");
    expect(checkout.get("customer")).toBe("cus_new_a");
    expect(checkout.get("client_reference_id")).toBe(a.org.id);
    expect(checkout.get("line_items[0][price]")).toBe("price_starter");
    expect(checkout.get("subscription_data[metadata][organization_id]")).toBe(a.org.id);

    fetchMock.mockClear();
    await startCheckout(a.ctx, "growth");
    expect(fetchMock.mock.calls.map((c) => c[0])).toEqual(["https://api.stripe.com/v1/checkout/sessions"]);
    await expect(startCheckout(a.ctx, "enterprise")).rejects.toThrow(/can't be bought online/);
    expect((await listAuditLogs(a.ctx, { area: "billing" })).rows[0].action).toBe("billing.checkout_started");
  });

  it("reports provider errors without leaking Stripe's message", async () => {
    configure();
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ error: { message: "No such price: 'price_starter'" } }), { status: 400 }));
    await expect(startCheckout(a.ctx, "starter")).rejects.toMatchObject({ code: "payment_provider_error", status: 502 });
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

  it("links the customer on checkout completion and applies subscription state transitions", async () => {
    configure();
    const done = await deliver("checkout.session.completed", { id: "cs_x", mode: "subscription", client_reference_id: b.org.id, customer: `cus_${b.org.id.slice(0, 8)}`, subscription: "sub_x", metadata: { plan_id: "starter" } });
    expect(done.status).toBe(200);
    expect((await withSystem((db) => db.one<{ c: string }>("select billing_customer_id as c from platform.organizations where id = $1", [b.org.id])))!.c).toBe(`cus_${b.org.id.slice(0, 8)}`);

    // incomplete → no plan yet
    await deliver("customer.subscription.created", sub(b.org.id, "incomplete"));
    expect(await orgPlan(b.org.id)).toBe("free");
    // active → paid plan, and its limits apply immediately
    const t0 = Math.floor(Date.now() / 1000) + 1000;
    await deliver("customer.subscription.updated", sub(b.org.id, "active"), { created: t0 });
    expect(await orgPlan(b.org.id)).toBe("starter");
    await createApp(b.ctx, { name: "Paid Second App", platforms: ["web"] });
    // past_due keeps the plan while Stripe retries
    await deliver("customer.subscription.updated", sub(b.org.id, "past_due"), { created: t0 + 10 });
    expect(await orgPlan(b.org.id)).toBe("starter");
    // an older event delivered late is ignored
    await deliver("customer.subscription.updated", sub(b.org.id, "canceled"), { created: t0 + 5 });
    expect(await orgPlan(b.org.id)).toBe("starter");
    expect((await billingOverview(b.ctx)).subscription).toMatchObject({ status: "past_due", plan_id: "starter" });
    // cancelled → back to free
    await deliver("customer.subscription.deleted", sub(b.org.id, "canceled"), { created: t0 + 20 });
    expect(await orgPlan(b.org.id)).toBe("free");
    expect((await billingOverview(b.ctx)).subscription).toBeNull();
    const actions = (await listAuditLogs(b.ctx, { area: "billing" })).rows.map((r) => r.action);
    expect(actions.filter((x) => x === "billing.plan_changed")).toHaveLength(2);
    // the other organization is untouched
    expect(await orgPlan(a.org.id)).toBe("free");
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

  it("retries an event it can't apply instead of losing it", async () => {
    configure();
    const c = await makeTenant("stripe-unknown-price");
    const object = { ...sub(c.org.id, "active"), items: { data: [{ price: { id: "price_unknown" } }] } };
    const event = { id: "evt_unknown_price", created: Math.floor(Date.now() / 1000) };
    await expect(deliver("customer.subscription.created", object, event)).rejects.toThrow(/stripe_price_id/);
    await withSystem((db) => db.query("update platform.plans set stripe_price_id = 'price_unknown' where id = 'pro'"));
    expect((await deliver("customer.subscription.created", object, event)).body).toEqual({ received: true });
    expect(await orgPlan(c.org.id)).toBe("pro");
    await withSystem((db) => db.query("update platform.plans set stripe_price_id = null where id = 'pro'"));
  });

  it("records invoices; a late payment_failed never overrides a payment", async () => {
    configure();
    const customer = `cus_${a.org.id.slice(0, 8)}`;
    await withSystem((db) => db.query("update platform.organizations set billing_customer_id = $2 where id = $1", [a.org.id, customer]));
    const inv = (status: string) => ({
      id: "in_a1", customer, number: "LA-0001", status, currency: "sar", amount_paid: status === "paid" ? 18_700 : 0, amount_due: 18_700,
      period_start: 1_790_000_000, period_end: 1_792_600_000, hosted_invoice_url: "https://invoice.stripe.com/i/abc", invoice_pdf: "https://evil.example/x.pdf",
      status_transitions: { paid_at: 1_790_000_100 },
    });
    await deliver("invoice.paid", inv("paid"));
    await deliver("invoice.payment_failed", inv("open"));
    await deliver("invoice.payment_failed", { ...inv("open"), id: "in_a2", number: "LA-0002" });
    const { invoices } = await billingOverview(a.ctx);
    expect(invoices.map((i) => [i.number, i.status, Number(i.amount_cents), i.currency])).toEqual(
      expect.arrayContaining([["LA-0001", "paid", 18_700, "SAR"], ["LA-0002", "open", 18_700, "SAR"]]),
    );
    const paid = invoices.find((i) => i.number === "LA-0001")!;
    expect(paid.hosted_invoice_url).toBe("https://invoice.stripe.com/i/abc");
    expect(paid.invoice_pdf_url).toBeNull(); // only Stripe-hosted links are kept
    // tenant isolation
    expect((await billingOverview(b.ctx)).invoices).toHaveLength(0);
  });

  it("opens the Customer Portal for an organization with a billing account", async () => {
    configure();
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ url: "https://billing.stripe.com/p/session/x" }), { status: 200 }));
    expect(await openBillingPortal(a.ctx)).toBe("https://billing.stripe.com/p/session/x");
    expect(new URLSearchParams(fetchMock.mock.calls[0][1].body).get("customer")).toBe(`cus_${a.org.id.slice(0, 8)}`);
    const fresh = await makeTenant("stripe-noacct");
    await expect(openBillingPortal(fresh.ctx)).rejects.toThrow(/no billing account/);
  });
});
