/**
 * CAC and LTV by acquisition channel (modules/attribution/economics):
 * new users by their first install, revenue of those users only, spend per
 * source, the currency rules (no conversion, no LTV:CAC across currencies),
 * permissions and tenant isolation.
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
const id = () => crypto.randomUUID();
const track = (name: string, n: number, o: Record<string, unknown>, hour = 12) => ({ type: "track", event_name: name, event_id: id(), timestamp: daysAgo(n, hour), ...o });
const identify = (n: number, anon: string, user: string) => ({ type: "identify", event_id: id(), timestamp: daysAgo(n, 13), anonymous_id: anon, user_id: user });

beforeAll(async () => {
  A = await makeTenant("cac");
  B = await makeTenant("cac-b");
  scope = { environmentId: A.dev.id, timezone: "UTC" };
  const sdk = (await authenticateIngestionKey(A.sdkKey))!;
  const batch = [
    // u1 (tiktok): two purchases and a refund, 100 SAR net.
    identify(6, "a1", "u1"),
    track("purchase_completed", 5, { anonymous_id: "a1", user_id: "u1", properties: { revenue: 100, currency: "SAR", transaction_id: "t1" } }),
    track("purchase_completed", 4, { anonymous_id: "a1", user_id: "u1", properties: { revenue: 50, currency: "SAR", transaction_id: "t2" } }),
    track("refund_completed", 3, { anonymous_id: "a1", user_id: "u1", properties: { refund_amount: 50, currency: "SAR", transaction_id: "t2" } }),
    // a2 (tiktok): installed, never paid.
    track("app_opened", 5, { anonymous_id: "a2" }),
    // u3 (organic): 20 USD.
    identify(4, "a3", "u3"),
    track("purchase_completed", 3, { anonymous_id: "a3", user_id: "u3", properties: { revenue: 20, currency: "USD", transaction_id: "t3" } }),
    // a4 (meta), anonymous: 30 USD, while meta's spend is in SAR.
    track("purchase_completed", 2, { anonymous_id: "a4", properties: { revenue: 30, currency: "USD", transaction_id: "t4" } }),
    // u1's second device (google): not a new user.
    identify(2, "a5", "u1"),
    // u6 installed long before the range (tiktok): their purchase doesn't count.
    identify(3, "a6", "u6"),
    track("purchase_completed", 2, { anonymous_id: "a6", user_id: "u6", properties: { revenue: 999, currency: "SAR", transaction_id: "t6" } }),
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
    await install("a1", daysAgo(6, 11), "deterministic", "tiktok");
    await install("a2", daysAgo(5, 11), "deterministic", "tiktok");
    await install("a3", daysAgo(4, 11), "organic", null);
    await install("a4", daysAgo(3, 11), "deterministic", "meta");
    await install("a5", daysAgo(2, 11), "deterministic", "google", "reinstall");
    await install("a6", new Date(Date.now() - 60 * 86_400_000).toISOString(), "deterministic", "tiktok");
  });

  const spendScope = { appId: A.app.id, environmentId: A.dev.id, timezone: "UTC" };
  const day = (n: number) => daysAgo(n).slice(0, 10);
  await saveSpend(A.ctx, spendScope, { date: day(6), source: "tiktok", currency: "SAR", amount: "60" });
  await saveSpend(A.ctx, spendScope, { date: day(5), source: "tiktok", campaign: "eid", currency: "SAR", amount: "20" });
  await saveSpend(A.ctx, spendScope, { date: day(45), source: "tiktok", currency: "SAR", amount: "1000" }); // outside the range
  await saveSpend(A.ctx, spendScope, { date: day(3), source: "meta", currency: "SAR", amount: "40" });
  await saveSpend(A.ctx, spendScope, { date: day(2), source: "google", currency: "EUR", amount: "10" });
});

describe("CAC and LTV by channel", () => {
  it("counts new users by first install, their net revenue, spend, CAC, LTV and LTV:CAC per currency", async () => {
    const r = await channelEconomicsReport(A.ctx, scope, { days: 30 });
    expect(r.channels.map((c) => c.channel)).toEqual(["tiktok", "meta", "organic", "google"]);
    const by = Object.fromEntries(r.channels.map((c) => [c.channel, c]));
    // 80 SAR of spend in range for 2 new users; 100 SAR net from u1 (u6's 999 SAR is not a new user's).
    expect(by.tiktok).toEqual({
      channel: "tiktok", newUsers: 2, payingUsers: 1, currencyMismatch: false,
      amounts: [{ currency: "SAR", spend: 80, cac: 40, revenue: 100, ltv: 50, ltvToCac: 1.25 }],
    });
    // No spend on organic: no CAC, no ratio.
    expect(by.organic).toMatchObject({ newUsers: 1, payingUsers: 1, amounts: [{ currency: "USD", spend: null, cac: null, revenue: 20, ltv: 20, ltvToCac: null }] });
    // Spend in SAR, revenue in USD: never compared.
    expect(by.meta).toMatchObject({
      newUsers: 1, payingUsers: 1, currencyMismatch: true,
      amounts: [
        { currency: "SAR", spend: 40, cac: 40, revenue: null, ltv: null, ltvToCac: null },
        { currency: "USD", spend: null, cac: null, revenue: 30, ltv: 30, ltvToCac: null },
      ],
    });
    // u1's second device isn't a new user, so google has spend but no CAC.
    expect(by.google).toMatchObject({ newUsers: 0, payingUsers: 0, amounts: [{ currency: "EUR", spend: 10, cac: null, revenue: 0, ltv: null, ltvToCac: null }] });
    expect(r.totals).toEqual({ newUsers: 4, payingUsers: 3 });
  });

  it("follows the range: custom days leave out earlier installs and spend", async () => {
    const from = daysAgo(4).slice(0, 10);
    const to = daysAgo(0).slice(0, 10);
    const r = await channelEconomicsReport(A.ctx, scope, { from, to });
    expect(r.range).toMatchObject({ from, to, preset: null });
    expect(r.channels.map((c) => [c.channel, c.newUsers])).toEqual([["meta", 1], ["organic", 1], ["google", 0]]);
  });

  it("needs attribution.read and analytics.read, and keeps each organization to its own data", async () => {
    const viewer: TenantContext = { ...A.ctx, role: "viewer" }; // analytics.read, no attribution.read
    await expect(channelEconomicsReport(viewer, scope, { days: 30 })).rejects.toBeInstanceOf(ForbiddenError);
    const analyst: TenantContext = { ...A.ctx, role: "analyst" };
    expect((await channelEconomicsReport(analyst, scope, { days: 30 })).channels).toHaveLength(4);
    const other = await channelEconomicsReport(B.ctx, scope, { days: 30 });
    expect(other.channels).toEqual([]);
  });
});
