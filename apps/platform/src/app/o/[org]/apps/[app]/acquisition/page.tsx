import Link from "next/link";
import { AcquisitionHeader, AcquisitionRange, money, num, pct } from "@/components/acquisition/AcquisitionHeader";
import { rangeFromParams, toSearch } from "@/modules/analytics/report-params";
import { Stat } from "@/components/Stat";
import { TrendChart } from "@/components/TrendChart";
import { envName, rich } from "@/components/acquisition/rich";
import { getT } from "@/i18n/server";
import { ChannelCoverage, ChannelTable } from "@/components/acquisition/ChannelPerformance";
import { CHANNEL_KEY_LABELS } from "@/modules/analytics/sql";
import { channelReport } from "@/modules/channels/report";
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
  const [r, ch] = await Promise.all([
    attributionOverview(ctx, { environmentId: env.id, timezone: a.timezone }, rangeInput),
    channelReport(ctx, { appId: a.id, environmentId: env.id, timezone: a.timezone, includeSpend: can(ctx.role, "analytics.read") }, rangeInput),
  ]);
  const base = `/o/${org}/apps/${app}/acquisition`;
  const rangeQuery = new URLSearchParams({ env: env.type, ...(r.range.preset ? { days: String(r.range.preset) } : { days: "custom", from: r.range.from, to: r.range.to }) });
  const tr = await getT();
  const t = r.totals;
  const allInstalls = t.installs + t.reinstalls;
  const linkInstalls = r.links.reduce((s, l) => s + l.installs, 0);
  const sources = r.bySource.filter((s) => !CHANNEL_KEY_LABELS[s.source]).slice(0, 5);
  const organic = ch.channels.filter((c) => c.group === "organic").reduce((n, c) => n + c.installs + c.reinstalls, 0);
  const direct = ch.channels.find((c) => c.key === "direct");

  return (
    <div className="space-y-6">
      <AcquisitionHeader base={base} current="" env={env.type} title={tr("Acquisition")}
        description={tr("Where your installs come from and what they lead to, for the selected environment.")} />
      <AcquisitionRange env={env.type} range={r.range} />

      <section className="stat-grid" aria-label={tr("Acquisition numbers")}>
        {[
          [tr("Link clicks"), num(t.clicks), tr("Bots and prefetches excluded")],
          [tr("Installs"), num(allInstalls), t.reinstalls ? tr("{n} reinstalls", { n: num(t.reinstalls) }) : tr("First opens")],
          [tr("Attributed"), `${num(t.attributed)} · ${pct(t.attributed, allInstalls)}`,
            tr("{deterministic} deterministic · {reported} reported · {probabilistic} probabilistic", { deterministic: num(t.deterministic), reported: num(t.reported), probabilistic: num(t.probabilistic) })],
          [tr("Unattributed"), `${num(ch.coverage.unattributed)} · ${pct(ch.coverage.unattributed, allInstalls)}`,
            ch.coverage.iosUnattributed ? tr("{n} on iOS, where paid installs can't be matched without SKAdNetwork or Apple Search Ads", { n: num(ch.coverage.iosUnattributed) })
              : tr("{organic} organic from the store referrer · {direct} direct", { organic: num(organic), direct: num(direct ? direct.installs + direct.reinstalls : 0) })],
        ].map(([label, value, note]) => (
          <Stat key={label} label={label} value={value} note={note} />
        ))}
      </section>

      {allInstalls === 0 && t.clicks === 0 ? (
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
          <section className="card overflow-x-auto p-0">
            <div className="flex flex-wrap items-baseline justify-between gap-2 px-5 pt-5">
              <h2 className="h2">{tr("Channels")}</h2>
              <Link className="text-sm underline" href={`${base}/sources?${rangeQuery}`}>{tr("All channels with cost and retention")}</Link>
            </div>
            <ChannelTable report={ch} compact />
          </section>
          <section className="card space-y-3">
            <h2 className="h2">{tr("Installs per day")}</h2>
            <TrendChart days={r.trend.days} series={r.trend.series.map((s) => ({ ...s, key: tr(s.key) }))} label={tr("Attributed and unmatched installs per day")} />
          </section>
          <div className="grid gap-6 lg:grid-cols-2">
            <section className="card space-y-3">
              <div className="flex items-baseline justify-between gap-2">
                <h2 className="h2">{tr("Top sources")}</h2>
                <Link className="text-sm underline" href={`${base}/sources?${rangeQuery}`}>{tr("All sources & campaigns")}</Link>
              </div>
              {sources.length === 0 ? <p className="text-sm text-ink-3">{tr("No install in this range carried a source.")}</p> : (
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
          <ChannelCoverage report={ch} timezone={a.timezone} />
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
