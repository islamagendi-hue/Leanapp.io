import "server-only";
import { z } from "zod";
import type { Db } from "@/lib/db";
import { ValidationError } from "@/lib/errors";
import { tenantTx, type TenantContext } from "@/modules/tenancy/context";

/**
 * Analytics v1 on Postgres (ADR-002): event trends, funnels and retention for
 * one environment. Every query runs under the organization's RLS scope with a
 * statement timeout, so a heavy query can't hold the database.
 *
 * Conventions shared by all reports:
 * - Event names are canonical: accepted mappings count `purchase` and
 *   `order_completed` as one event. Only `track` events are counted; screens
 *   and identify calls are not events in these reports.
 * - A person is the user_id; anonymous activity is attributed to the user when
 *   the install is linked to exactly one user (identity_links), otherwise it
 *   stays its own anonymous person. Shared devices are never merged.
 * - Days are calendar days in the app's timezone; ranges end now.
 */

export const RANGES = [7, 30, 90] as const;
export type RangeDays = (typeof RANGES)[number];
export const BREAKDOWNS = ["platform", "app_version", "country"] as const;

const STATEMENT_TIMEOUT = "15s";
const MAX_GROUPS = 5;

function rangeDays(v: unknown): RangeDays {
  const n = Number(v);
  return (RANGES as readonly number[]).includes(n) ? (n as RangeDays) : 30;
}

const eventName = z.string().trim().min(1).max(200);

/**
 * Identity stitching for a row of platform.events aliased `e`: the person is
 * the user_id, else the one user its install is linked to, else the anonymous
 * id. Shared by analytics and usage (MAU) so both count the same people.
 */
export const PERSON = {
  expr: "coalesce(e.user_id, l.user_id, 'anon:' || e.anonymous_id)",
  join: `left join lateral (
        select min(il.user_id) as user_id from platform.identity_links il
         where il.environment_id = e.environment_id and il.anonymous_id = e.anonymous_id
        having count(*) = 1
      ) l on e.user_id is null and e.anonymous_id is not null`,
};

/**
 * The events of the range with one row per event and its person, as a CTE.
 * $1 environment, $2 range start. Adds `name`, `person` and `ts`; `id` orders events with equal timestamps.
 */
const EV = `
  ev as (
    select coalesce(e.canonical_name, e.event_name) as name,
           ${PERSON.expr} as person,
           e."timestamp" as ts, e.id, e.platform, e.app_version, e.properties, e.context
      from platform.events e
      ${PERSON.join}
     where e.environment_id = $1 and e."timestamp" >= $2 and e.type = 'track'
       and coalesce(e.user_id, e.anonymous_id) is not null
  )`;

function rangeStart(days: number, now = new Date()): Date {
  return new Date(now.getTime() - days * 86_400_000);
}

/** Calendar days (YYYY-MM-DD) in `timezone` from range start to today, inclusive. */
export function dayList(days: number, timezone: string, now = new Date()): string[] {
  const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" });
  const out = new Set<string>();
  for (let i = days; i >= 0; i--) out.add(fmt.format(new Date(now.getTime() - i * 86_400_000)));
  return [...out];
}

function query<T>(ctx: TenantContext, fn: (db: Db) => Promise<T>): Promise<T> {
  return tenantTx(ctx, "analytics.read", async (db) => {
    await db.query(`set local statement_timeout = '${STATEMENT_TIMEOUT}'`);
    return fn(db);
  });
}

// ── Event list ──────────────────────────────────────────────────────────────
export interface EventTotal {
  name: string;
  count: number;
  people: number;
}

/** Every event seen in the range with its count and distinct people, most frequent first. */
export async function topEvents(ctx: TenantContext, scope: { environmentId: string; days: unknown }): Promise<EventTotal[]> {
  const days = rangeDays(scope.days);
  return query(ctx, async (db) => {
    const rows = await db.query<{ name: string; count: string; people: string }>(
      `with ${EV} select name, count(*) as count, count(distinct person) as people from ev group by name order by count(*) desc, name limit 200`,
      [scope.environmentId, rangeStart(days)],
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
  days: string[];
  series: TrendSeries[];
  total: { count: number; people: number };
  breakdown: string | null;
}

export const trendSchema = z.object({
  event: eventName,
  days: z.unknown().transform(rangeDays),
  breakdown: z.union([z.enum(BREAKDOWNS), z.string().regex(/^property:[A-Za-z0-9_.$-]{1,64}$/)]).optional().catch(undefined),
});

function groupExpr(breakdown: string | undefined): { sql: string; param?: string } {
  if (!breakdown) return { sql: "'All'" };
  if (breakdown === "platform") return { sql: "coalesce(platform, '(none)')" };
  if (breakdown === "app_version") return { sql: "coalesce(app_version, '(none)')" };
  if (breakdown === "country") return { sql: "coalesce(context->'location'->>'country', context->>'country', '(none)')" };
  return { sql: "coalesce(properties->>$4, '(none)')", param: breakdown.slice("property:".length) };
}

/** Daily counts and distinct people for one event, optionally split by a dimension (top 5, the rest as "Other"). */
export async function eventTrend(ctx: TenantContext, scope: { environmentId: string; timezone: string }, input: unknown): Promise<Trend> {
  const r = trendSchema.safeParse(input);
  if (!r.success) throw new ValidationError(r.error.issues[0]?.message ?? "Choose an event.");
  const { event, days, breakdown } = r.data;
  const group = groupExpr(breakdown);
  return query(ctx, async (db) => {
    const params: unknown[] = [scope.environmentId, rangeStart(days), scope.timezone, ...(group.param ? [group.param] : []), event];
    const nameParam = `$${params.length}`;
    const rows = await db.query<{ g: string; d: string; count: string; people: string }>(
      `with ${EV}
       select ${group.sql} as g, (ts at time zone $3)::date as d, count(*) as count, count(distinct person) as people
         from ev where name = ${nameParam} group by 1, 2`,
      params,
    );
    const totals = await db.one<{ count: string; people: string }>(
      `with ${EV} select count(*) as count, count(distinct person) as people from ev where name = $3`,
      [scope.environmentId, rangeStart(days), event],
    );
    const dayKeys = dayList(days, scope.timezone);
    const byGroup = new Map<string, number>();
    for (const row of rows) byGroup.set(row.g, (byGroup.get(row.g) ?? 0) + Number(row.count));
    const ranked = [...byGroup.entries()].sort((a, b) => b[1] - a[1]).map(([g]) => g);
    const keep = new Set(ranked.slice(0, MAX_GROUPS));
    const series = new Map<string, TrendSeries>();
    const ensure = (key: string) => {
      if (!series.has(key)) series.set(key, { key, counts: dayKeys.map(() => 0), people: dayKeys.map(() => 0), total: 0 });
      return series.get(key)!;
    };
    for (const row of rows) {
      const i = dayKeys.indexOf(row.d);
      if (i < 0) continue;
      const s = ensure(keep.has(row.g) ? row.g : "Other");
      s.counts[i] += Number(row.count);
      // People are distinct per group and day; "Other" sums groups, so it's an upper bound there.
      s.people[i] += Number(row.people);
      s.total += Number(row.count);
    }
    return {
      event,
      days: dayKeys,
      series: [...series.values()].sort((a, b) => (a.key === "Other" ? 1 : b.key === "Other" ? -1 : b.total - a.total)),
      total: { count: Number(totals!.count), people: Number(totals!.people) },
      breakdown: breakdown ?? null,
    };
  });
}

// ── Funnel ──────────────────────────────────────────────────────────────────
export const funnelSchema = z.object({
  steps: z.array(eventName).min(2, "A funnel needs at least two steps.").max(6, "Use at most six steps."),
  windowDays: z.coerce.number().int().min(1).max(30).catch(7),
  days: z.unknown().transform(rangeDays),
  breakdown: z.enum(["platform"]).optional().catch(undefined),
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
  days: RangeDays;
  breakdown: { key: string; people: number[] }[] | null;
}

/**
 * Ordered funnel: a person enters at their first step-1 event in the range and
 * converts on each later step done after the previous one, within the window
 * from entering.
 */
export async function funnel(ctx: TenantContext, scope: { environmentId: string }, input: unknown): Promise<Funnel> {
  const r = funnelSchema.safeParse(input);
  if (!r.success) throw new ValidationError(r.error.issues[0]?.message ?? "Invalid funnel.");
  const { steps, windowDays, days, breakdown } = r.data;
  // $1 env, $2 range start, $3 window (days), $4.. step names.
  const stepParam = (i: number) => `$${4 + i}`;
  const ctes = [
    `s0 as (select distinct on (person) person, ts as t, id, ts as t0, ${breakdown ? "coalesce(platform, '(none)')" : "'all'"} as g
            from ev where name = ${stepParam(0)} order by person, ts, id)`,
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
  const select = steps
    .map((_, k) =>
      k === 0
        ? `select 0 as step, g, count(*) as people, null::float8 as median from s0 group by g`
        : `select ${k}, s${k}.g, count(*), percentile_cont(0.5) within group (order by extract(epoch from s${k}.t - s${k - 1}.t))
             from s${k} join s${k - 1} using (person) group by s${k}.g`,
    )
    .join(" union all ");
  return query(ctx, async (db) => {
    const rows = await db.query<{ step: number; g: string; people: string; median: number | null }>(
      `with ${EV}, ${ctes.join(", ")} ${select}`,
      [scope.environmentId, rangeStart(days), windowDays, ...steps],
    );
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
    return { steps: out, windowDays, days, breakdown: groups };
  });
}

// ── Retention ───────────────────────────────────────────────────────────────
export const RETENTION_DAYS = [1, 3, 7, 14, 30] as const;

export const retentionSchema = z.object({
  startEvent: eventName,
  returnEvent: eventName,
  days: z.unknown().transform(rangeDays),
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
}

/**
 * N-day retention: people are grouped by the day of their first start event in
 * the range; a person is retained on day N if they did the return event on that
 * calendar day (in the app's timezone).
 */
export async function retention(ctx: TenantContext, scope: { environmentId: string; timezone: string }, input: unknown): Promise<Retention> {
  const r = retentionSchema.safeParse(input);
  if (!r.success) throw new ValidationError(r.error.issues[0]?.message ?? "Choose a start and a return event.");
  const { startEvent, returnEvent, days } = r.data;
  return query(ctx, async (db) => {
    const rows = await db.query<{ d0: string; n: number | null; size: string; returned: string }>(
      `with ${EV},
        starts as (select person, min((ts at time zone $3)::date) as d0 from ev where name = $4 group by person),
        returns as (select distinct person, (ts at time zone $3)::date as d from ev where name = $5),
        sizes as (select d0, count(*) as size from starts group by d0)
       select s.d0, (r.d - s.d0) as n, z.size, count(distinct r.person) as returned
         from starts s
         join sizes z on z.d0 = s.d0
         left join returns r on r.person = s.person and r.d - s.d0 = any($6)
        group by s.d0, n, z.size`,
      [scope.environmentId, rangeStart(days), scope.timezone, startEvent, returnEvent, [...RETENTION_DAYS]],
    );
    const today = dayList(0, scope.timezone).at(-1)!;
    const elapsed = (d0: string) => Math.round((Date.parse(today) - Date.parse(d0)) / 86_400_000);
    const byDay = new Map<string, RetentionCohort>();
    for (const row of rows) {
      const day = row.d0;
      if (!byDay.has(day)) {
        byDay.set(day, { day, size: Number(row.size), returned: RETENTION_DAYS.map((n) => (n < elapsed(day) ? 0 : null)) });
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
  });
}
