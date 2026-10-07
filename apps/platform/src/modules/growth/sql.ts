/**
 * SQL for growth state. Pure (builds text and bind values only) so the shapes
 * are unit tested. The same flag expressions are used by the per-event update
 * and by the set-based rebuild, so both always agree on what an activation,
 * core action, purchase or return is.
 */
import { numeric, Params, PERSON, propertyPredicate } from "@/modules/analytics/sql";
import { RETENTION_DAYS, type EventRule, type GrowthDefinition } from "./definition";

/** Event types that count as activity (identify, alias and push_token are protocol calls). */
export const ACTIVE_TYPES = ["track", "screen"] as const;

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

/** Filter for events that count toward growth state. */
export const COUNTED_EVENTS = `e.type in ('track', 'screen') and e.processed_at is not null and e.processing_error is null`;

/**
 * Recomputes growth_state rows for a set of people from all their events.
 * Binds: $1 environment, $2 persons (text[]), $3 user ids, $4 anonymous ids
 * (the candidate events: every event of those users or installs), $5 plan
 * version id (nullable). People with no counted events are not returned.
 */
export function rebuildSelectSql(def: GrowthDefinition, defaultCurrency: string): { sql: string; params: Params } {
  return rowsSql(def, defaultCurrency, 5, "(e.user_id = any($3::text[]) or e.anonymous_id = any($4::text[]))", "person = any($2::text[])", "$5::uuid");
}

/**
 * The same rows for everyone active in a window, as if the window were all of
 * history (the preview on the growth setup page). Binds: $1 environment, $2 window start.
 */
export function windowSelectSql(def: GrowthDefinition, defaultCurrency: string): { sql: string; params: Params } {
  return rowsSql(def, defaultCurrency, 2, `e."timestamp" >= $2`, "true", "null::uuid");
}

function rowsSql(def: GrowthDefinition, defaultCurrency: string, reserved: number, candidates: string, people: string, version: string) {
  const p = new Params(new Array(reserved).fill(undefined));
  const retention = RETENTION_DAYS.map(
    (d) => `min(ts) filter (where is_return and ts >= first_seen + interval '${d} days') as retained_d${d}_at`,
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
 * into the summary numbers. Retention rates only count people first seen at
 * least N days ago (the others can't have come back on day N yet).
 */
export const SUMMARY_SELECT = `
  select count(*)::int as people,
         count(activated_at)::int as activated,
         count(first_core_action_at)::int as core_people,
         coalesce(sum(core_action_count), 0)::float8 as core_actions,
         count(first_revenue_at)::int as paying,
         coalesce(sum(purchases), 0)::float8 as purchases,
         ${RETENTION_DAYS.map((d) => `count(*) filter (where first_seen_at <= now() - interval '${d} days')::int as d${d}_eligible,
         count(retained_d${d}_at) filter (where first_seen_at <= now() - interval '${d} days')::int as d${d}_retained`).join(", ")}
    from rows`;

export const REVENUE_SELECT = `
  select r.key as currency, sum(r.value::numeric)::float8 as total
    from rows, jsonb_each_text(rows.revenue) r
   group by r.key order by r.key`;

/**
 * Applies one newly processed event to its person's existing row. Only
 * updates when the row exists and the event is not earlier than first_seen_at
 * (then nothing already derived can change except by min/max/sum); otherwise
 * returns no row and the caller rebuilds the person from all events.
 * Binds: $1 environment, $2 person, $3 event row id, $4 plan version id.
 */
export function applyEventSql(def: GrowthDefinition, defaultCurrency: string): { sql: string; params: Params } {
  const p = new Params([undefined, undefined, undefined, undefined]);
  const retention = RETENTION_DAYS.map(
    (d) => `retained_d${d}_at = case when ev.is_return and ev.ts >= g.first_seen_at + interval '${d} days' then least(g.retained_d${d}_at, ev.ts) else g.retained_d${d}_at end`,
  ).join(",\n           ");
  const sql = `
    update platform.growth_state g set
           last_active_at = greatest(g.last_active_at, ev.ts),
           activated_at = case when ev.is_act then least(g.activated_at, ev.ts) else g.activated_at end,
           first_core_action_at = case when ev.is_core then least(g.first_core_action_at, ev.ts) else g.first_core_action_at end,
           core_action_count = g.core_action_count + case when ev.is_core then 1 else 0 end,
           first_revenue_at = case when ev.amount is not null then least(g.first_revenue_at, ev.ts) else g.first_revenue_at end,
           revenue = case when ev.amount is not null
                          then g.revenue || jsonb_build_object(ev.currency, coalesce(${numeric("(g.revenue->ev.currency)")}, 0) + ev.amount)
                          else g.revenue end,
           purchases = g.purchases + case when ev.amount is not null then 1 else 0 end,
           ${retention},
           plan_version_id = $4::uuid,
           updated_at = now()
      from (select e."timestamp" as ts, ${flagColumns(def, p, defaultCurrency)}
              from platform.events e where e.id = $3 and ${COUNTED_EVENTS}) ev
     where g.environment_id = $1 and g.person = $2 and ev.ts >= g.first_seen_at
    returning 1`;
  return { sql, params: p };
}
