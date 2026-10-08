/**
 * PR 3 analytics foundation against Postgres: the shared counting rule, the
 * "Other" series' distinct people, custom ranges, weekly/monthly buckets,
 * period comparison, single-number results, one retention rule for the
 * Retention report and Activation, and the Activation rebuild on a timezone change.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { withSystem } from "@/lib/db";
import { updateAppLocale } from "@/modules/apps/service";
import { eventTrend, funnel, kpi, retention, topEvents } from "@/modules/analytics/service";
import { revenueReport } from "@/modules/analytics/revenue";
import { localDate } from "@/modules/analytics/range";
import { authenticateIngestionKey } from "@/modules/credentials/service";
import { growthOverview, setGrowthModel } from "@/modules/growth/service";
import { ingest } from "@/modules/ingestion/service";
import { processPendingEvents } from "@/modules/processing/processor";
import { runReprocessJobs } from "@/modules/reprocess/jobs";
import { makeTenant } from "./helpers";

type T = Awaited<ReturnType<typeof makeTenant>>;
let t: T;
let scope: { environmentId: string; timezone: string };

function daysAgo(n: number, hour = 12): string {
  const d = new Date();
  d.setUTCHours(hour, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString();
}
const day = (n: number) => daysAgo(n).slice(0, 10);
const track = (name: string, n: number, o: Record<string, unknown>, hour = 12) => ({ type: "track", event_name: name, event_id: crypto.randomUUID(), timestamp: daysAgo(n, hour), ...o });

beforeAll(async () => {
  t = await makeTenant("foundation");
  scope = { environmentId: t.dev.id, timezone: "UTC" };
  const sdk = (await authenticateIngestionKey(t.sdkKey))!;
  const batch = [
    // Seven countries for one person, so a split by country has an "Other" series.
    ...["SA", "AE", "EG", "KW", "QA", "BH", "OM"].map((c, i) => track("item_viewed", 2, { user_id: "p1", properties: { country: c } }, 8 + i)),
    track("item_viewed", 2, { user_id: "p2", properties: { country: "OM" } }),
    track("item_viewed", 2, { user_id: "p3", properties: { country: "BH" } }),
    // Last period (days 8 to 14 ago) for comparisons.
    track("item_viewed", 10, { user_id: "p1", properties: { country: "SA" } }),
    // Retention: start on day 10, come back on day 9 (day 1) and day 3 (day 7).
    track("signed_up", 10, { user_id: "r1" }),
    track("app_opened", 9, { user_id: "r1" }),
    track("app_opened", 3, { user_id: "r1" }),
    track("signed_up", 10, { user_id: "r2" }),
    track("app_opened", 8, { user_id: "r2" }), // day 2: not day 1
    // Revenue this period and last period.
    track("purchase_completed", 2, { user_id: "p2", properties: { revenue: 30, currency: "SAR" } }),
    track("purchase_completed", 10, { user_id: "p2", properties: { revenue: 20, currency: "SAR" } }),
    { type: "screen", event_name: "Home", event_id: crypto.randomUUID(), timestamp: daysAgo(2), user_id: "p3" },
  ];
  await ingest(sdk, { batch }, { mode: "batch" });
  await processPendingEvents({ environmentId: t.dev.id, limit: 1000 });
});

describe("one counting rule", () => {
  it("counts processed track events and screen views, never unprocessed or failed events", async () => {
    const sdk = (await authenticateIngestionKey(t.sdkKey))!;
    await ingest(sdk, { batch: [track("late_event", 1, { user_id: "p9" })] }, { mode: "batch" }); // not processed yet
    let names = (await topEvents(t.ctx, { environmentId: t.dev.id, days: 7 })).map((e) => e.name);
    expect(names).toContain("screen_viewed");
    expect(names).not.toContain("late_event");
    await withSystem((db) => db.query("update platform.events set processed_at = now(), processing_error = 'boom' where environment_id = $1 and event_name = 'late_event'", [t.dev.id]));
    names = (await topEvents(t.ctx, { environmentId: t.dev.id, days: 7 })).map((e) => e.name);
    expect(names).not.toContain("late_event");
  });
});

describe("trends", () => {
  it("counts the Other series' people once, not once per value", async () => {
    const trend = await eventTrend(t.ctx, scope, { event: "item_viewed", days: 7, breakdown: "property:country" });
    expect(trend.series).toHaveLength(6);
    const other = trend.series.find((s) => s.key === "Other")!;
    const i = trend.days.indexOf(day(2));
    // The 5 kept values are BH and OM (two people each) plus three of p1's; Other holds p1's last two countries.
    expect(other.total).toBe(2);
    expect(other.people[i]).toBe(1);
    expect(trend.total).toEqual({ count: 9, people: 3 });
  });

  it("buckets by week and month, and covers a custom range only", async () => {
    const custom = { from: day(12), to: day(5) };
    const daily = await eventTrend(t.ctx, scope, { event: "item_viewed", ...custom });
    expect(daily.range).toMatchObject({ from: day(12), to: day(5), preset: null });
    expect(daily.days[0]).toBe(day(12));
    expect(daily.days.at(-1)).toBe(day(5));
    expect(daily.total.count).toBe(1); // only day 10's event
    const weekly = await eventTrend(t.ctx, scope, { event: "item_viewed", days: 30, interval: "week" });
    expect(weekly.interval).toBe("week");
    expect(weekly.days.every((d) => new Date(`${d}T00:00:00Z`).getUTCDay() === 1)).toBe(true);
    expect(weekly.series[0].counts.reduce((a, b) => a + b, 0)).toBe(10);
    const monthly = await eventTrend(t.ctx, scope, { event: "item_viewed", days: 90, interval: "month" });
    expect(monthly.days.every((d) => d.endsWith("-01"))).toBe(true);
  });

  it("compares with the previous period", async () => {
    const trend = await eventTrend(t.ctx, scope, { event: "item_viewed", days: 7, compare: true });
    expect(trend.total.count).toBe(9);
    expect(trend.previous).toEqual({ count: 1, people: 1 });
    expect(trend.range.previous).not.toBeNull();
    expect((await eventTrend(t.ctx, scope, { event: "item_viewed", days: 7 })).previous).toBeNull();
  });
});

describe("single-number results", () => {
  it("gives event counts, people and active people with the change from last period", async () => {
    expect(await kpi(t.ctx, scope, { metric: "events", event: "item_viewed", days: 7, compare: true })).toMatchObject({ value: 9, previous: 1, change: 8 });
    expect(await kpi(t.ctx, scope, { metric: "people", event: "item_viewed", days: 7 })).toMatchObject({ value: 3, previous: null, change: null });
    const active = await kpi(t.ctx, scope, { metric: "active_people", days: 7 });
    expect(active.value).toBe(4); // p1, p2, p3 (a screen view counts as activity) and r1 (opened 3 days ago)
    await expect(kpi(t.ctx, scope, { metric: "events", days: 7 })).rejects.toThrow(/event/);
    await expect(kpi({ ...t.ctx, role: "viewer" }, scope, { metric: "active_people", days: 7 })).resolves.toBeDefined();
  });
});

describe("comparison on funnels, retention and revenue", () => {
  it("funnels report the previous period's entries and conversions", async () => {
    const f = await funnel(t.ctx, scope, { steps: ["signed_up", "app_opened"], windowDays: 7, days: 7, compare: true });
    expect(f.steps[0].people).toBe(0);
    expect(f.previous).toEqual({ entered: 2, converted: 2 });
  });

  it("revenue reports the previous period's net per currency", async () => {
    const r = await revenueReport(t.ctx, scope, { days: 7, compare: true, interval: "week" });
    expect(r.currencies.find((c) => c.currency === "SAR")?.net).toBe(30);
    expect(r.previous).toEqual([{ currency: "SAR", net: 20 }]);
    expect(r.interval).toBe("week");
  });
});

describe("one retention rule", () => {
  it("retains on calendar day N in the report and in Activation alike", async () => {
    const r = await retention(t.ctx, scope, { startEvent: "signed_up", returnEvent: "app_opened", days: 30 });
    const cohort = r.cohorts.find((c) => c.day === day(10))!;
    expect(cohort.size).toBe(2);
    expect(cohort.returned[0]).toBe(1); // day 1: r1 only (r2 came back on day 2)

    // Activation over the same people, with retention by any event.
    await setGrowthModel(t.ctx, t.app.id, true);
    await runReprocessJobs({ deadline: Date.now() + 30_000 });
    const g = await withSystem((db) =>
      db.query<{ person: string; retained_d1_at: Date | null; retained_d7_at: Date | null }>(
        "select person, retained_d1_at, retained_d7_at from platform.growth_state where environment_id = $1 and person in ('r1', 'r2') order by person",
        [t.dev.id],
      ),
    );
    expect(g.map((x) => [x.person, !!x.retained_d1_at, !!x.retained_d7_at])).toEqual([["r1", true, true], ["r2", false, false]]);
    const o = await growthOverview(t.ctx, t.app.id, t.dev.id);
    const d1 = o.summary!.retention.find((x) => x.day === 1)!;
    expect(d1.retained).toBeGreaterThanOrEqual(1);
  });

  it("rebuilds Activation when the app's timezone changes", async () => {
    await runReprocessJobs({ deadline: Date.now() + 30_000 });
    await updateAppLocale(t.ctx, t.app.id, { timezone: "Asia/Dubai", defaultCurrency: "SAR" });
    const jobs = await withSystem((db) =>
      db.query<{ status: string; reason: string }>("select status, reason from platform.app_reprocess_jobs where app_id = $1 and kind = 'growth_rebuild' and status = 'queued'", [t.app.id]),
    );
    expect(jobs.length).toBeGreaterThan(0);
    expect(jobs[0].reason).toMatch(/timezone/);
    expect(localDate(new Date(), "Asia/Dubai")).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
