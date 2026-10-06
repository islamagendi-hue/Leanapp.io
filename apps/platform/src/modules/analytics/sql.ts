/**
 * SQL building blocks shared by the analytics reports. Pure (no database
 * access) so the query shapes can be unit tested; values always travel as
 * bind parameters, never in the SQL text.
 */
import { z } from "zod";

/**
 * Identity stitching for a row of platform.events aliased `e`: the person is
 * the user_id, else the one user its install is linked to, else the anonymous
 * id. Shared by analytics and usage (MAU) so both count the same people.
 * An install linked to several users (a shared device) is never merged.
 */
export const PERSON = {
  expr: "coalesce(e.user_id, l.user_id, 'anon:' || e.anonymous_id)",
  join: `left join lateral (
        select min(il.user_id) as user_id from platform.identity_links il
         where il.environment_id = e.environment_id and il.anonymous_id = e.anonymous_id
        having count(*) = 1
      ) l on e.user_id is null and e.anonymous_id is not null`,
};

/** Collects bind values; `add` returns the placeholder for the value. */
export class Params {
  readonly values: unknown[];
  constructor(initial: unknown[] = []) {
    this.values = [...initial];
  }
  add(v: unknown): string {
    this.values.push(v);
    return `$${this.values.length}`;
  }
}

// ── Property filters ────────────────────────────────────────────────────────
export const PROPERTY_OPS = ["eq", "neq", "contains", "gt", "gte", "lt", "lte", "exists", "not_exists"] as const;
export type PropertyOp = (typeof PROPERTY_OPS)[number];
export const PROPERTY_OP_LABELS: Record<PropertyOp, string> = {
  eq: "is",
  neq: "is not",
  contains: "contains",
  gt: ">",
  gte: "≥",
  lt: "<",
  lte: "≤",
  exists: "is set",
  not_exists: "is not set",
};
const NUMERIC_OPS = new Set<PropertyOp>(["gt", "gte", "lt", "lte"]);

export const propertyName = z.string().trim().regex(/^[A-Za-z0-9_.$-]{1,64}$/, "Property names use letters, digits, _ . $ - (up to 64).");

export const propertyFilterSchema = z
  .object({
    name: propertyName,
    op: z.enum(PROPERTY_OPS),
    value: z.string().trim().max(200).optional().default(""),
  })
  .superRefine((f, ctx) => {
    if (f.op === "exists" || f.op === "not_exists") return;
    if (NUMERIC_OPS.has(f.op) && !/^-?\d+(\.\d+)?$/.test(f.value)) ctx.addIssue({ code: "custom", message: `"${f.name}" needs a number to compare with.` });
    if (!NUMERIC_OPS.has(f.op) && f.value === "") ctx.addIssue({ code: "custom", message: `Enter a value for "${f.name}".` });
  });
export type PropertyFilter = z.output<typeof propertyFilterSchema>;

/** A jsonb value as a number when it is a number or a numeric string, else null. */
export function numeric(json: string): string {
  return `(case when jsonb_typeof(${json}) = 'number' then (${json} #>> '{}')::numeric
               when jsonb_typeof(${json}) = 'string' and (${json} #>> '{}') ~ '^-?[0-9]+(\\.[0-9]+)?$' then (${json} #>> '{}')::numeric end)`;
}

/** Predicate on a jsonb object column/expression. `neq` and comparisons only match people who have the property. */
export function propertyPredicate(json: string, f: PropertyFilter, p: Params): string {
  const k = p.add(f.name);
  const value = `(${json}->${k})`;
  const text = `(${json}->>${k})`;
  switch (f.op) {
    case "exists":
      return `coalesce(jsonb_typeof(${value}), 'null') <> 'null'`;
    case "not_exists":
      return `coalesce(jsonb_typeof(${value}), 'null') = 'null'`;
    case "eq":
      return `${text} = ${p.add(f.value)}`;
    case "neq":
      return `${text} <> ${p.add(f.value)}`;
    case "contains":
      return `strpos(lower(${text}), lower(${p.add(f.value)})) > 0`;
    default: {
      const op = { gt: ">", gte: ">=", lt: "<", lte: "<=" }[f.op];
      return `${numeric(value)} ${op} ${p.add(f.value)}::numeric`;
    }
  }
}

// ── Cohort definitions ──────────────────────────────────────────────────────
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use a YYYY-MM-DD date.").refine((s) => !Number.isNaN(Date.parse(s)), "Not a valid date.");

export const COHORT_LAST_DAYS = [1, 7, 14, 30, 60, 90, 180, 365] as const;

const rangeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("last"), days: z.coerce.number().int().min(1).max(365) }),
  z.object({ kind: z.literal("between"), from: isoDate, to: isoDate }).refine((r) => r.from <= r.to, "The start date must be on or before the end date."),
]);

export const cohortDefinitionSchema = z
  .object({
    event: z
      .object({
        name: z.string().trim().min(1).max(200),
        minCount: z.coerce.number().int().min(1, "At least once.").max(10_000).default(1),
        range: rangeSchema,
        property: propertyFilterSchema.optional(),
      })
      .optional(),
    userProperty: propertyFilterSchema.optional(),
  })
  .refine((d) => d.event || d.userProperty, "A cohort needs an event condition, a user property condition, or both.");
export type CohortDefinition = z.output<typeof cohortDefinitionSchema>;

/**
 * SELECT of the cohort's people (column `person`, same keys as PERSON.expr).
 * `$1` must be the environment id. Event condition: people who did the event
 * at least minCount times in the range (days in `timezone` for date ranges),
 * counting only events matching the property filter. User property condition:
 * identified users by their profile, plus anonymous installs (not stitched to
 * one user) by their anonymous traits. Both conditions: people in both.
 */
export function cohortSql(def: CohortDefinition, p: Params, opts: { timezone: string; now?: Date }): string {
  const parts: string[] = [];
  if (def.event) {
    const ev = def.event;
    let from: string;
    let to: string;
    if (ev.range.kind === "last") {
      const now = opts.now ?? new Date();
      from = p.add(new Date(now.getTime() - ev.range.days * 86_400_000));
      to = p.add(now);
    } else {
      const tz = p.add(opts.timezone);
      from = `(${p.add(ev.range.from)}::date::timestamp at time zone ${tz})`;
      to = `((${p.add(ev.range.to)}::date + 1)::timestamp at time zone ${tz})`;
    }
    parts.push(`select ${PERSON.expr} as person
        from platform.events e
        ${PERSON.join}
       where e.environment_id = $1 and e.type = 'track'
         and coalesce(e.canonical_name, e.event_name) = ${p.add(ev.name)}
         and coalesce(e.user_id, e.anonymous_id) is not null
         and e."timestamp" >= ${from} and e."timestamp" < ${to}
         ${ev.property ? `and ${propertyPredicate("e.properties", ev.property, p)}` : ""}
       group by 1 having count(*) >= ${p.add(ev.minCount)}`);
  }
  if (def.userProperty) {
    const up = def.userProperty;
    parts.push(`select u.external_id as person from platform.app_users u
       where u.environment_id = $1 and ${propertyPredicate("u.properties", up, p)}
      union
      select 'anon:' || a.anonymous_id from platform.anonymous_users a
       where a.environment_id = $1 and ${propertyPredicate("coalesce(a.first_context->'traits', '{}'::jsonb)", up, p)}
         and (select count(*) from platform.identity_links il where il.environment_id = a.environment_id and il.anonymous_id = a.anonymous_id) <> 1`);
  }
  return parts.map((s) => `(${s})`).join(" intersect ");
}

/**
 * The events of the range with one row per event and its person, as CTEs
 * (`cohort` when a cohort filters the report, then `ev`). `$1` environment,
 * `$2` range start. `ev` has `name`, `person`, `ts`, `id`, `platform`,
 * `app_version`, `properties`, `context`; `id` orders events with equal timestamps.
 */
export function evCte(cohort?: string): string {
  return `${cohort ? `cohort as (${cohort}),` : ""}
  ev as (
    select coalesce(e.canonical_name, e.event_name) as name,
           ${PERSON.expr} as person,
           e."timestamp" as ts, e.id, e.platform, e.app_version, e.properties, e.context
      from platform.events e
      ${PERSON.join}
     where e.environment_id = $1 and e."timestamp" >= $2 and e.type = 'track'
       and coalesce(e.user_id, e.anonymous_id) is not null
       ${cohort ? `and ${PERSON.expr} in (select person from cohort)` : ""}
  )`;
}
