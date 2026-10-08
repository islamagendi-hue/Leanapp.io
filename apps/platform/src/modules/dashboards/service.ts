import "server-only";
import { z } from "zod";
import type { Db } from "@/lib/db";
import { AppError, ForbiddenError, NotFoundError, ValidationError } from "@/lib/errors";
import { cachedReport } from "@/modules/analytics/cache";
import { startEventOf } from "@/modules/analytics/overview";
import { revenueReport, type RevenueReport } from "@/modules/analytics/revenue";
import { reportConfig } from "@/modules/analytics/saved-reports";
import {
  analyticsTx, eventTrend, funnel, kpi, kpiSchema, retention, topEvents, type Funnel, type Kpi, type Retention, type Trend,
} from "@/modules/analytics/service";
import { audit } from "@/modules/audit/service";
import { compileAudience, parseDefinition } from "@/modules/audiences/definition";
import { growthOverview, type GrowthSummary } from "@/modules/growth/service";
import { can } from "@/modules/rbac/authorize";
import type { TenantContext } from "@/modules/tenancy/context";
import { planTemplate, TEMPLATE_INFO, TEMPLATES, type TemplateFacts } from "./templates";

/**
 * Dashboards: named grids of widgets per project. A dashboard is viewed in the
 * selected environment; each widget runs a report there when the dashboard is
 * opened (through the report result cache). Nothing is precomputed or copied.
 *
 * Widgets reuse what already exists: a saved report (its config), or an inline
 * config validated by the same report schemas. Types: trend, funnel,
 * retention, revenue, kpi, growth (Activation numbers) and audience_size.
 *
 * Access: viewing needs analytics.read, changing needs analytics.write.
 * Workspace dashboards are shared with everyone who can see analytics;
 * private ones exist only for the person who made them.
 */

export const WIDGET_TYPES = ["trend", "funnel", "retention", "revenue", "kpi", "growth", "audience_size"] as const;
export type WidgetType = (typeof WIDGET_TYPES)[number];
export const REPORT_WIDGETS = ["trend", "funnel", "retention", "revenue"] as const;
export const GROWTH_METRICS = ["people", "activated", "activation_rate", "core_people", "paying", "d1", "d7", "d30"] as const;
export type GrowthMetric = (typeof GROWTH_METRICS)[number];

export const MAX_DASHBOARDS = 50;
export const MAX_WIDGETS = 30;
export const GRID_COLUMNS = 12;

export interface Dashboard {
  id: string;
  app_id: string;
  name: string;
  description: string | null;
  visibility: "workspace" | "private";
  created_by: string | null;
  created_by_name: string | null;
  updated_at: Date;
  widget_count: number;
}

export interface Widget {
  id: string;
  type: WidgetType;
  title: string | null;
  saved_report_id: string | null;
  saved_report_name: string | null;
  config: Record<string, unknown> | null;
  x: number;
  y: number;
  w: number;
  h: number;
}

const uuid = z.uuid();
const dashboardInput = z.object({
  name: z.string().trim().min(1, "Name the dashboard.").max(80),
  description: z.string().trim().max(500).optional().transform((v) => v || null),
  visibility: z.enum(["workspace", "private"]).default("workspace"),
});

const position = z.object({
  x: z.coerce.number().int().min(0).max(GRID_COLUMNS - 1).default(0),
  y: z.coerce.number().int().min(0).max(500).optional(),
  w: z.coerce.number().int().min(1).max(GRID_COLUMNS).default(6),
  h: z.coerce.number().int().min(1).max(8).default(2),
});

const widgetInput = z
  .object({
    type: z.enum(WIDGET_TYPES),
    title: z.string().trim().max(80).optional().transform((v) => v || null),
    savedReportId: uuid.optional(),
    config: z.record(z.string(), z.unknown()).optional(),
  })
  .and(position);

function parse<S extends z.ZodType>(schema: S, input: unknown): z.output<S> {
  const r = schema.safeParse(input);
  if (!r.success) throw new ValidationError(r.error.issues[0]?.message ?? "Invalid input.");
  return r.data;
}

const dropUndefined = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));

/** A widget's inline config, validated by its type's schema (the report schemas for reports). */
export function widgetConfig(type: WidgetType, input: unknown): Record<string, unknown> {
  switch (type) {
    case "trend":
    case "funnel":
    case "retention":
    case "revenue":
      return reportConfig(type, input).config;
    case "kpi":
      return dropUndefined(parse(kpiSchema, input) as Record<string, unknown>);
    case "growth":
      return parse(z.object({ metric: z.enum(GROWTH_METRICS) }), input);
    case "audience_size":
      return parse(z.object({ audienceId: z.uuid("Choose an audience.") }), input);
  }
}

const SELECT_DASHBOARD = `select d.id, d.app_id, d.name, d.description, d.visibility, d.created_by, d.updated_at,
  (select u.name from platform.users u where u.id = d.created_by) as created_by_name,
  (select count(*)::int from platform.dashboard_widgets w where w.dashboard_id = d.id) as widget_count
  from platform.dashboards d`;
const VISIBLE = "(d.visibility = 'workspace' or d.created_by = $2)";

export function listDashboards(ctx: TenantContext, appId: string): Promise<Dashboard[]> {
  return analyticsTx(ctx, (db) =>
    db.query<Dashboard>(`${SELECT_DASHBOARD} where d.app_id = $1 and ${VISIBLE} order by lower(d.name), d.id`, [appId, ctx.userId]),
  );
}

async function loadDashboard(db: Db, ctx: TenantContext, id: string): Promise<Dashboard> {
  if (!uuid.safeParse(id).success) throw new NotFoundError("Dashboard");
  const d = await db.one<Dashboard>(`${SELECT_DASHBOARD} where d.id = $1 and ${VISIBLE}`, [id, ctx.userId]);
  if (!d) throw new NotFoundError("Dashboard");
  return d;
}

export async function getDashboard(ctx: TenantContext, id: string): Promise<{ dashboard: Dashboard; widgets: Widget[] }> {
  return analyticsTx(ctx, async (db) => {
    const dashboard = await loadDashboard(db, ctx, id);
    const widgets = await db.query<Widget>(
      `select w.id, w.type, w.title, w.saved_report_id, r.name as saved_report_name, w.config, w.x, w.y, w.w, w.h
         from platform.dashboard_widgets w left join platform.analytics_saved_reports r on r.id = w.saved_report_id
        where w.dashboard_id = $1 order by w.y, w.x, w.created_at`,
      [id],
    );
    return { dashboard, widgets };
  });
}

/** Changing a dashboard: analytics.write, and only its creator for a private one. */
async function editable(db: Db, ctx: TenantContext, id: string): Promise<Dashboard> {
  const d = await loadDashboard(db, ctx, id);
  if (d.visibility === "private" && d.created_by !== ctx.userId) throw new NotFoundError("Dashboard");
  return d;
}

function write<T>(ctx: TenantContext, fn: (db: Db) => Promise<T>): Promise<T> {
  return analyticsTx(ctx, fn, "analytics.write");
}

export async function createDashboard(ctx: TenantContext, appId: string, input: unknown): Promise<{ id: string }> {
  const data = parse(dashboardInput, input);
  return write(ctx, async (db) => ({ id: await insertDashboard(db, ctx, appId, data) }));
}

async function insertDashboard(db: Db, ctx: TenantContext, appId: string, data: z.output<typeof dashboardInput>): Promise<string> {
  const app = await db.one<{ id: string }>("select id from platform.apps where id = $1", [appId]);
  if (!app) throw new NotFoundError("Project");
  const n = await db.one<{ n: number }>("select count(*)::int as n from platform.dashboards where app_id = $1", [appId]);
  if (n!.n >= MAX_DASHBOARDS) throw new ValidationError(`A project can have at most ${MAX_DASHBOARDS} dashboards.`);
  const row = await db.one<{ id: string }>(
    `insert into platform.dashboards (organization_id, app_id, name, description, visibility, created_by, updated_by)
     values ($1, $2, $3, $4, $5, $6, $6) returning id`,
    [ctx.organizationId, appId, data.name, data.description, data.visibility, ctx.userId],
  );
  await audit(db, { organizationId: ctx.organizationId, actorUserId: ctx.userId, action: "dashboard.created", targetType: "dashboard", targetId: row!.id, metadata: { name: data.name, visibility: data.visibility } });
  return row!.id;
}

export async function updateDashboard(ctx: TenantContext, id: string, input: unknown): Promise<void> {
  const data = parse(dashboardInput, input);
  await write(ctx, async (db) => {
    const d = await editable(db, ctx, id);
    // Only the creator can make a shared dashboard private (others would lose it).
    if (data.visibility === "private" && d.visibility === "workspace" && d.created_by !== ctx.userId) {
      throw new ForbiddenError("Only the person who made this dashboard can make it private.");
    }
    await db.query("update platform.dashboards set name = $2, description = $3, visibility = $4, updated_by = $5 where id = $1", [id, data.name, data.description, data.visibility, ctx.userId]);
    await audit(db, { organizationId: ctx.organizationId, actorUserId: ctx.userId, action: "dashboard.updated", targetType: "dashboard", targetId: id, metadata: { name: data.name, visibility: data.visibility } });
  });
}

export async function deleteDashboard(ctx: TenantContext, id: string): Promise<void> {
  await write(ctx, async (db) => {
    const d = await editable(db, ctx, id);
    await db.query("delete from platform.dashboards where id = $1", [id]);
    await audit(db, { organizationId: ctx.organizationId, actorUserId: ctx.userId, action: "dashboard.deleted", targetType: "dashboard", targetId: id, metadata: { name: d.name } });
  });
}

export async function addWidget(ctx: TenantContext, dashboardId: string, input: unknown): Promise<{ id: string }> {
  const data = parse(widgetInput, input);
  if (data.x + data.w > GRID_COLUMNS) throw new ValidationError("The widget doesn't fit in the grid.");
  return write(ctx, async (db) => {
    const d = await editable(db, ctx, dashboardId);
    const count = await db.one<{ n: number; bottom: number }>(
      "select count(*)::int as n, coalesce(max(y + h), 0)::int as bottom from platform.dashboard_widgets where dashboard_id = $1",
      [dashboardId],
    );
    if (count!.n >= MAX_WIDGETS) throw new ValidationError(`A dashboard can have at most ${MAX_WIDGETS} widgets.`);
    let savedReportId: string | null = null;
    let config: Record<string, unknown> | null = null;
    if (data.savedReportId) {
      if (!(REPORT_WIDGETS as readonly string[]).includes(data.type)) throw new ValidationError("Only report widgets can use a saved report.");
      const report = await db.one<{ kind: string }>(
        `select r.kind from platform.analytics_saved_reports r join platform.environments e on e.id = r.environment_id
          where r.id = $1 and e.app_id = $2`,
        [data.savedReportId, d.app_id],
      );
      if (!report) throw new NotFoundError("Saved report");
      if (report.kind !== data.type) throw new ValidationError(`That saved report is a ${report.kind}, not a ${data.type}.`);
      savedReportId = data.savedReportId;
    } else {
      config = widgetConfig(data.type, data.config ?? {});
    }
    const row = await db.one<{ id: string }>(
      `insert into platform.dashboard_widgets (organization_id, dashboard_id, type, title, saved_report_id, config, x, y, w, h)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) returning id`,
      [ctx.organizationId, dashboardId, data.type, data.title, savedReportId, config && JSON.stringify(config), data.x, data.y ?? count!.bottom, data.w, data.h],
    );
    await touch(db, ctx, dashboardId, "widget_added", { type: data.type });
    return { id: row!.id };
  });
}

export async function updateWidget(ctx: TenantContext, dashboardId: string, widgetId: string, input: { title?: unknown; config?: unknown }): Promise<void> {
  if (!uuid.safeParse(widgetId).success) throw new NotFoundError("Widget");
  await write(ctx, async (db) => {
    await editable(db, ctx, dashboardId);
    const w = await db.one<{ type: WidgetType; saved_report_id: string | null }>("select type, saved_report_id from platform.dashboard_widgets where id = $1 and dashboard_id = $2", [widgetId, dashboardId]);
    if (!w) throw new NotFoundError("Widget");
    const title = parse(z.string().trim().max(80).optional().transform((v) => v || null), input.title);
    const config = input.config === undefined || w.saved_report_id ? undefined : widgetConfig(w.type, input.config);
    await db.query(
      "update platform.dashboard_widgets set title = $3, config = coalesce($4::jsonb, config) where id = $1 and dashboard_id = $2",
      [widgetId, dashboardId, title, config ? JSON.stringify(config) : null],
    );
    await touch(db, ctx, dashboardId, "widget_updated", { widgetId });
  });
}

export async function removeWidget(ctx: TenantContext, dashboardId: string, widgetId: string): Promise<void> {
  if (!uuid.safeParse(widgetId).success) throw new NotFoundError("Widget");
  await write(ctx, async (db) => {
    await editable(db, ctx, dashboardId);
    const row = await db.one("delete from platform.dashboard_widgets where id = $1 and dashboard_id = $2 returning id", [widgetId, dashboardId]);
    if (!row) throw new NotFoundError("Widget");
    await touch(db, ctx, dashboardId, "widget_removed", { widgetId });
  });
}

/** Saves the grid: every listed widget's position and size (reorder and resize). */
export async function saveLayout(ctx: TenantContext, dashboardId: string, layout: unknown): Promise<void> {
  const items = parse(z.array(z.object({ id: uuid }).and(position.required({ y: true }))).max(MAX_WIDGETS), layout);
  for (const i of items) if (i.x + i.w > GRID_COLUMNS) throw new ValidationError("A widget doesn't fit in the grid.");
  await write(ctx, async (db) => {
    await editable(db, ctx, dashboardId);
    for (const i of items) {
      const row = await db.one("update platform.dashboard_widgets set x = $3, y = $4, w = $5, h = $6 where id = $1 and dashboard_id = $2 returning id", [i.id, dashboardId, i.x, i.y, i.w, i.h]);
      if (!row) throw new NotFoundError("Widget");
    }
    await touch(db, ctx, dashboardId, "layout_saved", { widgets: items.length });
  });
}

export const MOVES = ["up", "down", "wider", "narrower", "taller", "shorter"] as const;
export type Move = (typeof MOVES)[number];

/**
 * Reorders or resizes one widget. Widgets flow in order (y, then x) through
 * the 12-column grid, so moving swaps a widget with its neighbour; widths
 * step by 3 columns (3 to 12) and heights by one row (1 to 8).
 */
export async function moveWidget(ctx: TenantContext, dashboardId: string, widgetId: string, move: unknown): Promise<void> {
  const m = parse(z.enum(MOVES), move);
  if (!uuid.safeParse(widgetId).success) throw new NotFoundError("Widget");
  await write(ctx, async (db) => {
    await editable(db, ctx, dashboardId);
    const list = await db.query<{ id: string; w: number; h: number }>("select id, w, h from platform.dashboard_widgets where dashboard_id = $1 order by y, x, created_at", [dashboardId]);
    const i = list.findIndex((w) => w.id === widgetId);
    if (i < 0) throw new NotFoundError("Widget");
    const w = list[i];
    if (m === "up" && i > 0) [list[i - 1], list[i]] = [list[i], list[i - 1]];
    if (m === "down" && i < list.length - 1) [list[i + 1], list[i]] = [list[i], list[i + 1]];
    if (m === "wider") w.w = Math.min(GRID_COLUMNS, w.w + 3);
    if (m === "narrower") w.w = Math.max(3, w.w - 3);
    if (m === "taller") w.h = Math.min(8, w.h + 1);
    if (m === "shorter") w.h = Math.max(1, w.h - 1);
    for (const [order, item] of list.entries()) {
      await db.query("update platform.dashboard_widgets set x = 0, y = $3, w = $4, h = $5 where id = $1 and dashboard_id = $2", [item.id, dashboardId, order, item.w, item.h]);
    }
    await touch(db, ctx, dashboardId, "widget_moved", { widgetId, move: m });
  });
}

type Scope = { appId: string; environmentId: string; timezone: string };

/**
 * What templates can use in an environment: its most used events (last 30
 * days), the published Activation steps (when the person can read them) and a
 * couple of its audiences.
 */
export async function templateFacts(ctx: TenantContext, scope: Scope): Promise<TemplateFacts> {
  const env = { environmentId: scope.environmentId, timezone: scope.timezone };
  const events = (await topEvents(ctx, { ...env, days: 30 })).map((e) => e.name);
  const def = can(ctx.role, "growth.read") ? ((await growthOverview(ctx, scope.appId, scope.environmentId)).definitions.published?.definition ?? null) : null;
  const audiences = await analyticsTx(ctx, (db) =>
    db.query<{ id: string; name: string }>("select id, name from platform.audiences where environment_id = $1 and status <> 'archived' order by created_at limit 2", [scope.environmentId]),
  );
  return {
    startEvent: startEventOf(events),
    activationEvent: def?.activation?.event ?? null,
    coreEvent: def?.core_action?.event ?? null,
    revenueEvent: def?.revenue?.event ?? null,
    topEvents: events,
    audiences,
  };
}

/**
 * A new dashboard from a template, built from what the project defines
 * (Activation steps, the environment's events, its audiences). Widgets that
 * need something missing are skipped; their reasons come back. The dashboard
 * and its widgets are written in one transaction.
 */
export async function createFromTemplate(ctx: TenantContext, scope: Scope, template: unknown, opts: { visibility?: unknown } = {}): Promise<{ id: string; added: number; skipped: string[] }> {
  const id = parse(z.enum(TEMPLATES), template);
  if (!can(ctx.role, "analytics.write")) throw new ForbiddenError("You can't create dashboards.");
  const plan = planTemplate(id, await templateFacts(ctx, scope));
  const visibility = parse(dashboardInput.shape.visibility, opts.visibility ?? "workspace");
  const configs = plan.widgets.map((w) => widgetConfig(w.type, w.config));
  const dashboardId = await write(ctx, async (db) => {
    const dashboardId = await insertDashboard(db, ctx, scope.appId, { name: TEMPLATE_INFO[id].name, description: TEMPLATE_INFO[id].description, visibility });
    for (const [y, w] of plan.widgets.entries()) {
      await db.query(
        `insert into platform.dashboard_widgets (organization_id, dashboard_id, type, title, config, x, y, w, h) values ($1, $2, $3, $4, $5, 0, $6, $7, $8)`,
        [ctx.organizationId, dashboardId, w.type, w.title, JSON.stringify(configs[y]), y, w.w, w.h],
      );
    }
    await touch(db, ctx, dashboardId, "template_applied", { template: id, widgets: plan.widgets.length });
    return dashboardId;
  });
  return { id: dashboardId, added: plan.widgets.length, skipped: plan.skipped };
}

async function touch(db: Db, ctx: TenantContext, dashboardId: string, change: string, metadata: Record<string, unknown>) {
  await db.query("update platform.dashboards set updated_by = $2 where id = $1", [dashboardId, ctx.userId]);
  await audit(db, { organizationId: ctx.organizationId, actorUserId: ctx.userId, action: "dashboard.updated", targetType: "dashboard", targetId: dashboardId, metadata: { change, ...metadata } });
}

// ── Running widgets ─────────────────────────────────────────────────────────
export type WidgetData =
  | { type: "trend"; trend: Trend }
  | { type: "funnel"; funnel: Funnel }
  | { type: "retention"; retention: Retention }
  | { type: "revenue"; revenue: RevenueReport }
  | { type: "kpi"; kpi: Kpi }
  | { type: "growth"; metric: GrowthMetric; enabled: boolean; value: number | null; rate: boolean; summary: GrowthSummary | null }
  | { type: "audience_size"; name: string; size: number };

export type WidgetResult = { ok: true; data: WidgetData } | { ok: false; error: string };

/**
 * Runs one widget in an environment of the dashboard's project. Errors (a
 * deleted saved report or audience, a missing permission, a timeout) come back
 * as a message for that widget only, so one widget never breaks the dashboard.
 */
export async function runWidget(
  ctx: TenantContext,
  scope: { appId: string; environmentId: string; timezone: string },
  widget: Widget,
  opts: { fresh?: boolean } = {},
): Promise<WidgetResult> {
  try {
    return { ok: true, data: await run(ctx, scope, widget, opts) };
  } catch (e) {
    if (e instanceof AppError) return { ok: false, error: e.message };
    throw e;
  }
}

async function widgetInputOf(ctx: TenantContext, widget: Widget): Promise<Record<string, unknown>> {
  if (widget.config) return widget.config;
  if (!widget.saved_report_id) throw new ValidationError("The saved report behind this widget was deleted.");
  const row = await analyticsTx(ctx, (db) => db.one<{ config: Record<string, unknown> }>("select config from platform.analytics_saved_reports where id = $1", [widget.saved_report_id]));
  if (!row) throw new ValidationError("The saved report behind this widget was deleted.");
  return row.config;
}

async function run(ctx: TenantContext, scope: { appId: string; environmentId: string; timezone: string }, widget: Widget, opts: { fresh?: boolean }): Promise<WidgetData> {
  const env = { environmentId: scope.environmentId, timezone: scope.timezone };
  const cached = <T>(kind: Parameters<typeof cachedReport>[2], input: Record<string, unknown>, fn: () => Promise<T>) =>
    cachedReport(ctx, env, kind, input, fn, opts).then((r) => r.value);
  switch (widget.type) {
    case "trend": {
      const input = await widgetInputOf(ctx, widget);
      return { type: "trend", trend: await cached("trend", input, () => eventTrend(ctx, env, input)) };
    }
    case "funnel": {
      const input = await widgetInputOf(ctx, widget);
      return { type: "funnel", funnel: await cached("funnel", input, () => funnel(ctx, env, input)) };
    }
    case "retention": {
      const input = await widgetInputOf(ctx, widget);
      return { type: "retention", retention: await cached("retention", input, () => retention(ctx, env, input)) };
    }
    case "revenue": {
      const input = await widgetInputOf(ctx, widget);
      return { type: "revenue", revenue: await cached("revenue", input, () => revenueReport(ctx, env, input)) };
    }
    case "kpi": {
      const input = widget.config ?? {};
      return { type: "kpi", kpi: await cached("kpi", input, () => kpi(ctx, env, input)) };
    }
    case "growth": {
      const metric = (widget.config?.metric ?? "people") as GrowthMetric;
      if (!can(ctx.role, "growth.read")) throw new ForbiddenError("You don't have access to Activation.");
      const o = await growthOverview(ctx, scope.appId, scope.environmentId);
      return { type: "growth", metric, enabled: o.enabled, ...growthValue(o.summary, metric), summary: o.summary };
    }
    case "audience_size": {
      const input = widget.config ?? {};
      const id = String(input.audienceId ?? "");
      return cached("audience_size", { cohortId: id }, () => audienceSize(ctx, scope.environmentId, id));
    }
  }
}

/** One Activation number; rates are shares (0.25 = 25%), null when there's nothing to divide. */
export function growthValue(s: GrowthSummary | null, metric: GrowthMetric): { value: number | null; rate: boolean } {
  if (!s) return { value: null, rate: false };
  const ratio = (a: number, b: number) => (b > 0 ? a / b : null);
  switch (metric) {
    case "activation_rate":
      return { value: ratio(s.activated, s.people), rate: true };
    case "d1":
    case "d7":
    case "d30": {
      const r = s.retention.find((x) => x.day === Number(metric.slice(1)));
      return { value: r ? ratio(r.retained, r.eligible) : null, rate: true };
    }
    default:
      return { value: s[metric], rate: false };
  }
}

/** Members of an audience in the environment, computed now (drafts included). */
async function audienceSize(ctx: TenantContext, environmentId: string, id: string): Promise<WidgetData> {
  if (!uuid.safeParse(id).success) throw new ValidationError("Choose an audience.");
  return analyticsTx(ctx, async (db) => {
    const a = await db.one<{ name: string; definition: unknown }>(
      "select name, definition from platform.audiences where id = $1 and environment_id = $2 and status <> 'archived'",
      [id, environmentId],
    );
    if (!a) throw new ValidationError("That audience doesn't exist in this environment.");
    const { sql, params } = compileAudience(parseDefinition(a.definition), environmentId);
    const row = await db.one<{ n: string }>(`with target as (${sql}) select count(*) as n from target`, params);
    return { type: "audience_size" as const, name: a.name, size: Number(row!.n) };
  });
}
