import { describe, expect, it } from "vitest";
import { marketingOnly, servedInMarketingOnly } from "./access";

describe("marketing-only mode", () => {
  it("is on only when MARKETING_ONLY is 1", () => {
    expect(marketingOnly({ MARKETING_ONLY: "1" })).toBe(true);
    expect(marketingOnly({ MARKETING_ONLY: "true" })).toBe(false);
    expect(marketingOnly({})).toBe(false);
  });

  it("serves the public pages and nothing from the app", () => {
    for (const p of ["/", "/features", "/pricing", "/about", "/developers", "/lang", "/theme"]) expect(servedInMarketingOnly(p)).toBe(true);
    for (const p of ["/login", "/signup", "/onboarding", "/o/acme", "/v1/events", "/api/webhooks/stripe", "/demo", "/featuresx"]) expect(servedInMarketingOnly(p)).toBe(false);
  });
});
