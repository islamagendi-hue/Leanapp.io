import "server-only";
import type { Db } from "@/lib/db";
import { featureOn } from "@/modules/apps/features";
import { attributionRange, type AttributionRangeInput } from "@/modules/attribution/reports";
import { tenantTx, type TenantContext } from "@/modules/tenancy/context";
import { buildChannelReport, type AttributionRow, type ChannelReport, type ClickRow, type CohortRow, type ConversionRow, type CreditModel } from "./report-pure";
import type { SpendEntry } from "./reconcile";
import { loadClassifyContext } from "./service";

/**
 * Channel performance for one environment over a range (Acquisition →
 * Overview and Sources & campaigns). Reads only what LeanApp stores:
 *
 *   clicks          tracking-link clicks (attribution_touchpoints, kind click), bots excluded at the edge
 *   installs        attribution_events install / reinstall, with how each was matched (evidence)
 *   web touches     attribution_events web_touch: web visits with campaign evidence
 *   new users       people whose first install on record is in the range (stitched as in Analytics)
 *   activation and  growth_state (only when the app's growth model is on; otherwise "not measured")
 *   retention       D1 / D7 / D30 of the new users, counting only people who have had that long
 *   signups,        attribution_conversions in the range credited by the chosen model (last touch,
 *                   first touch or last non-direct touch); signups are
 *   purchases,      sign-up / registration events, purchases are conversions with positive revenue
 *   revenue         (per currency, refunds negative)
 *   spend, CPI, CPA ad_spend_daily, reconciled (reconcile.ts) and matched to channels by source
 *   coverage        attributed vs unattributed installs, conversions with an install on record,
 *                   provider-reported postbacks (SKAN, never added), freshness of every input
 *
 * Sessions by channel are not reported: no LeanApp SDK sends a session event that carries the touch.
 * Needs attribution.read; spend needs analytics.read as well (left out without it).
 */

const SIGNUP = "^(sign_?up|signup_completed|sign_up_completed|registration|registration_completed|account_created|user_registered)$";

/** People stitched as in Analytics: user_id, else the one user the install is linked to, else the anonymous id. */
const STITCHED = `select ae.*, coalesce(ae.user_id, l.user_id, 'anon:' || ae.anonymous_id) as person
                    from platform.attribution_events ae
                    left join lateral (
                      select min(il.user_id) as user_id from platform.identity_links il
                       where il.environment_id = ae.environment_id and il.anonymous_id = ae.anonymous_id
                      having count(*) = 1
                    ) l on ae.user_id is null and ae.anonymous_id is not null
                   where ae.environment_id = $1 and ae.kind in ('install', 'reinstall') and coalesce(ae.user_id, ae.anonymous_id) is not null`;

const num = (v: unknown) => Number(v ?? 0);

export async function channelReport(
  ctx: TenantContext,
  scope: { appId: string; environmentId: string; timezone: string; includeSpend: boolean },
  input: AttributionRangeInput & { model?: unknown },
): Promise<ChannelReport & { range: { preset: number | null; from: string; to: string; label: string } }> {
  const range = attributionRange(input, scope.timezone);
  return tenantTx(ctx, "attribution.read", async (db: Db) => {
    await db.query("set local statement_timeout = '20s'");
    const settings = await db.one<{ reporting_model: CreditModel }>("select reporting_model from platform.attribution_settings where app_id = $1", [scope.appId]);
    const model: CreditModel = input.model === "first_touch" || input.model === "last_touch" || input.model === "last_non_direct" ? input.model : settings?.reporting_model ?? "last_touch";
    const classify = await loadClassifyContext(db, scope.appId);
    const growthMeasured = await featureOn(db, scope.appId, "growth_model");
    const p = [scope.environmentId, range.start, range.end];

    const attributions = await db.query<AttributionRow>(
      `select kind, lower(source) as source, lower(medium) as medium, network, match_type, match_key, referrer_host,
              case when source is null then campaign end as campaign,
              count(*)::int as n, count(*) filter (where platform = 'ios')::int as ios
         from platform.attribution_events
        where environment_id = $1 and occurred_at >= $2 and occurred_at < $3
        group by 1, 2, 3, 4, 5, 6, 7, 8`,
      p,
    );
    const clicks = await db.query<ClickRow>(
      `select lower(source) as source, lower(medium) as medium, network, count(*)::int as n
         from platform.attribution_touchpoints
        where environment_id = $1 and kind = 'click' and touchpoint_at >= $2 and touchpoint_at < $3
        group by 1, 2, 3`,
      p,
    );
    const cohort = await db.query<CohortRow>(
      `with fi as (select distinct on (person) person, occurred_at, source, medium, network, match_type, match_key
                     from (${STITCHED}) i order by person, occurred_at, id)
       select lower(fi.source) as source, lower(fi.medium) as medium, fi.network, fi.match_type, fi.match_key,
              count(*)::int as people,
              count(g.activated_at)::int as activated,
              count(*) filter (where fi.occurred_at + interval '1 day' <= now())::int as d1_eligible,
              count(g.retained_d1_at)::int as d1,
              count(*) filter (where fi.occurred_at + interval '7 days' <= now())::int as d7_eligible,
              count(g.retained_d7_at)::int as d7,
              count(*) filter (where fi.occurred_at + interval '30 days' <= now())::int as d30_eligible,
              count(g.retained_d30_at)::int as d30
         from fi
         left join platform.growth_state g on g.environment_id = $1 and g.person = fi.person
        where fi.occurred_at >= $2 and fi.occurred_at < $3
        group by 1, 2, 3, 4, 5`,
      p,
    );
    const credit = model === "first_touch" ? "case when c.first_touch_recorded then c.first_attribution_event_id else c.attribution_event_id end"
      : model === "last_non_direct" ? "case when c.last_non_direct_recorded then c.last_non_direct_attribution_event_id else c.attribution_event_id end"
      : "c.attribution_event_id";
    const conversions = await db.query<ConversionRow>(
      `select lower(ae.source) as source, lower(ae.medium) as medium, ae.network, coalesce(ae.match_type, 'organic') as match_type, ae.match_key, ae.referrer_host,
              case when ae.source is null then ae.campaign end as campaign,
              ae.id is not null as credited,
              case when c.revenue > 0 then 'purchase' when c.event_name ~ '${SIGNUP}' then 'signup' else 'other' end as kind,
              c.currency, count(*)::int as n, coalesce(sum(c.revenue), 0)::float8 as revenue
         from platform.attribution_conversions c
         left join platform.attribution_events ae on ae.id = ${credit}
        where c.environment_id = $1 and c.occurred_at >= $2 and c.occurred_at < $3
        group by 1, 2, 3, 4, 5, 6, 7, 8, 9, 10`,
      p,
    );
    const fallback = await db.one<{ n: string; lnd: string }>(
      `select count(*) filter (where not first_touch_recorded) as n, count(*) filter (where not last_non_direct_recorded) as lnd
         from platform.attribution_conversions
        where environment_id = $1 and occurred_at >= $2 and occurred_at < $3 and attribution_event_id is not null`,
      p,
    );
    const skan = await db.one<{ n: string }>(
      "select count(*) as n from platform.skan_postbacks where environment_id = $1 and received_at >= $2 and received_at < $3",
      p,
    );
    const spend = scope.includeSpend
      ? await db.query<{ day: string; source: string; campaign: string; currency: string; amount: string }>(
          `select to_char(day, 'YYYY-MM-DD') as day, source, campaign, currency, amount
             from platform.ad_spend_daily where environment_id = $1 and day >= $2::date and day <= $3::date`,
          [scope.environmentId, range.from, range.to],
        )
      : [];
    const fresh = await db.one<{ click: Date | null; attribution: Date | null; processed: Date | null; conversion: Date | null; spend_day: string | null; spend_saved: Date | null }>(
      `select (select max(touchpoint_at) from platform.attribution_touchpoints where environment_id = $1 and kind = 'click') as click,
              (select max(occurred_at) from platform.attribution_events where environment_id = $1) as attribution,
              (select max(created_at) from platform.attribution_events where environment_id = $1) as processed,
              (select max(occurred_at) from platform.attribution_conversions where environment_id = $1) as conversion,
              ${scope.includeSpend ? "(select to_char(max(day), 'YYYY-MM-DD') from platform.ad_spend_daily where environment_id = $1)" : "null::text"} as spend_day,
              ${scope.includeSpend ? "(select max(updated_at) from platform.ad_spend_daily where environment_id = $1)" : "null::timestamptz"} as spend_saved`,
      [scope.environmentId],
    );
    const report = buildChannelReport({
      model,
      classify,
      attributions: attributions.map((r) => ({ ...r, n: num(r.n), ios: num(r.ios) })),
      clicks: clicks.map((r) => ({ ...r, n: num(r.n) })),
      cohort: cohort.map((r) => ({
        ...r, people: num(r.people), activated: num(r.activated), d1_eligible: num(r.d1_eligible), d1: num(r.d1), d7_eligible: num(r.d7_eligible),
        d7: num(r.d7), d30_eligible: num(r.d30_eligible), d30: num(r.d30),
      })),
      growthMeasured,
      conversions: conversions.map((r) => ({ ...r, n: num(r.n), revenue: num(r.revenue) })),
      spend: spend.map((s): SpendEntry => ({ day: s.day, source: s.source, campaign: s.campaign, currency: s.currency, amount: num(s.amount) })),
      firstTouchFallback: num(fallback?.n),
      lastNonDirectFallback: num(fallback?.lnd),
      providerReported: num(skan?.n),
      freshness: {
        lastClickAt: fresh?.click ?? null, lastAttributionAt: fresh?.attribution ?? null, lastProcessedAt: fresh?.processed ?? null,
        lastConversionAt: fresh?.conversion ?? null, lastSpendDay: fresh?.spend_day ?? null, lastSpendSavedAt: fresh?.spend_saved ?? null,
      },
    });
    return { ...report, range: { preset: range.preset, from: range.from, to: range.to, label: range.label } };
  });
}
