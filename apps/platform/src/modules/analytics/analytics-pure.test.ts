import { describe, expect, it } from "vitest";
import { compileAudience, describeNode, parseDefinition } from "@/modules/audiences/definition";
import { inputFromParams, paramsFromConfig, toSearch } from "./report-params";
import { catalogRules, revenueRules, ruleFor } from "./revenue-rules";
import { evCte, Params, propertyFilterSchema, propertyPredicate } from "./sql";

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

describe("activation property filters", () => {
  it("validates property filters", () => {
    expect(propertyFilterSchema.safeParse({ name: "plan", op: "eq", value: "gold" }).success).toBe(true);
    expect(propertyFilterSchema.safeParse({ name: "plan", op: "eq" }).success).toBe(false);
    expect(propertyFilterSchema.safeParse({ name: "age", op: "gt", value: "x" }).success).toBe(false);
    expect(propertyFilterSchema.safeParse({ name: "age", op: "exists" }).success).toBe(true);
    expect(propertyFilterSchema.safeParse({ name: "a b", op: "exists" }).success).toBe(false);
  });

  it("keeps values in bind parameters", () => {
    const p = new Params(["env"]);
    const sql = propertyPredicate("e.properties", { name: "plan'--", op: "eq", value: "x'); drop table y; --" }, p);
    expect(sql).toBe("(e.properties->>$2) = $3");
    expect(p.values).toEqual(["env", "plan'--", "x'); drop table y; --"]);
    const n = new Params();
    expect(propertyPredicate("u.properties", { name: "age", op: "gte", value: "30" }, n)).toContain(">= $2::numeric");
  });
});

describe("audiences as report filters", () => {
  it("embed in a report's query, continuing its bind values", () => {
    const def = parseDefinition({
      type: "and",
      children: [
        { type: "event", event: "purchase_completed", countOp: "gte", count: 2, between: { from: "2026-09-01", to: "2026-09-30" }, where: [{ property: "revenue", op: "gt", value: 10 }] },
        { type: "user_property", property: "plan", op: "eq", value: "gold" },
      ],
    });
    const p = new Params(["env", new Date("2026-09-01T00:00:00Z")]);
    const { sql, params } = compileAudience(def, "env", { params: p, timezone: "Asia/Riyadh" });
    expect(params).toBe(p.values);
    expect(p.values.slice(0, 2)).toEqual(["env", new Date("2026-09-01T00:00:00Z")]);
    expect(p.values).toContain("Asia/Riyadh");
    expect(p.values).toContain("2026-09-30");
    expect(sql).toMatch(/at time zone \$\d+::text/);
    expect(sql).toContain("e.type in ('track', 'screen') and e.processed_at is not null");
    expect(evCte(sql)).toContain("in (select person from cohort)");
    expect(evCte()).not.toContain("cohort");
    expect(describeNode(def)).toBe('(did purchase_completed where revenue > 10 at least 2 times between 2026-09-01 and 2026-09-30 AND user plan is "gold")');
    expect(() => compileAudience(def, "other", { params: new Params(["env"]) })).toThrow(/environment id/);
  });

  it("validate date ranges", () => {
    expect(() => parseDefinition({ type: "event", event: "x", between: { from: "2026-02-01", to: "2026-01-01" } })).toThrow(/start date/);
    expect(() => parseDefinition({ type: "event", event: "x", between: { from: "2026-02-30x", to: "2026-03-01" } })).toThrow();
    expect(() => parseDefinition({ type: "event", event: "x", sinceTrigger: true, between: { from: "2026-01-01", to: "2026-01-02" } }, { allowSinceTrigger: true })).toThrow(/either/);
    expect(describeNode(parseDefinition({ type: "event", event: "x", between: { from: "2026-01-01", to: "2026-01-01" } }))).toBe("did x on 2026-01-01");
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
