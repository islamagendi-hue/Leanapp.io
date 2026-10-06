import { describe, expect, it } from "vitest";
import { inputFromParams, paramsFromConfig, toSearch } from "./report-params";
import { catalogRules, revenueRules, ruleFor } from "./revenue-rules";
import { cohortDefinitionSchema, cohortSql, evCte, Params, propertyFilterSchema, propertyPredicate } from "./sql";

describe("revenue rules", () => {
  it("derives revenue and refund events from the catalog", () => {
    const rules = Object.fromEntries(catalogRules().map((r) => [r.event, r]));
    expect(rules.purchase_completed).toMatchObject({ property: "revenue", kind: "revenue" });
    expect(rules.order_completed).toMatchObject({ property: "revenue", kind: "revenue" });
    expect(rules.subscription_started).toMatchObject({ property: "price", kind: "revenue" });
    expect(rules.subscription_renewed).toMatchObject({ property: "price", kind: "revenue" });
    expect(rules.transfer_completed).toMatchObject({ property: "fee", kind: "revenue" }); // your fee, not the amount moved
    expect(rules.refund_completed).toMatchObject({ property: "refund_amount", kind: "refund" });
    expect(rules.lead_qualified).toBeUndefined(); // an expected value is not revenue
    expect(rules.product_viewed).toBeUndefined(); // price on a non-revenue event
  });

  it("lets the published plan override and extend the catalog", () => {
    const rules = revenueRules([
      { name: "subscription_started", properties: ["revenue", "price", "currency"] },
      { name: "coins_bought", properties: ["price", "currency"] },
      { name: "chargeback", properties: ["refund_amount", "currency"] },
      { name: "lead_scored", properties: ["value"] },
    ]);
    const by = Object.fromEntries(rules.map((r) => [r.event, r]));
    expect(by.subscription_started).toMatchObject({ property: "revenue", source: "plan" });
    expect(by.coins_bought).toMatchObject({ property: "price", kind: "revenue", source: "plan" });
    expect(by.chargeback).toMatchObject({ kind: "refund" });
    expect(by.lead_scored).toBeUndefined();
    expect(ruleFor("x", [], "plan")).toBeNull();
  });
});

describe("cohort definitions", () => {
  it("validates property filters", () => {
    expect(propertyFilterSchema.safeParse({ name: "plan", op: "eq", value: "gold" }).success).toBe(true);
    expect(propertyFilterSchema.safeParse({ name: "plan", op: "eq" }).success).toBe(false);
    expect(propertyFilterSchema.safeParse({ name: "age", op: "gt", value: "x" }).success).toBe(false);
    expect(propertyFilterSchema.safeParse({ name: "age", op: "exists" }).success).toBe(true);
    expect(propertyFilterSchema.safeParse({ name: "a b", op: "exists" }).success).toBe(false);
  });

  it("needs a condition and an ordered date range", () => {
    expect(cohortDefinitionSchema.safeParse({}).success).toBe(false);
    expect(cohortDefinitionSchema.safeParse({ event: { name: "x", range: { kind: "between", from: "2026-02-01", to: "2026-01-01" } } }).success).toBe(false);
    const ok = cohortDefinitionSchema.parse({ event: { name: "x", range: { kind: "last", days: "30" } } });
    expect(ok.event).toEqual({ name: "x", minCount: 1, range: { kind: "last", days: 30 } });
  });

  it("keeps values in bind parameters", () => {
    const p = new Params(["env"]);
    const sql = propertyPredicate("e.properties", { name: "plan'--", op: "eq", value: "x'); drop table y; --" }, p);
    expect(sql).toBe("(e.properties->>$2) = $3");
    expect(p.values).toEqual(["env", "plan'--", "x'); drop table y; --"]);
    const n = new Params();
    expect(propertyPredicate("u.properties", { name: "age", op: "gte", value: "30" }, n)).toContain(">= $2::numeric");
  });

  it("builds event, user property and combined cohorts", () => {
    const now = new Date("2026-10-06T00:00:00Z");
    const p = new Params(["env"]);
    const def = cohortDefinitionSchema.parse({
      event: { name: "purchase_completed", minCount: 2, range: { kind: "between", from: "2026-09-01", to: "2026-09-30" }, property: { name: "revenue", op: "gt", value: "10" } },
      userProperty: { name: "plan", op: "eq", value: "gold" },
    });
    const sql = cohortSql(def, p, { timezone: "Asia/Riyadh", now });
    expect(sql).toContain(" intersect ");
    expect(sql).toContain("having count(*) >= ");
    expect(p.values).toEqual(["env", "Asia/Riyadh", "2026-09-01", "2026-09-30", "purchase_completed", "revenue", "10", 2, "plan", "gold", "plan", "gold"]);
    const last = new Params(["env"]);
    cohortSql(cohortDefinitionSchema.parse({ event: { name: "x", range: { kind: "last", days: 7 } } }), last, { timezone: "UTC", now });
    expect(last.values.slice(1, 3)).toEqual([new Date("2026-09-29T00:00:00Z"), now]);
    expect(evCte("select 'u1' as person")).toContain("in (select person from cohort)");
    expect(evCte()).not.toContain("cohort");
  });
});

describe("report params", () => {
  it("round-trips every report kind through the URL", () => {
    const trend = inputFromParams("trend", toSearch({ event: "purchase", days: "7", by: "property", property: "plan", cohort: "c1" }));
    expect(trend).toEqual({ event: "purchase", days: "7", cohortId: "c1", breakdown: "property:plan" });
    expect(paramsFromConfig("trend", { event: "purchase", days: 7, breakdown: "property:plan", cohortId: "c1" }).toString())
      .toBe("event=purchase&by=property&property=plan&days=7&cohort=c1");
    expect(inputFromParams("funnel", toSearch({ step: ["a", " ", "b"], window: "3", split: "platform" }))).toMatchObject({ steps: ["a", "b"], windowDays: "3", breakdown: "platform" });
    expect(inputFromParams("retention", toSearch({ start: "a", return: "b" }))).toMatchObject({ startEvent: "a", returnEvent: "b" });
    expect(paramsFromConfig("retention", { startEvent: "a", returnEvent: "b", days: 30 }).toString()).toBe("start=a&return=b&days=30");
    expect(inputFromParams("revenue", toSearch({ by: "platform" }))).toMatchObject({ breakdown: "platform" });
    expect(paramsFromConfig("revenue", { days: 90, breakdown: "event" }).toString()).toBe("by=event&days=90");
  });
});
