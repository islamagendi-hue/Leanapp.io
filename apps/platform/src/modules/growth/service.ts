import "server-only";
import { withTenant, type Db } from "@/lib/db";
import { NotFoundError, ValidationError } from "@/lib/errors";
import { appFeatures, setAppFeature } from "@/modules/apps/features";
import { loadPlanEvents } from "@/modules/implementation/plan-store";
import { latestJobs, enqueueReprocess, type ReprocessJob } from "@/modules/reprocess/jobs";
import { tenantTx, type TenantContext } from "@/modules/tenancy/context";
import { effectiveDefinition, growthDefinitionSchema, type GrowthDefinition } from "./definition";
import { REVENUE_SELECT, summarySelect, windowSelectSql } from "./sql";

/**
 * Growth model for the dashboard and the management API: definitions (read
 * from the plan versions), the growth summary (from growth_state), a preview
 * of a candidate definition over the last 30 days, and the feature switch.
 */

export interface GrowthSummary {
  people: number;
  activated: number;
  core_people: number;
  core_actions: number;
  paying: number;
  purchases: number;
  revenue: { currency: string; total: number }[];
  retention: { day: number; eligible: number; retained: number }[];
}

type SummaryRow = Omit<GrowthSummary, "revenue" | "retention"> & Record<string, number>;

function shape(row: SummaryRow | null, revenue: { currency: string; total: number }[]): GrowthSummary {
  const r = row ?? ({ people: 0, activated: 0, core_people: 0, core_actions: 0, paying: 0, purchases: 0 } as SummaryRow);
  return {
    people: r.people,
    activated: r.activated,
    core_people: r.core_people,
    core_actions: r.core_actions,
    paying: r.paying,
    purchases: r.purchases,
    revenue,
    retention: [1, 7, 30].map((d) => ({ day: d, eligible: r[`d${d}_eligible`] ?? 0, retained: r[`d${d}_retained`] ?? 0 })),
  };
}

export interface GrowthDefinitions {
  /** What the growth state is computed with now (the published version's definitions). */
  published: { versionId: string; version: number; definition: GrowthDefinition; saved: boolean } | null;
  /** The working draft's definitions, when there is a draft. */
  draft: { versionId: string; version: number; definition: GrowthDefinition; saved: boolean; events: string[] } | null;
}

async function definitions(db: Db, appId: string): Promise<GrowthDefinitions> {
  const versions = await db.query<{ id: string; version: number; status: string; growth: unknown; activation_event: string | null; north_star_event: string | null }>(
    `select v.id, v.version, v.status, v.growth, v.activation_event, v.north_star_event
       from platform.tracking_plan_versions v join platform.tracking_plans p on p.id = v.tracking_plan_id
      where p.app_id = $1 and (v.id = p.published_version_id or v.status = 'draft')
      order by v.version desc`,
    [appId],
  );
  const load = async (v: (typeof versions)[number] | undefined) => {
    if (!v) return null;
    const events = await loadPlanEvents(db, v.id);
    return { versionId: v.id, version: v.version, definition: effectiveDefinition(v, events), saved: v.growth != null, events: events.map((e) => e.event_name) };
  };
  const published = await load(versions.find((v) => v.status === "published"));
  const draft = await load(versions.find((v) => v.status === "draft"));
  return { published: published && { versionId: published.versionId, version: published.version, definition: published.definition, saved: published.saved }, draft };
}

export interface GrowthOverview {
  enabled: boolean;
  definitions: GrowthDefinitions;
  summary: GrowthSummary | null;
  lastUpdatedAt: Date | null;
  jobs: ReprocessJob[];
}

/** Everything the growth page shows for one environment. */
export function growthOverview(ctx: TenantContext, appId: string, environmentId: string): Promise<GrowthOverview> {
  return tenantTx(ctx, "growth.read", async (db) => {
    const features = await appFeatures(db, appId);
    const defs = await definitions(db, appId);
    const jobs = (await latestJobs(db, appId)).filter((j) => j.environment_id === environmentId);
    if (!features.growth_model) return { enabled: false, definitions: defs, summary: null, lastUpdatedAt: null, jobs };
    const { summary, updatedAt } = await summaryFor(db, environmentId);
    return { enabled: true, definitions: defs, summary, lastUpdatedAt: updatedAt, jobs };
  });
}

async function summaryFor(db: Db, environmentId: string) {
  const rows = "rows as (select * from platform.growth_state where environment_id = $1)";
  const tz = await db.one<{ timezone: string }>(
    "select a.timezone from platform.apps a join platform.environments e on e.app_id = a.id where e.id = $1",
    [environmentId],
  );
  const row = await db.one<SummaryRow>(`with ${rows} ${summarySelect("$2")}`, [environmentId, tz?.timezone ?? "UTC"]);
  const revenue = await db.query<{ currency: string; total: number }>(`with ${rows} ${REVENUE_SELECT}`, [environmentId]);
  const updated = await db.one<{ at: Date | null }>("select max(updated_at) as at from platform.growth_state where environment_id = $1", [environmentId]);
  return { summary: shape(row, revenue), updatedAt: updated?.at ?? null };
}

/**
 * What a candidate definition gives over the last 30 days of an environment,
 * computed directly from events (nothing is saved).
 */
export function previewDefinition(ctx: TenantContext, appId: string, environmentId: string, input: unknown, opts: { days?: number } = {}): Promise<GrowthSummary> {
  const parsed = growthDefinitionSchema.safeParse(input);
  if (!parsed.success) throw new ValidationError(parsed.error.issues.map((i) => i.message).join(" "));
  return tenantTx(ctx, "growth.read", async (db) => {
    const app = await db.one<{ default_currency: string; timezone: string }>(
      "select a.default_currency, a.timezone from platform.apps a join platform.environments e on e.app_id = a.id where a.id = $1 and e.id = $2",
      [appId, environmentId],
    );
    if (!app) throw new NotFoundError("Environment");
    const { sql, params } = windowSelectSql(parsed.data, app.default_currency, app.timezone);
    const since = new Date(Date.now() - (opts.days ?? 30) * 86_400_000);
    const values = [environmentId, since, ...params.values.slice(2)];
    // The window SQL binds the timezone first after its reserved values ($3).
    const row = await db.one<SummaryRow>(`with rows as (${sql}) ${summarySelect("$3")}`, values);
    const revenue = await db.query<{ currency: string; total: number }>(`with rows as (${sql}) ${REVENUE_SELECT}`, values);
    return shape(row, revenue);
  });
}

/** Turns the growth model on (queues the first build of growth state) or off. */
export function setGrowthModel(ctx: TenantContext, appId: string, on: boolean) {
  return setAppFeature(ctx, appId, "growth_model", on, (db) => enqueueReprocess(db, appId, "growth_rebuild", "growth model turned on", ctx.userId));
}

/** Turns mapping history on (queues a re-map of all past events) or off. */
export function setMappingHistory(ctx: TenantContext, appId: string, on: boolean) {
  return setAppFeature(ctx, appId, "mapping_history", on, (db) => enqueueReprocess(db, appId, "remap", "mapping history turned on", ctx.userId));
}

export function growthDefinitions(ctx: TenantContext, appId: string): Promise<GrowthDefinitions> {
  return tenantTx(ctx, "growth.read", (db) => definitions(db, appId));
}

// ── Management API (secret key scoped to one app and environment) ───────────
export interface KeyScope {
  organizationId: string;
  appId: string;
  environmentId: string;
}

export function apiGrowthDefinition(key: KeyScope) {
  return withTenant({ organizationId: key.organizationId, userId: null }, async (db) => {
    const features = await appFeatures(db, key.appId);
    const defs = await definitions(db, key.appId);
    if (!defs.published) throw new NotFoundError("Published tracking plan");
    return {
      enabled: features.growth_model,
      plan_version: defs.published.version,
      plan_version_id: defs.published.versionId,
      source: defs.published.saved ? "saved" : "derived",
      definition: defs.published.definition,
    };
  });
}

export function apiGrowthSummary(key: KeyScope) {
  return withTenant({ organizationId: key.organizationId, userId: null }, async (db) => {
    const features = await appFeatures(db, key.appId);
    const jobs = (await latestJobs(db, key.appId)).filter((j) => j.environment_id === key.environmentId && j.kind === "growth_rebuild");
    if (!features.growth_model) return { enabled: false, summary: null };
    const { summary, updatedAt } = await summaryFor(db, key.environmentId);
    const rebuilding = jobs.find((j) => j.status === "queued" || j.status === "running");
    return {
      enabled: true,
      updated_at: updatedAt,
      rebuilding: rebuilding ? { status: rebuilding.status, done: rebuilding.done_count, total_estimate: rebuilding.total_estimate } : null,
      summary,
    };
  });
}

/** Latest re-map and growth-rebuild jobs of the app, per environment (progress on the dashboard). */
export function listReprocessJobs(ctx: TenantContext, appId: string): Promise<ReprocessJob[]> {
  return tenantTx(ctx, "implementation.read", (db) => latestJobs(db, appId));
}
