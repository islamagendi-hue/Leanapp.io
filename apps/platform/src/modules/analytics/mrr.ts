import "server-only";
import type { Db } from "@/lib/db";
import type { Interval, ReportRange } from "./range";
import { eventsSource } from "./service";
import { numeric } from "./sql";

/**
 * Monthly recurring revenue from the standard subscription events
 * (subscription_started, subscription_renewed, subscription_expired), keyed by
 * `subscription_id`. At a moment T a subscription is active when its latest
 * charge before T still covers T (its `billing_period`, plus GRACE_DAYS for
 * late renewal events) and no subscription_expired came after that charge.
 * A cancellation only turns auto-renew off, so the subscription counts until
 * its period ends. Its MRR is `price` turned into a monthly amount; lifetime
 * and unknown periods are left out. Per currency, as sent: no FX conversion.
 */

export const MRR_EVENTS = { charge: ["subscription_started", "subscription_renewed"], end: "subscription_expired" } as const;
export const GRACE_DAYS = 3;
/** How far back a charge can still cover today: a year, plus grace. */
const LOOKBACK_DAYS = 366 + GRACE_DAYS;

/** Billing period → [length as a Postgres interval, monthly factor]. */
export const PERIODS: Record<string, [string, number]> = {
  weekly: ["7 days", 52 / 12],
  monthly: ["1 month", 1],
  quarterly: ["3 months", 1 / 3],
  yearly: ["1 year", 1 / 12],
};

export interface MrrCurrency {
  currency: string;
  /** MRR at the end of the range, and at its start. */
  mrr: number;
  startMrr: number;
  activeSubscriptions: number;
  /** MRR at the end of each bucket. */
  series: number[];
  plans: { plan: string; mrr: number; subscriptions: number }[];
}

const round = (n: number) => Math.round(n * 100) / 100;

export async function mrrByCurrency(
  db: Db,
  scope: { environmentId: string; timezone: string },
  cohortId: string | undefined,
  range: ReportRange,
  interval: Interval,
  keys: string[],
): Promise<MrrCurrency[]> {
  const since = new Date(range.start.getTime() - LOOKBACK_DAYS * 86_400_000);
  const src = await eventsSource(db, scope, cohortId, [scope.environmentId, since], range.end);
  const p = src.p;
  const step = interval === "day" ? "1 day" : interval === "week" ? "1 week" : "1 month";
  const tz = p.add(scope.timezone);
  const periodCase = (field: 0 | 1) =>
    `case c.properties->>'billing_period' ${Object.entries(PERIODS).map(([k, v]) => `when '${k}' then ${field === 0 ? `interval '${v[0]}'` : v[1]}`).join(" ")} end`;
  const rows = await db.query<{ k: string; currency: string; plan: string | null; gp: number; mrr: number; n: string }>(
    `with ${src.sql},
     pts as (
       select k, least(((k::date + interval '${step}')::timestamp at time zone ${tz}), ${p.add(range.end)}::timestamptz) as t
         from unnest(${p.add(keys)}::text[]) k
       union all select '', ${p.add(range.start)}::timestamptz
     ),
     s as (
       select ev.properties->>'subscription_id' as sid, ev.name, ev.ts, ev.id, ev.properties
         from ev
        where ev.name in ('${MRR_EVENTS.charge.join("', '")}', '${MRR_EVENTS.end}')
          and coalesce(ev.properties->>'subscription_id', '') <> ''
     ),
     snap as (
       select pts.k, pts.t, lc.*
         from pts cross join lateral (
           select distinct on (c.sid) c.sid, c.ts,
                  ${numeric("c.properties->'price'")} * (${periodCase(1)}) as monthly,
                  c.ts + (${periodCase(0)}) + interval '${GRACE_DAYS} days' as covered_until,
                  c.properties->>'plan_id' as plan,
                  case when c.properties->>'currency' ~ '^[A-Za-z]{3}$' then upper(c.properties->>'currency') else '(none)' end as currency
             from s c
            where c.name <> '${MRR_EVENTS.end}' and c.ts < pts.t
            order by c.sid, c.ts desc, c.id desc
         ) lc
        where lc.monthly is not null and lc.covered_until > pts.t
          and not exists (select 1 from s e where e.sid = lc.sid and e.name = '${MRR_EVENTS.end}' and e.ts >= lc.ts and e.ts < pts.t)
     )
     select k, currency, plan, grouping(plan) as gp, sum(monthly)::float8 as mrr, count(*) as n
       from snap
      group by grouping sets ((k, currency), (k, currency, plan))`,
    p.values,
  );
  const end = keys.at(-1) ?? "";
  const out = new Map<string, MrrCurrency>();
  for (const row of rows) {
    if (!out.has(row.currency)) out.set(row.currency, { currency: row.currency, mrr: 0, startMrr: 0, activeSubscriptions: 0, series: keys.map(() => 0), plans: [] });
    const c = out.get(row.currency)!;
    const mrr = round(Number(row.mrr));
    if (Number(row.gp) === 0) {
      if (row.k === end) c.plans.push({ plan: row.plan ?? "(none)", mrr, subscriptions: Number(row.n) });
      continue;
    }
    if (row.k === "") c.startMrr = mrr;
    else {
      const i = keys.indexOf(row.k);
      if (i >= 0) c.series[i] = mrr;
      if (row.k === end) {
        c.mrr = mrr;
        c.activeSubscriptions = Number(row.n);
      }
    }
  }
  for (const c of out.values()) c.plans.sort((a, b) => b.mrr - a.mrr || a.plan.localeCompare(b.plan));
  return [...out.values()].filter((c) => c.mrr || c.startMrr || c.series.some(Boolean)).sort((a, b) => b.mrr - a.mrr || a.currency.localeCompare(b.currency));
}
