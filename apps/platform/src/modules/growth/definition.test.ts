import { describe, expect, it } from "vitest";
import { definitionInputFromFields, definitionProblems, derivedDefinition, effectiveDefinition, fieldsFromDefinition, growthDefinitionSchema } from "./definition";

const planEvents = [
  { event_name: "signup_completed", revenue_relevance: false, properties: [{ name: "method" }] },
  { event_name: "subscription_started", revenue_relevance: true, properties: [{ name: "plan" }, { name: "price" }, { name: "currency" }] },
  { event_name: "order_completed", revenue_relevance: true, properties: [{ name: "revenue" }, { name: "currency" }] },
];

describe("growth definitions", () => {
  it("derives definitions for plan versions saved before Phase 1", () => {
    const def = effectiveDefinition({ growth: null, activation_event: "signup_completed", north_star_event: "order_completed" }, planEvents);
    expect(def).toEqual({
      activation: { event: "signup_completed", filters: [] },
      core_action: { event: "order_completed", filters: [] },
      // The first revenue-relevant event with an amount property (price for subscriptions).
      revenue: { event: "subscription_started", amount_property: "price", currency_property: "currency" },
      retention: { return_event: "any" },
    });
    expect(derivedDefinition(null)).toEqual({ activation: null, core_action: null, revenue: null, retention: { return_event: "any" } });
  });

  it("uses saved definitions, and falls back to derived ones when they no longer validate", () => {
    const saved = { activation: { event: "order_completed", filters: [{ name: "first", op: "eq", value: "true" }] } };
    expect(effectiveDefinition({ growth: saved, activation_event: "signup_completed", north_star_event: null }).activation).toEqual(saved.activation);
    const broken = { activation: { event: "", filters: [] } };
    expect(effectiveDefinition({ growth: broken, activation_event: "signup_completed", north_star_event: null }).activation?.event).toBe("signup_completed");
  });

  it("validates filters the same way analytics does", () => {
    expect(growthDefinitionSchema.safeParse({ core_action: { event: "x", filters: [{ name: "amount", op: "gt", value: "abc" }] } }).success).toBe(false);
    expect(growthDefinitionSchema.safeParse({ core_action: { event: "x", filters: [{ name: "bad name!", op: "eq", value: "a" }] } }).success).toBe(false);
    expect(growthDefinitionSchema.safeParse({ core_action: { event: "x", filters: [{ name: "plan", op: "exists" }] } }).success).toBe(true);
  });

  it("requires the events to be in the plan, and a core action for core-action retention", () => {
    const def = growthDefinitionSchema.parse({ activation: { event: "app_opened" }, retention: { return_event: "core_action" } });
    expect(definitionProblems(def, ["signup_completed"])).toEqual([
      'Activation: "app_opened" is not in the tracking plan. Add it to the plan first.',
      "Retention counts returns by the core action, so choose a core action.",
    ]);
    expect(definitionProblems(growthDefinitionSchema.parse({ activation: { event: "signup_completed" } }), ["signup_completed"])).toEqual([]);
  });

  it("round-trips through the setup form's fields", () => {
    const def = growthDefinitionSchema.parse({
      activation: { event: "signup_completed", filters: [{ name: "method", op: "eq", value: "email" }] },
      core_action: { event: "order_completed" },
      revenue: { event: "order_completed", amount_property: "revenue" },
      retention: { return_event: "core_action" },
    });
    const fields = fieldsFromDefinition(def);
    expect(growthDefinitionSchema.parse(definitionInputFromFields((k) => fields[k]))).toEqual(def);
    // Empty event fields mean "not set"; an empty filter name means no filter.
    expect(growthDefinitionSchema.parse(definitionInputFromFields(() => ""))).toEqual({ activation: null, core_action: null, revenue: null, retention: { return_event: "any" } });
  });
});
