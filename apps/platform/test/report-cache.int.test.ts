/**
 * PR 6: short-lived report result cache. Results are reused for minutes,
 * keyed by everything they depend on, never shared across organizations,
 * and never stand in for Postgres (fresh=1 and expiry recompute).
 */
import { beforeAll, describe, expect, it } from "vitest";
import { withSystem } from "@/lib/db";
import { cachedReport, cacheKey, stableJson } from "@/modules/analytics/cache";
import { eventTrend } from "@/modules/analytics/service";
import { createAudience, updateAudience } from "@/modules/audiences/service";
import { authenticateIngestionKey } from "@/modules/credentials/service";
import { ingest } from "@/modules/ingestion/service";
import { purgeOperationalData } from "@/modules/maintenance/retention";
import { processPendingEvents } from "@/modules/processing/processor";
import { makeTenant } from "./helpers";

type T = Awaited<ReturnType<typeof makeTenant>>;
let A: T;
let B: T;
let scope: { environmentId: string; timezone: string };

const track = (user: string) => ({ type: "track", event_name: "order_completed", event_id: crypto.randomUUID(), timestamp: new Date(Date.now() - 3600_000).toISOString(), user_id: user });
async function send(t: T, users: string[]) {
  const sdk = (await authenticateIngestionKey(t.sdkKey))!;
  await ingest(sdk, { batch: users.map(track) }, { mode: "batch" });
  await processPendingEvents({ environmentId: t.dev.id, limit: 100 });
}

beforeAll(async () => {
  A = await makeTenant("cache");
  B = await makeTenant("cache-b");
  scope = { environmentId: A.dev.id, timezone: "UTC" };
  await send(A, ["u1", "u2"]);
});

function counter<V>(value: V) {
  const c = { calls: 0, fn: async () => (c.calls++, value) };
  return c;
}

describe("keys", () => {
  it("ignore key order and undefined values, and change with any input", () => {
    expect(stableJson({ b: 1, a: [1, undefined], c: undefined })).toBe('{"a":[1,null],"b":1}');
    const base = { environmentId: "e", timezone: "UTC", kind: "trend" as const, input: { event: "x", days: 7 }, audienceVersion: null };
    expect(cacheKey(base)).toBe(cacheKey({ ...base, input: { days: 7, event: "x", cohortId: undefined } }));
    for (const change of [{ environmentId: "f" }, { timezone: "Asia/Riyadh" }, { kind: "funnel" as const }, { input: { event: "x", days: 30 } }, { input: { event: "x", days: 7, compare: true } }, { audienceVersion: "v2" }]) {
      expect(cacheKey({ ...base, ...change })).not.toBe(cacheKey(base));
    }
  });
});

describe("cachedReport", () => {
  it("reuses a result until it is refreshed or expires", async () => {
    const c = counter({ n: 1 });
    const first = await cachedReport(A.ctx, scope, "kpi", { metric: "events", days: 7 }, c.fn);
    expect(first).toMatchObject({ value: { n: 1 }, fromCache: false });
    const second = await cachedReport(A.ctx, scope, "kpi", { days: 7, metric: "events" }, c.fn);
    expect(second).toMatchObject({ value: { n: 1 }, fromCache: true });
    expect(second.computedAt).toBeInstanceOf(Date);
    expect(c.calls).toBe(1);

    expect((await cachedReport(A.ctx, scope, "kpi", { metric: "events", days: 7 }, c.fn, { fresh: true })).fromCache).toBe(false);
    expect(c.calls).toBe(2);

    await withSystem((db) => db.query("update platform.report_cache set expires_at = now() - interval '1 second' where environment_id = $1", [A.dev.id]));
    expect((await cachedReport(A.ctx, scope, "kpi", { metric: "events", days: 7 }, c.fn)).fromCache).toBe(false);
    expect(c.calls).toBe(3);
  });

  it("keeps the TTL between 1 and 15 minutes", async () => {
    await cachedReport(A.ctx, scope, "kpi", { metric: "people", days: 7 }, async () => 1, { ttlSeconds: 99_999 });
    const row = await withSystem((db) => db.one<{ s: number }>("select extract(epoch from expires_at - created_at)::int as s from platform.report_cache where environment_id = $1 and kind = 'kpi' order by created_at desc limit 1", [A.dev.id]));
    expect(row!.s).toBeLessThanOrEqual(900);
  });

  it("serves a real report from the cache, and Postgres again after a refresh", async () => {
    const input = { event: "order_completed", days: 7 };
    const run = (fresh?: boolean) => cachedReport(A.ctx, scope, "trend", input, () => eventTrend(A.ctx, scope, input), { fresh });
    expect((await run()).value.total).toEqual({ count: 2, people: 2 });
    await send(A, ["u3"]);
    const cached = await run();
    expect(cached.fromCache).toBe(true);
    expect(cached.value.total).toEqual({ count: 2, people: 2 }); // reused, at most TTL old
    expect((await run(true)).value.total).toEqual({ count: 3, people: 3 });
  });

  it("recomputes when the audience filter changes", async () => {
    const id = (await createAudience(A.ctx, A.dev.id, { name: "Buyers", definition: { type: "event", event: "order_completed" } })).id;
    const c = counter(1);
    await cachedReport(A.ctx, scope, "trend", { event: "order_completed", cohortId: id }, c.fn);
    await cachedReport(A.ctx, scope, "trend", { event: "order_completed", cohortId: id }, c.fn);
    expect(c.calls).toBe(1);
    await updateAudience(A.ctx, id, { name: "Buyers", definition: { type: "event", event: "order_completed", count: 2 } });
    await cachedReport(A.ctx, scope, "trend", { event: "order_completed", cohortId: id }, c.fn);
    expect(c.calls).toBe(2);
  });

  it("never shares results across organizations", async () => {
    const secret = await cachedReport(A.ctx, scope, "revenue", { days: 30 }, async () => ({ secret: true }));
    expect(secret.fromCache).toBe(false);
    // B asks for the same key in A's environment: it can't read A's row, and can't write one there.
    const c = counter({ secret: false });
    const b = await cachedReport(B.ctx, scope, "revenue", { days: 30 }, c.fn);
    expect(b).toMatchObject({ value: { secret: false }, fromCache: false });
    const rows = await withSystem((db) => db.query<{ organization_id: string }>("select organization_id from platform.report_cache where environment_id = $1", [A.dev.id]));
    expect(rows.every((r) => r.organization_id === A.org.id)).toBe(true);
  });

  it("is purged by the scheduled cleanup once expired", async () => {
    await withSystem((db) => db.query("update platform.report_cache set expires_at = now() - interval '1 second' where environment_id = $1", [A.dev.id]));
    const r = await purgeOperationalData();
    expect(r.report_cache).toBeGreaterThanOrEqual(1);
    const left = await withSystem((db) => db.query("select 1 from platform.report_cache where environment_id = $1", [A.dev.id]));
    expect(left).toEqual([]);
  });
});
