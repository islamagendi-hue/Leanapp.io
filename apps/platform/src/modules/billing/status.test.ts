import { describe, expect, it } from "vitest";
import type { VerificationResult } from "./provider";
import { CHECKOUT_STATES, configShape, deriveState, type StoredCheck } from "./status";

const ok: VerificationResult = {
  ok: true,
  mode: "test",
  account: { ok: true },
  prices: [{ planId: "starter", interval: "month", priceId: "price_1", ok: true }],
  webhook: { state: "found", url: "https://app.example/api/webhooks/stripe" },
};
const check = (details: Partial<VerificationResult> = {}): StoredCheck => ({ checkedAt: new Date(), ok: true, details: { ...ok, ...details } });
const keys = { STRIPE_SECRET_KEY: "sk_test_abc", STRIPE_WEBHOOK_SECRET: "whsec_abc" };

describe("billing configuration shape", () => {
  it("is not configured with nothing set", () => {
    expect(configShape({})).toEqual({ state: "not_configured", mode: null, problems: [] });
    expect(configShape({ STRIPE_SECRET_KEY: " ", STRIPE_WEBHOOK_SECRET: "" }).state).toBe("not_configured");
  });

  it("reports missing or malformed credentials by name, never by value", () => {
    expect(configShape({ STRIPE_SECRET_KEY: "sk_test_abc" })).toMatchObject({ state: "missing_credentials", problems: [{ variable: "STRIPE_WEBHOOK_SECRET" }] });
    expect(configShape({ STRIPE_WEBHOOK_SECRET: "whsec_abc" })).toMatchObject({ state: "missing_credentials", problems: [{ variable: "STRIPE_SECRET_KEY" }] });
    const pk = configShape({ STRIPE_SECRET_KEY: "pk_live_publishable", STRIPE_WEBHOOK_SECRET: "whsec_abc" });
    expect(pk.state).toBe("missing_credentials");
    expect(JSON.stringify(pk)).not.toContain("pk_live_publishable");
    expect(configShape({ ...keys, STRIPE_WEBHOOK_SECRET: "secret" }).state).toBe("missing_credentials");
    expect(configShape({ STRIPE_PRICE_STARTER_MONTHLY: "price_1" }).state).toBe("missing_credentials");
  });

  it("tells test and live keys apart from the prefix", () => {
    expect(configShape(keys)).toMatchObject({ state: "credentials_present", mode: "test" });
    expect(configShape({ ...keys, STRIPE_SECRET_KEY: "rk_live_abc" })).toMatchObject({ state: "credentials_present", mode: "live" });
  });
});

describe("billing configuration state", () => {
  const present = configShape(keys);
  const live = configShape({ ...keys, STRIPE_SECRET_KEY: "sk_live_abc" });

  it("stays unverified until a verification has run", () => {
    expect(deriveState(present, null, null)).toBe("credentials_unverified");
    expect(deriveState(configShape({}), check(), new Date())).toBe("not_configured");
  });

  it("fails on a bad key or any bad or missing price", () => {
    expect(deriveState(present, check({ account: { ok: false, problem: "key_invalid" }, prices: [] }), null)).toBe("verification_failed");
    expect(deriveState(present, check({ prices: [] }), null)).toBe("verification_failed");
    expect(deriveState(present, check({ prices: [...ok.prices, { planId: "growth", interval: "month", priceId: "price_2", ok: false, problem: "wrong_currency" }] }), null)).toBe("verification_failed");
  });

  it("separates a missing webhook endpoint from one that can't be checked", () => {
    expect(deriveState(present, check({ webhook: { state: "missing", url: "" } }), null)).toBe("webhook_not_configured");
    expect(deriveState(present, check({ webhook: { state: "missing_events", url: "", missingEvents: ["charge.refunded"] } }), null)).toBe("webhook_not_configured");
    expect(deriveState(present, check({ webhook: { state: "disabled", url: "" } }), null)).toBe("webhook_not_configured");
    expect(deriveState(present, check({ webhook: { state: "unverifiable", url: "" } }), null)).toBe("webhook_unverified");
    expect(deriveState(present, check(), null)).toBe("connected_verified");
  });

  it("is ready only once a signed event has arrived in this mode", () => {
    expect(deriveState(present, check(), new Date())).toBe("ready_test");
    expect(deriveState(live, check({ mode: "live" }), new Date())).toBe("ready_live");
    // a signed event proves the secret even when the key can't list endpoints
    expect(deriveState(present, check({ webhook: { state: "unverifiable", url: "" } }), new Date())).toBe("ready_test");
  });

  it("opens checkout only from connected_verified on", () => {
    expect([...CHECKOUT_STATES].sort()).toEqual(["connected_verified", "ready_live", "ready_test"]);
  });
});
