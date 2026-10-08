/**
 * PR 4: one property catalog (observed data + tracking plan + descriptions)
 * behind Attributes, Users filters and columns, Audience suggestions and
 * Analytics filters and breakdowns.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { withSystem } from "@/lib/db";
import { searchPeople } from "@/modules/analytics/profiles";
import { eventFiltersFromParams, inputFromParams, paramsFromConfig } from "@/modules/analytics/report-params";
import { reportConfig } from "@/modules/analytics/saved-reports";
import { eventTrend, kpi } from "@/modules/analytics/service";
import { authenticateIngestionKey } from "@/modules/credentials/service";
import { addPlanEvent, setPlanUserProperty } from "@/modules/implementation/editor";
import { ingest } from "@/modules/ingestion/service";
import { processPendingEvents } from "@/modules/processing/processor";
import { describeProperty, options, propertyCatalog } from "@/modules/properties/catalog";
import { filterFromParts, filtersFromSearch } from "@/modules/properties/filters";
import { makeTenant } from "./helpers";

type T = Awaited<ReturnType<typeof makeTenant>>;
let t: T;
let scope: { environmentId: string; timezone: string };

function daysAgo(n: number): string {
  const d = new Date();
  d.setUTCHours(12, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString();
}
const id = () => crypto.randomUUID();
const identify = (user: string, traits: Record<string, unknown>) => ({ type: "identify", event_id: id(), timestamp: daysAgo(3), anonymous_id: `a-${user}`, user_id: user, user_properties: traits });
const track = (name: string, user: string, properties: Record<string, unknown>, ctx: Record<string, unknown> = {}) => ({ type: "track", event_name: name, event_id: id(), timestamp: daysAgo(2), user_id: user, properties, context: ctx });

beforeAll(async () => {
  t = await makeTenant("catalog");
  scope = { environmentId: t.dev.id, timezone: "UTC" };
  const me = { kind: "user" as const, ctx: t.ctx };
  // The plan knows `plan` (user) and `amount` on purchase_completed, typed differently from the data.
  await setPlanUserProperty(me, t.app.id, { name: "plan", type: "string", description: "Subscription tier." });
  await setPlanUserProperty(me, t.app.id, { name: "loyalty_tier", type: "string", description: "Not sent yet." });
  await addPlanEvent(me, t.app.id, { event_name: "purchase_completed", properties: [{ name: "amount", type: "string", description: "Paid amount." }] });

  const sdk = (await authenticateIngestionKey(t.sdkKey))!;
  const batch = [
    identify("u1", { plan: "gold", city: "Riyadh", age: 31 }),
    identify("u2", { plan: "silver", city: "Jeddah", age: 25 }),
    identify("u3", { plan: "gold", city: "Riyadh" }),
    track("purchase_completed", "u1", { amount: 120, method: "card" }, { platform: "ios" }),
    track("purchase_completed", "u2", { amount: 40, method: "cash" }, { platform: "android" }),
    track("purchase_completed", "u3", { amount: 300, method: "card" }, { platform: "ios" }),
    track("item_viewed", "u1", { category: "shoes" }),
  ];
  await ingest(sdk, { batch }, { mode: "batch" });
  await processPendingEvents({ environmentId: t.dev.id, limit: 100 });
});

describe("the catalog", () => {
  it("merges observed user properties, their values and the tracking plan", async () => {
    const c = await propertyCatalog(t.ctx, { appId: t.app.id, environmentId: t.dev.id }, "implementation.read");
    const plan = c.user.find((p) => p.name === "plan")!;
    expect(plan).toMatchObject({ type: "string", seen: 3, description: "Subscription tier.", descriptionFrom: "plan", typeMismatch: false });
    expect(plan.values).toEqual([{ value: "gold", count: 2 }, { value: "silver", count: 1 }]);
    expect(plan.plan).not.toBeNull();
    const age = c.user.find((p) => p.name === "age")!;
    expect(age).toMatchObject({ type: "number", seen: 2, plan: null });
    // In the plan but not sent yet.
    expect(c.user.find((p) => p.name === "loyalty_tier")).toMatchObject({ seen: 0, values: [] });
    expect(c.sample.users).toBe(3);
  });

  it("lists event properties with their events, built-in attributes, and plan type mismatches", async () => {
    const c = await propertyCatalog(t.ctx, { appId: t.app.id, environmentId: t.dev.id }, "analytics.read", { only: "event" });
    expect(c.user).toEqual([]);
    const amount = c.event.find((p) => p.name === "amount")!;
    expect(amount).toMatchObject({ type: "string", observedTypes: ["number"], typeMismatch: true, seen: 3, events: ["purchase_completed"] });
    expect(amount.plan?.events).toEqual(["purchase_completed"]);
    expect(c.event.find((p) => p.name === "category")?.events).toEqual(["item_viewed"]);
    const platform = c.event.find((p) => p.name === "platform")!;
    expect(platform.builtIn).toBe(true);
    expect(platform.values.map((v) => v.value)).toEqual(["ios", "android"]);
    // Pickers skip built-ins (they have their own split options) unless asked.
    expect(options(c.event).some((o) => o.name === "platform")).toBe(false);
    expect(options(c.event).find((o) => o.name === "method")).toMatchObject({ values: ["card", "cash"], events: ["purchase_completed"] });
  });

  it("keeps descriptions people write, per project, with an audit entry", async () => {
    await describeProperty(t.ctx, t.app.id, { scope: "user", name: "city", description: "City from the profile." });
    await describeProperty(t.ctx, t.app.id, { scope: "user", name: "plan", description: "Billing tier (overrides the plan text)." });
    const c = await propertyCatalog(t.ctx, { appId: t.app.id, environmentId: t.dev.id }, "implementation.read");
    expect(c.user.find((p) => p.name === "city")).toMatchObject({ description: "City from the profile.", descriptionFrom: "custom" });
    expect(c.user.find((p) => p.name === "plan")).toMatchObject({ description: "Billing tier (overrides the plan text).", descriptionFrom: "custom" });
    // The production environment shares the description but has no data.
    const prod = t.environments.find((e) => e.type === "production")!;
    const pc = await propertyCatalog(t.ctx, { appId: t.app.id, environmentId: prod.id }, "implementation.read");
    expect(pc.user.find((p) => p.name === "city")).toMatchObject({ seen: 0, description: "City from the profile." });
    // Clearing falls back to the plan's text.
    await describeProperty(t.ctx, t.app.id, { scope: "user", name: "plan", description: "" });
    const again = await propertyCatalog(t.ctx, { appId: t.app.id, environmentId: t.dev.id }, "implementation.read", { only: "user" });
    expect(again.user.find((p) => p.name === "plan")?.descriptionFrom).toBe("plan");
    const log = await withSystem((db) => db.query<{ action: string }>("select action from platform.audit_logs where organization_id = $1 and action = 'property.described'", [t.org.id]));
    expect(log).toHaveLength(3);
    await expect(describeProperty({ ...t.ctx, role: "analyst" }, t.app.id, { scope: "user", name: "city", description: "x" })).rejects.toThrow();
    await expect(describeProperty(t.ctx, t.app.id, { scope: "user", name: "bad name!", description: "x" })).rejects.toThrow(/property name/);
  });

  it("follows each surface's permission and stays inside the workspace", async () => {
    await expect(propertyCatalog({ ...t.ctx, role: "viewer" }, { appId: t.app.id, environmentId: t.dev.id }, "users.read", { only: "user" })).resolves.toBeDefined();
    await expect(propertyCatalog({ ...t.ctx, role: "viewer" }, { appId: t.app.id, environmentId: t.dev.id }, "implementation.read")).rejects.toThrow();
    const other = await makeTenant("catalog-other");
    await expect(propertyCatalog(other.ctx, { appId: t.app.id, environmentId: t.dev.id }, "implementation.read")).rejects.toThrow(/not found/i);
  });
});

describe("users filtered by catalog properties", () => {
  it("filters with the audience operators and returns chosen columns", async () => {
    const gold = await searchPeople(t.ctx, t.dev.id, "", { filters: [filterFromParts("plan", "eq", "gold")!], columns: ["city", "plan"] });
    expect(gold.users.map((u) => u.userId).sort()).toEqual(["u1", "u3"]);
    expect(gold.users.find((u) => u.userId === "u1")?.properties).toEqual({ city: "Riyadh", plan: "gold" });
    const older = await searchPeople(t.ctx, t.dev.id, "", { filters: [filterFromParts("age", "gt", "26")!] });
    expect(older.users.map((u) => u.userId)).toEqual(["u1"]);
    const both = await searchPeople(t.ctx, t.dev.id, "u", { filters: [filterFromParts("city", "eq", "Riyadh")!, filterFromParts("age", "not_exists", "")!] });
    expect(both.users.map((u) => u.userId)).toEqual(["u3"]);
    expect(both.installs).toEqual([]);
    const oneOf = await searchPeople(t.ctx, t.dev.id, "", { filters: [filterFromParts("city", "in", "Jeddah, Dammam")!] });
    expect(oneOf.users.map((u) => u.userId)).toEqual(["u2"]);
  });

  it("reads filters from the form, dropping empty or invalid rows", () => {
    const { filters, parts } = filtersFromSearch({ fp: ["plan", "", "age"], fo: ["eq", "", "gt"], fv: ["gold", "", "abc"] }, "f", 3);
    expect(filters).toEqual([{ property: "plan", op: "eq", value: "gold" }]); // "abc" isn't a number
    expect(parts.map((p) => p.property)).toEqual(["plan", "age"]);
    expect(filterFromParts("x'); drop", "eq", "1")).toBeNull();
  });
});

describe("analytics filters and breakdowns", () => {
  it("filters a trend and its totals by an event property, and saves the filter with the report", async () => {
    const sp = new URLSearchParams([["event", "purchase_completed"], ["days", "7"], ["fp", "method"], ["fo", "eq"], ["fv", "card"]]);
    const input = inputFromParams("trend", sp);
    const trend = await eventTrend(t.ctx, scope, input);
    expect(trend.total).toEqual({ count: 2, people: 2 });
    expect(trend.where).toEqual([{ property: "method", op: "eq", value: "card" }]);
    const big = await kpi(t.ctx, scope, { metric: "events", event: "purchase_completed", days: 7, where: [filterFromParts("amount", "gte", "100")!] });
    expect(big.value).toBe(2);
    const { config } = reportConfig("trend", input);
    expect(config.where).toEqual([{ property: "method", op: "eq", value: "card" }]);
    expect(paramsFromConfig("trend", config).getAll("fp")).toEqual(["method"]);
    expect(eventFiltersFromParams(paramsFromConfig("trend", config)).filters).toEqual(config.where);
    // A report without filters saves exactly what it did before.
    expect(reportConfig("trend", inputFromParams("trend", new URLSearchParams([["event", "purchase_completed"], ["days", "7"]]))).config).toEqual({ event: "purchase_completed", days: 7 });
  });

  it("splits by a catalog property", async () => {
    const trend = await eventTrend(t.ctx, scope, { event: "purchase_completed", days: 7, breakdown: "property:method" });
    expect(trend.series.map((s) => [s.key, s.total]).sort()).toEqual([["card", 2], ["cash", 1]]);
  });
});
