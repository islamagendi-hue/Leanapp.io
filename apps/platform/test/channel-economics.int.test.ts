/**
 * CAC and LTV by acquisition channel (modules/attribution/economics):
 * new users by first install (CAC), first-time buyers by first purchase ever
 * with revenue inside a window after it (LTV), the cumulative curve over
 * buyers who have had that long, the per-person table, spend per source, the
 * currency rules (no conversion, no LTV:CAC across currencies), permissions
 * and tenant isolation.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { withSystem } from "@/lib/db";
import { ForbiddenError } from "@/lib/errors";
import { channelEconomicsReport } from "@/modules/attribution/economics";
import { saveSpend } from "@/modules/attribution/spend";
import { authenticateIngestionKey } from "@/modules/credentials/service";
import { ingest } from "@/modules/ingestion/service";
import { processPendingEvents } from "@/modules/processing/processor";
import type { TenantContext } from "@/modules/tenancy/context";
import { makeTenant } from "./helpers";

type T = Awaited<ReturnType<typeof makeTenant>>;
let A: T;
let B: T;
let scope: { environmentId: string; timezone: string };

function daysAgo(n: number, hour = 12): string {
  const d = new Date();
  d.setUTCHours(hour, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString();
}
const day = (n: number) => daysAgo(n).slice(0, 10);
const id = () => crypto.randomUUID();
const buy = (n: number, who: Record<string, unknown>, revenue: number, currency: string, tx: string) =>
  ({ type: "track", event_name: "purchase_completed", event_id: id(), timestamp: daysAgo(n), ...who, properties: { revenue, currency, transaction_id: tx } });
const identify = (n: number, anon: string, user: string) => ({ type: "identify", event_id: id(), timestamp: daysAgo(n, 11), anonymous_id: anon, user_id: user });
/** From 22 days ago to today: u6's first purchase (25 days ago) is before it. */
const range = () => ({ from: day(22), to: day(0) });

beforeAll(async () => {
  A = await makeTenant("cac");
  B = await makeTenant("cac-b");
  scope = { environmentId: A.dev.id, timezone: "UTC" };
  const sdk = (await authenticateIngestionKey(A.sdkKey))!;
  const u1 = { anonymous_id: "a1", user_id: "u1" };
  const batch = [
    // u1 (tiktok): 100 SAR first, 50 SAR 3 days later and refunded, 70 SAR 10 days later (after a 7-day window).
    identify(20, "a1", "u1"),
    buy(20, u1, 100, "SAR", "t1"),
    buy(17, u1, 50, "SAR", "t2"),
    { type: "track", event_name: "refund_completed", event_id: id(), timestamp: daysAgo(16), ...u1, properties: { refund_amount: 50, currency: "SAR", transaction_id: "t2" } },
    buy(10, u1, 70, "SAR", "t5"),
    // a2 (tiktok): installed, never paid.
    { type: "track", event_name: "app_opened", event_id: id(), timestamp: daysAgo(19), anonymous_id: "a2" },
    // u3 (organic): first purchase 3 days ago, so a 7-day window hasn't ended.
    identify(15, "a3", "u3"),
    buy(3, { anonymous_id: "a3", user_id: "u3" }, 20, "USD", "t3"),
    // a4 (meta), anonymous: 30 USD, while meta's spend is in SAR.
    buy(12, { anonymous_id: "a4" }, 30, "USD", "t4"),
    // u1's second device (google): not a new user.
    identify(5, "a5", "u1"),
    // u6 (tiktok, installed long ago): first purchase 25 days ago, before the range.
    identify(25, "a6", "u6"),
    buy(25, { anonymous_id: "a6", user_id: "u6" }, 999, "SAR", "t6"),
    buy(18, { anonymous_id: "a6", user_id: "u6" }, 5, "SAR", "t7"),
    // u7: no install on record.
    buy(8, { user_id: "u7" }, 15, "SAR", "t8"),
  ];
  const res = await ingest(sdk, { batch }, { mode: "batch" });
  expect((res.body as { accepted: number }).accepted).toBe(batch.length);
  await processPendingEvents({ environmentId: A.dev.id, limit: 500 });

  await withSystem(async (db) => {
    const env = (await db.one<{ organization_id: string; app_id: string }>("select organization_id, app_id from platform.environments where id = $1", [A.dev.id]))!;
    const install = (anon: string, at: string, matchType: string, source: string | null, kind = "install") =>
      db.query(
        `insert into platform.attribution_events (organization_id, app_id, environment_id, kind, anonymous_id, occurred_at, match_type, source)
         values ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [env.organization_id, env.app_id, A.dev.id, kind, anon, at, matchType, source],
      );
    await install("a1", daysAgo(20, 10), "deterministic", "tiktok");
    await install("a2", daysAgo(19, 10), "deterministic", "tiktok");
    await install("a3", daysAgo(15, 10), "organic", null);
    await install("a4", daysAgo(12, 10), "deterministic", "meta");
    await install("a5", daysAgo(5, 10), "deterministic", "google", "reinstall");
    await install("a6", new Date(Date.now() - 60 * 86_400_000).toISOString(), "deterministic", "tiktok");
  });

  const spendScope = { appId: A.app.id, environmentId: A.dev.id, timezone: "UTC" };
  await saveSpend(A.ctx, spendScope, { date: day(20), source: "tiktok", currency: "SAR", amount: "60" });
  await saveSpend(A.ctx, spendScope, { date: day(19), source: "tiktok", campaign: "eid", currency: "SAR", amount: "20" });
  await saveSpend(A.ctx, spendScope, { date: day(45), source: "tiktok", currency: "SAR", amount: "1000" }); // outside the range
  await saveSpend(A.ctx, spendScope, { date: day(12), source: "meta", currency: "SAR", amount: "40" });
  await saveSpend(A.ctx, spendScope, { date: day(5), source: "google", currency: "EUR", amount: "10" });
});

describe("CAC and LTV by channel", () => {
  it("puts CAC (new users) next to LTV (first-time buyers, 7 days from their first purchase), per currency", async () => {
    const r = await channelEconomicsReport(A.ctx, scope, { ...range(), window: 7 });
    expect(r.window).toBe(7);
    expect(r.channels.map((c) => c.channel)).toEqual(["tiktok", "meta", "organic", "(no install on record)", "google"]);
    const by = Object.fromEntries(r.channels.map((c) => [c.channel, c]));
    // CAC: 80 SAR ÷ 2 new users. LTV: u1's 100 + 50 − 50 in 7 days (not the 70 on day 10; not u6, who first bought before the range).
    expect(by.tiktok).toMatchObject({
      newUsers: 2, buyers: 1, buyersComplete: 1, currencyMismatch: false,
      amounts: [{ currency: "SAR", spend: 80, cac: 40, revenue: 100, ltv: 100, ltvToCac: 2.5 }],
      curve: [{ currency: "SAR", points: [{ day: 0, people: 1, ltv: 100 }, { day: 7, people: 1, ltv: 100 }] }],
    });
    // u3's window is still open: counted, marked, and left out of the day-7 point.
    expect(by.organic).toMatchObject({
      newUsers: 1, buyers: 1, buyersComplete: 0,
      amounts: [{ currency: "USD", spend: null, cac: null, revenue: 20, ltv: 20, ltvToCac: null }],
      curve: [{ currency: "USD", points: [{ day: 0, people: 1, ltv: 20 }, { day: 7, people: 0, ltv: null }] }],
    });
    // Spend in SAR, revenue in USD: never compared.
    expect(by.meta).toMatchObject({
      newUsers: 1, buyers: 1, currencyMismatch: true,
      amounts: [
        { currency: "SAR", spend: 40, cac: 40, revenue: null, ltv: null, ltvToCac: null },
        { currency: "USD", spend: null, cac: null, revenue: 30, ltv: 30, ltvToCac: null },
      ],
    });
    expect(by["(no install on record)"]).toMatchObject({ newUsers: 0, buyers: 1, amounts: [{ currency: "SAR", revenue: 15, ltv: 15, cac: null }] });
    // u1's second device isn't a new user, so google has spend but no CAC.
    expect(by.google).toMatchObject({ newUsers: 0, buyers: 0, amounts: [{ currency: "EUR", spend: 10, cac: null, revenue: null, ltv: null, ltvToCac: null }] });
    expect(r.totals).toEqual({ newUsers: 4, buyers: 4, buyersComplete: 3 });
    expect(r.people.map((p) => [p.person, p.channel, p.currency, p.revenue, p.purchases, p.complete, p.firstPurchaseAt.slice(0, 10)])).toEqual([
      ["u1", "tiktok", "SAR", 100, 2, true, day(20)],
      ["anon:a4", "meta", "USD", 30, 1, true, day(12)],
      ["u3", "organic", "USD", 20, 1, false, day(3)],
      ["u7", "(no install on record)", "SAR", 15, 1, true, day(8)],
    ]);
  });

  it("follows the window: 30 days takes in later purchases and isn't complete yet", async () => {
    const r = await channelEconomicsReport(A.ctx, scope, { ...range(), window: 30 });
    const tiktok = r.channels.find((c) => c.channel === "tiktok")!;
    expect(tiktok).toMatchObject({ buyers: 1, buyersComplete: 0, amounts: [{ currency: "SAR", revenue: 170, ltv: 170, ltvToCac: 4.25 }] });
    expect(tiktok.curve[0].points.map((p) => [p.day, p.people, p.ltv])).toEqual([[0, 1, 100], [7, 1, 100], [30, 0, null]]);
  });

  it("follows the range: a first purchase in it counts even after an older install", async () => {
    const r = await channelEconomicsReport(A.ctx, scope, { days: 30, window: 7 });
    const tiktok = r.channels.find((c) => c.channel === "tiktok")!;
    expect(tiktok).toMatchObject({ newUsers: 2, buyers: 2, amounts: [{ currency: "SAR", revenue: 1099, ltv: 549.5 }] }); // u1 100 + u6 999 (u6's 5 SAR came exactly 7 days later: outside the window)
  });

  it("needs attribution.read and analytics.read, and keeps each organization to its own data", async () => {
    const viewer: TenantContext = { ...A.ctx, role: "viewer" }; // analytics.read, no attribution.read
    await expect(channelEconomicsReport(viewer, scope, range())).rejects.toBeInstanceOf(ForbiddenError);
    const analyst: TenantContext = { ...A.ctx, role: "analyst" };
    const r = await channelEconomicsReport(analyst, scope, range());
    expect(r.window).toBe(90); // the default
    expect(r.channels).toHaveLength(5);
    const other = await channelEconomicsReport(B.ctx, scope, range());
    expect(other.channels).toEqual([]);
    expect(other.people).toEqual([]);
  });
});
