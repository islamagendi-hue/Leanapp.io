import Link from "next/link";
import { AcquisitionHeader, AcquisitionRange, money, num } from "@/components/acquisition/AcquisitionHeader";
import { rich } from "@/components/acquisition/rich";
import { rangeFromParams, toSearch } from "@/modules/analytics/report-params";
import { mergeCampaignRows } from "@/modules/attribution/pure";
import { attributionOverview } from "@/modules/attribution/reports";
import { getT } from "@/i18n/server";
import { loadApp, pickEnvironment, requirePermission } from "@/server/session";

export async function generateMetadata() {
  return { title: (await getT())("Sources & campaigns") };
}

export default async function SourcesPage(props: PageProps<"/o/[org]/apps/[app]/acquisition/sources">) {
  const { org, app } = await props.params;
  const sp = await props.searchParams;
  const { ctx, app: a, environments } = await loadApp(org, app);
  requirePermission(ctx, "attribution.read");
  const env = await pickEnvironment(environments, sp.env);
  const r = await attributionOverview(ctx, { environmentId: env.id, timezone: a.timezone }, rangeFromParams(toSearch(sp)));
  const base = `/o/${org}/apps/${app}/acquisition`;
  const campaigns = mergeCampaignRows(r.byCampaign);
  const t = await getT();

  return (
    <div className="space-y-6">
      <AcquisitionHeader base={base} current="/sources" env={env.type} title={t("Sources & campaigns")}
        description={t("Installs, re-engagements, conversions and revenue per source and campaign, as labelled on your tracking links or sent by ad networks in their click ids and UTM parameters.")} />
      <AcquisitionRange env={env.type} range={r.range} />

      <section className="card overflow-x-auto p-0">
        <h2 className="h2 px-5 pt-5">{t("Installs by source and campaign")}</h2>
        <p className="px-5 text-sm text-ink-3">{t("Deterministic: matched to a click your tracking link recorded. Reported: only the install's own context (an ad-network click id or UTM parameters) names the source; nothing verifies it. Probabilistic: opt-in Android match on device signals. iOS installs without a LeanApp click id count as organic.")}</p>
        {r.bySource.length === 0 ? <p className="px-5 pb-5 pt-3 text-sm text-ink-3">{t("No installs in this range.")}</p> : (
          <table className="table mt-3">
            <thead><tr><th>{t("Source")}</th><th>{t("Campaign")}</th><th className="text-end">{t("Installs")}</th><th className="text-end">{t("Deterministic")}</th><th className="text-end">{t("Reported")}</th><th className="text-end">{t("Probabilistic")}</th><th className="text-end">{t("Re-engagements")}</th></tr></thead>
            <tbody>
              {r.bySource.map((s) => (
                <tr key={`${s.source}:${s.campaign}`}>
                  <td>{s.source === "organic" ? <span className="pill border-line">{t("organic")}</span> : s.source}</td>
                  <td className="text-ink-2">{s.campaign ?? "–"}</td>
                  <td className="text-end tabular-nums">{num(s.installs)}</td>
                  <td className="text-end tabular-nums">{num(s.deterministic)}</td>
                  <td className="text-end tabular-nums">{num(s.reported)}</td>
                  <td className="text-end tabular-nums">{num(s.probabilistic)}</td>
                  <td className="text-end tabular-nums">{num(s.reengagements)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="card overflow-x-auto p-0">
        <h2 className="h2 px-5 pt-5">{t("Conversions and revenue by campaign")}</h2>
        <p className="px-5 text-sm text-ink-3">{t("Last touch: each conversion counts for the latest install or re-engagement of that person before it, within the conversion window. Amounts are in the currency the event was sent in, never converted.")}</p>
        {r.byCampaign.length === 0 ? (
          <p className="px-5 pb-5 pt-3 text-sm text-ink-3">{t("No conversion events yet. Conversions are the events your tracking plan marks as conversion or revenue (for example purchase_completed).")}</p>
        ) : (
          <table className="table mt-3">
            <thead><tr><th>{t("Source")}</th><th>{t("Campaign")}</th><th className="text-end">{t("Conversions")}</th><th className="text-end">{t("Revenue")}</th></tr></thead>
            <tbody>
              {campaigns.map((c) => (
                <tr key={`${c.source}:${c.campaign}`}>
                  <td>{c.source === "organic" ? <span className="pill border-line">{t("organic")}</span> : c.source}</td>
                  <td className="text-ink-2">{c.campaign ?? "–"}</td>
                  <td className="text-end tabular-nums">{num(c.conversions)}</td>
                  <td className="text-end tabular-nums">{c.revenue.length ? c.revenue.map((x) => `${money(x.amount)} ${x.currency}`).join(" · ") : "–"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
      <p className="text-sm text-ink-3">
        {rich(t("No cost or CPI here: enter spend on the {spend} page to see return and ROAS in Revenue by channel."), {
          spend: <Link className="underline" href={`${base}/spend?env=${env.type}`}>{t("Ad spend")}</Link>,
        })}
      </p>
    </div>
  );
}
