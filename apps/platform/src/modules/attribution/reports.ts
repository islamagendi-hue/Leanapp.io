import "server-only";
import type { Db } from "@/lib/db";
import { datesBetween, rangeDays, resolveRange, type ReportRange } from "@/modules/analytics/range";
import { CHANNEL_NO_INSTALL, channelLabelSql } from "@/modules/analytics/sql";
import { tenantTx, type TenantContext } from "@/modules/tenancy/context";
import { msg } from "@/i18n/translate";

export { RANGES as ATTRIBUTION_RANGES } from "@/modules/analytics/range";

/** The range an Acquisition report covers: a preset (`days`) or custom calendar days (`from` to `to`), as in Analytics. */
export type AttributionRangeInput = { days?: unknown; from?: string; to?: string };

export function attributionRange(input: AttributionRangeInput, timezone: string): ReportRange {
  return resolveRange({ days: rangeDays(input.days), from: input.from, to: input.to }, timezone);
}

export interface AttributionOverview {
  range: { preset: number | null; from: string; to: string; label: string };
  /**
   * Installs + reinstalls by match type (docs/attribution.md): attributed = deterministic + reported +
   * probabilistic + provider_reported (Apple Search Ads installs Apple's AdServices API attributed). organic_ios is the iOS share of organic: it includes paid iOS installs, which
   * can't be attributed deterministically without SKAdNetwork / AdAttributionKit or Apple Search Ads.
   */
  totals: {
    clicks: number; installs: number; reinstalls: number; attributed: number; deterministic: number; reported: number; probabilistic: number;
    provider_reported: number;
    organic: number; organic_ios: number; reengagements: number; conversions: number;
    /** Split of `organic` (no match): the store's organic referrer, direct parameters, organic from an unknown source; the rest is unattributed. */
    organic_store: number; direct: number; organic_unknown: number; unattributed: number;
  };
  revenue: { currency: string | null; revenue: number; conversions: number }[];
  trend: { days: string[]; series: { key: string; counts: number[] }[] };
  bySource: { source: string; campaign: string | null; installs: number; deterministic: number; reported: number; probabilistic: number; reengagements: number }[];
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

/** Attribution dashboard for one environment over a range. */
export async function attributionOverview(ctx: TenantContext, scope: { environmentId: string; timezone: string }, input: AttributionRangeInput): Promise<AttributionOverview> {
  const range = attributionRange(input, scope.timezone);
  return query(ctx, async (db) => {
    const env = scope.environmentId;
    const totals = await db.one<Record<string, string>>(
      `select
         (select count(*) from platform.attribution_touchpoints where environment_id = $1 and kind = 'click' and touchpoint_at >= $2 and touchpoint_at < $3) as clicks,
         count(*) filter (where kind = 'install') as installs,
         count(*) filter (where kind = 'reinstall') as reinstalls,
         count(*) filter (where kind in ('install', 'reinstall') and match_type <> 'organic') as attributed,
         count(*) filter (where kind in ('install', 'reinstall') and match_type = 'deterministic') as deterministic,
         count(*) filter (where kind in ('install', 'reinstall') and match_type = 'reported') as reported,
         count(*) filter (where kind in ('install', 'reinstall') and match_type = 'probabilistic') as probabilistic,
         count(*) filter (where kind in ('install', 'reinstall') and match_type = 'provider_reported') as provider_reported,
         count(*) filter (where kind in ('install', 'reinstall') and match_type = 'organic') as organic,
         count(*) filter (where kind in ('install', 'reinstall') and match_type = 'organic' and platform = 'ios') as organic_ios,
         count(*) filter (where kind in ('install', 'reinstall') and match_type = 'organic' and match_key = 'store_organic') as organic_store,
         count(*) filter (where kind in ('install', 'reinstall') and match_type = 'organic' and match_key = 'direct') as direct,
         count(*) filter (where kind in ('install', 'reinstall') and match_type = 'organic' and match_key = 'organic_other') as organic_unknown,
         count(*) filter (where kind = 're_engagement') as reengagements,
         (select count(*) from platform.attribution_conversions where environment_id = $1 and occurred_at >= $2 and occurred_at < $3) as conversions
       from platform.attribution_events where environment_id = $1 and occurred_at >= $2 and occurred_at < $3`,
      [env, range.start, range.end],
    );
    const revenue = await db.query<{ currency: string | null; revenue: string; conversions: string }>(
      `select currency, coalesce(sum(revenue), 0) as revenue, count(*) as conversions
         from platform.attribution_conversions where environment_id = $1 and occurred_at >= $2 and occurred_at < $3 and revenue is not null
        group by currency order by 2 desc`,
      [env, range.start, range.end],
    );
    const daily = await db.query<{ d: string; attributed: string; organic: string }>(
      `select to_char(occurred_at at time zone $4, 'YYYY-MM-DD') as d,
              count(*) filter (where match_type <> 'organic') as attributed, count(*) filter (where match_type = 'organic') as organic
         from platform.attribution_events
        where environment_id = $1 and kind in ('install', 'reinstall') and occurred_at >= $2 and occurred_at < $3
        group by 1`,
      [env, range.start, range.end, scope.timezone],
    );
    const dayKeys = datesBetween(range.from, range.to);
    const at = new Map(daily.map((r) => [r.d, r]));
    const bySource = await db.query<{ source: string; campaign: string | null; installs: string; deterministic: string; reported: string; probabilistic: string; reengagements: string }>(
      `select ${channelLabelSql("")} as source, campaign,
              count(*) filter (where kind in ('install', 'reinstall')) as installs,
              count(*) filter (where kind in ('install', 'reinstall') and match_type = 'deterministic') as deterministic,
              count(*) filter (where kind in ('install', 'reinstall') and match_type = 'reported') as reported,
              count(*) filter (where kind in ('install', 'reinstall') and match_type = 'probabilistic') as probabilistic,
              count(*) filter (where kind = 're_engagement') as reengagements
         from platform.attribution_events where environment_id = $1 and occurred_at >= $2 and occurred_at < $3
          and kind in ('install', 'reinstall', 're_engagement')
        group by 1, 2 order by 3 desc, 7 desc limit 100`,
      [env, range.start, range.end],
    );
    const byCampaign = await db.query<{ source: string; campaign: string | null; currency: string | null; conversions: string; revenue: string }>(
      `select case when ae.id is null then '${CHANNEL_NO_INSTALL}' else ${channelLabelSql("ae.")} end as source,
              ae.campaign, c.currency, count(*) as conversions, coalesce(sum(c.revenue), 0) as revenue
         from platform.attribution_conversions c
         left join platform.attribution_events ae on ae.id = c.attribution_event_id
        where c.environment_id = $1 and c.occurred_at >= $2 and c.occurred_at < $3
        group by 1, 2, 3 order by 5 desc, 4 desc limit 100`,
      [env, range.start, range.end],
    );
    const links = await db.query<{ id: string; code: string; name: string; source: string; campaign: string | null; status: string; clicks: string; installs: string }>(
      `select l.id, l.code, l.name, l.source, l.campaign, l.status,
              (select count(*) from platform.attribution_touchpoints t where t.link_id = l.id and t.kind = 'click' and t.touchpoint_at >= $2 and t.touchpoint_at < $3) as clicks,
              (select count(*) from platform.attribution_events ae where ae.link_id = l.id and ae.kind in ('install', 'reinstall') and ae.occurred_at >= $2 and ae.occurred_at < $3) as installs
         from platform.attribution_links l where l.environment_id = $1
        order by 7 desc, l.created_at desc limit 50`,
      [env, range.start, range.end],
    );
    return {
      range: { preset: range.preset, from: range.from, to: range.to, label: range.label },
      totals: {
        clicks: n(totals?.clicks), installs: n(totals?.installs), reinstalls: n(totals?.reinstalls), attributed: n(totals?.attributed),
        deterministic: n(totals?.deterministic), reported: n(totals?.reported), probabilistic: n(totals?.probabilistic),
        provider_reported: n(totals?.provider_reported),
        organic: n(totals?.organic), organic_ios: n(totals?.organic_ios), reengagements: n(totals?.reengagements), conversions: n(totals?.conversions),
        organic_store: n(totals?.organic_store), direct: n(totals?.direct), organic_unknown: n(totals?.organic_unknown),
        unattributed: n(totals?.organic) - n(totals?.organic_store) - n(totals?.direct) - n(totals?.organic_unknown),
      },
      revenue: revenue.map((r) => ({ currency: r.currency, revenue: n(r.revenue), conversions: n(r.conversions) })),
      trend: {
        days: dayKeys,
        series: [
          { key: msg("Attributed"), counts: dayKeys.map((d) => n(at.get(d)?.attributed)) },
          { key: msg("No match"), counts: dayKeys.map((d) => n(at.get(d)?.organic)) },
        ],
      },
      bySource: bySource.map((r) => ({ ...r, installs: n(r.installs), deterministic: n(r.deterministic), reported: n(r.reported), probabilistic: n(r.probabilistic), reengagements: n(r.reengagements) })),
      byCampaign: byCampaign.map((r) => ({ ...r, conversions: n(r.conversions), revenue: n(r.revenue) })),
      links: links.map((l) => ({ ...l, clicks: n(l.clicks), installs: n(l.installs), rate: n(l.clicks) ? n(l.installs) / n(l.clicks) : null })),
    };
  });
}
