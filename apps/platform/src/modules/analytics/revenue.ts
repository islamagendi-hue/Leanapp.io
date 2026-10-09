import "server-only";
import { z } from "zod";
import type { Db } from "@/lib/db";
import { ValidationError } from "@/lib/errors";
import { msg } from "@/i18n/translate";
import type { TenantContext } from "@/modules/tenancy/context";
import { revenueRules, type RevenueRule } from "./revenue-rules";
import { bucketKeys, bucketSql, defaultInterval, intervalField, comparisonRange, rangeFields, resolveRange, type Interval, type ReportRange } from "./range";
import { analyticsTx, eventsSource, rangeInfo, type RangeInfo } from "./service";
import { numeric, type Params } from "./sql";

/**
 * Revenue from events (see ./revenue-rules.ts for which events and
 * properties count). Amounts are reported per currency, as sent: there is no
 * FX conversion, so totals in different currencies are never added together.
 * Refunds are subtracted from the currency they were sent in. A transaction is
 * counted once per event name and `transaction_id` (events without one count
 * individually). People and stitching follow the other reports.
 */

export const REVENUE_BREAKDOWNS = ["platform", "event", "channel"] as const;

/** Channel keys for people with no attributed source (shown translated). */
export const CHANNEL_ORGANIC = "organic";
export const CHANNEL_UNKNOWN = "(unknown)";
export const CHANNEL_NO_INSTALL = "(no install on record)";

export const revenueSchema = z.object({
  ...rangeFields,
  interval: intervalField,
  breakdown: z.union([z.enum(REVENUE_BREAKDOWNS), z.string().regex(/^property:[A-Za-z0-9_.$-]{1,64}$/)]).optional().catch(undefined),
  cohortId: z.uuid().optional().catch(undefined),
});

/** Events with no currency (or not a 3-letter code) are grouped under this key. */
export const NO_CURRENCY = "(none)";

export interface CurrencyRevenue {
  currency: string;
  gross: number;
  refunds: number;
  net: number;
  transactions: number;
  refundCount: number;
  payingUsers: number;
  /** Net revenue per active person in the range (everyone with a track event). */
  arpu: number;
  /** Net revenue per paying person. */
  arppu: number;
}

export interface RevenueReport {
  /** Bucket keys (days, week starts or month starts). */
  days: string[];
  interval: Interval;
  range: RangeInfo;
  activeUsers: number;
  currencies: CurrencyRevenue[];
  /** Net revenue per bucket, per currency. */
  daily: { key: string; counts: number[] }[];
  /** Net revenue per currency in the comparison period, when one was asked for. */
  previous: { currency: string; net: number }[] | null;
  breakdown: { key: string; currency: string; gross: number; refunds: number; net: number; payingUsers: number }[] | null;
  breakdownBy: string | null;
  rules: RevenueRule[];
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
 */
export function revenueCtes(p: Params, rules: RevenueRule[]): string {
  const amount = numeric("ev.properties->coalesce(r.property, 'revenue')");
  const txKey = "coalesce(ev.properties->>'transaction_id', ev.id::text)";
  return `rules as (
      select * from unnest(${p.add(rules.map((r) => r.event))}::text[], ${p.add(rules.map((r) => r.property))}::text[], ${p.add(rules.map((r) => r.kind))}::text[])
        as r(name, property, kind)
    ),
    tx as (
      select distinct on (ev.name, ${txKey})
             ev.name, ev.person, ev.ts, ev.id, ev.platform, ev.properties,
             coalesce(r.kind, 'revenue') as kind,
             ${amount} as amount,
             case when ev.properties->>'currency' ~ '^[A-Za-z]{3}$' then upper(ev.properties->>'currency') else '${NO_CURRENCY}' end as currency
        from ev left join rules r on r.name = ev.name
       where ${amount} is not null
       order by ev.name, ${txKey}, ev.ts, ev.id
    )`;
}

function groupExpr(breakdown: string | undefined, p: Params): string {
  if (!breakdown) return "'All'";
  if (breakdown === "platform") return "coalesce(platform, '(none)')";
  if (breakdown === "event") return "name";
  if (breakdown === "channel") return channelExpr();
  return `coalesce(properties->>${p.add(breakdown.slice("property:".length))}, '(none)')`;
}

/**
 * The acquisition channel of the person behind a transaction: the source of
 * their latest install or reinstall attribution at or before it (last touch),
 * labelled like the Acquisition reports. The install is found by the person's
 * user_id, their anonymous_id, or an install linked to their user_id.
 */
function channelExpr(): string {
  return `coalesce((
      select coalesce(ae.source, case when ae.match_type = 'organic' then '${CHANNEL_ORGANIC}' else '${CHANNEL_UNKNOWN}' end)
        from platform.attribution_events ae
       where ae.environment_id = $1 and ae.kind in ('install', 'reinstall') and ae.occurred_at <= tx.ts
         and (ae.user_id = tx.person
              or 'anon:' || ae.anonymous_id = tx.person
              or ae.anonymous_id in (select il.anonymous_id from platform.identity_links il where il.environment_id = $1 and il.user_id = tx.person))
       order by ae.occurred_at desc limit 1), '${CHANNEL_NO_INSTALL}')`;
}

const round = (n: number) => Math.round(n * 100) / 100;

export async function revenueReport(ctx: TenantContext, scope: { environmentId: string; timezone: string }, input: unknown): Promise<RevenueReport> {
  const r = revenueSchema.safeParse(input);
  if (!r.success) throw new ValidationError(r.error.issues[0]?.message ?? msg("Invalid revenue report."));
  const { breakdown, cohortId } = r.data;
  const range = resolveRange(r.data, scope.timezone);
  const interval = defaultInterval(range, r.data.interval);
  const previousRangeOf = comparisonRange(range, scope.timezone, r.data);
  return analyticsTx(ctx, async (db) => {
    const rules = await loadRevenueRules(db, scope.environmentId);
    const src = await eventsSource(db, scope, cohortId, [scope.environmentId, range.start, scope.timezone], range.end);
    const p = src.p;
    const ctes = revenueCtes(p, rules);
    const g = groupExpr(breakdown, p);
    const rows = await db.query<{
      currency: string | null; d: string | null; g: string | null; kind: string; gd: number; gg: number; amount: number | null; n: string; people: string;
    }>(
      `with ${src.sql}, ${ctes}
       select currency, d, g, kind, grouping(d) as gd, grouping(g) as gg, sum(amount)::float8 as amount, count(*) as n, count(distinct person) as people
         from (select *, ${bucketSql("ts", "$3", interval)} as d, ${g} as g from tx) t
        group by grouping sets ((currency, kind), (currency, d, kind), (currency, g, kind))
       union all
       select null, null, null, 'active', 1, 1, null, 0, count(distinct person) from ev`,
      p.values,
    );
    const dayKeys = bucketKeys(range, interval);
    const previous = previousRangeOf ? await netByCurrency(db, scope, cohortId, rules, previousRangeOf) : null;
    const totals = new Map<string, CurrencyRevenue>();
    const ensure = (c: string) => {
      if (!totals.has(c)) totals.set(c, { currency: c, gross: 0, refunds: 0, net: 0, transactions: 0, refundCount: 0, payingUsers: 0, arpu: 0, arppu: 0 });
      return totals.get(c)!;
    };
    const daily = new Map<string, number[]>();
    const groups = new Map<string, { key: string; currency: string; gross: number; refunds: number; net: number; payingUsers: number }>();
    let activeUsers = 0;
    for (const row of rows) {
      if (row.kind === "active") {
        activeUsers = Number(row.people);
        continue;
      }
      const c = row.currency ?? NO_CURRENCY;
      const amount = Number(row.amount ?? 0);
      const sign = row.kind === "refund" ? -1 : 1;
      if (Number(row.gd) === 1 && Number(row.gg) === 1) {
        const t = ensure(c);
        if (row.kind === "refund") {
          t.refunds += amount;
          t.refundCount += Number(row.n);
        } else {
          t.gross += amount;
          t.transactions += Number(row.n);
          t.payingUsers = Number(row.people);
        }
      } else if (Number(row.gd) === 0) {
        if (!daily.has(c)) daily.set(c, dayKeys.map(() => 0));
        const i = dayKeys.indexOf(row.d!);
        if (i >= 0) daily.get(c)![i] += sign * amount;
      } else {
        const key = `${c}\u0000${row.g}`;
        if (!groups.has(key)) groups.set(key, { key: row.g ?? "(none)", currency: c, gross: 0, refunds: 0, net: 0, payingUsers: 0 });
        const grp = groups.get(key)!;
        if (row.kind === "refund") grp.refunds += amount;
        else {
          grp.gross += amount;
          grp.payingUsers = Number(row.people);
        }
      }
    }
    const currencies = [...totals.values()].map((t) => {
      const net = t.gross - t.refunds;
      return {
        ...t,
        gross: round(t.gross),
        refunds: round(t.refunds),
        net: round(net),
        arpu: activeUsers ? round(net / activeUsers) : 0,
        arppu: t.payingUsers ? round(net / t.payingUsers) : 0,
      };
    }).sort((a, b) => b.transactions - a.transactions || a.currency.localeCompare(b.currency));
    const order = currencies.map((c) => c.currency);
    return {
      days: dayKeys,
      interval,
      range: rangeInfo(range, previousRangeOf, r.data.compare),
      previous,
      activeUsers,
      currencies,
      daily: order.filter((c) => daily.has(c)).map((c) => ({ key: c, counts: daily.get(c)!.map(round) })),
      breakdown: breakdown
        ? [...groups.values()]
            .map((x) => ({ ...x, gross: round(x.gross), refunds: round(x.refunds), net: round(x.gross - x.refunds) }))
            .sort((a, b) => order.indexOf(a.currency) - order.indexOf(b.currency) || b.net - a.net || a.key.localeCompare(b.key))
        : null,
      breakdownBy: breakdown ?? null,
      rules,
    };
  });
}

/** Net revenue per currency in a range (the comparison period's totals). */
async function netByCurrency(db: Db, scope: { environmentId: string; timezone: string }, cohortId: string | undefined, rules: RevenueRule[], range: ReportRange) {
  const src = await eventsSource(db, scope, cohortId, [scope.environmentId, range.start], range.end);
  const rows = await db.query<{ currency: string; net: number }>(
    `with ${src.sql}, ${revenueCtes(src.p, rules)}
     select currency, sum(case when kind = 'refund' then -amount else amount end)::float8 as net from tx group by currency order by currency`,
    src.p.values,
  );
  return rows.map((x) => ({ currency: x.currency, net: round(Number(x.net)) }));
}
