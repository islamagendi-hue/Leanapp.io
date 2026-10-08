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

/**
 * The one counting rule for every report, Activation and usage: an event
 * counts once it has been processed without error (so it carries its
 * canonical name), and only product events count: `track` events and screen
 * views (`screen`, named screen_viewed). identify, alias, push_token and
 * consent are protocol calls, not activity. For rows aliased `e`.
 */
export const COUNTED_TYPES = ["track", "screen"] as const;
export const COUNTED_EVENTS = `e.type in ('track', 'screen') and e.processed_at is not null and e.processing_error is null`;

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

/**
 * The counted events of the range with one row per event and its person, as
 * CTEs (`cohort` when an audience filters the report, then `ev`). `$1`
 * environment, `$2` range start; `end` is the placeholder of the exclusive end
 * (none: up to now). `ev` has `name`, `person`, `ts`, `id`, `platform`,
 * `app_version`, `properties`, `context`; `id` orders events with equal timestamps.
 */
export function evCte(cohort?: string, end?: string): string {
  return `${cohort ? `cohort as (${cohort}),` : ""}
  ev as (
    select coalesce(e.canonical_name, e.event_name) as name,
           ${PERSON.expr} as person,
           e."timestamp" as ts, e.id, e.platform, e.app_version, e.properties, e.context
      from platform.events e
      ${PERSON.join}
     where e.environment_id = $1 and e."timestamp" >= $2${end ? ` and e."timestamp" < ${end}` : ""} and ${COUNTED_EVENTS}
       and coalesce(e.user_id, e.anonymous_id) is not null
       ${cohort ? `and ${PERSON.expr} in (select person from cohort)` : ""}
  )`;
}
