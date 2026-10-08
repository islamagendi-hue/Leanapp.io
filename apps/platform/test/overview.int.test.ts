/**
 * PR 8: the numbers behind the project Overview. "Any event" trends, KPIs
 * and retention, and new people, all from the shared analytics rules.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { ANY_EVENT, eventTrend, kpi, retention } from "@/modules/analytics/service";
import { createAudience } from "@/modules/audiences/service";
import { authenticateIngestionKey } from "@/modules/credentials/service";
import { ingest } from "@/modules/ingestion/service";
import { processPendingEvents } from "@/modules/processing/processor";
import { makeTenant } from "./helpers";

type T = Awaited<ReturnType<typeof makeTenant>>;
let A: T;
let scope: { environmentId: string; timezone: string };

function daysAgo(n: number): string {
  const d = new Date();
  d.setUTCHours(12, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString();
}
const ev = (name: string, n: number, who: Record<string, string>) => ({ type: "track", event_name: name, event_id: crypto.randomUUID(), timestamp: daysAgo(n), ...who });

beforeAll(async () => {
  A = await makeTenant("overview");
  scope = { environmentId: A.dev.id, timezone: "UTC" };
  const sdk = (await authenticateIngestionKey(A.sdkKey))!;
  await ingest(sdk, {
    batch: [
      // u1: first seen 20 days ago, back yesterday (and the day after starting).
      ev("app_opened", 20, { user_id: "u1" }), ev("app_opened", 19, { user_id: "u1" }), ev("order_completed", 1, { user_id: "u1" }),
      // u2: new 3 days ago, came back the next day.
      ev("app_opened", 3, { user_id: "u2" }), ev("app_opened", 2, { user_id: "u2" }),
      // An anonymous install, new yesterday.
      ev("app_opened", 1, { anonymous_id: "a3" }),
    ],
  }, { mode: "batch" });
  await processPendingEvents({ environmentId: A.dev.id, limit: 100 });
});

describe("overview numbers", () => {
  it("counts active, new and all events with the change from the previous period", async () => {
    const active = await kpi(A.ctx, scope, { metric: "active_people", days: 7, compare: true });
    expect([active.value, active.previous]).toEqual([3, 0]);
    const fresh = await kpi(A.ctx, scope, { metric: "new_people", days: 7, compare: true });
    expect([fresh.value, fresh.previous]).toEqual([2, 0]); // u2 and the install; u1 is older
    expect((await kpi(A.ctx, scope, { metric: "new_people", days: 30 })).value).toBe(3);
    const all = await kpi(A.ctx, scope, { metric: "all_events", days: 7 });
    expect(all.value).toBe(4);
    await expect(kpi(A.ctx, scope, { metric: "events" })).rejects.toThrow(/Choose an event/);
  });

  it("narrows new people to an audience", async () => {
    const orders = (await createAudience(A.ctx, A.dev.id, { name: "Ordered", definition: { type: "event", event: "order_completed" } })).id;
    expect((await kpi(A.ctx, scope, { metric: "new_people", days: 30, cohortId: orders })).value).toBe(1);
    expect((await kpi(A.ctx, scope, { metric: "new_people", days: 7, cohortId: orders })).value).toBe(0);
  });

  it("trends active people per day across any event", async () => {
    const t = await eventTrend(A.ctx, scope, { event: ANY_EVENT, days: 7, interval: "day" });
    expect(t.total).toEqual({ count: 4, people: 3 });
    const yesterday = daysAgo(1).slice(0, 10);
    expect(t.series[0].people[t.days.indexOf(yesterday)]).toBe(2); // u1 and the install
  });

  it("measures retention over any event by the shared calendar-day rule", async () => {
    const r = await retention(A.ctx, scope, { startEvent: ANY_EVENT, returnEvent: ANY_EVENT, days: 30 });
    expect(r.people).toBe(3);
    // D1: u1 (day 20 → 19) and u2 (day 3 → 2) came back; the install's day 1 is today, not over yet.
    expect(r.overall[0]).toBe(1);
  });
});
