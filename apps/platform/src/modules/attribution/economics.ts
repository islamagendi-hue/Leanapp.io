import "server-only";
import { loadRevenueRules, revenueCtes } from "@/modules/analytics/revenue";
import { analyticsTx, eventsSource } from "@/modules/analytics/service";
import { CHANNEL_ORGANIC, CHANNEL_UNKNOWN } from "@/modules/analytics/sql";
import { assertCan } from "@/modules/rbac/authorize";
import type { TenantContext } from "@/modules/tenancy/context";
import { channelEconomics, type ChannelEconomics } from "./economics-pure";
import { attributionRange, type AttributionRangeInput } from "./reports";
import { spendBySource } from "./spend";

/**
 * CAC and LTV by acquisition channel (Acquisition → CAC & LTV) for one
 * environment over a range. The arithmetic and currency rules are in
 * ./economics-pure.ts.
 *
 * - A new user is a person whose first install or reinstall on record in the
 *   environment falls in the range. The person is stitched as in Analytics
 *   (user_id, else the one user the install is linked to, else the anonymous
 *   id), so a second device of the same person isn't a new user.
 * - Their channel is that first install's source, labelled as in Acquisition
 *   (a source, `organic` or `(unknown)`).
 * - Revenue is the net revenue (gross − refunds) of those new users from the
 *   revenue events in the range, per currency (same rules as the Revenue
 *   report). It is observed revenue to date, not a forecast.
 * - Spend is the ad spend entered for the source over the range's days.
 *
 * Needs analytics.read (revenue and spend) and attribution.read.
 */

export interface ChannelEconomicsReport {
  range: { preset: number | null; from: string; to: string; label: string };
  channels: ChannelEconomics[];
  totals: { newUsers: number; payingUsers: number };
}

export async function channelEconomicsReport(ctx: TenantContext, scope: { environmentId: string; timezone: string }, input: AttributionRangeInput): Promise<ChannelEconomicsReport> {
  assertCan(ctx.role, "attribution.read");
  const range = attributionRange(input, scope.timezone);
  return analyticsTx(ctx, async (db) => {
    const rules = await loadRevenueRules(db, scope.environmentId);
    const src = await eventsSource(db, scope, undefined, [scope.environmentId, range.start], range.end);
    const p = src.p;
    const ctes = revenueCtes(p, rules);
    const end = p.add(range.end);
    const rows = await db.query<{ channel: string; currency: string | null; kind: string; people: string; amount: number | null }>(
      `with ${src.sql}, ${ctes},
       first_install as (
         select distinct on (person) person, occurred_at,
                coalesce(source, case when match_type = 'organic' then '${CHANNEL_ORGANIC}' else '${CHANNEL_UNKNOWN}' end) as channel
           from (select ae.*, coalesce(ae.user_id, l.user_id, 'anon:' || ae.anonymous_id) as person
                   from platform.attribution_events ae
                   left join lateral (
                     select min(il.user_id) as user_id from platform.identity_links il
                      where il.environment_id = ae.environment_id and il.anonymous_id = ae.anonymous_id
                     having count(*) = 1
                   ) l on ae.user_id is null and ae.anonymous_id is not null
                  where ae.environment_id = $1 and ae.kind in ('install', 'reinstall') and ae.occurred_at < ${end}
                    and coalesce(ae.user_id, ae.anonymous_id) is not null) i
          order by person, occurred_at, id
       ),
       acquired as (select person, channel from first_install where occurred_at >= $2),
       paid as (select a.channel, tx.person, tx.kind, tx.currency, tx.amount from tx join acquired a on a.person = tx.person)
       select channel, null as currency, 'acquired' as kind, count(*) as people, null::float8 as amount from acquired group by channel
       union all
       select channel, null, 'paying', count(distinct person), null from paid where kind <> 'refund' group by channel
       union all
       select channel, currency, 'net', 0, sum(case when kind = 'refund' then -amount else amount end)::float8 from paid group by channel, currency`,
      p.values,
    );
    const spend = await spendBySource(db, scope.environmentId, range.from, range.to);
    const acquired = new Map<string, { channel: string; people: number; paying: number }>();
    const entry = (c: string) => {
      if (!acquired.has(c)) acquired.set(c, { channel: c, people: 0, paying: 0 });
      return acquired.get(c)!;
    };
    const revenue: { channel: string; currency: string; net: number }[] = [];
    for (const r of rows) {
      if (r.kind === "acquired") entry(r.channel).people = Number(r.people);
      else if (r.kind === "paying") entry(r.channel).paying = Number(r.people);
      else revenue.push({ channel: r.channel, currency: r.currency!, net: Number(r.amount ?? 0) });
    }
    const channels = channelEconomics({ acquired: [...acquired.values()], revenue, spend });
    return {
      range: { preset: range.preset, from: range.from, to: range.to, label: range.label },
      channels,
      totals: { newUsers: channels.reduce((s, c) => s + c.newUsers, 0), payingUsers: channels.reduce((s, c) => s + c.payingUsers, 0) },
    };
  });
}
