import { describe, expect, it } from "vitest";
import { describeTrigger, parseAutomation, renderTemplate } from "./definition";

const base = { trigger: { type: "event", event: "checkout_started" }, steps: [{ type: "delay", amount: 1, unit: "hours" }] };

describe("automation definitions", () => {
  it("applies guardrail defaults", () => {
    const d = parseAutomation(base);
    expect(d.entry).toEqual({ mode: "every_time", cooldownHours: 0 });
    expect(d.frequencyCap).toEqual({ messages: 3, hours: 24 });
    expect(d.quietHours).toEqual({ start: "22:00", end: "08:00" });
  });

  it("validates branches: conditions, forward jumps only", () => {
    const ok = parseAutomation({
      ...base,
      steps: [
        { type: "branch", condition: { type: "event", event: "purchase", did: false, sinceTrigger: true }, else: { goto: 2 } },
        { type: "push", title: "Hi", body: "Come back" },
        { type: "in_app", title: "Hi", body: "Welcome" },
      ],
    });
    expect(ok.steps[0]).toMatchObject({ type: "branch", else: { goto: 2 } });
    expect(() => parseAutomation({ ...base, steps: [{ type: "delay", amount: 1, unit: "hours" }, { type: "branch", condition: { type: "platform", platforms: ["ios"] }, else: { goto: 1 } }] })).toThrow(/forward/);
    expect(() => parseAutomation({ ...base, steps: [{ type: "branch", condition: { type: "platform", platforms: ["ios"] }, else: { goto: 5 } }] })).toThrow(/no step/);
    expect(() => parseAutomation({ ...base, steps: [{ type: "branch", condition: { type: "nope" }, else: "exit" }] })).toThrow(/Branch condition/);
  });

  it("rejects unsafe deep links and unknown steps", () => {
    expect(() => parseAutomation({ ...base, steps: [{ type: "push", title: "a", body: "b", deepLink: "javascript:alert(1)" }] })).toThrow();
    expect(() => parseAutomation({ ...base, steps: [{ type: "sql", query: "drop" }] })).toThrow();
    expect(parseAutomation({ ...base, steps: [{ type: "push", title: "a", body: "b", deepLink: "myapp://cart" }] }).steps[0]).toMatchObject({ deepLink: "myapp://cart" });
  });

  it("requires a weekday for weekly schedules", () => {
    const id = "00000000-0000-4000-8000-000000000001";
    expect(() => parseAutomation({ ...base, trigger: { type: "schedule", audienceId: id, every: "week", at: "09:00" } })).toThrow(/weekday/);
    const d = parseAutomation({ ...base, trigger: { type: "schedule", audienceId: id, every: "week", at: "09:00", weekday: 5 } });
    expect(describeTrigger(d.trigger, () => "VIPs")).toBe("Every Friday at 09:00 for everyone in VIPs");
  });

  it("renders templates from user and event properties only", () => {
    expect(renderTemplate("Hi {{ user.name }}, your {{event.item}} is waiting{{user.missing}}", { user: { name: "Sara" }, event: { item: "cart" } })).toBe("Hi Sara, your cart is waiting");
    expect(renderTemplate("{{process.env.X}}{{user.obj}}", { user: { obj: { a: 1 } } })).toBe("{{process.env.X}}");
  });
});
