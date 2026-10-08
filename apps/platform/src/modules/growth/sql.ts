/**
 * SQL for growth state. Pure (builds text and bind values only) so the shapes
 * are unit tested. The same flag expressions are used by the per-event update
 * and by the set-based rebuild, so both always agree on what an activation,
 * core action, purchase or return is.
 */
import { dayNumberSql, measurableSql } from "@/modules/analytics/retention-rule";
import { COUNTED_EVENTS, numeric, Params, PERSON, propertyPredicate } from "@/modules/analytics/sql";
import { RETENTION_DAYS, type EventRule, type GrowthDefinition } from "./definition";

export { COUNTED_EVENTS, COUNTED_TYPES as ACTIVE_TYPES } from "@/modules/analytics/sql";

function ruleSql(rule: EventRule | null, p: Params, name: string, props: string): string {
  if (!rule) return "false";
  const parts = [`${name} = ${p.add(rule.event)}`, ...rule.filters.map((f) => propertyPredicate(props, f, p))];
  return `(${parts.join(" and ")})`;
}

/**
 * Per-event flags for rows of platform.events aliased `e`:
 * is_act, is_core, is_return, amount (null = not a purchase), currency.
 */
export function flagColumns(def: GrowthDefinition, p: Params, defaultCurrency: string): string {
  const name = "coalesce(e.canonical_name, e.event_name)";
  const isCore = ruleSql(def.core_action, p, name, "e.properties");
  let amount = "null::numeric";
  let currency = "null::text";
  if (def.revenue) {
    const ev = p.add(def.revenue.event);
    const amt = p.add(def.revenue.amount_property);
    const cur = p.add(def.revenue.currency_property);
    amount = `case when ${name} = ${ev} then ${numeric(`(e.properties->${amt})`)} end`;
    currency = `case when (e.properties->>${cur}) ~ '^[A-Za-z]{3}$' then upper(e.properties->>${cur}) else ${p.add(defaultCurrency)}::text end`;
  }
  return `${ruleSql(def.activation, p, name, "e.properties")} as is_act,
          ${isCore} as is_core,
          ${def.retention.return_event === "core_action" ? isCore : "true"} as is_return,
          ${amount} as amount,
          ${currency} as currency`;
}

/**
 * Recomputes growth_state rows for a set of people from all their events.
 * Binds: $1 environment, $2 persons (text[]), $3 user ids, $4 anonymous ids
 * (the candidate events: every event of those users or installs), $5 plan
 * version id (nullable). People with no counted events are not returned.
 */
export function rebuildSelectSql(def: GrowthDefinition, defaultCurrency: string, timezone: string): { sql: string; params: Params } {
  return rowsSql(def, defaultCurrency, timezone, 5, "(e.user_id = any($3::text[]) or e.anonymous_id = any($4::text[]))", "person = any($2::text[])", "$5::uuid");
}

/**
 * The same rows for everyone active in a window, as if the window were all of
 * history (the preview on the growth setup page). Binds: $1 environment, $2 window start.
 */
export function windowSelectSql(def: GrowthDefinition, defaultCurrency: string, timezone: string): { sql: string; params: Params } {
  return rowsSql(def, defaultCurrency, timezone, 2, `e."timestamp" >= $2`, "true", "null::uuid");
}

function rowsSql(def: GrowthDefinition, defaultCurrency: string, timezone: string, reserved: number, candidates: string, people: string, version: string) {
  const p = new Params(new Array(reserved).fill(undefined));
  const tz = p.add(timezone);
  const retention = RETENTION_DAYS.map(
    (d) => `min(ts) filter (where is_return and ${dayNumberSql("ts", "first_seen", tz)} = ${d}) as retained_d${d}_at`,
  ).join(",\n           ");
  const sql = `
    with ev as (
      select ${PERSON.expr} as person, e."timestamp" as ts, ${flagColumns(def, p, defaultCurrency)}
        from platform.events e
        ${PERSON.join}
       where e.environment_id = $1
         and ${candidates}
         and coalesce(e.user_id, e.anonymous_id) is not null
         and ${COUNTED_EVENTS}
    ),
    mine as (
      select *, min(ts) over (partition by person) as first_seen from ev where ${people}
    ),
    money as (
      select person, jsonb_object_agg(currency, total) as revenue
        from (select person, currency, sum(amount) as total from mine where amount is not null group by person, currency) x
       group by person
    )
    select m.person,
           case when m.person like 'anon:%' then null else m.person end as user_id,
           case when m.person like 'anon:%' then substr(m.person, 6) end as anonymous_id,
           min(ts) as first_seen_at,
           max(ts) as last_active_at,
           min(ts) filter (where is_act) as activated_at,
           min(ts) filter (where is_core) as first_core_action_at,
           count(*) filter (where is_core) as core_action_count,
           min(ts) filter (where amount is not null) as first_revenue_at,
           coalesce((select revenue from money where money.person = m.person), '{}'::jsonb) as revenue,
           count(*) filter (where amount is not null) as purchases,
           ${retention},
           ${version} as plan_version_id
      from mine m
     group by m.person`;
  return { sql, params: p };
}

/**
 * Aggregates growth rows (a growth_state selection or a rows CTE named `rows`)
 * into the summary numbers. Retention on day N only counts people whose day N
 * is over (see analytics/retention-rule.ts); `tz` is the timezone placeholder.
 */
export const summarySelect = (tz: string) => `
  select count(*)::int as people,
         count(activated_at)::int as activated,
         count(first_core_action_at)::int as core_people,
         coalesce(sum(core_action_count), 0)::float8 as core_actions,
         count(first_revenue_at)::int as paying,
         coalesce(sum(purchases), 0)::float8 as purchases,
         ${RETENTION_DAYS.map((d) => `count(*) filter (where ${measurableSql("first_seen_at", d, tz)})::int as d${d}_eligible,
         count(retained_d${d}_at) filter (where ${measurableSql("first_seen_at", d, tz)})::int as d${d}_retained`).join(", ")}
    from rows`;

export const REVENUE_SELECT = `
  select r.key as currency, sum(r.value::numeric)::float8 as total
    from rows, jsonb_each_text(rows.revenue) r
   group by r.key order by r.key`;

/**
 * Applies a batch of newly processed events to their people's existing rows
 * in one statement, resolving people with the analytics key. A person is
 * updated only when they have a row and none of their batch events is earlier
 * than first_seen_at (then nothing already derived can change except by
 * min / max / sum). Returns every person in the batch and whether their row
 * was updated; the caller rebuilds the others from all their events.
 * Binds: $1 environment, $2 event row ids (bigint[]), $3 plan version id.
 */
export function applyBatchSql(def: GrowthDefinition, defaultCurrency: string, timezone: string): { sql: string; params: Params } {
  const p = new Params([undefined, undefined, undefined]);
  const tz = p.add(timezone);
  const retentionAgg = RETENTION_DAYS.map(
    (d) => `min(ts) filter (where is_return and ${dayNumberSql("ts", "first_seen_at", tz)} = ${d}) as r${d}`,
  ).join(",\n             ");
  const retentionSet = RETENTION_DAYS.map((d) => `retained_d${d}_at = least(g.retained_d${d}_at, a.r${d})`).join(",\n             ");
  const sql = `
    with ev as (
      select ${PERSON.expr} as person, e."timestamp" as ts, ${flagColumns(def, p, defaultCurrency)}
        from platform.events e
        ${PERSON.join}
       where e.environment_id = $1 and e.id = any($2::bigint[])
         and coalesce(e.user_id, e.anonymous_id) is not null and ${COUNTED_EVENTS}
    ),
    j as (
      select ev.*, g.first_seen_at
        from ev join platform.growth_state g on g.environment_id = $1 and g.person = ev.person
    ),
    ok as (select person from j group by person having min(ts) >= min(first_seen_at)),
    a as (
      select person,
             max(ts) as last_ts,
             min(ts) filter (where is_act) as act,
             min(ts) filter (where is_core) as core_first,
             count(*) filter (where is_core) as core_n,
             min(ts) filter (where amount is not null) as rev_first,
             count(*) filter (where amount is not null) as purchases,
             ${retentionAgg}
        from j where person in (select person from ok)
       group by person
    ),
    money as (
      select person, currency, sum(amount) as total
        from j where amount is not null and person in (select person from ok)
       group by person, currency
    ),
    upd as (
      update platform.growth_state g set
             last_active_at = greatest(g.last_active_at, a.last_ts),
             activated_at = least(g.activated_at, a.act),
             first_core_action_at = least(g.first_core_action_at, a.core_first),
             core_action_count = g.core_action_count + a.core_n,
             first_revenue_at = least(g.first_revenue_at, a.rev_first),
             revenue = case when a.purchases = 0 then g.revenue else (
               select coalesce(jsonb_object_agg(c, t), '{}'::jsonb) from (
                 select c, sum(t) as t from (
                   select r.key as c, ${numeric("r.value")} as t from jsonb_each(g.revenue) r
                   union all
                   select m.currency, m.total from money m where m.person = g.person) x
                 group by c) y) end,
             purchases = g.purchases + a.purchases,
             ${retentionSet},
             plan_version_id = $3::uuid,
             updated_at = now()
        from a
       where g.environment_id = $1 and g.person = a.person
      returning g.person)
    select distinct ev.person, ev.person in (select person from upd) as applied from ev`;
  return { sql, params: p };
}
