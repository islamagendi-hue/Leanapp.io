import { describe, expect, it } from "vitest";
import { COMPARE_AR, COMPARE_EN, FLOW, FLOW_AR, landingCopy, landingLang } from "./landing";

describe("landing content", () => {
  it("follows the product flow", () => {
    expect(FLOW.map((s) => s.step)).toEqual(["Connect", "Collect", "Understand", "Funnels", "Retention", "Audiences", "Act"]);
  });

  it("never labels as live what isn't", () => {
    const live = FLOW.flatMap((s) => s.items).filter((i) => i.state === "live").map((i) => i.name).join(" | ");
    expect(live).not.toMatch(/SDK|in-app|deep link|acquisition|attribution/i);
    for (const i of FLOW.flatMap((s) => s.items)) if (i.state === "beta") expect(i.note, i.name).toBeTruthy();
  });

  it("says the same thing in Arabic, item for item", () => {
    expect(FLOW_AR.length).toBe(FLOW.length);
    FLOW.forEach((s, i) => {
      expect(FLOW_AR[i].items.map((it) => [it.state, !!it.note])).toEqual(s.items.map((it) => [it.state, !!it.note]));
    });
    expect(COMPARE_AR.map((r) => r.cells)).toEqual(COMPARE_EN.map((r) => r.cells));
    const en = landingCopy("en");
    const ar = landingCopy("ar");
    expect(ar.pricing.plans).toHaveLength(en.pricing.plans.length);
    expect(ar.pricing.plans.map((p) => p.price)).toEqual(en.pricing.plans.map((p) => p.price));
    expect(ar.how.steps).toHaveLength(en.how.steps.length);
    expect(ar.faq.items).toHaveLength(en.faq.items.length);
    expect(ar.dir).toBe("rtl");
  });

  it("is honest in the comparison: attribution is beta and what we lack is listed", () => {
    const attribution = COMPARE_EN.find((r) => /attribution/i.test(r.need))!;
    expect(attribution.cells[0]).toBe("beta");
    expect(COMPARE_EN.some((r) => r.cells[0] === "no")).toBe(true);
  });

  it("picks Arabic unless asked for English or the browser prefers it", () => {
    expect(landingLang(undefined, null)).toBe("ar");
    expect(landingLang(undefined, "ar-SA,ar;q=0.9,en;q=0.8")).toBe("ar");
    expect(landingLang(undefined, "en-US,en;q=0.9")).toBe("en");
    expect(landingLang("ar", "en-US")).toBe("ar");
    expect(landingLang("en", "ar-SA")).toBe("en");
    expect(landingLang("fr", "ar")).toBe("ar");
  });
});
