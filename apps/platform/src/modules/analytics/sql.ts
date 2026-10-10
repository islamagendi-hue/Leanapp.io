/**
 * SQL building blocks shared by the analytics reports. Pure (no database
 * access) so the query shapes can be unit tested; values always travel as
 * bind parameters, never in the SQL text.
 */
import { z } from "zod";
import { msg } from "@/i18n/translate";

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

/**
 * "Any event": every counted event. Real event names start with a letter
 * (ingestion rule), so this can't collide with one. Trends, KPIs and
 * retention accept it.
 */
export const ANY_EVENT = "$any";

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

/**
 * Channel keys for people with no attributed source (shown translated). Organic only when the
 * install's own referrer said so (match_key store_organic); direct when its parameters said
 * direct; unattributed when nothing matched; unknown when a match carried no source name.
 */
export const CHANNEL_ORGANIC = "organic";
export const CHANNEL_DIRECT = "(direct)";
export const CHANNEL_UNATTRIBUTED = "(unattributed)";
export const CHANNEL_UNKNOWN = "(unknown)";
export const CHANNEL_NO_INSTALL = "(no install on record)";

/** Labels of the keys above, marked for translation. */
export const CHANNEL_KEY_LABELS: Record<string, string> = {
  [CHANNEL_ORGANIC]: msg("organic"),
  [CHANNEL_DIRECT]: msg("Direct"),
  [CHANNEL_UNATTRIBUTED]: msg("Unattributed"),
  [CHANNEL_UNKNOWN]: msg("Unknown source"),
  [CHANNEL_NO_INSTALL]: msg("No install on record"),
};

/** The channel label of an attribution_events row (`prefix` is its alias with a dot, or ""). */
export function channelLabelSql(prefix: string): string {
  const c = (col: string) => `${prefix}${col}`;
  return `coalesce(${c("source")}, case when ${c("match_type")} = 'organic' then (case ${c("match_key")} when 'store_organic' then '${CHANNEL_ORGANIC}'
            when 'direct' then '${CHANNEL_DIRECT}' when 'organic_other' then '${CHANNEL_UNKNOWN}' else '${CHANNEL_UNATTRIBUTED}' end) else '${CHANNEL_UNKNOWN}' end)`;
}

/**
 * Each person's first install or reinstall on record (environment id in $1),
 * with `person`, `occurred_at` and `channel` labelled like the Acquisition
 * reports. People are stitched as in the reports: user_id, else the one user
 * the install is linked to, else the anonymous id. A query for a CTE body.
 */
export const FIRST_INSTALL_SQL = `select distinct on (person) person, occurred_at,
                ${channelLabelSql("")} as channel
           from (select ae.*, coalesce(ae.user_id, l.user_id, 'anon:' || ae.anonymous_id) as person
                   from platform.attribution_events ae
                   left join lateral (
                     select min(il.user_id) as user_id from platform.identity_links il
                      where il.environment_id = ae.environment_id and il.anonymous_id = ae.anonymous_id
                     having count(*) = 1
                   ) l on ae.user_id is null and ae.anonymous_id is not null
                  where ae.environment_id = $1 and ae.kind in ('install', 'reinstall')
                    and coalesce(ae.user_id, ae.anonymous_id) is not null) i
          order by person, occurred_at, id`;

/**
 * The acquisition channel of the person behind a row of `row`(a CTE with
 * `person` and `ts`, environment id in $1): the source of their latest install
 * or reinstall attribution at or before it (last touch), labelled like the
 * Acquisition reports. The install is found by the person's user_id, their
 * anonymous_id, or an install linked to their user_id.
 */
export function channelSql(row: string): string {
  return `coalesce((
      select ${channelLabelSql("ae.")}
        from platform.attribution_events ae
       where ae.environment_id = $1 and ae.kind in ('install', 'reinstall') and ae.occurred_at <= ${row}.ts
         and (ae.user_id = ${row}.person
              or 'anon:' || ae.anonymous_id = ${row}.person
              or ae.anonymous_id in (select il.anonymous_id from platform.identity_links il where il.environment_id = $1 and il.user_id = ${row}.person))
       order by ae.occurred_at desc limit 1), '${CHANNEL_NO_INSTALL}')`;
}
