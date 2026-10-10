import "server-only";
import { peopleCtes, PENDING_DELETION } from "@/modules/audiences/definition";
import type { TenantContext } from "@/modules/tenancy/context";
import {
  atRiskDays, bucketSql, churnByChannel, churnInterval, churnPeriods, churnSeries, churnWindow,
  type ChannelChurn, type ChurnBucket, type ChurnInterval, type ChurnPoint, type ChurnWindow,
} from "./churn-pure";
import { addDays, localDate, startOfDay } from "./range";
import { analyticsTx } from "./service";
import { CHANNEL_NO_INSTALL, FIRST_INSTALL_SQL, Params, PERSON } from "./sql";

/**
 * Churn for one environment (Retention → Churn). The rules are in
 * ./churn-pure.ts. People are the audiences' people (identified users, and
 * installs not linked to exactly one user), so the buckets have the same
 * members as the audiences saved from them; people with a privacy deletion in
 * progress are left out, as audiences leave them out. A person's channel is
 * their first install's source, as in CAC & LTV.
 */

/** How many at-risk people the page lists. */
export const AT_RISK_LIST = 100;

export interface AtRiskPerson {
  person: string;
  channel: string;
  firstSeenAt: string;
  lastSeenAt: string;
  /** Whole days since last seen. */
  daysAway: number;
}

export interface ChurnReport {
  window: ChurnWindow;
  atRiskAfter: number;
  interval: ChurnInterval;
  totals: Record<ChurnBucket, number> & { people: number };
  series: ChurnPoint[];
  channels: ChannelChurn[];
  /** The at-risk people closest to churning first. */
  atRisk: AtRiskPerson[];
}

export async function churnReport(
  ctx: TenantContext,
  scope: { environmentId: string; timezone: string },
  input: { window?: unknown; interval?: unknown },
  now = new Date(),
): Promise<ChurnReport> {
  const window = churnWindow(input.window);
  const interval = churnInterval(input.interval);
  const half = atRiskDays(window);
  return analyticsTx(ctx, async (db) => {
    // Everyone with activity on record, in one bucket each, with their channel.
    const p = new Params([scope.environmentId, window, half]);
    const classified = `with ${peopleCtes()},
      first_install as (${FIRST_INSTALL_SQL}),
      cls as (
        select p.person, p.first_seen_at, p.last_seen_at, ${bucketSql("p.last_seen_at", "$2", "$3")} as bucket,
               coalesce(fi.channel, '${CHANNEL_NO_INSTALL}') as channel
          from people p left join first_install fi on fi.person = p.person
         where p.last_seen_at is not null and not ${PENDING_DELETION("p")})`;
    const byChannel = await db.query<{ channel: string; bucket: ChurnBucket; n: number }>(
      `${classified} select channel, bucket, count(*)::int as n from cls group by channel, bucket`,
      p.values,
    );
    const atRisk = await db.query<{ person: string; channel: string; first_seen_at: Date; last_seen_at: Date; days: number }>(
      `${classified}
       select person, channel, first_seen_at, last_seen_at, floor(extract(epoch from now() - last_seen_at) / 86400)::int as days
         from cls where bucket = 'at_risk' order by last_seen_at, person limit ${AT_RISK_LIST}`,
      p.values,
    );

    // Churn rate per period, from each person's days with activity (events of any kind, like Last seen).
    const periods = churnPeriods(localDate(now, scope.timezone), interval);
    const h = new Params([scope.environmentId, startOfDay(addDays(periods[0].start, -window), scope.timezone), scope.timezone, window]);
    const history = await db.query<{ start: string; base: number; churned: number }>(
      `with act as (
         select distinct ${PERSON.expr} as person, (e."timestamp" at time zone $3)::date as d
           from platform.events e ${PERSON.join}
          where e.environment_id = $1 and e."timestamp" >= $2 and e.processed_at is not null and e.processing_error is null
            and coalesce(e.user_id, e.anonymous_id) is not null),
       periods as (select * from unnest(${h.add(periods.map((x) => x.start))}::date[], ${h.add(periods.map((x) => x.end))}::date[]) as x(s, e)),
       base as (select distinct x.s, a.person from periods x join act a on a.d >= x.s - $4::int and a.d < x.s),
       still as (select distinct x.s, a.person from periods x join act a on a.d >= x.e - $4::int and a.d < x.e)
       select b.s::text as start, count(*)::int as base, (count(*) filter (where st.person is null))::int as churned
         from base b left join still st on st.s = b.s and st.person = b.person
        group by b.s`,
      h.values,
    );

    const totals = { churned: 0, at_risk: 0, active: 0, people: 0 };
    for (const r of byChannel) {
      totals[r.bucket] += r.n;
      totals.people += r.n;
    }
    return {
      window,
      atRiskAfter: half,
      interval,
      totals,
      series: churnSeries(periods, history),
      channels: churnByChannel(byChannel.map((r) => ({ channel: r.channel, bucket: r.bucket, people: r.n }))),
      atRisk: atRisk.map((r) => ({
        person: r.person, channel: r.channel, firstSeenAt: new Date(r.first_seen_at).toISOString(), lastSeenAt: new Date(r.last_seen_at).toISOString(), daysAway: r.days,
      })),
    };
  });
}
