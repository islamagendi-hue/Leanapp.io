import { describe, expect, it } from "vitest";
import { formEncode, isAllowedProviderRedirect, keyMode, paymentsConnected, STRIPE_WEBHOOK_EVENTS, stripeSignatureHeader, verifyStripeSignature } from "./stripe";

const secret = "whsec_test_secret";
const payload = JSON.stringify({ id: "evt_1", type: "invoice.paid" });
const now = new Date("2026-10-06T12:00:00Z");
const t = Math.floor(now.getTime() / 1000);

describe("Stripe webhook signatures", () => {
  it("accepts a valid signature within the tolerance", () => {
    expect(verifyStripeSignature(payload, stripeSignatureHeader(payload, secret, t), secret, { now })).toEqual({ ok: true, timestamp: t });
    expect(verifyStripeSignature(payload, stripeSignatureHeader(payload, secret, t - 299), secret, { now }).ok).toBe(true);
  });

  it("accepts any matching v1 (secret rolling) and ignores v0", () => {
    const good = stripeSignatureHeader(payload, secret, t).split(",")[1];
    const header = `t=${t},v0=${"0".repeat(64)},v1=${"a".repeat(64)},${good}`;
    expect(verifyStripeSignature(payload, header, secret, { now }).ok).toBe(true);
  });

  it("rejects a wrong secret, a changed body and a missing or malformed header", () => {
    const header = stripeSignatureHeader(payload, secret, t);
    expect(verifyStripeSignature(payload, header, "whsec_other", { now })).toEqual({ ok: false, reason: "bad_signature" });
    expect(verifyStripeSignature(payload + " ", header, secret, { now })).toEqual({ ok: false, reason: "bad_signature" });
    expect(verifyStripeSignature(payload, null, secret, { now })).toEqual({ ok: false, reason: "missing_header" });
    expect(verifyStripeSignature(payload, "garbage", secret, { now })).toEqual({ ok: false, reason: "malformed_header" });
    expect(verifyStripeSignature(payload, `t=${t}`, secret, { now })).toEqual({ ok: false, reason: "malformed_header" });
    expect(verifyStripeSignature(payload, `t=${t},v1=zz`, secret, { now })).toEqual({ ok: false, reason: "malformed_header" });
  });

  it("rejects stale and future timestamps (replayed captures)", () => {
    expect(verifyStripeSignature(payload, stripeSignatureHeader(payload, secret, t - 301), secret, { now })).toEqual({ ok: false, reason: "stale_timestamp" });
    expect(verifyStripeSignature(payload, stripeSignatureHeader(payload, secret, t + 301), secret, { now })).toEqual({ ok: false, reason: "stale_timestamp" });
  });
});

describe("Stripe requests", () => {
  it("form-encodes nested params the way Stripe expects", () => {
    const body = formEncode({ mode: "subscription", line_items: [{ price: "price_1", quantity: 1 }], metadata: { organization_id: "o1" }, skip: undefined });
    expect(decodeURIComponent(body)).toBe("mode=subscription&line_items[0][price]=price_1&line_items[0][quantity]=1&metadata[organization_id]=o1");
  });

  it("counts payments as connected only with both the key and the webhook secret", () => {
    expect(paymentsConnected({})).toBe(false);
    expect(paymentsConnected({ STRIPE_SECRET_KEY: "sk_test_1" })).toBe(false);
    expect(paymentsConnected({ STRIPE_WEBHOOK_SECRET: "whsec_1" })).toBe(false);
    expect(paymentsConnected({ STRIPE_SECRET_KEY: "sk_test_1", STRIPE_WEBHOOK_SECRET: "whsec_1" })).toBe(true);
  });
});

describe("Stripe modes and redirects", () => {
  it("derives test or live from the key prefix and refuses anything else", () => {
    expect(keyMode("sk_test_abc")).toBe("test");
    expect(keyMode("rk_test_abc")).toBe("test");
    expect(keyMode("sk_live_abc")).toBe("live");
    expect(keyMode("rk_live_abc")).toBe("live");
    expect(keyMode("pk_live_abc")).toBeNull();
    expect(keyMode("sk_abc")).toBeNull();
    expect(keyMode(undefined)).toBeNull();
    expect(paymentsConnected({ STRIPE_SECRET_KEY: "pk_test_1", STRIPE_WEBHOOK_SECRET: "whsec_1" })).toBe(false);
    expect(paymentsConnected({ STRIPE_SECRET_KEY: "sk_test_1", STRIPE_WEBHOOK_SECRET: "secret" })).toBe(false);
  });

  it("allows redirects only to Stripe's Checkout and Portal hosts over https", () => {
    expect(isAllowedProviderRedirect("https://checkout.stripe.com/c/pay/cs_1")).toBe(true);
    expect(isAllowedProviderRedirect("https://billing.stripe.com/p/session/x")).toBe(true);
    expect(isAllowedProviderRedirect("http://checkout.stripe.com/c/pay/cs_1")).toBe(false);
    expect(isAllowedProviderRedirect("https://checkout.stripe.com.evil.example/x")).toBe(false);
    expect(isAllowedProviderRedirect("https://user:pw@checkout.stripe.com/x")).toBe(false);
    expect(isAllowedProviderRedirect("https://checkout.stripe.com:8443/x")).toBe(false);
    expect(isAllowedProviderRedirect("/o/acme/settings/billing")).toBe(false);
    expect(isAllowedProviderRedirect(undefined)).toBe(false);
  });

  it("lists every webhook event the handler applies", () => {
    expect(STRIPE_WEBHOOK_EVENTS).toEqual(expect.arrayContaining(["checkout.session.completed", "customer.subscription.deleted", "invoice.payment_succeeded", "invoice.payment_failed", "charge.refunded"]));
  });
});
