/**
 * The public demo against Postgres: created once, filled with sample events
 * that a refresh never duplicates, and signed in as a read-only Viewer.
 */
import { describe, expect, it } from "vitest";
import { withSystem } from "@/lib/db";
import { getUserBySessionToken } from "@/modules/auth/service";
import { ForbiddenError } from "@/lib/errors";
import { channelEconomicsReport } from "@/modules/attribution/economics";
import { attributionOverview } from "@/modules/attribution/reports";
import { listSpend, saveSpend } from "@/modules/attribution/spend";
import { DEMO_EMAIL, demoEvents, demoHistory, demoSession, ensureDemo, isDemoUser, seedDemoSpend, sendDemoHistory } from "@/modules/marketing/demo";
import { churnReport } from "@/modules/analytics/churn";
import { processPendingEvents } from "@/modules/processing/processor";
import { rfmReport } from "@/modules/analytics/rfm";
import { can } from "@/modules/rbac/authorize";
import { resolveTenant } from "@/modules/tenancy/context";

const now = new Date();

async function counts(environmentId: string) {
  return withSystem((db) =>
    db.one<{ events: number; orders: number }>(
      `select count(*)::int as events, count(*) filter (where event_name = 'order_completed')::int as orders
         from platform.events where environment_id = $1`,
      [environmentId],
    ),
  );
}

describe("public demo", () => {
  it("generates the same journeys whatever day it runs, all in the past", () => {
    const a = demoEvents(now);
    const b = demoEvents(now);
    expect(a).toEqual(b);
    expect(a.length).toBeGreaterThan(1000);
    expect(new Set(a.map((e) => e.event_id)).size).toBe(a.length);
    expect(a.every((e) => new Date(e.timestamp as string) < now)).toBe(true);
    // Tomorrow's set keeps today's journeys' ids (that's what makes a refresh idempotent).
    const later = new Set(demoEvents(new Date(now.getTime() + 86_400_000)).map((e) => e.event_id));
    expect(a.filter((e) => later.has(e.event_id as string)).length).toBeGreaterThan(a.length * 0.8);
  });

  it("creates the demo once, and a refresh adds nothing it already has", async () => {
    const refs = await ensureDemo({ now, staleHours: 0 });
    const first = (await counts(refs.environmentId))!;
    expect(first.events).toBeGreaterThan(1000);
    expect(first.orders).toBeGreaterThan(20);

    const again = await ensureDemo({ now, staleHours: 0 });
    expect(again).toEqual(refs);
    expect(await counts(refs.environmentId)).toEqual(first);

    const role = await withSystem((db) =>
      db.one<{ role_id: string }>(
        "select m.role_id from platform.organization_members m join platform.organizations o on o.id = m.organization_id where o.slug = $1 and m.user_id = $2",
        [refs.orgSlug, refs.viewerId],
      ),
    );
    expect(role?.role_id).toBe("viewer");
  }, 180_000); // A new demo stores and processes tens of thousands of events.

  it("shows the demo Viewer real Acquisition numbers: installs by source, ad spend, CAC & LTV", async () => {
    const refs = await ensureDemo({ now });
    const ctx = await resolveTenant(refs.viewerId, refs.orgSlug);
    expect(ctx.role).toBe("viewer");
    expect(can(ctx.role, "attribution.read")).toBe(true);
    expect(can(ctx.role, "attribution.manage")).toBe(false);
    const app = await withSystem((db) =>
      db.one<{ id: string; timezone: string; currency: string }>(
        "select a.id, a.timezone, a.default_currency as currency from platform.environments e join platform.apps a on a.id = e.app_id where e.id = $1",
        [refs.environmentId],
      ),
    );
    const scope = { environmentId: refs.environmentId, timezone: app!.timezone };

    // Acquisition → Overview / Sources & campaigns: installs from every paid source, and organic ones.
    const overview = await attributionOverview(ctx, scope, { days: "30" });
    expect(overview.totals.installs).toBeGreaterThan(200);
    expect(overview.totals.organic).toBeGreaterThan(20);
    const sources = new Set(overview.bySource.map((s) => s.source));
    for (const s of ["tiktok", "snapchat", "google", "meta"]) expect(sources, s).toContain(s);

    // Acquisition → Ad spend: the paid sources, every day, in the app's currency.
    const spend = await listSpend(ctx, refs.environmentId);
    expect(new Set(spend.map((r) => r.source))).toEqual(new Set(["tiktok", "snapchat", "google", "meta"]));
    expect(new Set(spend.map((r) => r.currency))).toEqual(new Set([app!.currency]));
    expect(new Set(spend.map((r) => r.date)).size).toBeGreaterThanOrEqual(28);
    // Viewing only: saving spend is refused.
    await expect(saveSpend(ctx, { appId: app!.id, environmentId: refs.environmentId, timezone: app!.timezone }, { date: spend[0].date, source: "tiktok", currency: app!.currency, amount: 1 })).rejects.toThrow(ForbiddenError);

    // Acquisition → CAC & LTV: each paid channel has new users, a CAC, an LTV and LTV:CAC.
    const econ = await channelEconomicsReport(ctx, scope, { days: "30" });
    expect(econ.channels.length).toBeGreaterThan(0);
    expect(econ.totals.newUsers).toBeGreaterThan(200);
    expect(econ.totals.buyers).toBeGreaterThan(20);
    for (const source of ["tiktok", "snapchat", "google", "meta"]) {
      const c = econ.channels.find((x) => x.channel === source);
      expect(c, source).toBeDefined();
      const a = c!.amounts.find((x) => x.currency === app!.currency)!;
      expect(c!.newUsers, source).toBeGreaterThan(0);
      expect(a.cac, source).toBeGreaterThan(5);
      expect(a.cac, source).toBeLessThan(50);
      expect(a.ltv, source).toBeGreaterThan(0);
      expect(a.ltvToCac, source).toBeGreaterThan(0);
    }
  });

  it("fills in ad spend for a demo whose events were sent before spend existed, and a refresh changes nothing", async () => {
    const refs = await ensureDemo({ now });
    const total = () =>
      withSystem((db) => db.one<{ n: number; amount: string }>("select count(*)::int as n, coalesce(sum(amount), 0)::text as amount from platform.ad_spend_daily where environment_id = $1", [refs.environmentId]));
    const before = (await total())!;
    expect(before.n).toBeGreaterThan(50);
    expect(await seedDemoSpend(refs, now)).toBe(0);

    await withSystem((db) => db.query("delete from platform.ad_spend_daily where environment_id = $1", [refs.environmentId]));
    // The demo exists and its events are fresh (as on staging): only spend is filled in.
    await ensureDemo({ now, staleHours: Number.POSITIVE_INFINITY });
    expect(await total()).toEqual(before);
  });

  it("has history for Churn and RFM segments: people who left, people at risk, and most segments filled", async () => {
    const refs = await ensureDemo({ now });
    // A new demo leaves what doesn't fit in one run to the worker.
    while ((await processPendingEvents({ environmentId: refs.environmentId, limit: 20_000 })).processed > 0);
    const ctx = await resolveTenant(refs.viewerId, refs.orgSlug);
    const scope = { environmentId: refs.environmentId, timezone: "Asia/Riyadh" };
    // History is stored directly (older than ingestion takes) and sending it again adds nothing.
    const oldest = await withSystem((db) => db.one<{ days: number }>(`select extract(day from now() - min("timestamp"))::int as days from platform.events where environment_id = $1`, [refs.environmentId]));
    expect(oldest!.days).toBeGreaterThan(140);
    expect(await sendDemoHistory(refs, now)).toBe(0);
    expect(demoHistory(now)).toEqual(demoHistory(now));

    const churn = await churnReport(ctx, scope, { window: 30, interval: "week" });
    expect(churn.totals.churned).toBeGreaterThan(200);
    expect(churn.totals.at_risk).toBeGreaterThan(30);
    expect(churn.totals.active).toBeGreaterThan(100);
    expect(churn.series.filter((p) => p.rate !== null && p.rate > 0).length).toBeGreaterThanOrEqual(10);
    for (const s of ["tiktok", "snapchat", "google", "meta", "organic"]) expect(churn.channels.map((c) => c.channel), s).toContain(s);

    const rfm = await rfmReport(ctx, scope, { window: 365 });
    expect(rfm.currency).toBe("SAR");
    expect(rfm.customers).toBeGreaterThan(300);
    const filled = rfm.segments.filter((s) => s.customers > 0).map((s) => s.segment);
    expect(filled.length, filled.join()).toBeGreaterThanOrEqual(9);
    for (const s of ["champions", "loyal", "at_risk", "cant_lose", "lost", "new_customers"]) expect(filled, s).toContain(s);
  }, 180_000);

  it("signs in as the demo Viewer", async () => {
    const refs = await ensureDemo({ now });
    const s = await demoSession(refs, "vitest");
    const user = await getUserBySessionToken(s.token);
    expect(user?.email).toBe(DEMO_EMAIL);
    expect(isDemoUser(user)).toBe(true);
    expect(isDemoUser({ email: "someone@example.com" })).toBe(false);
  });
});
