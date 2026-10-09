import { describe, expect, it } from "vitest";
import { AR } from "@/i18n/ar";
import { makeT } from "@/i18n/translate";
import { parseDefinition } from "@/modules/audiences/definition";
import { EVENT_LIBRARY } from "@/modules/implementation/catalog/events";
import { EVENT_NAME_RE } from "@/modules/implementation/plan-input";
import { MESSAGE_STEPS, parseAutomation, type Step } from "./definition";
import {
  EVENT_SLOTS, FLOW_CATEGORIES, FLOW_GOALS, FLOW_TEMPLATE_IDS, FLOW_TEMPLATES, PENDING_AUDIENCE_ID,
  filterFlowTemplates, flowReadiness, getFlowTemplate, planFlowTemplate, suggestedEvents, type ChannelState, type EventSlot,
} from "./library";

const arabic = makeT(AR);
const ARABIC = /[؀-ۿ]/;
const whatsapp = { template: "cart_reminder", language: "ar", bodyParams: ["{{user.first_name}}"], headerParams: [] };
const plan = (id: (typeof FLOW_TEMPLATE_IDS)[number], t = makeT(null)) => planFlowTemplate(id, {}, t, null, { whatsapp });
const texts = (s: Step) =>
  s.type === "push" ? [s.title, s.body] : s.type === "in_app" ? [s.title, s.body, s.buttonText ?? ""] : s.type === "email" ? [s.subject ?? "", s.body ?? ""] : [];

describe("flows library", () => {
  it("has 15 to 20 templates with unique ids, covering every category and goal", () => {
    expect(FLOW_TEMPLATES.length).toBeGreaterThanOrEqual(15);
    expect(FLOW_TEMPLATES.length).toBeLessThanOrEqual(20);
    expect(new Set(FLOW_TEMPLATE_IDS).size).toBe(FLOW_TEMPLATES.length);
    expect(new Set(FLOW_TEMPLATES.map((f) => f.category))).toEqual(new Set(Object.keys(FLOW_CATEGORIES)));
    expect(new Set(FLOW_TEMPLATES.map((f) => f.goal))).toEqual(new Set(Object.keys(FLOW_GOALS)));
  });

  it.each(FLOW_TEMPLATE_IDS)("%s validates against the automation schema, in English and Arabic", (id) => {
    const tpl = getFlowTemplate(id);
    for (const t of [undefined, arabic]) {
      const p = plan(id, t);
      expect(p.name.length).toBeGreaterThanOrEqual(2);
      expect(p.name.length).toBeLessThanOrEqual(80);
      const d = parseAutomation(JSON.parse(JSON.stringify(p.definition)));
      // Only what the engine runs and needs nothing else created in the environment (no webhook, email template or existing audience).
      expect(d.steps.every((s) => ["delay", "branch", "push", "email", "in_app", "whatsapp", "exit"].includes(s.type))).toBe(true);
      // The channels it lists are exactly the ones its steps use.
      expect(new Set(d.steps.filter((s) => MESSAGE_STEPS.has(s.type)).map((s) => s.type))).toEqual(new Set(tpl.channels));
      // Every template says what success is, with an event other than the trigger.
      expect(d.goal).not.toBeNull();
      if (tpl.audience) {
        expect(d.trigger).toEqual({ type: "audience_entered", audienceId: PENDING_AUDIENCE_ID });
        expect(() => parseDefinition(p.audience!.definition)).not.toThrow();
        expect(p.audience!.name.length).toBeLessThanOrEqual(80);
      } else {
        expect(p.audience).toBeNull();
        expect(d.trigger).toEqual({ type: "event", event: EVENT_SLOTS[tpl.events[0]].defaults[0] });
      }
      // No {{user.x}} tokens: a missing property would render as nothing.
      expect(JSON.stringify(p.definition)).not.toMatch(/\{\{(?!user\.first_name)/);
    }
  });

  it.each(FLOW_TEMPLATE_IDS)("%s has every text in Arabic", (id) => {
    const tpl = getFlowTemplate(id);
    expect(AR[tpl.name]).toMatch(ARABIC);
    expect(AR[tpl.description]).toMatch(ARABIC);
    const en = parseAutomation(plan(id).definition);
    const ar = parseAutomation(plan(id, arabic).definition);
    expect(ar.steps.map((s) => s.type)).toEqual(en.steps.map((s) => s.type));
    for (const [i, s] of ar.steps.entries()) {
      for (const [j, text] of texts(s).entries()) {
        if (!texts(en.steps[i])[j]) continue;
        expect(text, `${id} step ${i + 1}`).toMatch(ARABIC);
        expect(text).toBe(AR[texts(en.steps[i])[j]]);
      }
    }
    if (tpl.audience) {
      const audience = plan(id, arabic).audience!;
      expect(audience.name).toMatch(ARABIC);
      expect(audience.description).toMatch(ARABIC);
    }
  });

  it("event slots name valid events from the event library, and every slot is used", () => {
    const used = new Set(FLOW_TEMPLATES.flatMap((f) => f.events));
    for (const [slot, def] of Object.entries(EVENT_SLOTS) as [EventSlot, (typeof EVENT_SLOTS)[EventSlot]][]) {
      expect(used.has(slot), slot).toBe(true);
      for (const name of [...def.defaults, ...def.aliases]) expect(name, slot).toMatch(EVENT_NAME_RE);
      if (!("custom" in def)) for (const name of def.defaults) expect(EVENT_LIBRARY[name], `${slot}: ${name}`).toBeDefined();
      expect(AR[def.label]).toMatch(ARABIC);
    }
  });

  it.each(FLOW_TEMPLATE_IDS)("%s uses every event slot it lists", (id) => {
    const tpl = getFlowTemplate(id);
    const events = Object.fromEntries(tpl.events.map((s) => [s, `mapped_${s}`]));
    const p = planFlowTemplate(id, events, undefined, null, { whatsapp });
    const json = JSON.stringify([p.definition, p.audience]);
    for (const slot of tpl.events) expect(json, slot).toContain(`"mapped_${slot}"`);
    expect(() => parseAutomation(p.definition)).not.toThrow();
  });

  it("uses the events the person maps, and suggestions for the rest", () => {
    const d = parseAutomation(planFlowTemplate("abandoned_cart", { cart: " add_to_bag ", purchase: "order_placed", checkout: "" }).definition);
    expect(d.trigger).toEqual({ type: "event", event: "add_to_bag" });
    expect(d.goal).toEqual({ event: "order_placed", withinDays: 3, stopOnConversion: true });
    expect(d.exitEvent).toBe("checkout_started");
    const nudge = parseAutomation(planFlowTemplate("onboarding_nudge", { key_action: "first_lesson" }).definition);
    expect(nudge.steps.filter((s) => s.type === "branch").map((s) => s.type === "branch" && s.condition)).toEqual([
      expect.objectContaining({ type: "event", event: "first_lesson", did: false, sinceTrigger: true }),
      expect.objectContaining({ type: "event", event: "first_lesson", did: false, sinceTrigger: true }),
    ]);
    const lapsed = planFlowTemplate("lapsed_buyers", { purchase: "order_paid" });
    expect(JSON.stringify(lapsed.audience!.definition)).toContain('"order_paid"');
    expect(lapsed.definition.goal).toMatchObject({ event: "order_paid" });
  });

  it("maps events to what the app sends first, then to its tracking plan, including common aliases", () => {
    const tpl = getFlowTemplate("post_purchase");
    expect(suggestedEvents(tpl, { seen: new Set(["order_completed"]), planned: null })).toEqual([
      { slot: "purchase", event: "order_completed", status: "received" },
      { slot: "review", event: "review_submitted", status: "missing" },
    ]);
    expect(suggestedEvents(tpl, { seen: new Set(), planned: new Set(["booking_completed", "rating_submitted"]) })).toEqual([
      { slot: "purchase", event: "booking_completed", status: "planned" },
      { slot: "review", event: "rating_submitted", status: "planned" },
    ]);
    // Received beats planned, and an alias the app sends beats a default it only plans.
    expect(suggestedEvents(getFlowTemplate("abandoned_cart"), { seen: new Set(["add_to_cart"]), planned: new Set(["product_added_to_cart"]) })[0])
      .toEqual({ slot: "cart", event: "add_to_cart", status: "received" });
    expect(suggestedEvents(tpl, null).map((e) => e.status)).toEqual(["unknown", "unknown"]);
    expect(parseAutomation(planFlowTemplate("post_purchase", {}, undefined, { seen: new Set(["order_completed"]) }).definition).trigger).toEqual({ type: "event", event: "order_completed" });
  });

  it("writes the copy in the chosen language", () => {
    const en = planFlowTemplate("welcome_series").definition;
    const ar = planFlowTemplate("welcome_series", {}, arabic).definition;
    expect(en.steps[0]).toMatchObject({ type: "push", title: "Welcome aboard!" });
    expect(ar.steps[0]).toMatchObject({ type: "push", title: AR["Welcome aboard!"] });
    expect(planFlowTemplate("welcome_series", {}, arabic).name).toBe(AR["Welcome series"]);
  });

  it("filters by category, goal and search, in English and Arabic", () => {
    const ids = (f: Parameters<typeof filterFlowTemplates>[0], t = makeT(null)) => filterFlowTemplates(f, t).map((x) => x.id);
    expect(ids({})).toHaveLength(FLOW_TEMPLATES.length);
    expect(ids({ category: "subscription" })).toEqual(["trial_conversion", "paywall_follow_up", "payment_failed", "subscription_win_back"]);
    expect(ids({ goal: "recovery" })).toEqual(["abandoned_cart", "cart_whatsapp", "checkout_recovery", "payment_failed"]);
    expect(ids({ category: "conversion", goal: "recovery", q: "whatsapp" })).toEqual(["cart_whatsapp"]);
    expect(ids({ q: "  CART  " })).toEqual(expect.arrayContaining(["abandoned_cart", "cart_whatsapp", "browse_abandonment"]));
    expect(ids({ q: "السلة" }, arabic)).toEqual(expect.arrayContaining(["abandoned_cart", "cart_whatsapp"]));
    expect(ids({ q: "trial_started" })).toEqual(["trial_conversion"]);
    expect(ids({ q: "nothing matches this" })).toEqual([]);
  });

  it("says what's missing, and blocks only what can't be created", () => {
    const all: ChannelState = { push: true, email: true, whatsapp: true, in_app: true };
    const cart = getFlowTemplate("abandoned_cart");
    const events = suggestedEvents(cart, { seen: new Set(["product_added_to_cart"]), planned: new Set(["checkout_started"]) });
    expect(flowReadiness(cart, { events, channels: { ...all, email: false }, approvedWhatsAppTemplates: 0, canManageAudiences: true })).toEqual({
      issues: [
        { kind: "event", slot: "checkout", event: "checkout_started", status: "planned" },
        { kind: "event", slot: "purchase", event: "purchase_completed", status: "missing" },
        { kind: "channel", channel: "email" },
      ],
      blocking: false,
    });
    const wa = getFlowTemplate("cart_whatsapp");
    const waEvents = suggestedEvents(wa, null);
    expect(flowReadiness(wa, { events: waEvents, channels: all, approvedWhatsAppTemplates: 0, canManageAudiences: true })).toEqual({ issues: [{ kind: "whatsapp_template" }], blocking: true });
    expect(flowReadiness(wa, { events: waEvents, channels: { ...all, whatsapp: false }, approvedWhatsAppTemplates: 0, canManageAudiences: true })).toEqual({ issues: [{ kind: "channel", channel: "whatsapp" }], blocking: true });
    expect(flowReadiness(wa, { events: waEvents, channels: all, approvedWhatsAppTemplates: 2, canManageAudiences: true })).toEqual({ issues: [], blocking: false });
    const winBack = getFlowTemplate("win_back");
    expect(flowReadiness(winBack, { events: suggestedEvents(winBack, null), channels: all, approvedWhatsAppTemplates: null, canManageAudiences: true, audienceName: "Inactive" }))
      .toEqual({ issues: [{ kind: "audience", name: "Inactive" }], blocking: false });
    expect(flowReadiness(winBack, { events: [], channels: all, approvedWhatsAppTemplates: null, canManageAudiences: false }).blocking).toBe(true);
  });
});
