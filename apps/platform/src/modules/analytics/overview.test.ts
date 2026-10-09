import { describe, expect, it } from "vitest";
import { growthDefinitionSchema } from "@/modules/growth/definition";
import { defaultFunnelSteps, keyFunnelSteps } from "./overview";

describe("key funnel", () => {
  const def = growthDefinitionSchema.parse({ activation: { event: "order_completed" }, core_action: { event: "order_completed" }, revenue: { event: "purchase_completed", amount_property: "revenue" } });

  it("starts at an install or sign-up event, then follows the Activation steps without repeats", () => {
    expect(keyFunnelSteps(def, ["screen_viewed", "signup_completed", "app_installed"])).toEqual(["signup_completed", "order_completed", "purchase_completed"]);
    expect(keyFunnelSteps(def, ["screen_viewed"])).toEqual(["order_completed", "purchase_completed"]);
  });

  it("needs two steps", () => {
    expect(keyFunnelSteps(null, ["app_installed"])).toBeNull();
    expect(keyFunnelSteps(growthDefinitionSchema.parse({ activation: { event: "x" } }), [])).toBeNull();
  });
});

describe("default funnel", () => {
  it("goes from install or sign-up through a cart-like step to a conversion, skipping background events", () => {
    const demo = ["app_opened", "restaurant_viewed", "product_added_to_cart", "app_installed", "screen_viewed", "checkout_started", "order_completed", "signup_completed"];
    expect(defaultFunnelSteps(demo)).toEqual(["app_installed", "product_added_to_cart", "order_completed"]);
  });

  it("falls back to the most used events, and needs two", () => {
    expect(defaultFunnelSteps(["app_opened", "lesson_started", "lesson_finished"])).toEqual(["lesson_started", "lesson_finished"]);
    expect(defaultFunnelSteps(["app_opened", "screen_viewed"])).toEqual([]);
    expect(defaultFunnelSteps([])).toEqual([]);
  });
});
