/**
 * The SQL that turns events into revenue transactions (see ./revenue-rules.ts
 * for which events and properties count). Pure (no database access of its
 * own), so audience conditions can compile it too; ./revenue.ts re-exports it
 * for the reports.
 */
import type { Db } from "@/lib/db";
import { revenueRules, type RevenueRule } from "./revenue-rules";
import { numeric } from "./sql";

/** Events with no currency (or not a 3-letter code) are grouped under this key. */
export const NO_CURRENCY = "(none)";

/** Bind values collected while building SQL; `add` returns the placeholder (analytics Params and the audience compiler's sink). */
interface Sink {
  readonly values: unknown[];
  add(v: unknown): string;
}

/** Revenue rules for the environment's app: its published plan, then the catalog. */
export async function loadRevenueRules(db: Db, environmentId: string): Promise<RevenueRule[]> {
  const rows = await db.query<{ name: string; properties: string[] }>(
    `select e.event_name as name, coalesce(array_agg(p.name) filter (where p.name is not null), '{}') as properties
       from platform.environments env
       join platform.tracking_plans tp on tp.app_id = env.app_id
       join platform.tracking_events e on e.plan_version_id = tp.published_version_id
       left join platform.tracking_event_properties p on p.tracking_event_id = e.id
      where env.id = $1 and e.revenue_relevance
      group by e.event_name`,
    [environmentId],
  );
  return revenueRules(rows);
}

/**
 * `rules` and `tx` CTEs over an `ev` CTE (name, person, ts, id, platform,
 * properties): one row per counted transaction with `kind`, `amount`, `currency`.
 * `names` renames the three CTEs, for a query that needs more than one set.
 */
export function revenueCtes(p: Sink, rules: RevenueRule[], names: { ev: string; rules: string; tx: string } = { ev: "ev", rules: "rules", tx: "tx" }): string {
  const { ev, rules: rulesCte, tx } = names;
  const amount = numeric(`${ev}.properties->coalesce(r.property, 'revenue')`);
  const txKey = `coalesce(${ev}.properties->>'transaction_id', ${ev}.id::text)`;
  return `${rulesCte} as (
      select * from unnest(${p.add(rules.map((r) => r.event))}::text[], ${p.add(rules.map((r) => r.property))}::text[], ${p.add(rules.map((r) => r.kind))}::text[])
        as r(name, property, kind)
    ),
    ${tx} as (
      select distinct on (${ev}.name, ${txKey})
             ${ev}.name, ${ev}.person, ${ev}.ts, ${ev}.id, ${ev}.platform, ${ev}.properties,
             coalesce(r.kind, 'revenue') as kind,
             ${amount} as amount,
             case when ${ev}.properties->>'currency' ~ '^[A-Za-z]{3}$' then upper(${ev}.properties->>'currency') else '${NO_CURRENCY}' end as currency
        from ${ev} left join ${rulesCte} r on r.name = ${ev}.name
       where ${amount} is not null
       order by ${ev}.name, ${txKey}, ${ev}.ts, ${ev}.id
    )`;
}
