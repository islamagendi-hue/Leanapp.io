import "server-only";
import { attributionRange, type AttributionRangeInput } from "@/modules/attribution/reports";
import { tenantTx, type TenantContext } from "@/modules/tenancy/context";

export interface DeepLinkReport {
  range: { preset: number | null; from: string; to: string; label: string };
  /** Deferred lookups answered in the range, by match. */
  deferred: { deterministic: number; probabilistic: number; none: number };
  /** Links with a deep link, busiest first. */
  links: { id: string; code: string; name: string; deep_link_path: string; status: string; clicks: number; installs: number; reengagements: number; deferred: number }[];
}

const n = (v: unknown) => Number(v ?? 0);

/** What links with a deep link led to over a range in one environment. */
export async function deepLinkReport(ctx: TenantContext, scope: { environmentId: string; timezone: string }, input: AttributionRangeInput): Promise<DeepLinkReport> {
  const environmentId = scope.environmentId;
  const range = attributionRange(input, scope.timezone);
  return tenantTx(ctx, "attribution.read", async (db) => {
    await db.query("set local statement_timeout = '15s'");
    const deferred = await db.one<{ deterministic: string; probabilistic: string; none: string }>(
      `select count(*) filter (where match_type = 'deterministic') as deterministic,
              count(*) filter (where match_type = 'probabilistic') as probabilistic,
              count(*) filter (where match_type = 'none') as none
         from platform.deep_link_deferred_matches where environment_id = $1 and created_at >= $2 and created_at < $3`,
      [environmentId, range.start, range.end],
    );
    const links = await db.query<{ id: string; code: string; name: string; deep_link_path: string; status: string; clicks: string; installs: string; reengagements: string; deferred: string }>(
      `select l.id, l.code, l.name, l.deep_link_path, l.status,
              (select count(*) from platform.attribution_touchpoints t where t.link_id = l.id and t.kind = 'click' and t.touchpoint_at >= $2 and t.touchpoint_at < $3) as clicks,
              (select count(*) from platform.attribution_events ae where ae.link_id = l.id and ae.kind in ('install', 'reinstall') and ae.occurred_at >= $2 and ae.occurred_at < $3) as installs,
              (select count(*) from platform.attribution_events ae where ae.link_id = l.id and ae.kind = 're_engagement' and ae.occurred_at >= $2 and ae.occurred_at < $3) as reengagements,
              (select count(*) from platform.deep_link_deferred_matches m where m.link_id = l.id and m.created_at >= $2 and m.created_at < $3) as deferred
         from platform.attribution_links l
        where l.environment_id = $1 and l.deep_link_path is not null
        order by clicks desc, l.created_at desc limit 50`,
      [environmentId, range.start, range.end],
    );
    return {
      range: { preset: range.preset, from: range.from, to: range.to, label: range.label },
      deferred: { deterministic: n(deferred?.deterministic), probabilistic: n(deferred?.probabilistic), none: n(deferred?.none) },
      links: links.map((l) => ({ ...l, clicks: n(l.clicks), installs: n(l.installs), reengagements: n(l.reengagements), deferred: n(l.deferred) })),
    };
  });
}
