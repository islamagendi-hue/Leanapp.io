import { describe, expect, it } from "vitest";
import { widgetInputFromForm } from "./form";
import { planTemplate, type TemplateFacts } from "./templates";

const none: TemplateFacts = { startEvent: null, activationEvent: null, coreEvent: null, revenueEvent: null, topEvents: [], audiences: [] };
const full: TemplateFacts = {
  startEvent: "sign_up", activationEvent: "first_order", coreEvent: "order_completed", revenueEvent: "purchase",
  topEvents: ["app_open", "sign_up", "order_completed"], audiences: [{ id: "a1", name: "VIP" }, { id: "a2", name: "New" }, { id: "a3", name: "Old" }],
};
const titles = (p: ReturnType<typeof planTemplate>) => p.widgets.map((w) => w.title);

describe("dashboard templates", () => {
  it("builds every widget when the project defines its steps", () => {
    expect(titles(planTemplate("growth", full))).toEqual([
      "DAU: active users per day", "WAU: active users, last 7 days", "MAU: active users, last 30 days", "Activation rate", "Sign-up to activation", "D7 retention", "Feature adoption: order_completed",
    ]);
    expect(planTemplate("product", full).widgets.find((w) => w.type === "funnel")?.config.steps).toEqual(["sign_up", "first_order", "order_completed"]);
    const money = planTemplate("monetization", full);
    expect(titles(money)).toEqual(["Revenue and ARPU", "Paying users", "Conversion to paying", "Revenue: VIP", "Revenue: New"]);
    expect(money.skipped).toEqual([]);
  });

  it("skips widgets it can't build instead of inventing events", () => {
    const g = planTemplate("growth", none);
    expect(titles(g)).toEqual(["DAU: active users per day", "WAU: active users, last 7 days", "MAU: active users, last 30 days", "Activation rate", "D7 retention"]);
    expect(g.skipped).toHaveLength(2);
    const m = planTemplate("monetization", none);
    expect(m.widgets.map((w) => w.type)).toEqual(["revenue", "growth"]);
    expect(m.skipped).toHaveLength(2);
    expect(planTemplate("product", { ...none, topEvents: ["app_open", "session_start"] }).skipped.join(" ")).toMatch(/Feature usage/);
  });

  it("keeps every widget inside the 12-column grid", () => {
    for (const id of ["growth", "product", "monetization"] as const) {
      for (const w of planTemplate(id, full).widgets) expect(w.w).toBeLessThanOrEqual(12);
    }
  });
});

describe("add-widget form", () => {
  it("leaves out empty fields and collects funnel steps in order", () => {
    const get = (o: Record<string, string>) => (k: string) => o[k];
    expect(widgetInputFromForm("kpi", get({ metric: "active_people", event: " ", days: "7", compare: "1" }))).toEqual({ metric: "active_people", days: "7", compare: "1" });
    expect(widgetInputFromForm("funnel", get({ step1: "a", step3: "c", step2: "b" })).steps).toEqual(["a", "b", "c"]);
    expect(widgetInputFromForm("audience_size", get({ audience: "x", days: "7" }))).toEqual({ audienceId: "x" });
    expect(widgetInputFromForm("revenue", get({ audience: "x" }))).toEqual({ cohortId: "x" });
  });
});
