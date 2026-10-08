import { AcquisitionHeader, AcquisitionRange, money, num } from "@/components/acquisition/AcquisitionHeader";
import { param } from "@/components/AnalyticsHeader";
import { ATTRIBUTION_RANGES, attributionOverview } from "@/modules/attribution/reports";
import { loadApp, pickEnvironment, requirePermission } from "@/server/session";

export const metadata = { title: "Sources & campaigns" };

export default async function SourcesPage(props: PageProps<"/o/[org]/apps/[app]/acquisition/sources">) {
  const { org, app } = await props.params;
  const sp = await props.searchParams;
  const { ctx, app: a, environments } = await loadApp(org, app);
  requirePermission(ctx, "attribution.read");
  const env = await pickEnvironment(environments, sp.env);
  const r = await attributionOverview(ctx, { environmentId: env.id, timezone: a.timezone }, param(sp.days));
  const base = `/o/${org}/apps/${app}/acquisition`;

  return (
    <div className="space-y-6">
      <AcquisitionHeader base={base} current="/sources" env={env.type} title="Sources & campaigns"
        description="Installs, re-engagements, conversions and revenue per source and campaign, as labelled on your tracking links or sent by ad networks in their click ids and UTM parameters." />
      <AcquisitionRange env={env.type} days={r.days} ranges={ATTRIBUTION_RANGES} />

      <section className="card overflow-x-auto p-0">
        <h2 className="h2 px-5 pt-5">Installs by source and campaign</h2>
        {r.bySource.length === 0 ? <p className="px-5 pb-5 pt-3 text-sm text-ink-3">No installs in this range.</p> : (
          <table className="table mt-3">
            <thead><tr><th>Source</th><th>Campaign</th><th className="text-end">Installs</th><th className="text-end">Deterministic</th><th className="text-end">Probabilistic</th><th className="text-end">Re-engagements</th></tr></thead>
            <tbody>
              {r.bySource.map((s) => (
                <tr key={`${s.source}:${s.campaign}`}>
                  <td>{s.source === "organic" ? <span className="pill border-line">organic</span> : s.source}</td>
                  <td className="text-ink-2">{s.campaign ?? "–"}</td>
                  <td className="text-end tabular-nums">{num(s.installs)}</td>
                  <td className="text-end tabular-nums">{num(s.deterministic)}</td>
                  <td className="text-end tabular-nums">{num(s.probabilistic)}</td>
                  <td className="text-end tabular-nums">{num(s.reengagements)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="card overflow-x-auto p-0">
        <h2 className="h2 px-5 pt-5">Conversions and revenue by campaign</h2>
        <p className="px-5 text-sm text-ink-3">Last touch: each conversion counts for the latest install or re-engagement of that person before it, within the conversion window. Amounts are in the currency the event was sent in, never converted.</p>
        {r.byCampaign.length === 0 ? (
          <p className="px-5 pb-5 pt-3 text-sm text-ink-3">No conversion events yet. Conversions are the events your tracking plan marks as conversion or revenue (for example purchase_completed).</p>
        ) : (
          <table className="table mt-3">
            <thead><tr><th>Source</th><th>Campaign</th><th className="text-end">Conversions</th><th className="text-end">Revenue</th><th>Currency</th></tr></thead>
            <tbody>
              {r.byCampaign.map((c) => (
                <tr key={`${c.source}:${c.campaign}:${c.currency}`}>
                  <td>{c.source}</td>
                  <td className="text-ink-2">{c.campaign ?? "–"}</td>
                  <td className="text-end tabular-nums">{num(c.conversions)}</td>
                  <td className="text-end tabular-nums">{money(c.revenue)}</td>
                  <td className="font-mono text-xs">{c.currency ?? "–"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
      <p className="text-sm text-ink-3">Ad spend isn&apos;t imported, so there is no cost, CPI or ROAS here.</p>
    </div>
  );
}
