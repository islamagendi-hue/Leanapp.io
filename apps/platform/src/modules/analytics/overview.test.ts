import { describe, expect, it } from "vitest";
import { growthDefinitionSchema } from "@/modules/growth/definition";
import { keyFunnelSteps } from "./overview";

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
