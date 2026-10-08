/**
 * Analytics v1 against Postgres: event totals and trends, ordered funnels with
 * conversion windows, N-day retention, identity stitching and canonical names.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { withSystem } from "@/lib/db";
import { dayList, eventTrend, funnel, retention, topEvents } from "@/modules/analytics/service";
import { authenticateIngestionKey, listKeys } from "@/modules/credentials/service";
import { ingest } from "@/modules/ingestion/service";
import { processPendingEvents } from "@/modules/processing/processor";
import { makeTenant } from "./helpers";

type T = Awaited<ReturnType<typeof makeTenant>>;
let t: T;
let scope: { environmentId: string; timezone: string };

/** Noon UTC, n days ago (n >= 1 keeps every event in the past). */
function daysAgo(n: number, hour = 12): string {
  const d = new Date();
  d.setUTCHours(hour, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString();
}
const day = (n: number) => daysAgo(n).slice(0, 10);

const track = (name: string, n: number, o: Record<string, unknown>, hour = 12) => ({
  type: "track", event_name: name, event_id: crypto.randomUUID(), timestamp: daysAgo(n, hour), ...o,
});

beforeAll(async () => {
  t = await makeTenant("analytics");
  scope = { environmentId: t.dev.id, timezone: "UTC" };
  const sdk = (await authenticateIngestionKey(t.sdkKey))!;
  const ios = { platform: "ios" };
  const android = { platform: "android" };
  const batch = [
    // u1: installs anonymously, signs up, buys twice. Anonymous install is stitched to u1.
    track("app_installed", 6, { anonymous_id: "a1", context: ios }),
    { type: "identify", event_id: crypto.randomUUID(), timestamp: daysAgo(6, 13), anonymous_id: "a1", user_id: "u1", context: ios },
    track("sign_up_completed", 6, { anonymous_id: "a1", user_id: "u1", context: ios }, 14),
    track("purchase", 5, { anonymous_id: "a1", user_id: "u1", properties: { plan: "gold" }, context: ios }),
    track("order_done", 3, { anonymous_id: "a1", user_id: "u1", context: ios }), // mapped to purchase below
    // u2: installs, signs up 3 days later (outside a 1-day window), never buys.
    track("app_installed", 6, { anonymous_id: "a2", context: android }),
    { type: "identify", event_id: crypto.randomUUID(), timestamp: daysAgo(3, 11), anonymous_id: "a2", user_id: "u2", context: android },
    track("sign_up_completed", 3, { anonymous_id: "a2", user_id: "u2", context: android }),
    // a3: installs only.
    track("app_installed", 1, { anonymous_id: "a3", context: android }),
    // A shared tablet linked to two users: its anonymous events stay one anonymous person.
    { type: "identify", event_id: crypto.randomUUID(), timestamp: daysAgo(2, 10), anonymous_id: "a4", user_id: "u3" },
    { type: "identify", event_id: crypto.randomUUID(), timestamp: daysAgo(2, 11), anonymous_id: "a4", user_id: "u4" },
    track("app_opened", 2, { anonymous_id: "a4" }),
    // A screen view counts as screen_viewed (the shared counting rule); identify calls never count.
    { type: "screen", event_name: "Home", event_id: crypto.randomUUID(), timestamp: daysAgo(2), anonymous_id: "a1", user_id: "u1" },
  ];
  const res = await ingest(sdk, { batch }, { mode: "batch" });
  expect((res.body as { accepted: number }).accepted).toBe(batch.length);
  await processPendingEvents({ environmentId: t.dev.id, limit: 100 });
  // An accepted mapping order_done → purchase (normally set by the processor from event_mappings).
  await withSystem((db) => db.query("update platform.events set canonical_name = 'purchase' where environment_id = $1 and event_name = 'order_done'", [t.dev.id]));
});

describe("event totals and trend", () => {
  it("lists events by canonical name with distinct people, stitching installs to users", async () => {
    const events = await topEvents(t.ctx, { environmentId: t.dev.id, days: 30 });
    const byName = Object.fromEntries(events.map((e) => [e.name, e]));
    expect(byName.purchase).toEqual({ name: "purchase", count: 2, people: 1 });
    expect(byName.app_installed).toEqual({ name: "app_installed", count: 3, people: 3 });
    expect(byName.order_done).toBeUndefined();
    expect(byName.Home).toBeUndefined();
    expect(byName.screen_viewed).toEqual({ name: "screen_viewed", count: 1, people: 1 });
    expect(byName.user_identified).toBeUndefined();
    expect(byName.app_opened.people).toBe(1);
  });

  it("returns a daily series over the range, split by platform", async () => {
    const trend = await eventTrend(t.ctx, scope, { event: "app_installed", days: 7, breakdown: "platform" });
    expect(trend.days).toEqual(dayList(7, "UTC"));
    expect(trend.total).toEqual({ count: 3, people: 3 });
    const android = trend.series.find((s) => s.key === "android")!;
    expect(android.total).toBe(2);
    expect(android.counts[trend.days.indexOf(day(6))]).toBe(1);
    expect(android.counts[trend.days.indexOf(day(1))]).toBe(1);
    expect(trend.series.find((s) => s.key === "ios")!.total).toBe(1);

    const byPlan = await eventTrend(t.ctx, scope, { event: "purchase", days: 7, breakdown: "property:plan" });
    expect(byPlan.series.map((s) => [s.key, s.total]).sort()).toEqual([["(none)", 1], ["gold", 1]]);
  });

  it("validates input and needs analytics.read", async () => {
    await expect(eventTrend(t.ctx, scope, { event: "", days: 7 })).rejects.toThrow();
    const odd = await eventTrend(t.ctx, scope, { event: "purchase", days: 12345, breakdown: "property:x'); drop" });
    expect(odd.days).toHaveLength(dayList(30, "UTC").length); // falls back to 30 days, no breakdown
    expect(odd.breakdown).toBeNull();
    await expect(topEvents({ ...t.ctx, role: "marketer" }, { environmentId: t.dev.id, days: 7 })).resolves.toBeDefined();
    await expect(topEvents({ ...t.ctx, role: "owner", organizationId: crypto.randomUUID() }, { environmentId: t.dev.id, days: 7 })).resolves.toEqual([]);
  });
});

describe("funnels", () => {
  it("counts ordered conversions within the window", async () => {
    const f = await funnel(t.ctx, scope, { steps: ["app_installed", "sign_up_completed", "purchase"], windowDays: 7, days: 30 });
    expect(f.steps.map((s) => s.people)).toEqual([3, 2, 1]);
    expect(f.steps[1].fromStart).toBeCloseTo(2 / 3);
    expect(f.steps[2].fromPrevious).toBeCloseTo(1 / 2);
    expect(f.steps[2].medianSeconds).toBe(22 * 3600); // day 6 14:00 → day 5 12:00

    const tight = await funnel(t.ctx, scope, { steps: ["app_installed", "sign_up_completed"], windowDays: 1, days: 30 });
    expect(tight.steps.map((s) => s.people)).toEqual([3, 1]);

    const reversed = await funnel(t.ctx, scope, { steps: ["purchase", "app_installed"], windowDays: 30, days: 30 });
    expect(reversed.steps.map((s) => s.people)).toEqual([1, 0]);
  });

  it("breaks down by platform", async () => {
    const f = await funnel(t.ctx, scope, { steps: ["app_installed", "sign_up_completed"], windowDays: 7, days: 30, breakdown: "platform" });
    expect(f.breakdown).toEqual([
      { key: "android", people: [2, 1] },
      { key: "ios", people: [1, 1] },
    ]);
  });

  it("needs a second event for a repeated step, even at the same timestamp", async () => {
    // A separate environment so these opens don't change the other reports.
    const prod = t.environments.find((e) => e.type === "production")!;
    const keys = await listKeys(t.ctx, t.app.id);
    const sdk = (await authenticateIngestionKey(keys.sdkKeys.find((k) => k.environment_id === prod.id)!.key))!;
    const same = daysAgo(2);
    const batch = [
      track("app_opened", 3, { anonymous_id: "x1" }),
      track("app_opened", 3, { anonymous_id: "x2" }),
      track("app_opened", 2, { anonymous_id: "x2" }),
      { type: "track", event_name: "app_opened", event_id: crypto.randomUUID(), timestamp: same, anonymous_id: "x3" },
      { type: "track", event_name: "app_opened", event_id: crypto.randomUUID(), timestamp: same, anonymous_id: "x3" },
    ];
    await ingest(sdk, { batch }, { mode: "batch" });
    await processPendingEvents({ environmentId: prod.id });
    const f = await funnel(t.ctx, { environmentId: prod.id }, { steps: ["app_opened", "app_opened"], windowDays: 7, days: 30 });
    expect(f.steps.map((s) => s.people)).toEqual([3, 2]);
    const thrice = await funnel(t.ctx, { environmentId: prod.id }, { steps: ["app_opened", "app_opened", "app_opened"], windowDays: 7, days: 30 });
    expect(thrice.steps.map((s) => s.people)).toEqual([3, 2, 0]);
  });

  it("needs two to six steps", async () => {
    await expect(funnel(t.ctx, scope, { steps: ["app_installed"] })).rejects.toThrow(/two steps/);
    await expect(funnel(t.ctx, scope, { steps: Array(7).fill("x") })).rejects.toThrow(/six/);
  });
});

describe("retention", () => {
  it("groups people by their first start day and counts returns on day N", async () => {
    const r = await retention(t.ctx, scope, { startEvent: "app_installed", returnEvent: "purchase", days: 30 });
    expect(r.people).toBe(3);
    const cohort = r.cohorts.find((c) => c.day === day(6))!;
    expect(cohort.size).toBe(2);
    // Days 1, 3, 7, 14, 30: u1 bought on day 1 and day 3; day 7+ hasn't happened for this cohort.
    expect(cohort.returned).toEqual([1, 1, null, null, null]);
    // Yesterday's cohort: day 1 is today, which isn't over yet.
    expect(r.cohorts.find((c) => c.day === day(1))!.returned).toEqual([null, null, null, null, null]);
    expect(r.overall[0]).toBeCloseTo(1 / 2);
    expect(r.overall[1]).toBeCloseTo(1 / 2);
    expect(r.overall[2]).toBeNull();
  });
});
