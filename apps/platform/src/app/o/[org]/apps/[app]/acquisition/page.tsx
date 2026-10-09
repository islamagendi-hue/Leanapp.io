import Link from "next/link";
import { AcquisitionHeader, AcquisitionRange, money, num, pct } from "@/components/acquisition/AcquisitionHeader";
import { rangeFromParams, toSearch } from "@/modules/analytics/report-params";
import { TrendChart } from "@/components/TrendChart";
import { attributionOverview } from "@/modules/attribution/reports";
import { loadApp, pickEnvironment, requirePermission } from "@/server/session";

export const metadata = { title: "Acquisition" };

export default async function AcquisitionOverviewPage(props: PageProps<"/o/[org]/apps/[app]/acquisition">) {
  const { org, app } = await props.params;
  const sp = await props.searchParams;
  const { ctx, app: a, environments } = await loadApp(org, app);
  requirePermission(ctx, "attribution.read");
  const env = await pickEnvironment(environments, sp.env);
  const r = await attributionOverview(ctx, { environmentId: env.id, timezone: a.timezone }, rangeFromParams(toSearch(sp)));
  const base = `/o/${org}/apps/${app}/acquisition`;
  const rangeQuery = new URLSearchParams({ env: env.type, ...(r.range.preset ? { days: String(r.range.preset) } : { days: "custom", from: r.range.from, to: r.range.to }) });
  const t = r.totals;
  const allInstalls = t.installs + t.reinstalls;
  const linkInstalls = r.links.reduce((s, l) => s + l.installs, 0);
  const sources = r.bySource.filter((s) => s.source !== "organic").slice(0, 5);

  return (
    <div className="space-y-6">
      <AcquisitionHeader base={base} current="" env={env.type} title="Acquisition"
        description="Where installs come from and what they lead to, for the selected environment." />
      <AcquisitionRange env={env.type} range={r.range} />

      <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4" aria-label="Acquisition numbers">
        {[
          ["Link clicks", num(t.clicks), "Bots and prefetches excluded"],
          ["Installs", num(allInstalls), t.reinstalls ? `${num(t.reinstalls)} reinstalls` : "First opens"],
          ["Attributed", `${num(t.attributed)} · ${pct(t.attributed, allInstalls)}`, t.probabilistic ? `${num(t.probabilistic)} probabilistic` : "All deterministic"],
          ["Organic", `${num(t.organic)} · ${pct(t.organic, allInstalls)}`, `${num(t.reengagements)} re-engagements`],
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
          <p>No acquisition data in {env.type} for this range.</p>
          <p className="text-sm text-ink-3">
            Create a <Link className="underline" href={`${base}/links?env=${env.type}`}>tracking link</Link> for your campaigns, and make sure your app sends
            <code className="mx-1 font-mono">app_installed</code> with the install referrer or click id (see Settings → Dev Ops → SDK).
          </p>
        </div>
      ) : (
        <>
          <section className="card space-y-3">
            <h2 className="h2">Installs per day</h2>
            <TrendChart days={r.trend.days} series={r.trend.series} label="Attributed and organic installs per day" />
          </section>
          <div className="grid gap-6 lg:grid-cols-2">
            <section className="card space-y-3">
              <div className="flex items-baseline justify-between gap-2">
                <h2 className="h2">Top sources</h2>
                <Link className="text-sm underline" href={`${base}/sources?${rangeQuery}`}>All sources &amp; campaigns</Link>
              </div>
              {sources.length === 0 ? <p className="text-sm text-ink-3">Every install in this range was organic.</p> : (
                <table className="table text-sm">
                  <thead><tr><th>Source</th><th>Campaign</th><th className="text-end">Installs</th></tr></thead>
                  <tbody>{sources.map((s) => <tr key={`${s.source}:${s.campaign}`}><td>{s.source}</td><td className="text-ink-2">{s.campaign ?? "–"}</td><td className="text-end tabular-nums">{num(s.installs)}</td></tr>)}</tbody>
                </table>
              )}
            </section>
            <section className="card space-y-3">
              <div className="flex items-baseline justify-between gap-2">
                <h2 className="h2">Links: click → install</h2>
                <Link className="text-sm underline" href={`${base}/links?env=${env.type}`}>Tracking links &amp; QR</Link>
              </div>
              <p className="text-sm text-ink-3">Overall {pct(linkInstalls, t.clicks)} of clicks led to an install.</p>
              <table className="table text-sm">
                <thead><tr><th>Link</th><th className="text-end">Clicks</th><th className="text-end">Installs</th></tr></thead>
                <tbody>{r.links.slice(0, 5).map((l) => <tr key={l.id}><td>{l.name}</td><td className="text-end tabular-nums">{num(l.clicks)}</td><td className="text-end tabular-nums">{num(l.installs)}</td></tr>)}</tbody>
              </table>
            </section>
          </div>
          {r.revenue.length > 0 && (
            <p className="text-sm text-ink-3">
              Revenue credited to installs in this range: {r.revenue.map((x) => `${money(x.revenue)} ${x.currency ?? "(no currency)"}`).join(" · ")}.{" "}
              <Link className="underline" href={`${base}/sources?${rangeQuery}`}>By campaign</Link>
            </p>
          )}
        </>
      )}
    </div>
  );
}
