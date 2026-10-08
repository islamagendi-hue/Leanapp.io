import Link from "next/link";
import { AnalyticsHeader, param, RANGE_LABELS } from "@/components/AnalyticsHeader";
import { TrendChart } from "@/components/TrendChart";
import { ATTRIBUTION_RANGES, attributionOverview } from "@/modules/attribution/reports";
import { skanBySource } from "@/modules/attribution/skan-service";
import { loadApp, pickEnvironment, requirePermission } from "@/server/session";

export const metadata = { title: "Attribution" };

const num = (n: number) => n.toLocaleString("en-US");
const pct = (a: number, b: number) => (b ? `${((a / b) * 100).toFixed(1)}%` : "–");
const money = (v: number) => v.toLocaleString("en-US", { maximumFractionDigits: 2 });

export default async function AttributionPage(props: PageProps<"/o/[org]/apps/[app]/acquisition">) {
  const { org, app } = await props.params;
  const sp = await props.searchParams;
  const { ctx, app: a, environments } = await loadApp(org, app);
  requirePermission(ctx, "attribution.read");
  const env = await pickEnvironment(environments, sp.env);
  const r = await attributionOverview(ctx, { environmentId: env.id, timezone: a.timezone }, param(sp.days));
  const skan = await skanBySource(ctx, env.id, r.days);
  const base = `/o/${org}/apps/${app}/acquisition`;
  const t = r.totals;
  const allInstalls = t.installs + t.reinstalls;
  const linkInstalls = r.links.reduce((s, l) => s + l.installs, 0);

  return (
    <div className="space-y-6">
      <AnalyticsHeader
        title="Attribution"
        description="Where installs come from and what they earn. Installs are matched to LeanApp link clicks, store referrers and ad-network click ids; the rest is organic."
        env={env.type}
      />

      <form method="get" className="flex flex-wrap items-end gap-3">
        <input type="hidden" name="env" value={env.type} />
        <label><span className="label">Range</span>
          <select name="days" className="input" defaultValue={String(r.days)}>{ATTRIBUTION_RANGES.map((d) => <option key={d} value={d}>{RANGE_LABELS[d]}</option>)}</select>
        </label>
        <button className="btn-secondary" type="submit">Show</button>
      </form>

      <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
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
          <p>No attribution data in {env.type} for this range.</p>
          <p className="text-sm text-ink-3">
            Create a <Link className="underline" href={`${base}/links?env=${env.type}`}>tracking link</Link> for your campaigns, and make sure your app sends
            <code className="mx-1 font-mono">app_installed</code> with the install referrer or click id (see the SDK guide).
          </p>
        </div>
      ) : (
        <>
          <section className="card space-y-3">
            <h2 className="h2">Installs per day</h2>
            <TrendChart days={r.trend.days} series={r.trend.series} label="Attributed and organic installs per day" />
          </section>

          <section className="card overflow-x-auto p-0">
            <h2 className="h2 px-5 pt-5">Installs by source and campaign</h2>
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
          </section>

          <section className="card overflow-x-auto p-0">
            <h2 className="h2 px-5 pt-5">Conversions and revenue by campaign</h2>
            <p className="px-5 text-sm text-ink-3">Last touch: each conversion counts for the latest install or re-engagement of that user before it. Amounts are in the currency the event was sent in.</p>
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

          <section className="card overflow-x-auto p-0">
            <div className="flex flex-wrap items-baseline justify-between gap-2 px-5 pt-5">
              <h2 className="h2">Links: click → install</h2>
              <span className="text-sm text-ink-3">Overall {pct(linkInstalls, t.clicks)}</span>
            </div>
            <table className="table mt-3">
              <thead><tr><th>Link</th><th>Source</th><th>Campaign</th><th className="text-end">Clicks</th><th className="text-end">Installs</th><th className="text-end">Rate</th></tr></thead>
              <tbody>
                {r.links.map((l) => (
                  <tr key={l.id}>
                    <td>{l.name} <span className="font-mono text-xs text-ink-3">/l/{l.code}</span>{l.status !== "active" && <span className="pill ms-2 border-line">{l.status}</span>}</td>
                    <td>{l.source}</td>
                    <td className="text-ink-2">{l.campaign ?? "–"}</td>
                    <td className="text-end tabular-nums">{num(l.clicks)}</td>
                    <td className="text-end tabular-nums">{num(l.installs)}</td>
                    <td className="text-end tabular-nums">{l.rate === null ? "–" : `${(l.rate * 100).toFixed(1)}%`}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
          {r.revenue.length > 0 && (
            <p className="text-sm text-ink-3">
              Total revenue: {r.revenue.map((x) => `${money(x.revenue)} ${x.currency ?? "(no currency)"}`).join(" · ")}
            </p>
          )}
        </>
      )}

      {skan.length > 0 && (
        <section className="card overflow-x-auto p-0">
          <div className="flex flex-wrap items-baseline justify-between gap-2 px-5 pt-5">
            <h2 className="h2">SKAdNetwork postbacks by source identifier</h2>
            <Link className="text-sm underline" href={`${base}/skan?env=${env.type}&days=${r.days}`}>Details</Link>
          </div>
          <p className="px-5 text-sm text-ink-3">Apple-verified iOS postbacks; aggregate only, never joined to users or counted in installs above.</p>
          <table className="table mt-3">
            <thead><tr><th>Ad network</th><th>Source id</th><th className="text-end">Postbacks</th><th className="text-end">Won</th><th className="text-end">Avg fine value</th><th className="text-end">Coarse high</th></tr></thead>
            <tbody>
              {skan.slice(0, 15).map((k) => (
                <tr key={`${k.framework}:${k.ad_network_id}:${k.source_identifier}`}>
                  <td className="font-mono text-xs">{k.network ?? k.ad_network_id}</td>
                  <td className="font-mono text-xs">{k.source_identifier ?? "–"}</td>
                  <td className="text-end tabular-nums">{num(k.postbacks)}</td>
                  <td className="text-end tabular-nums">{num(k.wins)}</td>
                  <td className="text-end tabular-nums">{k.fine_avg === null ? "–" : k.fine_avg.toFixed(1)}</td>
                  <td className="text-end tabular-nums">{num(k.coarse_high)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </div>
  );
}
