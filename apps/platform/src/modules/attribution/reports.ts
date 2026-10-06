import "server-only";
import type { Db } from "@/lib/db";
import { dayList } from "@/modules/analytics/service";
import { tenantTx, type TenantContext } from "@/modules/tenancy/context";

/** Attribution dashboard for one environment over the last `days` days. */
export const ATTRIBUTION_RANGES = [7, 30, 90] as const;

export interface AttributionOverview {
  days: number;
  totals: { clicks: number; installs: number; reinstalls: number; attributed: number; probabilistic: number; organic: number; reengagements: number; conversions: number };
  revenue: { currency: string | null; revenue: number; conversions: number }[];
  trend: { days: string[]; series: { key: string; counts: number[] }[] };
  bySource: { source: string; campaign: string | null; installs: number; deterministic: number; probabilistic: number; reengagements: number }[];
  byCampaign: { source: string; campaign: string | null; currency: string | null; conversions: number; revenue: number }[];
  links: { id: string; code: string; name: string; source: string; campaign: string | null; status: string; clicks: number; installs: number; rate: number | null }[];
}

const n = (v: unknown) => Number(v ?? 0);

function query<T>(ctx: TenantContext, fn: (db: Db) => Promise<T>): Promise<T> {
  return tenantTx(ctx, "attribution.read", async (db) => {
    await db.query("set local statement_timeout = '15s'");
    return fn(db);
  });
}

export async function attributionOverview(ctx: TenantContext, scope: { environmentId: string; timezone: string }, daysInput: unknown): Promise<AttributionOverview> {
  const days = (ATTRIBUTION_RANGES as readonly number[]).includes(Number(daysInput)) ? Number(daysInput) : 30;
  return query(ctx, async (db) => {
    const env = scope.environmentId;
    const since = `now() - make_interval(days => $2)`;
    const totals = await db.one<Record<string, string>>(
      `select
         (select count(*) from platform.attribution_touchpoints where environment_id = $1 and kind = 'click' and touchpoint_at >= ${since}) as clicks,
         count(*) filter (where kind = 'install') as installs,
         count(*) filter (where kind = 'reinstall') as reinstalls,
         count(*) filter (where kind in ('install', 'reinstall') and match_type <> 'organic') as attributed,
         count(*) filter (where kind in ('install', 'reinstall') and match_type = 'probabilistic') as probabilistic,
         count(*) filter (where kind in ('install', 'reinstall') and match_type = 'organic') as organic,
         count(*) filter (where kind = 're_engagement') as reengagements,
         (select count(*) from platform.attribution_conversions where environment_id = $1 and occurred_at >= ${since}) as conversions
       from platform.attribution_events where environment_id = $1 and occurred_at >= ${since}`,
      [env, days],
    );
    const revenue = await db.query<{ currency: string | null; revenue: string; conversions: string }>(
      `select currency, coalesce(sum(revenue), 0) as revenue, count(*) as conversions
         from platform.attribution_conversions where environment_id = $1 and occurred_at >= ${since} and revenue is not null
        group by currency order by 2 desc`,
      [env, days],
    );
    const daily = await db.query<{ d: string; attributed: string; organic: string }>(
      `select to_char(occurred_at at time zone $3, 'YYYY-MM-DD') as d,
              count(*) filter (where match_type <> 'organic') as attributed, count(*) filter (where match_type = 'organic') as organic
         from platform.attribution_events
        where environment_id = $1 and kind in ('install', 'reinstall') and occurred_at >= ${since}
        group by 1`,
      [env, days, scope.timezone],
    );
    const dayKeys = dayList(days, scope.timezone);
    const at = new Map(daily.map((r) => [r.d, r]));
    const bySource = await db.query<{ source: string; campaign: string | null; installs: string; deterministic: string; probabilistic: string; reengagements: string }>(
      `select coalesce(source, case when match_type = 'organic' then 'organic' else '(unknown)' end) as source, campaign,
              count(*) filter (where kind in ('install', 'reinstall')) as installs,
              count(*) filter (where kind in ('install', 'reinstall') and match_type = 'deterministic') as deterministic,
              count(*) filter (where kind in ('install', 'reinstall') and match_type = 'probabilistic') as probabilistic,
              count(*) filter (where kind = 're_engagement') as reengagements
         from platform.attribution_events where environment_id = $1 and occurred_at >= ${since}
        group by 1, 2 order by 3 desc, 6 desc limit 100`,
      [env, days],
    );
    const byCampaign = await db.query<{ source: string; campaign: string | null; currency: string | null; conversions: string; revenue: string }>(
      `select case when ae.id is null then '(no install on record)' else coalesce(ae.source, case when ae.match_type = 'organic' then 'organic' else '(unknown)' end) end as source,
              ae.campaign, c.currency, count(*) as conversions, coalesce(sum(c.revenue), 0) as revenue
         from platform.attribution_conversions c
         left join platform.attribution_events ae on ae.id = c.attribution_event_id
        where c.environment_id = $1 and c.occurred_at >= ${since}
        group by 1, 2, 3 order by 5 desc, 4 desc limit 100`,
      [env, days],
    );
    const links = await db.query<{ id: string; code: string; name: string; source: string; campaign: string | null; status: string; clicks: string; installs: string }>(
      `select l.id, l.code, l.name, l.source, l.campaign, l.status,
              (select count(*) from platform.attribution_touchpoints t where t.link_id = l.id and t.kind = 'click' and t.touchpoint_at >= ${since}) as clicks,
              (select count(*) from platform.attribution_events ae where ae.link_id = l.id and ae.kind in ('install', 'reinstall') and ae.occurred_at >= ${since}) as installs
         from platform.attribution_links l where l.environment_id = $1
        order by 7 desc, l.created_at desc limit 50`,
      [env, days],
    );
    return {
      days,
      totals: {
        clicks: n(totals?.clicks), installs: n(totals?.installs), reinstalls: n(totals?.reinstalls), attributed: n(totals?.attributed),
        probabilistic: n(totals?.probabilistic), organic: n(totals?.organic), reengagements: n(totals?.reengagements), conversions: n(totals?.conversions),
      },
      revenue: revenue.map((r) => ({ currency: r.currency, revenue: n(r.revenue), conversions: n(r.conversions) })),
      trend: {
        days: dayKeys,
        series: [
          { key: "Attributed", counts: dayKeys.map((d) => n(at.get(d)?.attributed)) },
          { key: "Organic", counts: dayKeys.map((d) => n(at.get(d)?.organic)) },
        ],
      },
      bySource: bySource.map((r) => ({ ...r, installs: n(r.installs), deterministic: n(r.deterministic), probabilistic: n(r.probabilistic), reengagements: n(r.reengagements) })),
      byCampaign: byCampaign.map((r) => ({ ...r, conversions: n(r.conversions), revenue: n(r.revenue) })),
      links: links.map((l) => ({ ...l, clicks: n(l.clicks), installs: n(l.installs), rate: n(l.clicks) ? n(l.installs) / n(l.clicks) : null })),
    };
  });
}
