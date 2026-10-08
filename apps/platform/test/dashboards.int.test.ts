/**
 * PR 7: dashboard architecture. Dashboards belong to a project, are shared
 * with the workspace or private, hold widgets that reuse saved reports or
 * carry an inline report config, and run in the selected environment.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { withSystem, withTenant } from "@/lib/db";
import { ForbiddenError, NotFoundError, ValidationError } from "@/lib/errors";
import { saveReport } from "@/modules/analytics/saved-reports";
import { createAudience } from "@/modules/audiences/service";
import { authenticateIngestionKey } from "@/modules/credentials/service";
import {
  addWidget, createDashboard, deleteDashboard, getDashboard, growthValue, listDashboards, removeWidget, runWidget, saveLayout, updateDashboard, updateWidget,
} from "@/modules/dashboards/service";
import { ingest } from "@/modules/ingestion/service";
import { processPendingEvents } from "@/modules/processing/processor";
import { signUp } from "@/modules/auth/service";
import { resolveTenant } from "@/modules/tenancy/context";
import { makeTenant } from "./helpers";

type T = Awaited<ReturnType<typeof makeTenant>>;
let A: T;
let B: T;
let scope: { appId: string; environmentId: string; timezone: string };

const at = (hoursAgo: number) => new Date(Date.now() - hoursAgo * 3600_000).toISOString();
const track = (name: string, user: string, h: number, properties: Record<string, unknown> = {}) => ({ type: "track", event_name: name, event_id: crypto.randomUUID(), timestamp: at(h), user_id: user, properties });

async function member(t: T, role: string, i: number) {
  const { user } = await signUp({ name: role, email: `dash-${role}-${Date.now()}-${i}@example.com`, password: "correct-horse-9" }, { ip: `10.8.${i}.1` });
  await withSystem((db) => db.query("insert into platform.organization_members (organization_id, user_id, role_id) values ($1, $2, $3)", [t.org.id, user.id, role]));
  return resolveTenant(user.id, t.org.slug);
}

beforeAll(async () => {
  A = await makeTenant("dash");
  B = await makeTenant("dash-b");
  scope = { appId: A.app.id, environmentId: A.dev.id, timezone: "UTC" };
  const sdk = (await authenticateIngestionKey(A.sdkKey))!;
  await ingest(sdk, {
    batch: [
      track("signup", "u1", 30), track("purchase_completed", "u1", 20, { revenue: 50, currency: "SAR" }),
      track("signup", "u2", 30),
    ],
  }, { mode: "batch" });
  await processPendingEvents({ environmentId: A.dev.id, limit: 100 });
});

describe("dashboards", () => {
  let id: string;

  it("creates, lists, renames and deletes dashboards with an audit trail", async () => {
    id = (await createDashboard(A.ctx, A.app.id, { name: "Growth" })).id;
    const tmp = (await createDashboard(A.ctx, A.app.id, { name: "Scratch", visibility: "private" })).id;
    expect((await listDashboards(A.ctx, A.app.id)).map((d) => [d.name, d.visibility])).toEqual([["Growth", "workspace"], ["Scratch", "private"]]);
    await updateDashboard(A.ctx, id, { name: "Growth KPIs", description: "Weekly review" });
    expect((await getDashboard(A.ctx, id)).dashboard).toMatchObject({ name: "Growth KPIs", description: "Weekly review", widget_count: 0 });
    await deleteDashboard(A.ctx, tmp);
    await expect(getDashboard(A.ctx, tmp)).rejects.toBeInstanceOf(NotFoundError);
    await expect(createDashboard(A.ctx, A.app.id, { name: "" })).rejects.toBeInstanceOf(ValidationError);
    const actions = await withSystem((db) => db.query<{ action: string }>("select action from platform.audit_logs where organization_id = $1 and action like 'dashboard.%' order by id", [A.org.id]));
    expect(actions.map((a) => a.action)).toEqual(["dashboard.created", "dashboard.created", "dashboard.updated", "dashboard.deleted"]);
  });

  it("adds widgets from saved reports and inline configs, and runs each in the selected environment", async () => {
    const report = await saveReport(A.ctx, A.dev.id, { name: "Signups", kind: "trend", query: new URLSearchParams({ event: "signup", days: "7" }) });
    await addWidget(A.ctx, id, { type: "trend", savedReportId: report.id, w: 12 });
    await addWidget(A.ctx, id, { type: "kpi", title: "Buyers", config: { metric: "people", event: "purchase_completed", days: "7" }, w: 3 });
    await addWidget(A.ctx, id, { type: "funnel", config: { steps: ["signup", "purchase_completed"], days: "7" } });
    await addWidget(A.ctx, id, { type: "retention", config: { startEvent: "signup", returnEvent: "purchase_completed", days: "7" } });
    await addWidget(A.ctx, id, { type: "revenue", config: { days: "7" } });
    await addWidget(A.ctx, id, { type: "growth", config: { metric: "activation_rate" } });
    const audience = (await createAudience(A.ctx, A.dev.id, { name: "Signed up", definition: { type: "event", event: "signup" } })).id;
    await addWidget(A.ctx, id, { type: "audience_size", config: { audienceId: audience } });

    const { widgets } = await getDashboard(A.ctx, id);
    expect(widgets.map((w) => w.type)).toEqual(["trend", "kpi", "funnel", "retention", "revenue", "growth", "audience_size"]);
    expect(widgets[0]).toMatchObject({ saved_report_name: "Signups", config: null, y: 0, w: 12 });
    expect(widgets[1]).toMatchObject({ title: "Buyers", config: { metric: "people", event: "purchase_completed", days: 7 } });
    expect(widgets[1].y).toBe(2); // placed below what is already there

    const results = await Promise.all(widgets.map((w) => runWidget(A.ctx, scope, w)));
    const data = results.map((r) => (r.ok ? r.data : r.error));
    expect(data[0]).toMatchObject({ type: "trend", trend: { total: { count: 2, people: 2 } } });
    expect(data[1]).toMatchObject({ type: "kpi", kpi: { value: 1 } });
    expect(data[2]).toMatchObject({ type: "funnel", funnel: { steps: [{ people: 2 }, { people: 1 }] } });
    expect(data[3]).toMatchObject({ type: "retention" });
    expect(data[4]).toMatchObject({ type: "revenue", revenue: { currencies: [{ currency: "SAR", net: 50 }] } });
    expect(data[5]).toMatchObject({ type: "growth", enabled: false, value: null });
    expect(data[6]).toEqual({ type: "audience_size", name: "Signed up", size: 2 });

    // The same dashboard in production: same widgets, production's (empty) data; the dev audience isn't there.
    const prod = A.environments.find((e) => e.type === "production")!;
    const inProd = await Promise.all(widgets.map((w) => runWidget(A.ctx, { ...scope, environmentId: prod.id }, w)));
    expect(inProd[0]).toMatchObject({ ok: true, data: { trend: { total: { count: 0 } } } });
    expect(inProd[6]).toEqual({ ok: false, error: "That audience doesn't exist in this environment." });
  });

  it("validates widgets with the report schemas", async () => {
    await expect(addWidget(A.ctx, id, { type: "funnel", config: { steps: ["one"] } })).rejects.toThrow(/two steps/);
    await expect(addWidget(A.ctx, id, { type: "kpi", config: { metric: "events" } })).rejects.toThrow(/Choose an event/);
    await expect(addWidget(A.ctx, id, { type: "growth", config: { metric: "x" } })).rejects.toBeInstanceOf(ValidationError);
    await expect(addWidget(A.ctx, id, { type: "pie" })).rejects.toBeInstanceOf(ValidationError);
    await expect(addWidget(A.ctx, id, { type: "kpi", config: { metric: "active_people" }, x: 10, w: 4 })).rejects.toThrow(/fit/);
    const funnelReport = await saveReport(A.ctx, A.dev.id, { name: "Signup funnel", kind: "funnel", query: new URLSearchParams([["step", "signup"], ["step", "purchase_completed"]]) });
    await expect(addWidget(A.ctx, id, { type: "trend", savedReportId: funnelReport.id })).rejects.toThrow(/is a funnel/);
    await expect(addWidget(A.ctx, id, { type: "growth", savedReportId: funnelReport.id })).rejects.toThrow(/report widgets/);
  });

  it("edits, moves, resizes and removes widgets", async () => {
    const { widgets } = await getDashboard(A.ctx, id);
    await updateWidget(A.ctx, id, widgets[1].id, { title: "Paying people", config: { metric: "people", event: "purchase_completed", days: 30 } });
    await saveLayout(A.ctx, id, [{ id: widgets[1].id, x: 6, y: 0, w: 6, h: 3 }, { id: widgets[0].id, x: 0, y: 0, w: 6, h: 3 }]);
    const after = (await getDashboard(A.ctx, id)).widgets;
    expect(after.slice(0, 2).map((w) => [w.id, w.x, w.w, w.h])).toEqual([[widgets[0].id, 0, 6, 3], [widgets[1].id, 6, 6, 3]]);
    expect(after[1]).toMatchObject({ title: "Paying people", config: { days: 30 } });
    await expect(saveLayout(A.ctx, id, [{ id: widgets[0].id, x: 8, y: 0, w: 6, h: 2 }])).rejects.toThrow(/fit/);
    await removeWidget(A.ctx, id, widgets[6].id);
    expect((await getDashboard(A.ctx, id)).widgets).toHaveLength(6);
  });

  it("shows a deleted saved report as a widget message, not an error page", async () => {
    await withSystem((db) => db.query("delete from platform.analytics_saved_reports where name = 'Signups' and environment_id = $1", [A.dev.id]));
    const [first] = (await getDashboard(A.ctx, id)).widgets;
    expect(await runWidget(A.ctx, scope, first)).toEqual({ ok: false, error: "The saved report behind this widget was deleted." });
  });

  it("reads Activation numbers as values and rates", () => {
    const s = { people: 10, activated: 4, core_people: 3, core_actions: 9, paying: 2, purchases: 5, revenue: [], retention: [{ day: 1, eligible: 8, retained: 2 }, { day: 7, eligible: 0, retained: 0 }, { day: 30, eligible: 0, retained: 0 }] };
    expect(growthValue(s, "activation_rate")).toEqual({ value: 0.4, rate: true });
    expect(growthValue(s, "d1")).toEqual({ value: 0.25, rate: true });
    expect(growthValue(s, "d7")).toEqual({ value: null, rate: true });
    expect(growthValue(s, "paying")).toEqual({ value: 2, rate: false });
  });
});

describe("access", () => {
  it("follows RBAC: viewers view, analysts and marketers edit, private stays private", async () => {
    const [viewer, analyst, marketer] = [await member(A, "viewer", 1), await member(A, "analyst", 2), await member(A, "marketer", 3)];
    const shared = (await createDashboard(A.ctx, A.app.id, { name: "Shared" })).id;
    const mine = (await createDashboard(analyst, A.app.id, { name: "Analyst's own", visibility: "private" })).id;

    expect((await listDashboards(viewer, A.app.id)).map((d) => d.name)).toContain("Shared");
    expect((await listDashboards(viewer, A.app.id)).map((d) => d.name)).not.toContain("Analyst's own");
    await expect(createDashboard(viewer, A.app.id, { name: "No" })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(addWidget(viewer, shared, { type: "kpi", config: { metric: "active_people" } })).rejects.toBeInstanceOf(ForbiddenError);

    await expect(addWidget(marketer, shared, { type: "kpi", config: { metric: "active_people" } })).resolves.toHaveProperty("id");
    await expect(getDashboard(marketer, mine)).rejects.toBeInstanceOf(NotFoundError);
    await expect(deleteDashboard(A.ctx, mine)).rejects.toBeInstanceOf(NotFoundError); // even the owner role doesn't see someone's private dashboard
    await expect(updateDashboard(marketer, shared, { name: "Shared", visibility: "private" })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(getDashboard(analyst, mine)).resolves.toBeDefined();
  });

  it("stays inside the workspace", async () => {
    const [d] = await listDashboards(A.ctx, A.app.id);
    expect(await listDashboards(B.ctx, A.app.id)).toEqual([]);
    await expect(getDashboard(B.ctx, d.id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(addWidget(B.ctx, d.id, { type: "kpi", config: { metric: "active_people" } })).rejects.toBeInstanceOf(NotFoundError);
    await expect(createDashboard(B.ctx, A.app.id, { name: "Steal" })).rejects.toBeInstanceOf(NotFoundError);
    // A widget can't point at another workspace's saved report.
    const bReport = await saveReport(B.ctx, B.dev.id, { name: "B report", kind: "trend", query: new URLSearchParams({ event: "x" }) });
    await expect(addWidget(A.ctx, d.id, { type: "trend", savedReportId: bReport.id })).rejects.toBeInstanceOf(NotFoundError);
    const rows = await withTenant({ organizationId: B.org.id, userId: B.user.id }, async (db) => {
      await db.query("set local role platform_app");
      return [...(await db.query("select id from platform.dashboards")), ...(await db.query("select id from platform.dashboard_widgets"))];
    });
    expect(rows).toEqual([]);
  });
});
