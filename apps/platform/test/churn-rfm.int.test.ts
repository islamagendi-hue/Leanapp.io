/**
 * Retention → Churn and RFM segments against Postgres: buckets and segments
 * from real events, and the audiences saved from them having exactly the
 * same people as the page.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { withSystem } from "@/lib/db";
import { ForbiddenError } from "@/lib/errors";
import { churnReport } from "@/modules/analytics/churn";
import { churnAudience } from "@/modules/analytics/churn-pure";
import { rfmReport } from "@/modules/analytics/rfm";
import { rfmAudience, RFM_SEGMENTS, scoreCustomers } from "@/modules/analytics/rfm-pure";
import { activateAudience, createAudience, getAudience, previewAudience } from "@/modules/audiences/service";
import { processPendingEvents } from "@/modules/processing/processor";
import { resolveTenant, type TenantContext } from "@/modules/tenancy/context";
import { makeTenant } from "./helpers";

type T = Awaited<ReturnType<typeof makeTenant>>;
let t: T;
let scope: { environmentId: string; timezone: string };
let seq = 0;

const DAY = 86_400_000;

/** Stores events as ingestion would have when they happened (older than ingestion accepts), for processing to pick up. */
async function events(rows: { daysAgo: number; user?: string; anon?: string; name?: string; type?: string; properties?: Record<string, unknown>; context?: Record<string, unknown> }[]) {
  await withSystem((db) =>
    db.query(
      `insert into platform.events (organization_id, app_id, environment_id, event_id, type, event_name, "timestamp", received_at, anonymous_id, user_id, source, properties, context)
       select $1, $2, $3, e.id, e.type, e.name, e.ts, now(), e.anon, e.uid, 'mobile_sdk', e.props, e.ctx
         from jsonb_to_recordset($4::jsonb) as e(id text, type text, name text, ts timestamptz, anon text, uid text, props jsonb, ctx jsonb)`,
      [
        t.org.id, t.app.id, t.dev.id,
        JSON.stringify(rows.map((r) => ({
          id: `cr-${++seq}`, type: r.type ?? "track", name: r.name ?? "app_opened", ts: new Date(Date.now() - r.daysAgo * DAY).toISOString(),
          anon: r.anon ?? null, uid: r.user ?? null, props: r.properties ?? {}, ctx: r.context ?? {},
        }))),
      ],
    ),
  );
}

const order = (user: string, daysAgo: number, revenue: number, currency = "SAR") =>
  ({ daysAgo, user, name: "order_completed", properties: { order_id: `o-${user}-${daysAgo}-${revenue}`, revenue, currency } });

beforeAll(async () => {
  t = await makeTenant("churn-rfm");
  scope = { environmentId: t.dev.id, timezone: "Asia/Riyadh" };
  await events([
    // Installs with a source, so churn has channels.
    { daysAgo: 70, anon: "dev-churned", name: "app_installed", context: { attribution: { utm_source: "tiktok", utm_medium: "paid" } } },
    { daysAgo: 70, anon: "dev-churned", user: "u-churned", type: "identify", name: "user_identified" },
    { daysAgo: 45, user: "u-churned" },
    { daysAgo: 20, user: "u-risk" },
    { daysAgo: 25, user: "u-risk" },
    { daysAgo: 0.1, user: "u-active" },
    { daysAgo: 10, user: "u-active" },
    { daysAgo: 100, anon: "lonely-device", name: "app_installed" },
    // Customers: recency, frequency and money all over the place, a refund and a second currency.
    order("c-champ", 1, 300), order("c-champ", 8, 250), order("c-champ", 15, 280), order("c-champ", 22, 260),
    order("c-new", 0.5, 20),
    order("c-whale", 200, 900), order("c-whale", 190, 800), order("c-whale", 180, 950), order("c-whale", 170, 700),
    order("c-gone", 300, 15),
    order("c-mid", 60, 80), order("c-mid", 75, 60),
    order("c-mid2", 40, 90), order("c-mid2", 50, 30),
    order("c-refund", 5, 100), { daysAgo: 4, user: "c-refund", name: "refund_completed", properties: { refund_amount: 100, currency: "SAR" } },
    order("c-usd", 3, 50, "USD"),
  ]);
  await processPendingEvents({ environmentId: t.dev.id, limit: 1000 });
});

describe("churn", () => {
  it("puts each person in one bucket by last seen, with their channel", async () => {
    const r = await churnReport(t.ctx, scope, { window: "30" });
    expect(r.window).toBe(30);
    expect(r.atRiskAfter).toBe(15);
    const risk = r.atRisk.map((p) => p.person);
    expect(risk).toContain("u-risk");
    expect(risk).not.toContain("u-active");
    expect(r.atRisk.find((p) => p.person === "u-risk")?.daysAway).toBe(20);
    expect(r.totals.people).toBe(r.totals.churned + r.totals.at_risk + r.totals.active);
    expect(r.totals.churned).toBeGreaterThanOrEqual(2); // u-churned, the lonely device, old customers
    const tiktok = r.channels.find((c) => c.channel === "tiktok");
    expect(tiktok).toMatchObject({ people: 1, churned: 1, rate: 1 });
    expect(r.channels.some((c) => c.channel === "(no install on record)")).toBe(true);
  });

  it("shows the churn rate per week: of the people active at the start, who churned by the end", async () => {
    const r = await churnReport(t.ctx, scope, { window: "14", interval: "week" });
    expect(r.series).toHaveLength(12);
    expect(r.series.at(-1)!.partial).toBe(true);
    for (const p of r.series) {
      expect(p.churned).toBeLessThanOrEqual(p.base);
      expect(p.rate).toBe(p.base ? p.churned / p.base : null);
    }
    // u-risk (seen 20 and 25 days ago) was active at the start of some week and gone 14 days later.
    expect(r.series.reduce((s, p) => s + p.churned, 0)).toBeGreaterThan(0);
    const months = await churnReport(t.ctx, scope, { window: "90", interval: "month" });
    expect(months.series).toHaveLength(6);
  });

  it("saves the churned and at-risk groups as audiences with exactly the page's people", async () => {
    for (const window of [14, 30, 60, 90] as const) {
      const r = await churnReport(t.ctx, scope, { window });
      for (const bucket of ["churned", "at_risk", "active"] as const) {
        const preview = await previewAudience(t.ctx, t.dev.id, churnAudience(bucket, window));
        expect(preview.size, `${bucket} ${window}`).toBe(r.totals[bucket]);
      }
    }
    const r = await churnReport(t.ctx, scope, { window: 30 });
    const { id } = await createAudience(t.ctx, t.dev.id, { name: "At risk", definition: churnAudience("at_risk", 30) });
    expect((await activateAudience(t.ctx, id)).size).toBe(r.totals.at_risk);
    const members = (await getAudience(t.ctx, id)).members.map((m) => m.user_key).sort();
    expect(members).toEqual(r.atRisk.map((p) => p.person).sort());
  });
});

describe("RFM segments", () => {
  it("scores the customers of the main currency, net of refunds", async () => {
    const r = await rfmReport(t.ctx, scope, { window: "365" });
    expect(r.window).toBe(365);
    expect(r.currencies).toEqual([{ currency: "SAR", customers: 7 }, { currency: "USD", customers: 1 }]);
    expect(r.currency).toBe("SAR");
    expect(r.customers).toBe(7);
    const all = Object.values(r.people).flat();
    expect(all.find((c) => c.person === "c-refund")).toMatchObject({ frequency: 1, monetary: 0, recency: 5 });
    expect(all.find((c) => c.person === "c-whale")).toMatchObject({ frequency: 4, monetary: 3350, recency: 170 });
    expect(all.find((c) => c.person === "c-champ")?.segment).toMatch(/champions|loyal/);
    expect(all.find((c) => c.person === "c-gone")?.segment).toBe("lost");
    expect(r.segments.reduce((s, x) => s + x.customers, 0)).toBe(7);
    expect(r.cells.flat().reduce((s, n) => s + n, 0)).toBe(7);
    // The page's segments are the pure scoring of its customers.
    const rescored = scoreCustomers(all.map(({ person, recency, frequency, monetary }) => ({ person, recency, frequency, monetary })));
    expect(Object.fromEntries(rescored.map((c) => [c.person, c.segment]))).toEqual(Object.fromEntries(all.map((c) => [c.person, c.segment])));

    const usd = await rfmReport(t.ctx, scope, { window: "365", currency: "USD" });
    expect(usd).toMatchObject({ currency: "USD", customers: 1 });
    // A shorter window drops older customers.
    const recent = await rfmReport(t.ctx, scope, { window: "30" });
    expect(recent.customers).toBe(3);
  });

  it("saves every segment as an audience with exactly the page's people, in SQL", async () => {
    for (const window of [30, 365] as const) {
      const r = await rfmReport(t.ctx, scope, { window });
      for (const segment of RFM_SEGMENTS) {
        const preview = await previewAudience(t.ctx, t.dev.id, rfmAudience(segment, window, "SAR"));
        expect(preview.size, `${segment} ${window}`).toBe(r.segments.find((s) => s.segment === segment)!.customers);
        expect(preview.sample.sort()).toEqual(r.people[segment].map((c) => c.person).sort());
      }
    }
    const { id } = await createAudience(t.ctx, t.dev.id, { name: "Lost", definition: rfmAudience("lost", 365, "SAR") });
    expect((await activateAudience(t.ctx, id)).size).toBe(1);
    expect((await getAudience(t.ctx, id)).description).toBe("in RFM segment Lost (SAR, last 365 days)");
  });

  it("is open to a Viewer, who can't save audiences", async () => {
    const viewer = await withSystem(async (db) => {
      const u = await db.one<{ id: string }>(
        "insert into platform.users (email, name, password_hash, email_verified_at) values ($1, 'V', 'x', now()) returning id",
        [`rfm-viewer-${Date.now()}@example.com`],
      );
      await db.query("insert into platform.organization_members (organization_id, user_id, role_id) values ($1, $2, 'viewer')", [t.org.id, u!.id]);
      return u!.id;
    });
    const ctx: TenantContext = await resolveTenant(viewer, t.org.slug);
    expect((await rfmReport(ctx, scope, {})).customers).toBe(7);
    expect((await churnReport(ctx, scope, {})).totals.people).toBeGreaterThan(0);
    await expect(createAudience(ctx, t.dev.id, { name: "Nope", definition: rfmAudience("lost", 365, "SAR") })).rejects.toThrow(ForbiddenError);
  });
});
