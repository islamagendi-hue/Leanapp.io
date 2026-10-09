import { describe, expect, it } from "vitest";
import { downgradeBlockers, entitled, overageEvents, planChange, priceEnvName, priceEnvProblems, priceLookup, resolvePriceId } from "./plans";

describe("plan prices from configuration", () => {
  const env = { STRIPE_PRICE_STARTER_MONTHLY: "price_s1", STRIPE_PRICE_STARTER_ANNUAL: " price_s12 ", STRIPE_PRICE_GROWTH_MONTHLY: "not-a-price" };

  it("names one variable per plan and interval", () => {
    expect(priceEnvName("starter", "month")).toBe("STRIPE_PRICE_STARTER_MONTHLY");
    expect(priceEnvName("growth", "year")).toBe("STRIPE_PRICE_GROWTH_ANNUAL");
    expect(priceEnvName("team-plus", "year")).toBe("STRIPE_PRICE_TEAM_PLUS_ANNUAL");
  });

  it("resolves only well-formed ids, with the legacy column as a monthly fallback", () => {
    expect(resolvePriceId(env, "starter", "month")).toBe("price_s1");
    expect(resolvePriceId(env, "starter", "year")).toBe("price_s12");
    expect(resolvePriceId(env, "growth", "month", "price_legacy")).toBeNull(); // a malformed env value is never sent, nor replaced
    expect(resolvePriceId({}, "growth", "month", "price_legacy")).toBe("price_legacy");
    expect(resolvePriceId({}, "growth", "year", "price_legacy")).toBeNull();
    expect(resolvePriceId({}, "growth", "month", "bogus")).toBeNull();
    expect(resolvePriceId(env, "../starter", "month")).toBeNull();
  });

  it("maps a price back to its plan and interval for webhooks", () => {
    const map = priceLookup(env, [{ id: "starter" }, { id: "growth", stripe_price_id: "price_glegacy" }]);
    expect(map.get("price_s1")).toEqual({ planId: "starter", interval: "month" });
    expect(map.get("price_s12")).toEqual({ planId: "starter", interval: "year" });
    expect(map.get("price_glegacy")).toBeUndefined(); // growth's monthly env var is set (malformed), so the legacy column isn't used
    expect(priceLookup({}, [{ id: "growth", stripe_price_id: "price_glegacy" }]).get("price_glegacy")).toEqual({ planId: "growth", interval: "month" });
  });

  it("reports malformed, duplicated and orphan variables by name only", () => {
    const problems = priceEnvProblems({ ...env, STRIPE_PRICE_PRO_MONTHLY: "price_s1", STRIPE_PRICE_TYPO_ANNUAL: "price_x" }, ["starter", "growth", "pro"]);
    expect(problems.map((p) => p.variable).sort()).toEqual(["STRIPE_PRICE_GROWTH_MONTHLY", "STRIPE_PRICE_PRO_MONTHLY", "STRIPE_PRICE_TYPO_ANNUAL"]);
    expect(JSON.stringify(problems)).not.toContain("price_s1\"");
  });
});

describe("plan changes", () => {
  it("orders plans by sort order", () => {
    expect(planChange({ id: "starter", sortOrder: 1 }, { id: "growth", sortOrder: 2 })).toBe("upgrade");
    expect(planChange({ id: "growth", sortOrder: 2 }, { id: "starter", sortOrder: 1 })).toBe("downgrade");
    expect(planChange({ id: "growth", sortOrder: 2 }, { id: "growth", sortOrder: 2 })).toBe("same");
  });

  it("lists hard limits a downgrade would leave exceeded", () => {
    expect(downgradeBlockers({ apps: 5, seats: 12 }, { events: 2_000_000, apps: 3, seats: 10 })).toEqual([
      { key: "apps", used: 5, limit: 3 },
      { key: "seats", used: 12, limit: 10 },
    ]);
    expect(downgradeBlockers({ apps: 3, seats: 10 }, { events: 1, apps: 3, seats: 10 })).toEqual([]);
    expect(downgradeBlockers({ apps: 99, seats: 99 }, { events: null, apps: null, seats: null })).toEqual([]);
  });
});

describe("entitlements and usage-based billing", () => {
  it("allows a feature unless the plan explicitly turns it off", () => {
    expect(entitled(null, "experiments")).toBe(true);
    expect(entitled({}, "experiments")).toBe(true);
    expect(entitled({ "feature.experiments": null }, "experiments")).toBe(true);
    expect(entitled({ "feature.experiments": true }, "experiments")).toBe(true);
    expect(entitled({ "feature.experiments": false }, "experiments")).toBe(false);
    expect(entitled({ "feature.experiments": "false" }, "experiments")).toBe(false);
  });

  it("computes overage only for usage-based plans", () => {
    expect(overageEvents(25_000_000, 20_000_000, true)).toBe(5_000_000);
    expect(overageEvents(19_000_000, 20_000_000, true)).toBe(0);
    expect(overageEvents(25_000_000, 20_000_000, false)).toBe(0);
    expect(overageEvents(25_000_000, null, true)).toBe(0);
  });
});
