import "server-only";
import { loadRevenueRules, revenueCtes } from "@/modules/analytics/revenue";
import { analyticsTx, eventsSource } from "@/modules/analytics/service";
import { CHANNEL_NO_INSTALL, FIRST_INSTALL_SQL } from "@/modules/analytics/sql";
import { assertCan } from "@/modules/rbac/authorize";
import type { TenantContext } from "@/modules/tenancy/context";
import { channelEconomics, curveDays, ltvWindow, type ChannelEconomics, type LtvWindow } from "./economics-pure";
import { attributionRange, type AttributionRangeInput } from "./reports";
import { spendBySource } from "./spend";

/**
 * CAC and LTV by acquisition channel (Acquisition → CAC & LTV) for one
 * environment over a range. The arithmetic and currency rules are in
 * ./economics-pure.ts.
 *
 * - People are stitched as in Analytics (user_id, else the one user the
 *   install is linked to, else the anonymous id). A person's channel is their
 *   first install's source, labelled as in Acquisition (a source, `organic`,
 *   `(unknown)`, or `(no install on record)`).
 * - New users (for CAC): people whose first install or reinstall on record
 *   falls in the range. A second device of the same person isn't a new user.
 * - First-time buyers (for LTV): people whose first revenue transaction ever
 *   that isn't a refund (the Revenue report's rules) falls in the range.
 *   Their revenue counts from that first purchase for `window` days, net of
 *   refunds, per currency. Observed revenue to date, not a forecast.
 * - Spend is the ad spend entered for the source over the range's days.
 *
 * Needs analytics.read (revenue and spend) and attribution.read.
 */

/** How many of the cohort's people the per-person table lists. */
export const TOP_BUYERS = 50;

export interface CohortPerson {
  /** user_id, or `anon:` + anonymous id. */
  person: string;
  channel: string;
  currency: string;
  firstPurchaseAt: string;
  /** Net revenue in this currency inside the person's window. */
  revenue: number;
  /** Revenue transactions (not refunds) in this currency inside the window. */
  purchases: number;
  /** The whole window has passed. */
  complete: boolean;
}

export interface ChannelEconomicsReport {
  range: { preset: number | null; from: string; to: string; label: string };
  window: LtvWindow;
  channels: ChannelEconomics[];
  totals: { newUsers: number; buyers: number; buyersComplete: number };
  /** The cohort's people with the most revenue in their window (a person with two currencies has two rows). */
  people: CohortPerson[];
}

export async function channelEconomicsReport(
  ctx: TenantContext,
  scope: { environmentId: string; timezone: string },
  input: AttributionRangeInput & { window?: unknown },
): Promise<ChannelEconomicsReport> {
  assertCan(ctx.role, "attribution.read");
  const range = attributionRange(input, scope.timezone);
  const window = ltvWindow(input.window);
  return analyticsTx(ctx, async (db) => {
    const rules = await loadRevenueRules(db, scope.environmentId);
    // A first purchase is the first ever, so the events start at the beginning; they end with the last window.
    const until = new Date(range.end.getTime() + window * 86_400_000);
    const src = await eventsSource(db, scope, undefined, [scope.environmentId, new Date(0)], until);
    const p = src.p;
    const ctes = revenueCtes(p, rules);
    const start = p.add(range.start);
    const end = p.add(range.end);
    const n = p.add(window);
    const points = p.add(curveDays(window));
    const rows = await db.query<{
      kind: string; channel: string; currency: string | null; day: number | null; person: string | null; first_at: Date | null; n: string; n2: string; amount: number | null; complete: boolean | null;
    }>(
      `with ${src.sql}, ${ctes},
       first_install as (${FIRST_INSTALL_SQL}),
       first_buy as (select person, min(ts) as first_at from tx where kind <> 'refund' group by person),
       buyers as (
         select b.person, b.first_at, coalesce(fi.channel, '${CHANNEL_NO_INSTALL}') as channel,
                b.first_at + make_interval(days => ${n}::int) <= now() as complete
           from first_buy b left join first_install fi on fi.person = b.person
          where b.first_at >= ${start} and b.first_at < ${end}
       ),
       win as (
         select b.channel, b.person, b.first_at, b.complete, tx.currency, tx.kind, tx.ts - b.first_at as age,
                case when tx.kind = 'refund' then -tx.amount else tx.amount end as net
           from buyers b join tx on tx.person = b.person and tx.ts >= b.first_at and tx.ts < b.first_at + make_interval(days => ${n}::int)
       ),
       pts as (select unnest(${points}::int[]) as d)
       select 'acquired' as kind, channel, null::text as currency, null::int as day, null::text as person, null::timestamptz as first_at,
              count(*) as n, 0::bigint as n2, null::float8 as amount, null::boolean as complete
         from first_install where occurred_at >= ${start} and occurred_at < ${end} group by channel
       union all
       select 'buyers', channel, null, null, null, null, count(*), count(*) filter (where complete), null, null from buyers group by channel
       union all
       select 'revenue', channel, currency, null, null, null, 0, 0, sum(net)::float8, null from win group by channel, currency
       union all
       select 'curve_people', b.channel, null, pts.d, null, null, count(*), 0, null, null
         from buyers b join pts on b.first_at + make_interval(days => greatest(pts.d, 1)) <= now() group by b.channel, pts.d
       union all
       select 'curve_revenue', w.channel, w.currency, pts.d, null, null, 0, 0, sum(w.net)::float8, null
         from win w join pts on w.first_at + make_interval(days => greatest(pts.d, 1)) <= now() and w.age < make_interval(days => greatest(pts.d, 1))
        group by w.channel, w.currency, pts.d
       union all
       (select 'person', channel, currency, null, person, first_at, count(*) filter (where kind <> 'refund'), 0, sum(net)::float8, complete
          from win group by channel, currency, person, first_at, complete
         order by sum(net) desc, person, currency limit ${TOP_BUYERS})`,
      p.values,
    );
    const spend = await spendBySource(db, scope.environmentId, range.from, range.to);
    const num = (v: unknown) => Number(v ?? 0);
    const of = (k: string) => rows.filter((r) => r.kind === k);
    const channels = channelEconomics({
      window,
      acquired: of("acquired").map((r) => ({ channel: r.channel, people: num(r.n) })),
      spend,
      buyers: of("buyers").map((r) => ({ channel: r.channel, buyers: num(r.n), complete: num(r.n2) })),
      revenue: of("revenue").map((r) => ({ channel: r.channel, currency: r.currency!, net: num(r.amount) })),
      curvePeople: of("curve_people").map((r) => ({ channel: r.channel, day: num(r.day), people: num(r.n) })),
      curveRevenue: of("curve_revenue").map((r) => ({ channel: r.channel, currency: r.currency!, day: num(r.day), net: num(r.amount) })),
    });
    const people = of("person")
      .map((r) => ({
        person: r.person!, channel: r.channel, currency: r.currency!, firstPurchaseAt: new Date(r.first_at!).toISOString(),
        revenue: Math.round(num(r.amount) * 100) / 100, purchases: num(r.n), complete: Boolean(r.complete),
      }))
      .sort((a, b) => b.revenue - a.revenue || a.person.localeCompare(b.person) || a.currency.localeCompare(b.currency));
    const sum = (f: (c: ChannelEconomics) => number) => channels.reduce((s, c) => s + f(c), 0);
    return {
      range: { preset: range.preset, from: range.from, to: range.to, label: range.label },
      window,
      channels,
      totals: { newUsers: sum((c) => c.newUsers), buyers: sum((c) => c.buyers), buyersComplete: sum((c) => c.buyersComplete) },
      people,
    };
  });
}
