import "server-only";
import { z } from "zod";
import type { Db } from "@/lib/db";
import { ValidationError } from "@/lib/errors";
import { msg } from "@/i18n/translate";
import type { TenantContext } from "@/modules/tenancy/context";
import { spendBySource } from "@/modules/attribution/spend";
import { grossReturn, roas } from "@/modules/attribution/spend-pure";
import { mrrByCurrency, type MrrCurrency } from "./mrr";
import type { RevenueRule } from "./revenue-rules";
import { loadRevenueRules, NO_CURRENCY, revenueCtes } from "./revenue-sql";
import { bucketKeys, bucketSql, defaultInterval, intervalField, comparisonRange, rangeFields, resolveRange, type Interval, type ReportRange } from "./range";
import { analyticsTx, eventsSource, rangeInfo, type RangeInfo } from "./service";
import { channelSql, type Params } from "./sql";

/**
 * Revenue from events (see ./revenue-rules.ts for which events and
 * properties count). Amounts are reported per currency, as sent: there is no
 * FX conversion, so totals in different currencies are never added together.
 * Refunds are subtracted from the currency they were sent in. A transaction is
 * counted once per event name and `transaction_id` (events without one count
 * individually). People and stitching follow the other reports. Broken down
 * by channel, each source also gets the ad spend entered for it (Acquisition →
 * Ad spend, modules/attribution/spend.ts) in the same currency, with return
 * and ROAS.
 */

export const REVENUE_BREAKDOWNS = ["platform", "event", "channel"] as const;

export { CHANNEL_NO_INSTALL, CHANNEL_ORGANIC, CHANNEL_UNKNOWN } from "./sql";
export { loadRevenueRules, NO_CURRENCY, revenueCtes } from "./revenue-sql";

export const revenueSchema = z.object({
  ...rangeFields,
  interval: intervalField,
  breakdown: z.union([z.enum(REVENUE_BREAKDOWNS), z.string().regex(/^property:[A-Za-z0-9_.$-]{1,64}$/)]).optional().catch(undefined),
  cohortId: z.uuid().optional().catch(undefined),
});

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

export interface BreakdownRow {
  key: string;
  currency: string;
  gross: number;
  refunds: number;
  net: number;
  payingUsers: number;
  /**
   * Channel breakdown only: ad spend entered for this source in this currency
   * over the range (null when none), gross revenue minus spend, and gross
   * revenue divided by spend (ROAS).
   */
  spend?: number | null;
  return?: number | null;
  roas?: number | null;
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
  breakdown: BreakdownRow[] | null;
  breakdownBy: string | null;
  /** Property names sent on the counted revenue events in the range, most used first (for the breakdown picker). */
  properties: string[];
  /** Channel breakdown: whether spend was matched (it isn't with an audience filter, which spend can't follow). */
  spendIncluded?: boolean;
  rules: RevenueRule[];
  /** Monthly recurring revenue from subscription events, per currency (./mrr.ts). */
  mrr: MrrCurrency[];
}

function groupExpr(breakdown: string | undefined, p: Params): string {
  if (!breakdown) return "'All'";
  if (breakdown === "platform") return "coalesce(platform, '(none)')";
  if (breakdown === "event") return "name";
  if (breakdown === "channel") return channelSql("tx");
  return `coalesce(properties->>${p.add(breakdown.slice("property:".length))}, '(none)')`;
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
    // Its own parameters: the main query's include ones this query doesn't use.
    const ps = await eventsSource(db, scope, cohortId, [scope.environmentId, range.start], range.end);
    const props = await db.query<{ key: string }>(
      `with ${ps.sql}, ${revenueCtes(ps.p, rules)}
       select k as key from tx cross join lateral jsonb_object_keys(case when jsonb_typeof(properties) = 'object' then properties else '{}'::jsonb end) k
        where k not in ('revenue', 'currency', 'transaction_id')
        group by k order by count(*) desc, k limit 100`,
      ps.p.values,
    );
    const dayKeys = bucketKeys(range, interval);
    const mrr = await mrrByCurrency(db, scope, cohortId, range, interval, dayKeys);
    const previous = previousRangeOf ? await netByCurrency(db, scope, cohortId, rules, previousRangeOf) : null;
    const totals = new Map<string, CurrencyRevenue>();
    const ensure = (c: string) => {
      if (!totals.has(c)) totals.set(c, { currency: c, gross: 0, refunds: 0, net: 0, transactions: 0, refundCount: 0, payingUsers: 0, arpu: 0, arppu: 0 });
      return totals.get(c)!;
    };
    const daily = new Map<string, number[]>();
    const groups = new Map<string, BreakdownRow>();
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
    const rank = (c: string) => (order.includes(c) ? order.indexOf(c) : order.length);
    // Channel breakdown: put manually entered spend next to each source's revenue,
    // in the same currency only; sources with spend but no revenue get a row too.
    const spendIncluded = breakdown === "channel" && !cohortId;
    if (spendIncluded) {
      for (const s of await spendBySource(db, scope.environmentId, range.from, range.to)) {
        const key = `${s.currency}\u0000${s.source}`;
        if (!groups.has(key)) groups.set(key, { key: s.source, currency: s.currency, gross: 0, refunds: 0, net: 0, payingUsers: 0 });
        groups.get(key)!.spend = s.amount;
      }
    }
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
            .map((x) => ({
              ...x,
              gross: round(x.gross),
              refunds: round(x.refunds),
              net: round(x.gross - x.refunds),
              ...(spendIncluded ? withSpend(round(x.gross), x.spend ?? null) : {}),
            }))
            .sort((a, b) => rank(a.currency) - rank(b.currency) || a.currency.localeCompare(b.currency) || b.net - a.net || (b.spend ?? 0) - (a.spend ?? 0) || a.key.localeCompare(b.key))
        : null,
      breakdownBy: breakdown ?? null,
      properties: props.map((x) => x.key),
      ...(breakdown === "channel" ? { spendIncluded } : {}),
      rules,
      mrr,
    };
  });
}

/** Spend, return (gross − spend) and ROAS (gross ÷ spend) of a channel row; each is null without spend. */
function withSpend(gross: number, spend: number | null) {
  return { spend: spend === null ? null : round(spend), return: grossReturn(gross, spend), roas: roas(gross, spend) };
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
