import { describe, expect, it } from "vitest";
import { CSV_COLUMNS, csvCell, diffPlans, planToCsv, planToJson, PLAN_EXPORT_FORMAT, type PlanSnapshot, type SnapshotEvent } from "./diff";
import { checkEventName, checkProperties, checkPropertyName, displayName } from "./plan-input";

const ev = (name: string, o: Partial<SnapshotEvent> = {}): SnapshotEvent => ({
  event_name: name, display_name: displayName(name), description: "", category: "custom", trigger: "", source: "mobile_sdk", priority: "medium",
  required: false, custom: false, activation_relevance: false, conversion_relevance: false, revenue_relevance: false, attribution_relevance: false,
  automation_relevance: false, platforms: ["android", "ios"], reason: "", properties: [], ...o,
});
const prop = (name: string, type = "string", required = false) => ({ name, type, required, description: "", example: null, allowed_values: null });

const snap = (id: string, version: number, events: SnapshotEvent[], o: Partial<PlanSnapshot> = {}): PlanSnapshot => ({
  version: { id, version, status: "draft", generator: "rules@1", business_model: "delivery", activation_event: "order_completed", north_star_event: "order_completed", created_at: new Date("2026-10-01T00:00:00Z"), approved_at: null, published_at: null },
  events,
  user_properties: [{ name: "city", type: "string", description: "", source: "mobile_sdk", reason: "" }],
  attribution_rules: [],
  ...o,
});

describe("diffPlans", () => {
  const a = snap("a", 1, [
    ev("app_opened"),
    ev("order_completed", { required: true, properties: [prop("revenue", "number", true), prop("currency", "currency", true), prop("coupon_code")] }),
    ev("review_submitted"),
  ]);
  const b = snap("b", 2, [
    ev("order_completed", { required: true, priority: "critical", properties: [prop("revenue", "number", true), prop("currency", "currency", false), prop("payment_method")] }),
    ev("app_opened", { platforms: ["ios", "android"] }), // same platforms, different order: not a change
    ev("gift_card_redeemed", { custom: true }),
  ], { user_properties: [{ name: "city", type: "string", description: "Home city", source: "mobile_sdk", reason: "" }, { name: "loyalty_tier", type: "string", description: "", source: "backend", reason: "" }] });

  it("lists added, removed and changed events and properties", () => {
    const d = diffPlans(a, b);
    expect(d.from).toEqual({ id: "a", version: 1 });
    expect(d.to).toEqual({ id: "b", version: 2 });
    expect(d.events.added.map((e) => e.event_name)).toEqual(["gift_card_redeemed"]);
    expect(d.events.removed.map((e) => e.event_name)).toEqual(["review_submitted"]);
    expect(d.events.changed).toHaveLength(1);
    const c = d.events.changed[0];
    expect(c.event_name).toBe("order_completed");
    expect(c.changes).toEqual([{ field: "priority", from: "medium", to: "critical" }]);
    expect(c.properties.added.map((p) => p.name)).toEqual(["payment_method"]);
    expect(c.properties.removed.map((p) => p.name)).toEqual(["coupon_code"]);
    expect(c.properties.changed).toEqual([{ name: "currency", changes: [{ field: "required", from: true, to: false }] }]);
    expect(d.user_properties.added.map((u) => u.name)).toEqual(["loyalty_tier"]);
    expect(d.user_properties.changed).toEqual([{ name: "city", changes: [{ field: "description", from: "", to: "Home city" }] }]);
    expect(d.count).toBe(1 + 1 + 1 + 1 + 1 + 1 + 1 + 1); // added, removed, priority, +prop, -prop, ~prop, +user prop, ~user prop
  });

  it("is empty for identical plans and mirrors when reversed", () => {
    expect(diffPlans(a, a).count).toBe(0);
    const r = diffPlans(b, a);
    expect(r.events.added.map((e) => e.event_name)).toEqual(["review_submitted"]);
    expect(r.events.removed.map((e) => e.event_name)).toEqual(["gift_card_redeemed"]);
    expect(r.events.changed[0].properties.added.map((p) => p.name)).toEqual(["coupon_code"]);
  });

  it("reports plan-level changes", () => {
    const d = diffPlans(a, { ...a, version: { ...a.version, id: "c", activation_event: "signup_completed" } });
    expect(d.plan).toEqual([{ field: "activation_event", from: "order_completed", to: "signup_completed" }]);
    expect(d.count).toBe(1);
  });
});

describe("export", () => {
  const s = snap("v-1", 3, [ev("order_completed", { required: true, description: "Order paid, \"confirmed\"", properties: [prop("revenue", "number", true), { ...prop("payment_method"), allowed_values: ["card", "cash"] }] }), ev("note_added", { description: "=HYPERLINK(\"http://x\")" })]);

  it("JSON is self-describing", () => {
    const j = planToJson(s, { id: "app-1", name: "Shop" });
    expect(j.format).toBe(PLAN_EXPORT_FORMAT);
    expect(j.version).toBe(3);
    expect(j.app).toEqual({ id: "app-1", name: "Shop" });
    expect(j.events[0]).toMatchObject({ event_name: "order_completed", required: true, relevance: { revenue: false } });
    expect(j.events[0].properties[1]).toEqual({ name: "payment_method", type: "string", required: false, description: "", allowed_values: ["card", "cash"], example: null });
    expect(j.created_at).toBe("2026-10-01T00:00:00.000Z");
    expect(JSON.parse(JSON.stringify(j))).toEqual(j);
  });

  it("CSV has one row per event, event property and user property", () => {
    const lines = planToCsv(s).trimEnd().split("\r\n");
    expect(lines[0]).toBe(CSV_COLUMNS.join(","));
    expect(lines).toHaveLength(1 + 2 + 2 + 1);
    expect(lines[1]).toBe('event,order_completed,Order Completed,custom,mobile_sdk,medium,true,false,,,,,,"Order paid, ""confirmed""",');
    expect(lines[3]).toBe("event_property,order_completed,,,,,,,payment_method,string,false,card|cash,,,");
    expect(lines[5]).toBe("user_property,,,,mobile_sdk,,,,city,string,,,,,");
  });

  it("neutralizes spreadsheet formulas", () => {
    expect(csvCell("=1+1")).toBe("'=1+1");
    expect(csvCell("@cmd")).toBe("'@cmd");
    expect(csvCell("-5")).toBe("-5");
    expect(csvCell('=HYPERLINK("x")')).toBe('"\'=HYPERLINK(""x"")"');
    expect(planToCsv(s)).not.toMatch(/,=HYPERLINK/);
  });
});

describe("plan input rules", () => {
  it("accepts catalog-style names and advises on style", () => {
    expect(checkEventName("gift_card_redeemed").warnings).toEqual([]);
    expect(checkEventName("checkout").warnings[0]).toMatch(/object_action/);
    expect(checkEventName("gift_card_redeem").warnings[0]).toMatch(/past tense/);
    expect(checkEventName("order_complete").similar).toBe("order_completed");
  });

  it("rejects names the plan can't hold", () => {
    expect(() => checkEventName("OrderCompleted")).toThrow(/snake_case/);
    expect(() => checkEventName("order completed")).toThrow(/snake_case/);
    expect(() => checkEventName("x")).toThrow(/snake_case/);
    expect(() => checkEventName("user_identified")).toThrow(/SDK/);
    expect(() => checkEventName("order__done")).toThrow(/double/);
    expect(() => checkPropertyName("user_id", "event")).toThrow(/top-level/);
    expect(() => checkPropertyName("Revenue", "event")).toThrow(/snake_case/);
    expect(() => checkPropertyName("cart_value", "user")).toThrow(/action/);
    expect(() => checkProperties([prop("a") as never, prop("a") as never])).toThrow(/twice/);
    expect(() => checkProperties([{ name: "n", type: "number", required: false, description: "", allowed_values: ["1"] }])).toThrow(/string/);
  });
});
