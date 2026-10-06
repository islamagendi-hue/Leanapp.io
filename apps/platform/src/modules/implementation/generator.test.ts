import { describe, expect, it } from "vitest";
import { generatePlan } from "./generator";
import type { Answers } from "./questions";

const food: Answers = {
  "business.description": "We are a food delivery app. Users choose restaurants, add meals to cart, checkout and pay.",
  "business.model": "delivery",
  "business.customer_type": "b2c",
  "business.countries": ["SA"],
  "business.currencies": ["SAR"],
  "app.primary_action": "Order food from restaurants",
  "app.has_signup": true,
  "app.has_onboarding": false,
  "app.features": ["search", "cart_checkout", "reviews", "push"],
  "app.multiple_user_types": false,
  "monetization.streams": ["one_time", "commission"],
  "monetization.payment_confirmation": "backend",
  "monetization.has_refunds": true,
  "journey.description": "Users see a TikTok ad, install the app, register, choose a restaurant, view the menu, add meals to cart, checkout and pay. The order is delivered and they rate it.",
  "attribution.channels": ["tiktok", "snapchat", "influencers"],
  "attribution.existing_mmp": "none",
  "value.activation_event": "order_completed",
  "value.north_star_event": "order_completed",
};

const names = (a: Answers) => generatePlan(a, ["android", "ios"]).events.map((e) => e.event_name);

describe("generatePlan", () => {
  it("turns a food delivery business into restaurant events with one revenue event", () => {
    const plan = generatePlan(food, ["android", "ios"]);
    const n = plan.events.map((e) => e.event_name);
    for (const e of ["app_opened", "signup_completed", "restaurant_viewed", "menu_viewed", "product_added_to_cart", "cart_viewed", "checkout_started", "order_completed", "order_cancelled", "order_delivered", "review_submitted"]) {
      expect(n).toContain(e);
    }
    expect(n).not.toContain("purchase_completed"); // "pay" maps to the plan's revenue event
    expect(n).not.toContain("vendor_viewed");
    expect(plan.revenue_event).toBe("order_completed");
    expect(plan.activation_event).toBe("order_completed");
    const order = plan.events.find((e) => e.event_name === "order_completed")!;
    expect(order.source).toBe("backend");
    expect(order.revenue_relevance && order.conversion_relevance && order.required).toBe(true);
    expect(order.properties.map((p) => p.name)).toEqual(expect.arrayContaining(["transaction_id", "revenue", "currency"]));
    expect(plan.events.find((e) => e.event_name === "restaurant_viewed")!.properties[0].name).toBe("restaurant_id");
    expect(plan.attribution_rules.map((r) => r.channel).sort()).toEqual(["influencers", "snapchat", "tiktok"]);
    expect(plan.attribution_rules.find((r) => r.channel === "tiktok")!.click_id_param).toBe("ttclid");
    expect(n).toContain("deep_link_opened"); // influencer links open the app
  });

  it("gives every event a reason and valid snake_case name", () => {
    for (const e of generatePlan(food, ["android", "ios"]).events) {
      expect(e.reason.length).toBeGreaterThan(10);
      expect(e.event_name).toMatch(/^[a-z][a-z0-9_]{1,63}$/);
    }
  });

  it("does not add irrelevant events for a different model", () => {
    const n = names({ ...food, "business.model": "edtech", "business.description": "Online Arabic courses", "journey.description": "Students enrol in a course and finish lessons", "monetization.streams": ["subscriptions"], "app.features": [], "value.activation_event": "lesson_completed", "value.north_star_event": "lesson_completed" });
    expect(n).toEqual(expect.arrayContaining(["course_started", "lesson_completed", "subscription_started"]));
    expect(n).not.toContain("restaurant_viewed");
    expect(n).not.toContain("order_completed");
    expect(n).not.toContain("product_added_to_cart");
  });

  it("splits a used-car marketplace into buyer and seller events", () => {
    const plan = generatePlan({
      "business.description": "We have a marketplace where users can buy and sell used cars.",
      "business.model": "marketplace",
      "app.has_signup": true,
      "app.has_onboarding": false,
      "app.features": ["search", "messaging"],
      "app.multiple_user_types": true,
      "app.user_types": "buyer, seller",
      "monetization.streams": ["commission"],
      "journey.description": "Sellers list a car. Buyers browse, contact the seller, make an offer and pay.",
      "attribution.channels": ["meta", "google"],
      "attribution.existing_mmp": "appsflyer",
      "attribution.authoritative": "mmp",
    }, ["android", "ios"]);
    const n = plan.events.map((e) => e.event_name);
    expect(n).toEqual(expect.arrayContaining(["listing_viewed", "listing_created", "listing_published", "message_started", "offer_created", "purchase_completed"]));
    expect(plan.events.find((e) => e.event_name === "purchase_completed")!.properties.map((p) => p.name)).toContain("listing_id");
    expect(plan.user_properties.find((u) => u.name === "user_type")!.description).toContain("buyer, seller");
    expect(plan.attribution_rules.find((r) => r.channel === "meta")!.notes).toContain("appsflyer");
  });

  it("honours a custom activation event", () => {
    const plan = generatePlan({ ...food, "value.activation_event": "first_address_saved" }, ["ios"]);
    const custom = plan.events.find((e) => e.event_name === "first_address_saved")!;
    expect(custom.category).toBe("custom");
    expect(custom.activation_relevance).toBe(true);
  });

  it("warns when payments are confirmed only on the client", () => {
    expect(generatePlan({ ...food, "monetization.payment_confirmation": "client_only" }, ["ios"]).warnings.join(" ")).toMatch(/backend/);
  });

  it("classifies from free text when no model was chosen", () => {
    const plan = generatePlan({ "business.description": "Book a salon appointment or hotel reservation", "journey.description": "users book" }, ["ios"]);
    expect(plan.business_model).toBe("booking");
  });
});

describe("generatePlan revenue integrity", () => {
  it("never plans two primary revenue events for a food app described with shop words", () => {
    const plan = generatePlan({
      "business.description": "We are a food delivery app. Users choose restaurants, add meals to cart, checkout and pay.",
      "app.has_signup": true,
      "app.has_onboarding": false,
      "monetization.streams": ["one_time"],
      "journey.description": "Users see a TikTok ad, install the app, register, browse products, add products to cart, checkout and pay.",
    }, ["android", "ios"]);
    const revenue = plan.events.filter((e) => e.revenue_relevance && e.conversion_relevance).map((e) => e.event_name);
    expect(revenue).toEqual(["order_completed"]);
    expect(plan.events.map((e) => e.event_name)).not.toContain("product_list_viewed");
  });
});
