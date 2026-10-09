import Link from "next/link";
import { AcquisitionHeader, AcquisitionRange, money, num, pct } from "@/components/acquisition/AcquisitionHeader";
import { rangeFromParams, toSearch } from "@/modules/analytics/report-params";
import { TrendChart } from "@/components/TrendChart";
import { envName, rich } from "@/components/acquisition/rich";
import { getT } from "@/i18n/server";
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
  const r = await attributionOverview(ctx, { environmentId: env.id, timezone: a.timezone }, rangeFromParams(toSearch(sp)));
  const base = `/o/${org}/apps/${app}/acquisition`;
  const rangeQuery = new URLSearchParams({ env: env.type, ...(r.range.preset ? { days: String(r.range.preset) } : { days: "custom", from: r.range.from, to: r.range.to }) });
  const tr = await getT();
  const t = r.totals;
  const allInstalls = t.installs + t.reinstalls;
  const linkInstalls = r.links.reduce((s, l) => s + l.installs, 0);
  const sources = r.bySource.filter((s) => s.source !== "organic").slice(0, 5);

  return (
    <div className="space-y-6">
      <AcquisitionHeader base={base} current="" env={env.type} title={tr("Acquisition")}
        description={tr("Where installs come from and what they lead to, for the selected environment.")} />
      <AcquisitionRange env={env.type} range={r.range} />

      <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4" aria-label={tr("Acquisition numbers")}>
        {[
          [tr("Link clicks"), num(t.clicks), tr("Bots and prefetches excluded")],
          [tr("Installs"), num(allInstalls), t.reinstalls ? tr("{n} reinstalls", { n: num(t.reinstalls) }) : tr("First opens")],
          [tr("Attributed"), `${num(t.attributed)} · ${pct(t.attributed, allInstalls)}`, t.probabilistic ? tr("{n} probabilistic", { n: num(t.probabilistic) }) : tr("All deterministic")],
          [tr("Organic"), `${num(t.organic)} · ${pct(t.organic, allInstalls)}`, tr("{n} re-engagements", { n: num(t.reengagements) })],
        ].map(([label, value, note]) => (
          <div key={label} className="card">
            <p className="font-mono text-[11px] uppercase tracking-wide text-ink-3">{label}</p>
            <p className="mt-1 text-2xl font-bold tabular-nums">{value}</p>
            <p className="text-xs text-ink-3">{note}</p>
          </div>
        ))}
      </section>

      {allInstalls === 0 && t.clicks === 0 ? (
        <div className="card space-y-2">
          <p>{tr("No acquisition data in {env} for this range.", { env: envName(tr, env.type) })}</p>
          <p className="text-sm text-ink-3">
            {rich(tr("Create a {link} for your campaigns, and make sure your app sends {event} with the install referrer or click id (see Settings → Dev Ops → SDK)."), {
              link: <Link className="underline" href={`${base}/links?env=${env.type}`}>{tr("tracking link")}</Link>,
              event: <code className="font-mono">app_installed</code>,
            })}
          </p>
        </div>
      ) : (
        <>
          <section className="card space-y-3">
            <h2 className="h2">{tr("Installs per day")}</h2>
            <TrendChart days={r.trend.days} series={r.trend.series.map((s) => ({ ...s, key: tr(s.key) }))} label={tr("Attributed and organic installs per day")} />
          </section>
          <div className="grid gap-6 lg:grid-cols-2">
            <section className="card space-y-3">
              <div className="flex items-baseline justify-between gap-2">
                <h2 className="h2">{tr("Top sources")}</h2>
                <Link className="text-sm underline" href={`${base}/sources?${rangeQuery}`}>{tr("All sources & campaigns")}</Link>
              </div>
              {sources.length === 0 ? <p className="text-sm text-ink-3">{tr("Every install in this range was organic.")}</p> : (
                <table className="table text-sm">
                  <thead><tr><th>{tr("Source")}</th><th>{tr("Campaign")}</th><th className="text-end">{tr("Installs")}</th></tr></thead>
                  <tbody>{sources.map((s) => <tr key={`${s.source}:${s.campaign}`}><td>{s.source}</td><td className="text-ink-2">{s.campaign ?? "–"}</td><td className="text-end tabular-nums">{num(s.installs)}</td></tr>)}</tbody>
                </table>
              )}
            </section>
            <section className="card space-y-3">
              <div className="flex items-baseline justify-between gap-2">
                <h2 className="h2">{tr("Links: click → install")}</h2>
                <Link className="text-sm underline" href={`${base}/links?env=${env.type}`}>{tr("Tracking links & QR")}</Link>
              </div>
              <p className="text-sm text-ink-3">{tr("Overall {pct} of clicks led to an install.", { pct: pct(linkInstalls, t.clicks) })}</p>
              <table className="table text-sm">
                <thead><tr><th>{tr("Link")}</th><th className="text-end">{tr("Clicks")}</th><th className="text-end">{tr("Installs")}</th></tr></thead>
                <tbody>{r.links.slice(0, 5).map((l) => <tr key={l.id}><td>{l.name}</td><td className="text-end tabular-nums">{num(l.clicks)}</td><td className="text-end tabular-nums">{num(l.installs)}</td></tr>)}</tbody>
              </table>
            </section>
          </div>
          {r.revenue.length > 0 && (
            <p className="text-sm text-ink-3">
              {tr("Revenue credited to installs in this range: {amounts}.", { amounts: r.revenue.map((x) => `${money(x.revenue)} ${x.currency ?? tr("(no currency)")}`).join(" · ") })}{" "}
              <Link className="underline" href={`${base}/sources?${rangeQuery}`}>{tr("By campaign")}</Link>
            </p>
          )}
        </>
      )}
    </div>
  );
}
