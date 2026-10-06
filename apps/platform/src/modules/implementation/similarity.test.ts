import { describe, expect, it } from "vitest";
import { suggestMapping } from "./similarity";

const plan = ["purchase_completed", "order_cancelled", "checkout_started", "product_added_to_cart", "signup_completed", "product_viewed"];

describe("suggestMapping", () => {
  it.each([
    ["purchase", "purchase_completed"],
    ["Purchase", "purchase_completed"],
    ["purchaseCompleted", "purchase_completed"],
    ["add_to_cart", "product_added_to_cart"],
    ["AddToCart", "product_added_to_cart"],
    ["sign_up", "signup_completed"],
    ["register", "signup_completed"],
    ["view_product", "product_viewed"],
    ["checkout_start", "checkout_started"],
  ])("%s → %s", (received, expected) => {
    expect(suggestMapping(received, plan)?.to).toBe(expected);
  });
  it("maps an order name onto the delivery revenue event", () => {
    expect(suggestMapping("purchase", ["order_completed", "order_cancelled", "order_delivered"])?.to).toBe("order_completed");
  });
  it("does not suggest unrelated names", () => {
    expect(suggestMapping("level_up", plan)).toBeNull();
    expect(suggestMapping("purchase_completed", plan)).toBeNull();
  });
});
