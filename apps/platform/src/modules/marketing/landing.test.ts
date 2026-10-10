import { describe, expect, it } from "vitest";
import { INTEGRATIONS } from "@/modules/integrations/catalog";
import { COMPARE_AR, COMPARE_EN, FLOW, FLOW_AR, landingCopy, landingLang, WORKS_WITH } from "./landing";

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

  it("offers A/B tests as beta, in both languages, and no longer lists them as not offered", () => {
    const ab = COMPARE_EN.find((r) => /A\/B/.test(r.need))!;
    expect(ab.cells[0]).toBe("beta");
    expect(FLOW.flatMap((s) => s.items).find((i) => /A\/B/.test(i.name))?.state).toBe("beta");
    expect(FLOW_AR.flatMap((s) => s.items).find((i) => /A\/B/.test(i.name))?.state).toBe("beta");
    for (const lang of ["en", "ar"] as const) {
      const copy = landingCopy(lang);
      expect(copy.notOffered).not.toMatch(/A\/B/);
      expect(copy.pricing.plans.flatMap((p) => p.features).join(" ")).not.toMatch(/coming soon|قريبًا/);
    }
  });

  it("shows one built-in dashboard, with the same parts in both languages", () => {
    const en = landingCopy("en");
    const ar = landingCopy("ar");
    expect(en.demo).not.toHaveProperty("shots");
    for (const key of ["kpis", "steps"] as const) {
      expect(ar.demo.board[key]).toHaveLength(en.demo.board[key].length);
      ar.demo.board[key].forEach((s, i) => expect(s).not.toBe(en.demo.board[key][i]));
    }
    for (const key of Object.keys(en.demo.board) as (keyof typeof en.demo.board)[]) {
      if (typeof en.demo.board[key] === "string") expect(ar.demo.board[key], key).not.toBe(en.demo.board[key]);
    }
    for (const key of ["title", "lead", "note", "cta", "alt", "pause", "play"] as const) expect(ar.demo[key], key).not.toBe(en.demo[key]);
  });

  it("lists only services we really connect to in Works with", () => {
    const catalog = new Map(INTEGRATIONS.flatMap((g) => g.items).map((i) => [i.id, i.state]));
    for (const w of WORKS_WITH) {
      expect(catalog.get(w.integration), w.name).toBeDefined();
      expect(catalog.get(w.integration), w.name).not.toBe("soon");
    }
    expect(WORKS_WITH.map((w) => w.name)).not.toContain("Microsoft Clarity");
    for (const lang of ["en", "ar"] as const) expect(landingCopy(lang).worksWith.note).toMatch(/Clarity/);
  });

  it("keeps the new copy plain: no em-dashes and no free offer", () => {
    for (const lang of ["en", "ar"] as const) {
      const { hero, demo, worksWith } = landingCopy(lang);
      const text = JSON.stringify({ hero, demo, worksWith });
      expect(text).not.toMatch(/—/);
      expect(text).not.toMatch(/\bfree\b|مجان/i);
    }
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
