/**
 * Analytics beyond v1: user profiles (search, stitching, timeline), revenue
 * per currency with refunds, saved cohorts used as report filters, saved
 * reports, analytics.write / users.read permissions and tenant isolation.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { withSystem, withTenant } from "@/lib/db";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "@/lib/errors";
import { cohortMembers, createCohort, deleteCohort, getCohort, listCohorts, previewCohortSize, updateCohort } from "@/modules/analytics/cohorts";
import { getProfile, profileTimeline, searchPeople, type Profile } from "@/modules/analytics/profiles";
import { paramsFromConfig } from "@/modules/analytics/report-params";
import { NO_CURRENCY, revenueReport } from "@/modules/analytics/revenue";
import { deleteSavedReport, listSavedReports, saveReport } from "@/modules/analytics/saved-reports";
import { eventTrend, funnel, retention, topEvents } from "@/modules/analytics/service";
import { authenticateIngestionKey } from "@/modules/credentials/service";
import { ingest } from "@/modules/ingestion/service";
import { processPendingEvents } from "@/modules/processing/processor";
import { ROLE_PERMISSIONS, ROLES } from "@/modules/rbac/permissions";
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
const identify = (n: number, anon: string, user: string, o: Record<string, unknown> = {}) => ({ type: "identify", event_id: id(), timestamp: daysAgo(n, 13), anonymous_id: anon, user_id: user, ...o });

beforeAll(async () => {
  A = await makeTenant("insights");
  B = await makeTenant("insights-b");
  scope = { environmentId: A.dev.id, timezone: "UTC" };
  const sdk = (await authenticateIngestionKey(A.sdkKey))!;
  const ios = { platform: "ios", app_version: "2.1.0" };
  const android = { platform: "android" };
  const u1 = { anonymous_id: "a1", user_id: "u1", context: ios, session_id: "s-u1" };
  const batch = [
    // u1: anonymous install stitched in, gold plan, two purchases (one sent twice), one refund, a USD subscription.
    track("app_installed", 6, { anonymous_id: "a1", context: ios, session_id: "s-a1" }),
    identify(6, "a1", "u1", { context: ios, user_properties: { plan: "gold", age: 30 } }),
    track("purchase_completed", 5, { ...u1, properties: { revenue: 100, currency: "SAR", transaction_id: "t1", product: "shoes" } }),
    track("purchase_completed", 5, { ...u1, properties: { revenue: 100, currency: "SAR", transaction_id: "t1", product: "shoes" } }, 13),
    track("purchase_completed", 3, { ...u1, properties: { revenue: "50", currency: "sar", transaction_id: "t2", product: "bag" } }),
    track("refund_completed", 2, { ...u1, properties: { refund_amount: 50, currency: "SAR", transaction_id: "t2" } }),
    track("subscription_started", 4, { ...u1, properties: { price: 10, currency: "USD", subscription_id: "sub1", plan_id: "p" } }),
    track("product_viewed", 4, { ...u1, properties: { price: 99, currency: "SAR", product_id: "x" } }), // a price, not revenue
    // u2: android, one USD purchase.
    track("app_installed", 5, { anonymous_id: "a2", context: android }),
    identify(5, "a2", "u2", { context: android, user_properties: { plan: "free" } }),
    track("purchase_completed", 3, { anonymous_id: "a2", user_id: "u2", context: android, properties: { revenue: 20, currency: "USD", transaction_id: "t3" } }),
    // A shared tablet (a4) linked to u3 and u4: its anonymous purchase stays with the tablet.
    identify(2, "a4", "u3"),
    identify(2, "a4", "u4"),
    track("app_opened", 2, { user_id: "u3", anonymous_id: "a4" }),
    track("purchase_completed", 1, { anonymous_id: "a4", properties: { revenue: 7, currency: "SAR", transaction_id: "t4" } }),
    // a3: anonymous only; a custom event with revenue but no currency.
    track("tip_sent", 1, { anonymous_id: "a3", properties: { revenue: 5 } }),
    { type: "identify", event_id: id(), timestamp: daysAgo(1), anonymous_id: "a3", user_properties: { plan: "gold" } },
  ];
  const res = await ingest(sdk, { batch }, { mode: "batch" });
  expect((res.body as { accepted: number }).accepted).toBe(batch.length);
  await processPendingEvents({ environmentId: A.dev.id, limit: 500 });
});

describe("revenue", () => {
  it("totals per currency with refunds netted, de-duplicated transactions, ARPU and ARPPU", async () => {
    const r = await revenueReport(A.ctx, scope, { days: 30 });
    const by = Object.fromEntries(r.currencies.map((c) => [c.currency, c]));
    expect(r.activeUsers).toBe(5); // u1, u2, u3, anon:a3, anon:a4
    expect(by.SAR).toMatchObject({ gross: 157, refunds: 50, net: 107, transactions: 3, refundCount: 1, payingUsers: 2 });
    expect(by.SAR.arpu).toBeCloseTo(107 / 5, 2);
    expect(by.SAR.arppu).toBeCloseTo(107 / 2, 2);
    expect(by.USD).toMatchObject({ gross: 30, refunds: 0, net: 30, transactions: 2, payingUsers: 2 });
    expect(by[NO_CURRENCY]).toMatchObject({ gross: 5, transactions: 1, payingUsers: 1 });
    expect(Object.keys(by).sort()).toEqual([NO_CURRENCY, "SAR", "USD"].sort());
    // Daily net: the refund is subtracted on its own day.
    const sar = r.daily.find((d) => d.key === "SAR")!;
    expect(sar.counts[r.days.indexOf(daysAgo(5).slice(0, 10))]).toBe(100);
    expect(sar.counts[r.days.indexOf(daysAgo(2).slice(0, 10))]).toBe(-50);
    expect(sar.counts.reduce((a, b) => a + b, 0)).toBe(107);
    expect(r.rules.find((x) => x.event === "subscription_started")).toMatchObject({ property: "price", kind: "revenue" });
  });

  it("breaks down by platform and by property", async () => {
    const r = await revenueReport(A.ctx, scope, { days: 30, breakdown: "platform" });
    const sar = r.breakdown!.filter((g) => g.currency === "SAR");
    expect(sar).toEqual([
      { key: "ios", currency: "SAR", gross: 150, refunds: 50, net: 100, payingUsers: 1 },
      { key: "(none)", currency: "SAR", gross: 7, refunds: 0, net: 7, payingUsers: 1 },
    ]);
    const byProduct = await revenueReport(A.ctx, scope, { days: 30, breakdown: "property:product" });
    expect(byProduct.breakdown!.filter((g) => g.currency === "SAR").map((g) => [g.key, g.net])).toEqual([["shoes", 100], ["(none)", -43], ["bag", 50]].sort((a, b) => Number(b[1]) - Number(a[1])));
  });
});

describe("user profiles", () => {
  it("searches users and installs by id prefix", async () => {
    const res = await searchPeople(A.ctx, A.dev.id, "u");
    expect(res.users.map((u) => u.userId).sort()).toEqual(["u1", "u2", "u3", "u4"]);
    const installs = await searchPeople(A.ctx, A.dev.id, "a4");
    expect(installs.installs).toEqual([expect.objectContaining({ anonymousId: "a4", linkedUsers: ["u3", "u4"] })]);
    const recent = await searchPeople(A.ctx, A.dev.id, "");
    expect(recent.users.length).toBe(4);
    expect((await searchPeople(A.ctx, A.dev.id, "%")).users).toEqual([]); // LIKE wildcards are literal
  });

  it("shows a user with stitched installs, properties, activity and revenue", async () => {
    const p = (await getProfile(A.ctx, scope, { userId: "u1" })) as Profile;
    expect(p.person).toBe("u1");
    expect(p.properties).toEqual({ plan: "gold", age: 30 });
    expect(p.installs).toEqual([expect.objectContaining({ anonymousId: "a1", stitched: true, linkedUsers: ["u1"] })]);
    expect(p.firstSeen!.toISOString()).toBe(daysAgo(6)); // the anonymous install counts
    expect(p.eventCount).toBe(7); // install + 3 purchases + refund + subscription + product view
    expect(p.sessionCount).toBe(2);
    expect(p.platform).toBe("ios");
    expect(p.appVersion).toBe("2.1.0");
    expect(Object.fromEntries(p.revenue.map((r) => [r.currency, r.net]))).toEqual({ SAR: 100, USD: 10 });
  });

  it("never merges a shared device into one user", async () => {
    const u3 = (await getProfile(A.ctx, scope, { userId: "u3" })) as Profile;
    expect(u3.installs).toEqual([expect.objectContaining({ anonymousId: "a4", stitched: false, linkedUsers: ["u3", "u4"] })]);
    expect(u3.eventCount).toBe(1);
    expect(u3.revenue).toEqual([]);
    const tablet = (await getProfile(A.ctx, scope, { anonymousId: "a4" })) as Profile;
    expect(tablet.person).toBe("anon:a4");
    expect(tablet.revenue).toEqual([expect.objectContaining({ currency: "SAR", net: 7 })]);
    expect(await getProfile(A.ctx, scope, { anonymousId: "a1" })).toEqual({ redirectToUser: "u1" });
    const anon = (await getProfile(A.ctx, scope, { anonymousId: "a3" })) as Profile;
    expect(anon.properties).toEqual({ plan: "gold" });
    await expect(getProfile(A.ctx, scope, { userId: "nobody" })).rejects.toBeInstanceOf(NotFoundError);
  });

  it("pages through the timeline newest first without gaps or repeats", async () => {
    const seen: string[] = [];
    let cursor: string | null = null;
    let last = Infinity;
    for (let i = 0; i < 10; i++) {
      const page: Awaited<ReturnType<typeof profileTimeline>> = await profileTimeline(A.ctx, scope, { userId: "u1" }, { cursor, limit: 3 });
      for (const e of page.events) {
        expect(e.timestamp.getTime()).toBeLessThanOrEqual(last);
        last = e.timestamp.getTime();
        seen.push(e.id);
      }
      cursor = page.nextCursor;
      if (!cursor) break;
    }
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen.length).toBe(8); // 7 track events + identify
  });
});

describe("cohorts", () => {
  let buyers: string;
  let gold: string;

  it("creates cohorts and computes their members", async () => {
    buyers = (await createCohort(A.ctx, A.dev.id, { name: "Buyers", definition: { event: { name: "purchase_completed", range: { kind: "last", days: 30 } } } })).id;
    expect(await cohortMembers(A.ctx, scope, buyers, { limit: 10 })).toMatchObject({ size: 3 });
    const sample = (await cohortMembers(A.ctx, scope, buyers, { limit: 10 })).sample.map((m) => m.person).sort();
    expect(sample).toEqual(["anon:a4", "u1", "u2"]);

    const size = (definition: unknown) => previewCohortSize(A.ctx, scope, definition);
    expect(await size({ event: { name: "purchase_completed", minCount: 2, range: { kind: "last", days: 30 } } })).toBe(1);
    expect(await size({ event: { name: "purchase_completed", range: { kind: "last", days: 30 }, property: { name: "revenue", op: "gt", value: "30" } } })).toBe(1);
    expect(await size({ event: { name: "purchase_completed", range: { kind: "last", days: 2 } } })).toBe(1); // only the tablet bought yesterday
    const from = daysAgo(5).slice(0, 10);
    expect(await size({ event: { name: "purchase_completed", range: { kind: "between", from, to: from } } })).toBe(1);
    // User property: identified users by profile, unstitched installs by anonymous traits.
    expect(await size({ userProperty: { name: "plan", op: "eq", value: "gold" } })).toBe(2); // u1, anon:a3
    expect(await size({ userProperty: { name: "age", op: "gte", value: "30" } })).toBe(1);
    expect(await size({ userProperty: { name: "plan", op: "exists" } })).toBe(3);
    gold = (await createCohort(A.ctx, A.dev.id, {
      name: "Gold buyers",
      definition: { event: { name: "purchase_completed", range: { kind: "last", days: 30 } }, userProperty: { name: "plan", op: "eq", value: "gold" } },
    })).id;
    expect((await cohortMembers(A.ctx, scope, gold, { limit: 5 })).sample.map((m) => m.person)).toEqual(["u1"]);
  });

  it("validates definitions and names", async () => {
    await expect(createCohort(A.ctx, A.dev.id, { name: "Empty", definition: {} })).rejects.toBeInstanceOf(ValidationError);
    await expect(createCohort(A.ctx, A.dev.id, { name: "", definition: { userProperty: { name: "plan", op: "exists" } } })).rejects.toBeInstanceOf(ValidationError);
    await expect(createCohort(A.ctx, A.dev.id, { name: "Bad", definition: { userProperty: { name: "age", op: "gt", value: "old" } } })).rejects.toBeInstanceOf(ValidationError);
    await expect(createCohort(A.ctx, A.dev.id, { name: "Bad", definition: { userProperty: { name: "x'); drop", op: "exists" } } })).rejects.toBeInstanceOf(ValidationError);
    await expect(createCohort(A.ctx, A.dev.id, { name: "buyers", definition: { userProperty: { name: "plan", op: "exists" } } })).rejects.toBeInstanceOf(ConflictError);
  });

  it("filters events, funnels, retention and revenue", async () => {
    const trend = await eventTrend(A.ctx, scope, { event: "purchase_completed", days: 30, cohortId: gold });
    expect(trend.total).toEqual({ count: 3, people: 1 });
    expect((await topEvents(A.ctx, { ...scope, days: 30, cohortId: gold })).map((e) => e.name)).not.toContain("tip_sent");
    const f = await funnel(A.ctx, scope, { steps: ["app_installed", "purchase_completed"], windowDays: 7, days: 30, cohortId: buyers });
    expect(f.steps.map((s) => s.people)).toEqual([2, 2]);
    const r = await retention(A.ctx, scope, { startEvent: "app_installed", returnEvent: "purchase_completed", days: 30, cohortId: gold });
    expect(r.people).toBe(1);
    const rev = await revenueReport(A.ctx, scope, { days: 30, cohortId: gold });
    expect(rev.currencies.map((c) => [c.currency, c.net])).toEqual([["SAR", 100], ["USD", 10]]);
    expect(rev.activeUsers).toBe(1);
  });

  it("updates and deletes with an audit trail", async () => {
    await updateCohort(A.ctx, A.dev.id, buyers, { name: "Repeat buyers", definition: { event: { name: "purchase_completed", minCount: 2, range: { kind: "last", days: 30 } } } });
    expect((await getCohort(A.ctx, A.dev.id, buyers)).name).toBe("Repeat buyers");
    expect((await cohortMembers(A.ctx, scope, buyers)).size).toBe(1);
    const tmp = (await createCohort(A.ctx, A.dev.id, { name: "Temp", definition: { userProperty: { name: "plan", op: "exists" } } })).id;
    await deleteCohort(A.ctx, A.dev.id, tmp);
    await expect(getCohort(A.ctx, A.dev.id, tmp)).rejects.toBeInstanceOf(NotFoundError);
    await expect(eventTrend(A.ctx, scope, { event: "purchase_completed", days: 30, cohortId: tmp })).rejects.toBeInstanceOf(ValidationError);
    const actions = await withSystem((db) => db.query<{ action: string }>("select action from platform.audit_logs where organization_id = $1 and action like 'cohort.%'", [A.org.id]));
    expect(actions.map((a) => a.action).sort()).toEqual(["cohort.created", "cohort.created", "cohort.created", "cohort.deleted", "cohort.updated"]);
  });

  it("keeps cohorts in their environment", async () => {
    const prod = A.environments.find((e) => e.type === "production")!;
    expect(await listCohorts(A.ctx, prod.id)).toEqual([]);
    await expect(eventTrend(A.ctx, { environmentId: prod.id, timezone: "UTC" }, { event: "purchase_completed", days: 30, cohortId: gold })).rejects.toBeInstanceOf(ValidationError);
  });
});

describe("saved reports", () => {
  it("saves validated configurations and rebuilds their links", async () => {
    const q = new URLSearchParams({ event: "purchase_completed", days: "7", by: "property", property: "product", junk: "x" });
    const { id: trendId } = await saveReport(A.ctx, A.dev.id, { name: "Purchases by product", kind: "trend", query: q });
    const funnelQuery = new URLSearchParams([["step", "app_installed"], ["step", "purchase_completed"], ["window", "3"], ["days", "90"], ["split", "platform"]]);
    await saveReport(A.ctx, A.dev.id, { name: "Install to purchase", kind: "funnel", query: funnelQuery });
    await saveReport(A.ctx, A.dev.id, { name: "Revenue", kind: "revenue", query: new URLSearchParams({ days: "30", by: "platform" }) });
    const list = await listSavedReports(A.ctx, A.dev.id);
    expect(list.map((r) => r.name)).toEqual(["Install to purchase", "Purchases by product", "Revenue"]);
    const trend = list.find((r) => r.id === trendId)!;
    expect(trend.config).toEqual({ event: "purchase_completed", days: 7, breakdown: "property:product" });
    expect(paramsFromConfig("trend", trend.config).toString()).toBe("event=purchase_completed&by=property&property=product&days=7");
    expect(paramsFromConfig("funnel", list[0].config).toString()).toBe("step=app_installed&step=purchase_completed&window=3&split=platform&days=90");

    await expect(saveReport(A.ctx, A.dev.id, { name: "No event", kind: "trend", query: new URLSearchParams() })).rejects.toBeInstanceOf(ValidationError);
    await expect(saveReport(A.ctx, A.dev.id, { name: "x", kind: "pie", query: new URLSearchParams() })).rejects.toBeInstanceOf(ValidationError);
    await expect(saveReport(A.ctx, A.dev.id, { name: "revenue", kind: "revenue", query: new URLSearchParams() })).rejects.toBeInstanceOf(ConflictError);
    await deleteSavedReport(A.ctx, A.dev.id, trendId);
    expect((await listSavedReports(A.ctx, A.dev.id)).map((r) => r.id)).not.toContain(trendId);
  });
});

describe("permissions", () => {
  it("adds analytics.write to the database exactly as in the source of truth", async () => {
    const rows = await withSystem((db) => db.query<{ role_id: string; permission_id: string }>("select role_id, permission_id from platform.role_permissions"));
    for (const role of ROLES) {
      expect(rows.filter((r) => r.role_id === role).map((r) => r.permission_id).sort()).toEqual([...ROLE_PERMISSIONS[role]].sort());
    }
    expect(ROLE_PERMISSIONS.developer).not.toContain("analytics.write");
  });

  it("needs analytics.write to save and users.read to see profiles", async () => {
    const developer = { ...A.ctx, role: "developer" as const };
    const marketer = { ...A.ctx, role: "marketer" as const };
    const analyst = { ...A.ctx, role: "analyst" as const };
    const def = { name: "Dev cohort", definition: { userProperty: { name: "plan", op: "exists" } } };
    await expect(createCohort(developer, A.dev.id, def)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(saveReport(developer, A.dev.id, { name: "r", kind: "revenue", query: new URLSearchParams() })).rejects.toBeInstanceOf(ForbiddenError);
    const cohorts = await listCohorts(developer, A.dev.id); // reading is analytics.read
    await expect(deleteCohort(developer, A.dev.id, cohorts[0].id)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(revenueReport(developer, scope, { days: 7 })).resolves.toBeDefined();
    await expect(getProfile(marketer, scope, { userId: "u1" })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(searchPeople(marketer, A.dev.id, "u")).rejects.toBeInstanceOf(ForbiddenError);
    await expect(createCohort(marketer, A.dev.id, { ...def, name: "Marketer cohort" })).resolves.toBeDefined();
    await expect(createCohort(analyst, A.dev.id, { ...def, name: "Analyst cohort" })).resolves.toBeDefined();
    await expect(getProfile(analyst, scope, { userId: "u1" })).resolves.toBeDefined();
  });
});

describe("tenant isolation", () => {
  it("never shows or changes another organization's cohorts, reports or people", async () => {
    const [cohort] = await listCohorts(A.ctx, A.dev.id);
    const [report] = await listSavedReports(A.ctx, A.dev.id);
    expect(await listCohorts(B.ctx, A.dev.id)).toEqual([]);
    expect(await listSavedReports(B.ctx, A.dev.id)).toEqual([]);
    await expect(getCohort(B.ctx, A.dev.id, cohort.id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(cohortMembers(B.ctx, { environmentId: A.dev.id, timezone: "UTC" }, cohort.id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(deleteCohort(B.ctx, A.dev.id, cohort.id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(updateCohort(B.ctx, A.dev.id, cohort.id, { name: "x", definition: { userProperty: { name: "a", op: "exists" } } })).rejects.toBeInstanceOf(NotFoundError);
    await expect(deleteSavedReport(B.ctx, A.dev.id, report.id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(createCohort(B.ctx, A.dev.id, { name: "Steal", definition: { userProperty: { name: "a", op: "exists" } } })).rejects.toBeInstanceOf(NotFoundError);
    await expect(saveReport(B.ctx, A.dev.id, { name: "Steal", kind: "revenue", query: new URLSearchParams() })).rejects.toBeInstanceOf(NotFoundError);
    // A's cohort can't filter B's reports, even in B's own environment.
    await expect(eventTrend(B.ctx, { environmentId: B.dev.id, timezone: "UTC" }, { event: "purchase_completed", cohortId: cohort.id })).rejects.toBeInstanceOf(ValidationError);
    // B sees none of A's people or revenue.
    expect(await searchPeople(B.ctx, A.dev.id, "u")).toEqual({ users: [], installs: [] });
    await expect(getProfile(B.ctx, { environmentId: A.dev.id }, { userId: "u1" })).rejects.toBeInstanceOf(NotFoundError);
    expect((await revenueReport(B.ctx, { environmentId: A.dev.id, timezone: "UTC" }, { days: 30 })).currencies).toEqual([]);
    // RLS, even without a WHERE clause.
    const rows = await withTenant({ organizationId: B.org.id, userId: B.user.id }, async (db) => {
      await db.query("set local role platform_app");
      return [
        ...(await db.query("select id from platform.analytics_cohorts")),
        ...(await db.query("select id from platform.analytics_saved_reports")),
      ];
    });
    expect(rows).toEqual([]);
    await expect(
      withTenant({ organizationId: B.org.id, userId: B.user.id }, (db) =>
        db.query("insert into platform.analytics_cohorts (organization_id, app_id, environment_id, name, definition) values ($1, $2, $3, 'x', '{}')", [A.org.id, A.app.id, A.dev.id]),
      ),
    ).rejects.toThrow(/row-level security/);
  });
});
