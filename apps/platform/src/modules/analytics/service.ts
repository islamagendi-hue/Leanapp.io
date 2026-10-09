import "server-only";
import { z } from "zod";
import type { Db } from "@/lib/db";
import { ValidationError } from "@/lib/errors";
import { msg } from "@/i18n/translate";
import type { Permission } from "@/modules/rbac/permissions";
import { compileAudienceIn, DefinitionError, parseDefinition, peopleCtes, propertyFilterSchema, propertyPredicate, type AudienceNode, type PropertyFilter } from "@/modules/audiences/definition";
import { tenantTx, type TenantContext } from "@/modules/tenancy/context";
import { measurable } from "./retention-rule";
import {
  bucketKeys, bucketSql, change, datesBetween, defaultInterval, intervalField, comparisonRange, localDate, rangeDays, type Compare, rangeFields, resolveRange,
  type Interval, type ReportRange,
} from "./range";
import { ANY_EVENT, channelSql, evCte, Params } from "./sql";

/**
 * Analytics on Postgres (ADR-002): event trends, funnels and retention for
 * one environment. Every query runs under the organization's RLS scope with a
 * statement timeout, so a heavy query can't hold the database.
 *
 * Conventions shared by all reports:
 * - Event names are canonical: accepted mappings count `purchase` and
 *   `order_completed` as one event. Events count by the shared rule in
 *   ./sql.ts (COUNTED_EVENTS): processed track events and screen views.
 * - A person is the user_id; anonymous activity is attributed to the user when
 *   the install is linked to exactly one user (identity_links), otherwise it
 *   stays its own anonymous person. Shared devices are never merged.
 * - Days are calendar days in the app's timezone. A range is a preset (last
 *   7, 15, 30 or 90 days, ending now) or custom calendar days (./range.ts); any
 *   report can compare with the period just before it, the same days a year
 *   earlier, or custom days (comparisonRange).
 * - Any report can be limited to the people of an audience (`cohortId`, the
 *   name saved reports have always used; see modules/audiences). Audiences
 *   are the one segmentation layer: the same condition tree and SQL compiler
 *   serve Analytics, Users and Engagement.
 * Revenue, profiles and saved reports live in sibling files.
 */

export { RANGES, type RangeDays } from "./range";
export const RANGE_SCHEMA = z.unknown().transform(rangeDays);
export const BREAKDOWNS = ["platform", "app_version", "country", "channel"] as const;

const STATEMENT_TIMEOUT = "15s";
const MAX_GROUPS = 5;

const eventName = z.string().trim().min(1).max(200);

export { ANY_EVENT } from "./sql";

export { PERSON } from "./sql";

const cohortId = z.uuid().optional().catch(undefined);

export function rangeStart(days: number, now = new Date()): Date {
  return new Date(now.getTime() - days * 86_400_000);
}

/** Calendar days (YYYY-MM-DD) in `timezone` from range start to today, inclusive. */
export function dayList(days: number, timezone: string, now = new Date()): string[] {
  return datesBetween(localDate(rangeStart(days, now), timezone), localDate(now, timezone));
}

/** What a report shows about its range: the days it covers, and the comparison period when one was asked for. */
export interface RangeInfo {
  from: string;
  to: string;
  label: string;
  preset: number | null;
  /** `kind` is the comparison asked for, as its search param value. */
  previous: { from: string; to: string; label: string; kind: CompareParam } | null;
}

export type CompareParam = "1" | "year" | "custom";

export function rangeInfo(range: ReportRange, prev: ReportRange | null, compare?: Compare): RangeInfo {
  const kind: CompareParam = compare === "year" || compare === "custom" ? compare : "1";
  return { from: range.from, to: range.to, label: range.label, preset: range.preset, previous: prev && { from: prev.from, to: prev.to, label: prev.label, kind } };
}

/** A tenant transaction (RLS + permission check) with the analytics statement timeout. */
export function analyticsTx<T>(ctx: TenantContext, fn: (db: Db) => Promise<T>, permission: Permission = "analytics.read"): Promise<T> {
  return tenantTx(ctx, permission, async (db) => {
    await db.query(`set local statement_timeout = '${STATEMENT_TIMEOUT}'`);
    return fn(db);
  });
}
const query = analyticsTx;

/** An audience's definition; it must be in the report's environment and not archived (RLS keeps it in the organization). */
export async function loadAudienceDefinition(db: Db, environmentId: string, id: string): Promise<AudienceNode> {
  if (!z.uuid().safeParse(id).success) throw new ValidationError(msg("That audience doesn't exist in this environment."));
  const row = await db.one<{ definition: unknown }>(
    "select definition from platform.audiences where id = $1 and environment_id = $2 and status <> 'archived'",
    [id, environmentId],
  );
  if (!row) throw new ValidationError(msg("That audience doesn't exist in this environment."));
  try {
    return parseDefinition(row.definition);
  } catch (e) {
    if (e instanceof DefinitionError) throw new ValidationError(`That audience can't be used: ${e.message}`);
    throw e;
  }
}

/** SELECT of an audience's people (column `person`), its values added to `p`, whose $1 must be the environment id. */
export async function audienceSql(db: Db, scope: { environmentId: string; timezone?: string }, id: string, p: Params): Promise<string> {
  const def = await loadAudienceDefinition(db, scope.environmentId, id);
  return (await compileAudienceIn(db, def, scope.environmentId, { params: p, timezone: scope.timezone ?? "UTC" })).sql;
}

/**
 * The `ev` CTE (and the cohort CTE when filtering) with its bind values:
 * `base` must start with [environment id, range start]; `end` bounds the
 * events (exclusive), none means up to now.
 */
export async function eventsSource(
  db: Db,
  scope: { environmentId: string; timezone?: string },
  cohort: string | undefined,
  base: unknown[],
  end?: Date,
): Promise<{ sql: string; p: Params }> {
  const p = new Params(base);
  const cohortText = cohort ? await audienceSql(db, scope, cohort, p) : undefined;
  return { sql: evCte(cohortText, end ? p.add(end) : undefined), p };
}

/** Events and distinct people in a range: of one event, or of every counted event (active people). */
async function totalsIn(
  db: Db,
  scope: { environmentId: string; timezone?: string },
  cohort: string | undefined,
  range: Pick<ReportRange, "start" | "end">,
  event: string | null,
  filters: PropertyFilter[] = [],
) {
  const src = await eventsSource(db, scope, cohort, [scope.environmentId, range.start], range.end);
  const where = [event === null ? "true" : `name = ${src.p.add(event)}`, ...filters.map((f) => propertyPredicate("properties", f, src.p))].join(" and ");
  const row = await db.one<{ count: string; people: string }>(`with ${src.sql} select count(*) as count, count(distinct person) as people from ev where ${where}`, src.p.values);
  return { count: Number(row?.count ?? 0), people: Number(row?.people ?? 0) };
}

// ── Event list ──────────────────────────────────────────────────────────────
export interface EventTotal {
  name: string;
  count: number;
  people: number;
}

/** Every event seen in the range with its count and distinct people, most frequent first. */
export async function topEvents(
  ctx: TenantContext,
  scope: { environmentId: string; days?: unknown; from?: string; to?: string; timezone?: string; cohortId?: unknown },
): Promise<EventTotal[]> {
  const range = resolveRange(scope, scope.timezone ?? "UTC");
  const cohort = cohortId.parse(scope.cohortId);
  return query(ctx, async (db) => {
    const src = await eventsSource(db, scope, cohort, [scope.environmentId, range.start], range.end);
    const rows = await db.query<{ name: string; count: string; people: string }>(
      `with ${src.sql} select name, count(*) as count, count(distinct person) as people from ev group by name order by count(*) desc, name limit 200`,
      src.p.values,
    );
    return rows.map((r) => ({ name: r.name, count: Number(r.count), people: Number(r.people) }));
  });
}

// ── Trend ───────────────────────────────────────────────────────────────────
export interface TrendSeries {
  key: string;
  counts: number[];
  people: number[];
  total: number;
}

export interface Trend {
  event: string;
  /** Bucket keys: each day, or the Monday of each week, or the first of each month. */
  days: string[];
  interval: Interval;
  series: TrendSeries[];
  total: { count: number; people: number };
  /** Totals of the comparison period, when one was asked for. */
  previous: { count: number; people: number } | null;
  breakdown: string | null;
  /** Event property filters applied (all must match). */
  where: PropertyFilter[];
  range: RangeInfo;
}

/** Event property filters on a report (the same filters as audience conditions). */
export const MAX_EVENT_FILTERS = 3;
const eventFilters = z.array(propertyFilterSchema).max(MAX_EVENT_FILTERS).optional().catch(undefined);

export const trendSchema = z.object({
  event: eventName,
  ...rangeFields,
  interval: intervalField,
  breakdown: z.union([z.enum(BREAKDOWNS), z.string().regex(/^property:[A-Za-z0-9_.$-]{1,64}$/)]).optional().catch(undefined),
  where: eventFilters,
  cohortId,
});

function groupExpr(breakdown: string | undefined, p: Params): string {
  if (!breakdown) return "'All'";
  if (breakdown === "platform") return "coalesce(platform, '(none)')";
  if (breakdown === "app_version") return "coalesce(app_version, '(none)')";
  if (breakdown === "country") return "coalesce(context->'location'->>'country', context->>'country', '(none)')";
  if (breakdown === "channel") return channelSql("ev");
  return `coalesce(properties->>${p.add(breakdown.slice("property:".length))}, '(none)')`;
}

/**
 * Counts and distinct people for one event per day, week or month, optionally
 * split by a dimension: the 5 most frequent values, the rest together as
 * "Other" (its people are counted distinct across those values, like any series).
 */
export async function eventTrend(ctx: TenantContext, scope: { environmentId: string; timezone: string }, input: unknown): Promise<Trend> {
  const r = trendSchema.safeParse(input);
  if (!r.success) throw new ValidationError(r.error.issues[0]?.message ?? msg("Choose an event."));
  const { event, breakdown, cohortId: cohort } = r.data;
  const where = r.data.where ?? [];
  const range = resolveRange(r.data, scope.timezone);
  const interval = defaultInterval(range, r.data.interval);
  return query(ctx, async (db) => {
    const src = await eventsSource(db, scope, cohort, [scope.environmentId, range.start], range.end);
    const p = src.p;
    const match = [event === ANY_EVENT ? "true" : `name = ${p.add(event)}`, ...where.map((f) => propertyPredicate("properties", f, p))].join(" and ");
    const group = groupExpr(breakdown, p);
    let keep: string[] | null = null;
    if (breakdown) {
      const top = await db.query<{ g: string }>(
        `with ${src.sql} select ${group} as g from ev where ${match} group by 1 order by count(*) desc, 1 limit ${MAX_GROUPS + 1}`,
        p.values,
      );
      if (top.length > MAX_GROUPS) keep = top.slice(0, MAX_GROUPS).map((x) => x.g);
    }
    // Bound after the top-values query, which doesn't use them (Postgres can't type an unused bind).
    const tz = p.add(scope.timezone);
    const keepParam = keep ? p.add(keep) : null;
    const rows = await db.query<{ g: string; d: string; count: string; people: string }>(
      `with ${src.sql}
       select ${keepParam ? `case when g = any(${keepParam}::text[]) then g else 'Other' end` : "g"} as g, d, count(*) as count, count(distinct person) as people
         from (select ${group} as g, ${bucketSql("ts", tz, interval)} as d, person from ev where ${match}) x
        group by 1, 2`,
      p.values,
    );
    const only = event === ANY_EVENT ? null : event;
    const total = await totalsIn(db, scope, cohort, range, only, where);
    const prevRange = comparisonRange(range, scope.timezone, r.data);
    const previous = prevRange ? await totalsIn(db, scope, cohort, prevRange, only, where) : null;
    const keys = bucketKeys(range, interval);
    const series = new Map<string, TrendSeries>();
    for (const row of rows) {
      const i = keys.indexOf(row.d);
      if (i < 0) continue;
      if (!series.has(row.g)) series.set(row.g, { key: row.g, counts: keys.map(() => 0), people: keys.map(() => 0), total: 0 });
      const s = series.get(row.g)!;
      s.counts[i] += Number(row.count);
      s.people[i] += Number(row.people);
      s.total += Number(row.count);
    }
    return {
      event,
      days: keys,
      interval,
      series: [...series.values()].sort((a, b) => (a.key === "Other" ? 1 : b.key === "Other" ? -1 : b.total - a.total || a.key.localeCompare(b.key))),
      total,
      previous,
      breakdown: breakdown ?? null,
      where,
      range: rangeInfo(range, prevRange, r.data.compare),
    };
  });
}

// ── Single-number results ───────────────────────────────────────────────────
/** events / people: of one event; all_events: every counted event; active_people: anyone with one; new_people: first seen in the range. */
export const KPI_METRICS = ["events", "people", "active_people", "all_events", "new_people"] as const;
export type KpiMetric = (typeof KPI_METRICS)[number];

export const kpiSchema = z
  .object({
    metric: z.enum(KPI_METRICS),
    event: eventName.optional(),
    ...rangeFields,
    where: eventFilters,
    cohortId,
  })
  .refine((k) => !(k.metric === "events" || k.metric === "people") || k.event, msg("Choose an event."));

export interface Kpi {
  metric: KpiMetric;
  event: string | null;
  value: number;
  /** The comparison period's value, when one was asked for. */
  previous: number | null;
  /** Relative change from the comparison period (0.25 = +25%), or null. */
  change: number | null;
  range: RangeInfo;
}

/**
 * One number for a range: how many times an event happened, how many people
 * did it, or how many people were active at all (any counted event).
 */
export async function kpi(ctx: TenantContext, scope: { environmentId: string; timezone: string }, input: unknown): Promise<Kpi> {
  const r = kpiSchema.safeParse(input);
  if (!r.success) throw new ValidationError(r.error.issues[0]?.message ?? msg("Invalid metric."));
  const { metric, cohortId: cohort } = r.data;
  const event = metric === "events" || metric === "people" ? (r.data.event === ANY_EVENT ? null : r.data.event!) : null;
  const where = r.data.where ?? [];
  const range = resolveRange(r.data, scope.timezone);
  return query(ctx, async (db) => {
    const measure = async (period: Pick<ReportRange, "start" | "end">) => {
      if (metric === "new_people") return newPeopleIn(db, scope, cohort, period);
      const t = await totalsIn(db, scope, cohort, period, event, where);
      return metric === "events" || metric === "all_events" ? t.count : t.people;
    };
    const value = await measure(range);
    const prevRange = comparisonRange(range, scope.timezone, r.data);
    const previous = prevRange ? await measure(prevRange) : null;
    return { metric, event, value, previous, change: change(value, previous), range: rangeInfo(range, prevRange, r.data.compare) };
  });
}

/**
 * People first seen in a range: identified users by the earliest of their
 * profile and their own installs, and anonymous installs (not linked to one
 * user) by their own first sighting. Same people as audiences.
 */
async function newPeopleIn(db: Db, scope: { environmentId: string; timezone?: string }, cohort: string | undefined, range: Pick<ReportRange, "start" | "end">): Promise<number> {
  const p = new Params([scope.environmentId]);
  const audience = cohort ? await audienceSql(db, scope, cohort, p) : null;
  const row = await db.one<{ n: string }>(
    `with ${peopleCtes()}${audience ? `, cohort as (${audience})` : ""}
     select count(*) as n from people
      where first_seen_at >= ${p.add(range.start)} and first_seen_at < ${p.add(range.end)}${audience ? " and person in (select person from cohort)" : ""}`,
    p.values,
  );
  return Number(row?.n ?? 0);
}

// ── Funnel ──────────────────────────────────────────────────────────────────
export const funnelSchema = z.object({
  steps: z.array(eventName).min(1, msg("Choose at least one step.")).max(10, msg("Use at most ten steps.")),
  windowDays: z.coerce.number().int().min(1).max(30).catch(7),
  ...rangeFields,
  breakdown: z.enum(["platform", "channel"]).optional().catch(undefined),
  cohortId,
});

export interface FunnelStep {
  name: string;
  people: number;
  /** Share of people who did step 1. */
  fromStart: number;
  /** Share of people who did the previous step. */
  fromPrevious: number;
  /** Median time from the previous step, in seconds. */
  medianSeconds: number | null;
}

export interface Funnel {
  steps: FunnelStep[];
  windowDays: number;
  days: number;
  breakdown: { key: string; people: number[] }[] | null;
  /** The comparison period: people entering and completing every step, when one was asked for. */
  previous: { entered: number; converted: number } | null;
  range: RangeInfo;
}

/**
 * Ordered funnel: a person enters at their first step-1 event in the range and
 * converts on each later step done after the previous one, within the window
 * from entering (later steps may fall after the range ends).
 */
/**
 * The step CTEs s0…sN of a funnel over `ev`: one row per person who reached
 * that step, with the time they did it. Parameters: $1 env, $2 range start,
 * $3 window (days), $4 range end, $5.. step names.
 */
function funnelCtes(steps: string[], breakdown?: "platform" | "channel"): string[] {
  const stepParam = (i: number) => `$${5 + i}`;
  const g = breakdown === "platform" ? "coalesce(platform, '(none)')" : breakdown === "channel" ? channelSql("ev") : "'all'";
  return [
    // $3 (the window) is unused by a one-step funnel; naming it keeps its type known.
    `s0 as (select distinct on (person) person, ts as t, id, ts as t0, ${g} as g
            from ev where name = ${stepParam(0)} and ts < $4 and $3::int > 0 order by person, ts, id)`,
    // Each step is the earliest matching event strictly after the previous step's
    // event (ties on timestamp broken by id), so a repeated step needs a second event.
    ...steps.slice(1).map(
      (_, k) => `s${k + 1} as (
        select distinct on (p.person) p.person, ev.ts as t, ev.id, p.t0, p.g from s${k} p
          join ev on ev.person = p.person and ev.name = ${stepParam(k + 1)}
                 and (ev.ts > p.t or (ev.ts = p.t and ev.id > p.id)) and ev.ts <= p.t0 + make_interval(days => $3)
         order by p.person, ev.ts, ev.id)`,
    ),
  ];
}

export const FUNNEL_PEOPLE_LIMIT = 100;

/** A person behind a funnel number: their user ID, or the install's anonymous ID when they never signed in. */
export interface FunnelPerson { userId: string | null; anonymousId: string | null; at: Date }

/**
 * The people behind one bar of a funnel: those who reached step `step`, or
 * (`dropped`) those who reached the step before it and never reached it,
 * using exactly the funnel's own rules. The most recent first, at most
 * FUNNEL_PEOPLE_LIMIT; `total` is the full count.
 */
export async function funnelPeople(
  ctx: TenantContext,
  scope: { environmentId: string; timezone?: string },
  input: unknown,
  pick: { step: number; dropped?: boolean },
): Promise<{ people: FunnelPerson[]; total: number }> {
  const r = funnelSchema.safeParse(input);
  if (!r.success) throw new ValidationError(r.error.issues[0]?.message ?? msg("Invalid funnel."));
  const { steps, windowDays, cohortId: cohort } = r.data;
  const k = Math.trunc(pick.step);
  if (!(k >= 0 && k < steps.length) || (pick.dropped && k === 0)) throw new ValidationError(msg("Choose a step of this funnel."));
  const range = resolveRange(r.data, scope.timezone ?? "UTC");
  const set = pick.dropped
    ? `select p.person, p.t from s${k - 1} p where not exists (select 1 from s${k} q where q.person = p.person)`
    : `select person, t from s${k}`;
  return query(ctx, async (db) => {
    const src = await eventsSource(db, scope, cohort, [scope.environmentId, range.start, windowDays, range.end, ...steps]);
    const limit = src.p.add(FUNNEL_PEOPLE_LIMIT);
    const rows = await db.query<{ person: string; t: Date; total: string }>(
      `with ${src.sql}, ${funnelCtes(steps).join(", ")}, picked as (${set})
       select person, t, count(*) over () as total from picked order by t desc, person limit ${limit}`,
      src.p.values,
    );
    return {
      total: Number(rows[0]?.total ?? 0),
      people: rows.map((x) => ({
        userId: x.person.startsWith("anon:") ? null : x.person,
        anonymousId: x.person.startsWith("anon:") ? x.person.slice(5) : null,
        at: x.t,
      })),
    };
  });
}

export async function funnel(ctx: TenantContext, scope: { environmentId: string; timezone?: string }, input: unknown): Promise<Funnel> {
  const r = funnelSchema.safeParse(input);
  if (!r.success) throw new ValidationError(r.error.issues[0]?.message ?? msg("Invalid funnel."));
  const { steps, windowDays, breakdown, cohortId: cohort } = r.data;
  const timezone = scope.timezone ?? "UTC";
  const range = resolveRange(r.data, timezone);
  // $1 env, $2 range start, $3 window (days), $4 range end, $5.. step names.
  const ctes = funnelCtes(steps, breakdown);
  const select = steps
    .map((_, k) =>
      k === 0
        ? `select 0 as step, g, count(*) as people, null::float8 as median from s0 group by g`
        : `select ${k}, s${k}.g, count(*), percentile_cont(0.5) within group (order by extract(epoch from s${k}.t - s${k - 1}.t))
             from s${k} join s${k - 1} using (person) group by s${k}.g`,
    )
    .join(" union all ");
  const run = async (db: Db, period: ReportRange) => {
    const src = await eventsSource(db, scope, cohort, [scope.environmentId, period.start, windowDays, period.end, ...steps]);
    return db.query<{ step: number; g: string; people: string; median: number | null }>(`with ${src.sql}, ${ctes.join(", ")} ${select}`, src.p.values);
  };
  return query(ctx, async (db) => {
    const rows = await run(db, range);
    let previous: Funnel["previous"] = null;
    const prevRange = comparisonRange(range, timezone, r.data);
    if (prevRange) {
      const prev = await run(db, prevRange);
      const at = (k: number) => prev.filter((x) => Number(x.step) === k).reduce((n, x) => n + Number(x.people), 0);
      previous = { entered: at(0), converted: at(steps.length - 1) };
    }
    const people = steps.map((_, k) => rows.filter((x) => Number(x.step) === k).reduce((n, x) => n + Number(x.people), 0));
    // Without a breakdown there is one group, so its median is the overall median. Medians of groups can't be combined.
    const medians = breakdown
      ? steps.map(() => null)
      : steps.map((_, k) => rows.find((x) => Number(x.step) === k)?.median ?? null);
    const out: FunnelStep[] = steps.map((name, k) => ({
      name,
      people: people[k],
      fromStart: people[0] ? people[k] / people[0] : 0,
      fromPrevious: k === 0 ? 1 : people[k - 1] ? people[k] / people[k - 1] : 0,
      medianSeconds: k === 0 ? null : medians[k] === null ? null : Math.round(Number(medians[k])),
    }));
    let groups: Funnel["breakdown"] = null;
    if (breakdown) {
      const keys = [...new Set(rows.filter((x) => Number(x.step) === 0).map((x) => x.g))];
      groups = keys
        .map((key) => ({ key, people: steps.map((_, k) => Number(rows.find((x) => Number(x.step) === k && x.g === key)?.people ?? 0)) }))
        .sort((a, b) => b.people[0] - a.people[0]);
    }
    return { steps: out, windowDays, days: range.preset ?? datesBetween(range.from, range.to).length, breakdown: groups, previous, range: rangeInfo(range, prevRange, r.data.compare) };
  });
}

// ── Retention ───────────────────────────────────────────────────────────────
export const RETENTION_DAYS = [1, 3, 7, 14, 30] as const;

export const retentionSchema = z.object({
  startEvent: eventName,
  returnEvent: eventName,
  ...rangeFields,
  cohortId,
});

export interface RetentionCohort {
  day: string;
  size: number;
  /** People who came back on exactly day N after their start day, per RETENTION_DAYS; null until day N is over (today is never counted). */
  returned: (number | null)[];
}

export interface Retention {
  cohorts: RetentionCohort[];
  /** Weighted over cohorts old enough to measure each day. */
  overall: (number | null)[];
  people: number;
  /** The comparison period's overall retention, when one was asked for. */
  previous: (number | null)[] | null;
  range: RangeInfo;
}

/**
 * N-day retention by the shared rule (./retention-rule.ts): people are grouped
 * by the day of their first start event in the range; a person is retained on
 * day N if they did the return event on that calendar day (in the app's
 * timezone), which may be after the range ends.
 */
export async function retention(ctx: TenantContext, scope: { environmentId: string; timezone: string }, input: unknown): Promise<Retention> {
  const r = retentionSchema.safeParse(input);
  if (!r.success) throw new ValidationError(r.error.issues[0]?.message ?? msg("Choose a start and a return event."));
  const { cohortId: cohort } = r.data;
  const range = resolveRange(r.data, scope.timezone);
  const prevRange = comparisonRange(range, scope.timezone, r.data);
  return query(ctx, async (db) => {
    const current = await retentionIn(db, scope, cohort, r.data, range);
    const previous = prevRange ? (await retentionIn(db, scope, cohort, r.data, prevRange)).overall : null;
    return { ...current, previous, range: rangeInfo(range, prevRange, r.data.compare) };
  });
}

async function retentionIn(
  db: Db,
  scope: { environmentId: string; timezone: string },
  cohort: string | undefined,
  input: { startEvent: string; returnEvent: string },
  range: ReportRange,
): Promise<Pick<Retention, "cohorts" | "overall" | "people">> {
  const { startEvent, returnEvent } = input;
  const src = await eventsSource(db, scope, cohort, [scope.environmentId, range.start, scope.timezone, startEvent, returnEvent, [...RETENTION_DAYS], range.end]);
  const rows = await db.query<{ d0: string; n: number | null; size: string; returned: string }>(
    `with ${src.sql},
      starts as (select person, min((ts at time zone $3)::date) as d0 from ev where (name = $4 or $4 = '${ANY_EVENT}') and ts < $7 group by person),
      returns as (select distinct person, (ts at time zone $3)::date as d from ev where (name = $5 or $5 = '${ANY_EVENT}')),
      sizes as (select d0, count(*) as size from starts group by d0)
     select s.d0, (r.d - s.d0) as n, z.size, count(distinct r.person) as returned
       from starts s
       join sizes z on z.d0 = s.d0
       left join returns r on r.person = s.person and r.d - s.d0 = any($6)
      group by s.d0, n, z.size`,
    src.p.values,
  );
  const today = localDate(new Date(), scope.timezone);
  const byDay = new Map<string, RetentionCohort>();
  for (const row of rows) {
    const day = row.d0;
    if (!byDay.has(day)) {
      byDay.set(day, { day, size: Number(row.size), returned: RETENTION_DAYS.map((n) => (measurable(day, n, today) ? 0 : null)) });
    }
    if (row.n !== null) {
      const i = RETENTION_DAYS.indexOf(Number(row.n) as (typeof RETENTION_DAYS)[number]);
      if (i >= 0 && byDay.get(day)!.returned[i] !== null) byDay.get(day)!.returned[i] = Number(row.returned);
    }
  }
  const cohorts = [...byDay.values()].sort((a, b) => b.day.localeCompare(a.day));
  const overall = RETENTION_DAYS.map((_, i) => {
    const eligible = cohorts.filter((c) => c.returned[i] !== null);
    const size = eligible.reduce((n, c) => n + c.size, 0);
    return size ? eligible.reduce((n, c) => n + (c.returned[i] ?? 0), 0) / size : null;
  });
  return { cohorts, overall, people: cohorts.reduce((n, c) => n + c.size, 0) };
}
