import "server-only";
import { msg } from "@/i18n/translate";
import { isUniqueViolation, type Db } from "@/lib/db";
import { ConflictError, NotFoundError, ValidationError } from "@/lib/errors";
import { datesBetween, localDate } from "@/modules/analytics/range";
import { loadRevenueRules, NO_CURRENCY, revenueCtes } from "@/modules/analytics/revenue";
import { analyticsTx } from "@/modules/analytics/service";
import { COUNTED_EVENTS, evCte, Params, PERSON, propertyPredicate } from "@/modules/analytics/sql";
import { audit } from "@/modules/audit/service";
import { fill } from "@/modules/automation/messages";
import { tenantTx, type TenantContext } from "@/modules/tenancy/context";
import { buildExperiment, definitionOf, EXPOSURE_EVENT, ExperimentError, type ExperimentDefinition, type ExperimentForm, type ExperimentStatus } from "./definition";
import { alphaFor, compareProportions, enoughData, rate, sampleRatioMismatch, type Comparison, type SampleRatio } from "./stats";

/**
 * Experiments (A/B tests) per environment. Rights are the engagement rights:
 * automations.read to see experiments and their results, automations.manage to
 * create, edit, start and stop them (an experiment changes what end users see,
 * like a campaign). Creating, editing, starting and stopping are audited.
 *
 * Lifecycle: draft → running → stopped. Only a draft can be edited: once it
 * runs, assignment is a hash of the stored salt, variants, weights, traffic and
 * audience, so changing them would move people between variants mid-test.
 * A stopped experiment stays stopped (start a new one to test again).
 */

export interface ExperimentRow extends ExperimentDefinition {
  id: string;
  appId: string;
  environmentId: string;
  status: ExperimentStatus;
  salt: string;
  startedAt: Date | null;
  stoppedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

interface DbRow {
  id: string;
  app_id: string;
  environment_id: string;
  key: string;
  name: string;
  hypothesis: string | null;
  status: ExperimentStatus;
  salt: string;
  variants: unknown;
  traffic_percent: number;
  audience_id: string | null;
  goal: unknown;
  secondary: unknown;
  started_at: Date | null;
  stopped_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

const COLUMNS = `id, app_id, environment_id, key, name, hypothesis, status, salt, variants, traffic_percent, audience_id, goal, secondary,
  started_at, stopped_at, created_at, updated_at`;

function rowOf(r: DbRow): ExperimentRow {
  return {
    ...definitionOf(r),
    id: r.id, appId: r.app_id, environmentId: r.environment_id, status: r.status, salt: r.salt,
    startedAt: r.started_at, stoppedAt: r.stopped_at, createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

export async function listExperiments(ctx: TenantContext, environmentId: string): Promise<ExperimentRow[]> {
  const rows = await tenantTx(ctx, "automations.read", (db) =>
    db.query<DbRow>(
      `select ${COLUMNS} from platform.experiments where environment_id = $1
        order by case status when 'running' then 0 when 'draft' then 1 else 2 end, coalesce(started_at, created_at) desc`,
      [environmentId],
    ),
  );
  return rows.map(rowOf);
}

async function load(db: Db, id: string, forUpdate = false): Promise<ExperimentRow> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new NotFoundError("Experiment");
  const r = await db.one<DbRow>(`select ${COLUMNS} from platform.experiments where id = $1${forUpdate ? " for update" : ""}`, [id]);
  if (!r) throw new NotFoundError("Experiment");
  return rowOf(r);
}

export function getExperiment(ctx: TenantContext, id: string): Promise<ExperimentRow> {
  return tenantTx(ctx, "automations.read", (db) => load(db, id));
}

function parse(form: ExperimentForm): ExperimentDefinition {
  try {
    return buildExperiment(form);
  } catch (err) {
    if (err instanceof ExperimentError) throw new ValidationError(err.message);
    throw err;
  }
}

/** The audience must be in the experiment's environment and not archived. */
async function checkAudience(db: Db, environmentId: string, audienceId: string | null, mustBeActive: boolean): Promise<void> {
  if (!audienceId) return;
  const a = await db.one<{ name: string; status: string }>("select name, status from platform.audiences where id = $1 and environment_id = $2", [audienceId, environmentId]);
  if (!a || a.status === "archived") throw new ValidationError(msg("That audience doesn't exist in this environment."));
  if (mustBeActive && a.status !== "active") throw new ValidationError(fill(msg('Activate the audience "{name}" first.'), { name: a.name }));
}

const DUPLICATE_KEY = msg("Another experiment in this environment already uses this key.");

/** Saves a draft experiment. */
export async function createExperiment(ctx: TenantContext, environmentId: string, form: ExperimentForm): Promise<{ id: string }> {
  const d = parse(form);
  return tenantTx(ctx, "automations.manage", async (db) => {
    const env = await db.one<{ app_id: string }>("select app_id from platform.environments where id = $1", [environmentId]);
    if (!env) throw new NotFoundError("Environment");
    await checkAudience(db, environmentId, d.audienceId, false);
    try {
      const row = await db.one<{ id: string }>(
        `insert into platform.experiments (organization_id, app_id, environment_id, key, name, hypothesis, variants, traffic_percent, audience_id, goal, secondary, created_by, updated_by)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $12) returning id`,
        [ctx.organizationId, env.app_id, environmentId, d.key, d.name, d.hypothesis, JSON.stringify(d.variants), d.trafficPercent, d.audienceId,
          JSON.stringify(d.goal), d.secondary ? JSON.stringify(d.secondary) : null, ctx.userId],
      );
      await audit(db, { organizationId: ctx.organizationId, actorUserId: ctx.userId, action: "experiment.created", targetType: "experiment", targetId: row!.id, metadata: { key: d.key, name: d.name, variants: d.variants.map((v) => v.key) } });
      return { id: row!.id };
    } catch (err) {
      if (isUniqueViolation(err)) throw new ConflictError(DUPLICATE_KEY);
      throw err;
    }
  });
}

/** Changes a draft. Running and stopped experiments keep the setup people were assigned with. */
export async function updateExperiment(ctx: TenantContext, id: string, form: ExperimentForm): Promise<void> {
  const d = parse(form);
  await tenantTx(ctx, "automations.manage", async (db) => {
    const e = await load(db, id, true);
    if (e.status !== "draft") throw new ConflictError(msg("Only a draft can be changed: people are already assigned to this experiment's variants."));
    await checkAudience(db, e.environmentId, d.audienceId, false);
    try {
      await db.query(
        `update platform.experiments set key = $2, name = $3, hypothesis = $4, variants = $5, traffic_percent = $6, audience_id = $7, goal = $8, secondary = $9, updated_by = $10
          where id = $1`,
        [id, d.key, d.name, d.hypothesis, JSON.stringify(d.variants), d.trafficPercent, d.audienceId, JSON.stringify(d.goal), d.secondary ? JSON.stringify(d.secondary) : null, ctx.userId],
      );
    } catch (err) {
      if (isUniqueViolation(err)) throw new ConflictError(DUPLICATE_KEY);
      throw err;
    }
    await audit(db, { organizationId: ctx.organizationId, actorUserId: ctx.userId, action: "experiment.updated", targetType: "experiment", targetId: id, metadata: { key: d.key, name: d.name } });
  });
}

/** Starts assigning people: the app gets variants from the assignment API from now on. */
export async function startExperiment(ctx: TenantContext, id: string): Promise<void> {
  await tenantTx(ctx, "automations.manage", async (db) => {
    const e = await load(db, id, true);
    if (e.status !== "draft") throw new ConflictError(e.status === "running" ? msg("This experiment is already running.") : msg("A stopped experiment can't be started again. Create a new one to test again."));
    await checkAudience(db, e.environmentId, e.audienceId, true);
    await db.query("update platform.experiments set status = 'running', started_at = now(), updated_by = $2 where id = $1", [id, ctx.userId]);
    await audit(db, { organizationId: ctx.organizationId, actorUserId: ctx.userId, action: "experiment.started", targetType: "experiment", targetId: id, metadata: { key: e.key, traffic_percent: e.trafficPercent, variants: e.variants } });
  });
}

/** Stops assigning: the API no longer returns the experiment, so the app shows its default. Results keep counting goals within the window. */
export async function stopExperiment(ctx: TenantContext, id: string): Promise<void> {
  await tenantTx(ctx, "automations.manage", async (db) => {
    const e = await load(db, id, true);
    if (e.status !== "running") throw new ConflictError(msg("Only a running experiment can be stopped."));
    await db.query("update platform.experiments set status = 'stopped', stopped_at = now(), updated_by = $2 where id = $1", [id, ctx.userId]);
    await audit(db, { organizationId: ctx.organizationId, actorUserId: ctx.userId, action: "experiment.stopped", targetType: "experiment", targetId: id, metadata: { key: e.key } });
  });
}

// ── Results ────────────────────────────────────────────────────────────────

export interface MetricResult {
  conversions: number;
  rate: number;
  /** Against the control; null for the control itself. */
  comparison: Comparison | null;
  /** Enough people and conversions in this variant and the control for the test. */
  enough: boolean;
  /** Null until there is enough data (and for the control). */
  significant: boolean | null;
}

export interface VariantResult {
  key: string;
  name: string;
  weight: number;
  exposed: number;
  goal: MetricResult;
  secondary: MetricResult | null;
  /** Net revenue in the window per currency, total and per exposed person (secondary metric "revenue"). */
  revenue: { currency: string; net: number; perPerson: number }[] | null;
}

export interface ExperimentResults {
  variants: VariantResult[];
  totalExposed: number;
  /** Significance level per comparison (5%, split across treatments). */
  alpha: number;
  /** At least one treatment has enough data to be tested. */
  enough: boolean;
  srm: SampleRatio;
  /** People whose exposures name more than one variant (counted in their first). */
  switched: number;
  /** People exposed less than the goal window ago: they can still convert. */
  stillInWindow: number;
  /** Calendar days in the app's timezone, and exposed people so far per variant. */
  days: string[];
  cumulative: { key: string; counts: number[] }[];
  currencies: string[];
}

function metric(control: { n: number; x: number }, variant: { n: number; x: number }, isControl: boolean, alpha: number): MetricResult {
  if (isControl) return { conversions: variant.x, rate: rate(variant), comparison: null, enough: false, significant: null };
  const comparison = compareProportions(control, variant);
  const enough = enoughData(control, variant);
  return { conversions: variant.x, rate: rate(variant), comparison, enough, significant: enough ? comparison.pValue < alpha : null };
}

/**
 * Results of one experiment. Who was exposed comes from `experiment_exposure`
 * events the app sent between the start and the stop; each person counts in
 * the variant of their first exposure. A person converts when they do the goal
 * event (counted events, canonical names, property filter) at or after their
 * first exposure and within the goal window. People follow the analytics rule
 * (user_id, with an install's anonymous activity when it is linked to one user).
 */
export async function experimentResults(ctx: TenantContext, id: string, timezone: string, now = new Date()): Promise<ExperimentResults> {
  return analyticsTx(ctx, async (db) => {
    const e = await load(db, id);
    const empty = (): ExperimentResults => ({
      variants: e.variants.map((v) => ({ ...v, exposed: 0, goal: { conversions: 0, rate: 0, comparison: null, enough: false, significant: null }, secondary: null, revenue: null })),
      totalExposed: 0, alpha: alphaFor(e.variants.length - 1), enough: false, srm: sampleRatioMismatch(e.variants.map(() => 0), e.variants.map((v) => v.weight)),
      switched: 0, stillInWindow: 0, days: [], cumulative: [], currencies: [],
    });
    if (!e.startedAt) return empty();
    const end = e.stoppedAt ?? now;
    const p = new Params([e.environmentId, e.startedAt]);
    const expId = p.add(e.id);
    const keys = p.add(e.variants.map((v) => v.key));
    const stop = p.add(end);
    const windowDays = p.add(e.goal.window_days);
    const goalName = p.add(e.goal.event);
    const tz = p.add(timezone);
    const goalFilter = e.goal.filter ? ` and ${propertyPredicate("g.properties", e.goal.filter, p)}` : "";
    const secondaryEvent = e.secondary?.kind === "event" ? p.add(e.secondary.event) : null;
    const nowP = p.add(now);
    const revenue = e.secondary?.kind === "revenue";
    const rules = revenue ? await loadRevenueRules(db, e.environmentId) : [];
    const within = (alias: string) => `${alias}.person = x.person and ${alias}.ts >= x.ts and ${alias}.ts < x.ts + make_interval(days => ${windowDays}::int)`;

    const sql = `with ${evCte()},
      expo_all as (
        select ${PERSON.expr} as person, e.properties->>'variant' as variant, e."timestamp" as ts, e.id
          from platform.events e
          ${PERSON.join}
         where e.environment_id = $1 and e.event_name = '${EXPOSURE_EVENT}' and ${COUNTED_EVENTS}
           and e."timestamp" >= $2 and e."timestamp" < ${stop}
           and e.properties->>'experiment_id' = ${expId} and e.properties->>'variant' = any(${keys}::text[])
           and coalesce(e.user_id, e.anonymous_id) is not null
      ),
      expo as (select distinct on (person) person, variant, ts from expo_all order by person, ts, id)
      ${revenue ? `, ${revenueCtes(p, rules)}` : ""}
      select 'v' as k, x.variant, null::text as d, null::text as currency,
             count(*)::int as n,
             (count(*) filter (where exists (select 1 from ev g where ${within("g")} and g.name = ${goalName}${goalFilter})))::int as conv,
             ${secondaryEvent ? `(count(*) filter (where exists (select 1 from ev s where ${within("s")} and s.name = ${secondaryEvent})))::int` : "0"} as conv2,
             (count(*) filter (where x.ts > ${nowP}::timestamptz - make_interval(days => ${windowDays}::int)))::int as open,
             null::float8 as amount
        from expo x group by x.variant
      union all
      select 'd', x.variant, to_char((x.ts at time zone ${tz})::date, 'YYYY-MM-DD'), null, count(*)::int, 0, 0, 0, null from expo x group by 2, 3
      union all
      select 's', null, null, null, count(*)::int, 0, 0, 0, null from (select person from expo_all group by person having count(distinct variant) > 1) m
      ${revenue ? `union all
      select 'r', x.variant, null, t.currency, 0, 0, 0, 0, sum(case when t.kind = 'refund' then -t.amount else t.amount end)::float8
        from expo x join tx t on ${within("t")} group by x.variant, t.currency` : ""}`;
    const rows = await db.query<{ k: string; variant: string | null; d: string | null; currency: string | null; n: number; conv: number; conv2: number; open: number; amount: number | null }>(sql, p.values);

    const byVariant = new Map(rows.filter((r) => r.k === "v").map((r) => [r.variant!, r]));
    const exposed = e.variants.map((v) => byVariant.get(v.key)?.n ?? 0);
    const alpha = alphaFor(e.variants.length - 1);
    const controlRow = byVariant.get(e.variants[0].key);
    const control = { n: controlRow?.n ?? 0, x: controlRow?.conv ?? 0 };
    const control2 = { n: controlRow?.n ?? 0, x: controlRow?.conv2 ?? 0 };
    const currencies = [...new Set(rows.filter((r) => r.k === "r").map((r) => r.currency ?? NO_CURRENCY))].sort();
    const round = (n: number) => Math.round(n * 100) / 100;

    const variants: VariantResult[] = e.variants.map((v, i) => {
      const r = byVariant.get(v.key);
      const n = r?.n ?? 0;
      return {
        ...v,
        exposed: n,
        goal: metric(control, { n, x: r?.conv ?? 0 }, i === 0, alpha),
        secondary: e.secondary?.kind === "event" ? metric(control2, { n, x: r?.conv2 ?? 0 }, i === 0, alpha) : null,
        revenue: revenue
          ? currencies.map((c) => {
              const net = rows.find((x) => x.k === "r" && x.variant === v.key && (x.currency ?? NO_CURRENCY) === c)?.amount ?? 0;
              return { currency: c, net: round(net), perPerson: n ? round(net / n) : 0 };
            })
          : null,
      };
    });

    const days = datesBetween(localDate(e.startedAt, timezone), localDate(end, timezone));
    const cumulative = e.variants.map((v) => {
      let sum = 0;
      return {
        key: v.name,
        counts: days.map((d) => (sum += rows.find((r) => r.k === "d" && r.variant === v.key && r.d === d)?.n ?? 0)),
      };
    });

    return {
      variants,
      totalExposed: exposed.reduce((a, b) => a + b, 0),
      alpha,
      enough: variants.slice(1).some((v) => v.goal.enough),
      srm: sampleRatioMismatch(exposed, e.variants.map((v) => v.weight)),
      switched: rows.find((r) => r.k === "s")?.n ?? 0,
      stillInWindow: rows.filter((r) => r.k === "v").reduce((a, r) => a + r.open, 0),
      days,
      cumulative,
      currencies,
    };
  }, "automations.read");
}
