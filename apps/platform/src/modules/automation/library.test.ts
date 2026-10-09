import { describe, expect, it } from "vitest";
import { AR } from "@/i18n/ar";
import { makeT } from "@/i18n/translate";
import { MESSAGE_STEPS, parseAutomation } from "./definition";
import { EVENT_SLOTS, FLOW_TEMPLATE_IDS, FLOW_TEMPLATES, getFlowTemplate, planFlowTemplate, suggestedEvents } from "./library";

const arabic = makeT(AR);

describe("flows library", () => {
  it("has 6 to 8 templates with unique ids", () => {
    expect(FLOW_TEMPLATES.length).toBeGreaterThanOrEqual(6);
    expect(FLOW_TEMPLATES.length).toBeLessThanOrEqual(8);
    expect(new Set(FLOW_TEMPLATE_IDS).size).toBe(FLOW_TEMPLATES.length);
  });

  it.each(FLOW_TEMPLATE_IDS)("%s validates against the automation schema, in English and Arabic", (id) => {
    for (const t of [undefined, arabic]) {
      const plan = planFlowTemplate(id, {}, t);
      expect(plan.name.length).toBeGreaterThanOrEqual(2);
      expect(plan.name.length).toBeLessThanOrEqual(80);
      const d = parseAutomation(JSON.parse(JSON.stringify(plan.definition)));
      expect(d.steps.some((s) => MESSAGE_STEPS.has(s.type))).toBe(true);
      // Only channels that need nothing created first in the environment (no WhatsApp template, webhook or audience).
      expect(d.steps.every((s) => ["delay", "branch", "push", "email", "in_app", "exit"].includes(s.type))).toBe(true);
      expect(d.trigger).toEqual({ type: "event", event: EVENT_SLOTS[getFlowTemplate(id).events[0]].defaults[0] });
    }
  });

  it("uses the events the person maps, and defaults for the rest", () => {
    const d = parseAutomation(planFlowTemplate("abandoned_cart", { cart: " add_to_bag ", purchase: "order_placed", checkout: "" }).definition);
    expect(d.trigger).toEqual({ type: "event", event: "add_to_bag" });
    expect(d.goal).toEqual({ event: "order_placed", withinDays: 3, stopOnConversion: true });
    expect(d.exitEvent).toBe("checkout_started");
    const nudge = parseAutomation(planFlowTemplate("onboarding_nudge", { key_action: "first_lesson" }).definition);
    expect(nudge.steps.filter((s) => s.type === "branch").map((s) => s.type === "branch" && s.condition)).toEqual([
      expect.objectContaining({ type: "event", event: "first_lesson", did: false, sinceTrigger: true }),
      expect.objectContaining({ type: "event", event: "first_lesson", did: false, sinceTrigger: true }),
    ]);
  });

  it("suggests an event the app already sends and marks the ones it hasn't seen", () => {
    const tpl = getFlowTemplate("post_purchase");
    expect(suggestedEvents(tpl, new Set(["order_completed"]))).toEqual([
      { slot: "purchase", event: "order_completed", seen: true },
      { slot: "review", event: "review_submitted", seen: false },
    ]);
    expect(suggestedEvents(tpl, null).map((e) => e.seen)).toEqual([null, null]);
    expect(parseAutomation(planFlowTemplate("post_purchase", {}, undefined, new Set(["order_completed"])).definition).trigger).toEqual({ type: "event", event: "order_completed" });
  });

  it("writes the copy in the reader's language", () => {
    const en = planFlowTemplate("welcome_series").definition;
    const ar = planFlowTemplate("welcome_series", {}, arabic).definition;
    expect(en.steps[0]).toMatchObject({ type: "push", title: "Welcome aboard!" });
    expect(ar.steps[0]).toMatchObject({ type: "push", title: AR["Welcome aboard!"] });
    expect(planFlowTemplate("welcome_series", {}, arabic).name).toBe(AR["Welcome series"]);
  });
});
