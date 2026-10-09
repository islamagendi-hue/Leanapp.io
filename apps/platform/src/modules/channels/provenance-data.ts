import "server-only";
import type { Db } from "@/lib/db";
import { localDate } from "@/modules/analytics/range";
import { attributionRange, type AttributionRangeInput } from "@/modules/attribution/reports";
import { AD_PROVIDERS, PROVIDERS } from "@/modules/integrations/registry";
import { tenantTx, type TenantContext } from "@/modules/tenancy/context";
import { buildAcquisitionDashboard, type AcquisitionDashboard, type CampaignConversionRow, type CampaignCountRow, type SpendImportState, type SpendOriginRow } from "./provenance";
import { channelReport } from "./report";
import type { ChannelReport, CreditModel } from "./report-pure";
import { loadClassifyContext } from "./service";

/**
 * Data for the Acquisition dashboard (./provenance.ts): the channel report,
 * plus what it does not carry: the same numbers by campaign, where spend came
 * from (imported from an ad account or entered by hand), and the state of the
 * environment's ad cost imports for coverage warnings.
 *
 * Needs attribution.read. Spend needs analytics.read (as in the channel
 * report); integration status needs integrations.read. Without them those
 * parts are left out and the dashboard says so.
 */

const SIGNUP = "^(sign_?up|signup_completed|sign_up_completed|registration|registration_completed|account_created|user_registered)$";

/** The conversion's credited attribution under a model; unknown models fall back to last touch. */
export function creditColumn(model: CreditModel): string {
  return model === "first_touch" ? "case when c.first_touch_recorded then c.first_attribution_event_id else c.attribution_event_id end" : "c.attribution_event_id";
}

const num = (v: unknown) => Number(v ?? 0);

export async function acquisitionDashboard(
  ctx: TenantContext,
  scope: { appId: string; environmentId: string; timezone: string; includeSpend: boolean; includeIntegrations: boolean },
  input: AttributionRangeInput & { model?: unknown },
): Promise<{ report: ChannelReport & { range: { preset: number | null; from: string; to: string; label: string } }; dashboard: AcquisitionDashboard }> {
  const report = await channelReport(ctx, scope, input);
  const range = attributionRange(input, scope.timezone);
  const extra = await tenantTx(ctx, "attribution.read", async (db: Db) => {
    await db.query("set local statement_timeout = '20s'");
    const classify = await loadClassifyContext(db, scope.appId);
    const p = [scope.environmentId, range.start, range.end];
    // Installs and new users (first install on record in the range, people stitched as in the channel report) by touch and campaign.
    const counts = await db.query<CampaignCountRow>(
      `with i as (
         select ae.*, coalesce(ae.user_id, l.user_id, 'anon:' || ae.anonymous_id) as person
           from platform.attribution_events ae
           left join lateral (
             select min(il.user_id) as user_id from platform.identity_links il
              where il.environment_id = ae.environment_id and il.anonymous_id = ae.anonymous_id
             having count(*) = 1
           ) l on ae.user_id is null and ae.anonymous_id is not null
          where ae.environment_id = $1 and ae.kind in ('install', 'reinstall')),
       fi as (select distinct on (person) id from i where person is not null order by person, occurred_at, id)
       select lower(i.source) as source, lower(i.medium) as medium, i.network, i.match_type, i.match_key, i.campaign,
              count(*)::int as installs,
              count(*) filter (where i.match_type = 'probabilistic')::int as modeled,
              count(fi.id)::int as users,
              count(g.activated_at) filter (where fi.id is not null)::int as activated
         from i
         left join fi on fi.id = i.id
         left join platform.growth_state g on g.environment_id = $1 and g.person = i.person and fi.id is not null
        where i.occurred_at >= $2 and i.occurred_at < $3
        group by 1, 2, 3, 4, 5, 6`,
      p,
    );
    const conversions = await db.query<CampaignConversionRow>(
      `select lower(ae.source) as source, lower(ae.medium) as medium, ae.network, coalesce(ae.match_type, 'organic') as match_type, ae.match_key, ae.campaign,
              ae.id is not null as credited,
              case when c.revenue > 0 then 'purchase' when c.event_name ~ '${SIGNUP}' then 'signup' else 'other' end as kind,
              c.currency, count(*)::int as n, coalesce(sum(c.revenue), 0)::float8 as revenue
         from platform.attribution_conversions c
         left join platform.attribution_events ae on ae.id = ${creditColumn(report.model)}
        where c.environment_id = $1 and c.occurred_at >= $2 and c.occurred_at < $3
        group by 1, 2, 3, 4, 5, 6, 7, 8, 9`,
      p,
    );
    // Spend by origin; a whole-source row is left out on days that also have campaign rows (rule S1, as in the channel report).
    const spend = scope.includeSpend
      ? await db.query<SpendOriginRow>(
          `select lower(s.source) as source, s.campaign, s.currency, s.origin, sum(s.amount)::float8 as amount
             from platform.ad_spend_daily s
            where s.environment_id = $1 and s.day >= $2::date and s.day <= $3::date
              and not (s.campaign = '' and exists (
                select 1 from platform.ad_spend_daily o
                 where o.environment_id = s.environment_id and o.day = s.day and lower(o.source) = lower(s.source) and o.currency = s.currency and o.campaign <> ''))
            group by 1, 2, 3, 4`,
          [scope.environmentId, range.from, range.to],
        )
      : [];
    const imports = scope.includeIntegrations
      ? await db.query<{ provider: string; capability: string; enabled: boolean; status: string; config: Record<string, string>; fresh: string | null }>(
          `select c.provider, k.capability, k.enabled, k.status, k.config, k.data_fresh_through::text as fresh
             from platform.integration_connections c
             join platform.integration_capabilities k on k.connection_id = c.id
            where c.environment_id = $1 and c.status = 'active' and c.provider = any($2) and k.capability in ('ad_reporting', 'spend_import')`,
          [scope.environmentId, [...AD_PROVIDERS]],
        )
      : null;
    return { classify, counts, conversions, spend, imports };
  });

  let imports: SpendImportState[] | null = null;
  if (extra.imports) {
    const byProvider = new Map<string, SpendImportState & { reportingFresh: string | null; spendFresh: string | null }>();
    for (const r of extra.imports) {
      const s = byProvider.get(r.provider) ?? {
        provider: r.provider, providerName: PROVIDERS.find((x) => x.id === r.provider)?.name ?? r.provider, source: r.provider.replace(/_ads$/, ""),
        reportingEnabled: false, reportingStatus: "not_configured", spendEnabled: false, spendStatus: "not_configured", freshThrough: null,
        reportingFresh: null, spendFresh: null,
      };
      if (r.capability === "ad_reporting") {
        s.reportingEnabled = r.enabled;
        s.reportingStatus = r.status;
        s.reportingFresh = r.fresh;
      } else {
        s.spendEnabled = r.enabled;
        s.spendStatus = r.status;
        s.spendFresh = r.fresh;
        if (r.config?.spend_source) s.source = String(r.config.spend_source).toLowerCase();
      }
      byProvider.set(r.provider, s);
    }
    // Spend is written from the reporting import, so it is only as fresh as the older of the two.
    for (const s of byProvider.values()) {
      const days = [s.reportingFresh, s.spendFresh].filter((d): d is string => Boolean(d)).sort();
      s.freshThrough = days[0] ?? null;
    }
    imports = [...byProvider.values()].map(({ reportingFresh: _r, spendFresh: _s, ...rest }) => rest).sort((a, b) => a.provider.localeCompare(b.provider));
  }

  const dashboard = buildAcquisitionDashboard({
    report,
    classify: extra.classify,
    range: { from: report.range.from, to: report.range.to },
    today: localDate(new Date(), scope.timezone),
    spendAccess: scope.includeSpend,
    spend: extra.spend.map((s) => ({ ...s, amount: num(s.amount) })),
    campaignCounts: extra.counts.map((r) => ({ ...r, installs: num(r.installs), modeled: num(r.modeled), users: num(r.users), activated: num(r.activated) })),
    campaignConversions: extra.conversions.map((r) => ({ ...r, n: num(r.n), revenue: num(r.revenue) })),
    imports,
  });
  return { report, dashboard };
}
