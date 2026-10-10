import Link from "next/link";
import { AcquisitionHeader, AcquisitionRange, num, pct } from "@/components/acquisition/AcquisitionHeader";
import { CoverageWarnings, DashboardTable, DashboardTotals, ProvenanceLegend } from "@/components/acquisition/AcquisitionDashboard";
import { rangeFromParams, toSearch } from "@/modules/analytics/report-params";
import { TrendChart } from "@/components/TrendChart";
import { envName, rich } from "@/components/acquisition/rich";
import { getT } from "@/i18n/server";
import { ChannelCoverage } from "@/components/acquisition/ChannelPerformance";
import { acquisitionDashboard } from "@/modules/channels/provenance-data";
import { can } from "@/modules/rbac/authorize";
import { attributionOverview } from "@/modules/attribution/reports";
import { loadApp, pickEnvironment, requirePermission } from "@/server/session";

export async function generateMetadata() {
  const t = await getT();
  return { title: t("Acquisition") };
}

export default async function AcquisitionOverviewPage(props: PageProps<"/o/[org]/apps/[app]/acquisition">) {
  const { org, app } = await props.params;
  const sp = await props.searchParams;
  const { ctx, app: a, environments } = await loadApp(org, app);
  requirePermission(ctx, "attribution.read");
  const env = await pickEnvironment(environments, sp.env);
  const rangeInput = rangeFromParams(toSearch(sp));
  const model = sp.model === "first_touch" || sp.model === "last_touch" || sp.model === "last_non_direct" ? sp.model : undefined;
  const spendAccess = can(ctx.role, "analytics.read");
  const [r, { report: ch, dashboard }] = await Promise.all([
    attributionOverview(ctx, { environmentId: env.id, timezone: a.timezone }, rangeInput),
    acquisitionDashboard(
      ctx,
      { appId: a.id, environmentId: env.id, timezone: a.timezone, includeSpend: spendAccess, includeIntegrations: can(ctx.role, "integrations.read") },
      { ...rangeInput, model },
    ),
  ]);
  const base = `/o/${org}/apps/${app}/acquisition`;
  const appBase = `/o/${org}/apps/${app}`;
  const rangeQuery = new URLSearchParams({ env: env.type, ...(r.range.preset ? { days: String(r.range.preset) } : { days: "custom", from: r.range.from, to: r.range.to }), ...(model ? { model } : {}) });
  const tr = await getT();
  const t = r.totals;
  const linkInstalls = r.links.reduce((s, l) => s + l.installs, 0);
  const anyData = t.installs + t.reinstalls + t.clicks + ch.coverage.conversions > 0 || ch.totals.spend.length > 0;
  const hrefs = {
    attribution: `${base}/attribution?env=${env.type}`,
    ...(spendAccess ? { spend: `${base}/spend?env=${env.type}` } : {}),
    ...(can(ctx.role, "integrations.read") ? { integrations: `${appBase}/settings/integrations?env=${env.type}` } : {}),
    ...(can(ctx.role, "implementation.read") ? { growth: `${appBase}/growth/setup?env=${env.type}` } : {}),
  };

  return (
    <div className="space-y-6">
      <AcquisitionHeader base={base} current="" env={env.type} title={tr("Acquisition")}
        description={tr("Users, installs, sign-ups, activation, purchases, revenue, spend, CAC and ROAS by source and campaign, for the selected environment. Every number says whether LeanApp observed it, imported it, modeled it, or has no data for it.")} />
      <AcquisitionRange env={env.type} range={r.range}>
        <label><span className="label">{tr("Credit")}</span>
          <select name="model" className="input" defaultValue={ch.model}>
            <option value="last_touch">{tr("Last touch")}</option>
            <option value="first_touch">{tr("First touch")}</option>
            <option value="last_non_direct">{tr("Last non-direct touch")}</option>
          </select>
        </label>
      </AcquisitionRange>

      <DashboardTotals dashboard={dashboard} />
      <ProvenanceLegend />
      <CoverageWarnings dashboard={dashboard} hrefs={hrefs} />

      {!anyData ? (
        <div className="card space-y-2">
          <p>{tr("No acquisition data in {env} for the selected range of dates.", { env: envName(tr, env.type) })}</p>
          <p className="max-w-2xl text-sm text-ink-3">
            {rich(tr("Create a {link} for your campaigns, then make sure your app sends {event} with the install referrer or click id when it is first opened (see Settings → Dev Ops → SDK)."), {
              link: <Link className="underline" href={`${base}/links?env=${env.type}`}>{tr("tracking link")}</Link>,
              event: <code className="font-mono">app_installed</code>,
            })}
          </p>
        </div>
      ) : (
        <>
          <section className="card p-0" aria-label={tr("By source")}>
            <div className="flex flex-wrap items-baseline justify-between gap-2 px-5 pt-5">
              <h2 className="h2">{tr("By source")}</h2>
              <Link className="text-sm underline" href={`${base}/sources?${rangeQuery}`}>{tr("All channels with cost and retention")}</Link>
            </div>
            <p className="px-5 text-sm text-ink-3">{tr("Each column says what its numbers rest on; a cell is tagged where it differs. Amounts stay in their own currency.")}</p>
            <DashboardTable rows={dashboard.channels} kind="channel" empty={tr("No clicks, installs or conversions in this range.")} />
          </section>

          <section className="card p-0" aria-label={tr("By campaign")}>
            <div className="flex flex-wrap items-baseline justify-between gap-2 px-5 pt-5">
              <h2 className="h2">{tr("By campaign")}</h2>
              <Link className="text-sm underline" href={`${base}/sources?${rangeQuery}`}>{tr("All sources & campaigns")}</Link>
            </div>
            <p className="px-5 text-sm text-ink-3">
              {tr("Campaigns as named on your tracking links and UTM parameters; spend is matched to them by name. Spend entered for a whole source stays on its own row.")}
              {dashboard.campaignsOmitted > 0 && <> {tr("Showing the top {n}; {more} more are left out.", { n: num(dashboard.campaigns.length), more: num(dashboard.campaignsOmitted) })}</>}
            </p>
            <DashboardTable rows={dashboard.campaigns} kind="campaign" empty={tr("No campaign in this range.")} />
          </section>

          <section className="card space-y-3">
            <h2 className="h2">{tr("Installs per day")}</h2>
            <TrendChart days={r.trend.days} series={r.trend.series.map((s) => ({ ...s, key: tr(s.key) }))} label={tr("Attributed and unmatched installs per day")} />
          </section>
          <section className="card space-y-3">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h2 className="h2">{tr("Links: click → install")}</h2>
              <Link className="text-sm underline" href={`${base}/links?env=${env.type}`}>{tr("Tracking links & QR")}</Link>
            </div>
            <p className="text-sm text-ink-3">{tr("Overall {pct} of clicks led to an install.", { pct: pct(linkInstalls, t.clicks) })}</p>
            <div className="overflow-x-auto">
              <table className="table text-sm">
                <thead><tr><th>{tr("Link")}</th><th className="text-end">{tr("Clicks")}</th><th className="text-end">{tr("Installs")}</th></tr></thead>
                <tbody>{r.links.slice(0, 5).map((l) => <tr key={l.id}><td>{l.name}</td><td className="text-end tabular-nums">{num(l.clicks)}</td><td className="text-end tabular-nums">{num(l.installs)}</td></tr>)}</tbody>
              </table>
            </div>
          </section>
          <ChannelCoverage report={ch} timezone={a.timezone} />
        </>
      )}
    </div>
  );
}
